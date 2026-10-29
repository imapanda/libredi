import type { RenderedFile } from "./csv.ts";
import {
  decode,
  describeCharacter,
  encode,
  firstUnencodable,
  refuseBomLike,
  type TextEncoding,
} from "./encoding.ts";
import { FormatError, type LayoutProblem, type Position } from "./errors.ts";
import {
  type Column,
  type ColumnConfig,
  checkRecordFiles,
  normalizeColumn,
  type RecordFile,
  type RecordType,
  throwIfAny,
  validateSchema,
} from "./layout.ts";
import { FileAssembler, joinFiles, renderRecords } from "./records.ts";
import type { DecimalMark, JsonObject } from "./values.ts";

/** A column of a fixed-width record, with its defaults filled in. */
export interface FixedColumn extends Column {
  width: number;
  align: "left" | "right";
  pad: string;
  impliedDecimals: boolean;
  overflow: "error" | "truncate";
}

/** A fixed-width format, checked and with its defaults filled in: see contracts/erp-formats. */
export interface FixedWidthFormat {
  format: "fixed-width";
  name?: string;
  encoding: TextEncoding;
  bom: boolean;
  lineEnding: "crlf" | "lf";
  decimalMark: DecimalMark;
  files: RecordFile<FixedColumn>[];
}

type FixedColumnConfig = ColumnConfig &
  Pick<FixedColumn, "width"> &
  Partial<Pick<FixedColumn, "align" | "pad" | "impliedDecimals" | "overflow">>;

interface FixedWidthConfig extends Partial<Omit<FixedWidthFormat, "files">> {
  files: {
    name: string;
    records: (Omit<RecordType, "columns"> & { columns: FixedColumnConfig[] })[];
  }[];
}

/** Where each column of a record starts, in characters from 0. */
const starts = (record: RecordType<FixedColumn>): number[] => {
  let start = 0;
  return record.columns.map((column) => {
    const at = start;
    start += column.width;
    return at;
  });
};

const lengthOf = (record: RecordType<FixedColumn>) =>
  record.columns.reduce((total, column) => total + column.width, 0);

/**
 * Checks a fixed-width format configuration (parsed from JSON or YAML) against its schema and
 * the rules a schema cannot say, and fills in the defaults. Throws a LayoutError.
 */
export function loadFixedWidthFormat(config: unknown): FixedWidthFormat {
  throwIfAny(validateSchema("fixed-width", config));
  const raw = config as FixedWidthConfig;
  const decimalMark = raw.decimalMark ?? ".";
  const format: FixedWidthFormat = {
    format: "fixed-width",
    ...(raw.name === undefined ? {} : { name: raw.name }),
    encoding: raw.encoding ?? "utf-8",
    bom: raw.bom ?? false,
    lineEnding: raw.lineEnding ?? "crlf",
    decimalMark,
    files: raw.files.map((file) => ({
      name: file.name,
      records: file.records.map((record) => ({
        ...record,
        columns: record.columns.map((column) => {
          const normalized = normalizeColumn(column, decimalMark);
          return {
            ...normalized,
            align: column.align ?? (normalized.type === "string" ? "left" : "right"),
            pad: column.pad ?? " ",
            impliedDecimals: column.impliedDecimals ?? false,
            overflow: column.overflow ?? "error",
          };
        }),
      })),
    })),
  };
  const problems: LayoutProblem[] = checkRecordFiles(
    format.files,
    (record, index) => `${starts(record)[index]}+${record.columns[index]?.width}`,
    { files: [] },
  );
  if (format.bom && format.encoding !== "utf-8") {
    problems.push({ path: "/bom", message: "a byte order mark exists in UTF-8 only" });
  }
  format.files.forEach((file, f) => {
    file.records.forEach((record, r) => {
      record.columns.forEach((column, c) => {
        const at = `/files/${f}/records/${r}/columns/${c}`;
        if (column.pad !== " " && column.align !== "right") {
          problems.push({
            path: `${at}/pad`,
            message: "a pad other than a space needs align: right",
          });
        }
        if (column.impliedDecimals && (column.type !== "decimal" || !column.scale)) {
          problems.push({
            path: `${at}/impliedDecimals`,
            message: "needs a decimal column with a scale",
          });
        }
        if (
          column.overflow === "truncate" &&
          (column.type !== "string" || column.value !== undefined)
        ) {
          problems.push({
            path: `${at}/overflow`,
            message: "only a string field can be truncated",
          });
        }
        if (column.value !== undefined && [...column.value].length > column.width) {
          problems.push({
            path: `${at}/value`,
            message: `is longer than the width, ${column.width}`,
          });
        }
      });
    });
  });
  throwIfAny(problems);
  return format;
}

/** Pads the text of a column to its width, refusing what a reader could not get back. */
function fit(column: FixedColumn, cell: string, encoding: TextEncoding, where: Position): string {
  if (cell === "") return " ".repeat(column.width);
  let text = column.impliedDecimals ? cell.replace(column.decimalMark, "") : cell;
  const bad = firstUnencodable(text, encoding);
  if (bad >= 0) {
    throw new FormatError(
      `${describeCharacter(text, bad)} cannot be written in ${encoding}`,
      where,
    );
  }
  let chars = [...text];
  if (chars.length > column.width) {
    if (column.overflow !== "truncate") {
      throw new FormatError(
        `"${text}" is ${chars.length} characters long, the column holds ${column.width}`,
        where,
      );
    }
    chars = chars.slice(0, column.width);
    text = chars.join("");
  }
  if (column.type === "string" && column.value === undefined) {
    const padded = column.align === "left" ? chars[chars.length - 1] : chars[0];
    if (padded === column.pad || text.trim() === "") {
      throw new FormatError(
        `"${text}" ${column.align === "left" ? "ends" : "starts"} with the padding character, which a reader would drop`,
        where,
      );
    }
  }
  const fill = column.pad.repeat(column.width - chars.length);
  if (column.align === "left") return text + fill;
  if (column.pad !== " " && text.startsWith("-")) return `-${fill}${text.slice(1)}`;
  return fill + text;
}

/**
 * Writes documents to the files of a fixed-width format, in the order of the format. Each file
 * holds the records of every document.
 */
export function renderFixedWidth(
  format: FixedWidthFormat,
  documents: readonly unknown[],
): RenderedFile[] {
  const eol = format.lineEnding === "crlf" ? "\r\n" : "\n";
  return format.files.map((file) => {
    let text = "";
    for (const rendered of renderRecords(file, documents)) {
      const columns = rendered.record.columns;
      text += rendered.cells
        .map((cell, index) =>
          fit(
            columns[index] as FixedColumn,
            cell,
            format.encoding,
            rendered.cellWhere[index] ?? rendered.where,
          ),
        )
        .join("");
      text += eol;
    }
    refuseBomLike(text, format.encoding, { file: file.name, line: 1, character: 1 });
    return { name: file.name, bytes: encode(text, format.encoding, format.bom) };
  });
}

/** Removes the padding of a column, on the side the alignment leaves to it. */
function strip(column: FixedColumn, text: string): string {
  let start = 0;
  let end = text.length;
  if (column.align === "right") while (start < end && text[start] === column.pad) start++;
  else while (end > start && text[end - 1] === column.pad) end--;
  return text.slice(start, end);
}

/** The text of a column without its padding, as `fit` received it: the inverse of `fit`. */
function readValue(column: FixedColumn, raw: string, where: Position): string {
  if (raw.trim() === "" || column.value !== undefined || column.type === "string") {
    return raw.trim() === "" ? "" : strip(column, raw);
  }
  // A number: a sign may come before zeros of padding, as fit writes it.
  let digits = strip(column, raw);
  let sign = "";
  if (digits.startsWith("-") && column.align === "right") {
    sign = "-";
    digits = strip(column, digits.slice(1));
  }
  if (column.impliedDecimals) {
    if (!/^[0-9]*$/.test(digits)) {
      throw new FormatError(`"${raw}" is not a number written with implied decimals`, where);
    }
    const scale = column.scale ?? 0;
    const padded = digits.padStart(scale + 1, "0");
    digits = `${padded.slice(0, -scale)}${column.decimalMark}${padded.slice(-scale)}`;
  }
  if (digits === "" || digits.startsWith(column.decimalMark)) digits = `0${digits}`;
  return sign + digits;
}

/**
 * Reads the files of a fixed-width format back into documents, one per document they hold, in
 * the order of the first file. Every line must have the exact length of its record type.
 */
export function readFixedWidth(
  format: FixedWidthFormat,
  files: Readonly<Record<string, Uint8Array>>,
): JsonObject[] {
  for (const name of Object.keys(files)) {
    if (!format.files.some((file) => file.name === name)) {
      throw new FormatError("is not a file of this format", { file: name });
    }
  }
  const assemblers = format.files.map((file) => {
    const bytes = Object.hasOwn(files, file.name) ? files[file.name] : undefined;
    if (!bytes) throw new FormatError("is missing", { file: file.name });
    const { text, offsetOf } = decode(bytes, format.encoding, file.name);
    const layouts = file.records.map((record) => ({
      record,
      starts: starts(record),
      length: lengthOf(record),
    }));
    const assembler = new FileAssembler<FixedColumn>(file);
    let lineStart = 0;
    for (let line = 1; lineStart < text.length; line++) {
      const newline = text.indexOf("\n", lineStart);
      const lineEnd = newline < 0 ? text.length : newline;
      const content = text.slice(lineStart, text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd);
      const chars = [...content];
      // UTF-16 index of each character, for the byte offset of a column.
      const units: number[] = [];
      let unit = lineStart;
      for (const char of chars) {
        units.push(unit);
        unit += char.length;
      }
      units.push(unit);
      const at = (character: number): Position => ({
        file: file.name,
        line,
        character: character + 1,
        offset: offsetOf(units[character] ?? unit),
      });
      const carriageReturn = content.indexOf("\r");
      if (carriageReturn >= 0) {
        throw new FormatError(
          "a carriage return not followed by a line feed",
          at([...content.slice(0, carriageReturn)].length),
        );
      }
      if (chars.length === 0) throw new FormatError("is empty", at(0));
      const slice = (start: number, width: number) => chars.slice(start, start + width).join("");

      const found =
        layouts.length === 1
          ? layouts[0]
          : layouts.find(({ record, starts: from }) =>
              record.columns.every(
                (column, index) =>
                  column.value === undefined ||
                  readValue(column, slice(from[index] ?? 0, column.width), {}) === column.value,
              ),
            );
      if (!found) {
        const expected = layouts.map(({ record, starts: from }) => {
          const codes = record.columns.flatMap((column, index) =>
            column.value === undefined || column.value === ""
              ? []
              : [`"${column.value}" at character ${(from[index] ?? 0) + 1}`],
          );
          return `${codes.join(" and ")} for ${record.name}`;
        });
        throw new FormatError(`matches no record type: expected ${expected.join(", or ")}`, at(0));
      }
      const { record, starts: from, length } = found;
      if (chars.length !== length) {
        throw new FormatError(
          `is ${chars.length} characters long, record type ${record.name} is ${length}`,
          { ...at(Math.min(chars.length, length)), record: record.name },
        );
      }
      const cells = record.columns.map((column, index) => slice(from[index] ?? 0, column.width));
      const cellWhere = (index: number): Position => ({
        ...at(from[index] ?? 0),
        record: record.name,
        column: record.columns[index]?.name ?? "",
      });
      // The values come out of their padding here; the assembler parses them as for CSV.
      const values = cells.map((cell, index) =>
        readValue(record.columns[index] as FixedColumn, cell, cellWhere(index)),
      );
      assembler.add({ record, cells: values, where: { ...at(0), record: record.name }, cellWhere });
      lineStart = newline < 0 ? text.length : newline + 1;
    }
    return assembler;
  });
  return joinFiles(assemblers);
}
