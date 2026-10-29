import {
  decode,
  describeCharacter,
  encode,
  firstUnencodable,
  refuseBomLike,
  type TextEncoding,
} from "./encoding.ts";
import { FormatError, type Position } from "./errors.ts";
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

/** A CSV file of a format, with its defaults filled in. */
export interface CsvFile extends RecordFile {
  header: boolean;
}

/** A CSV format, checked and with its defaults filled in: see contracts/erp-formats. */
export interface CsvFormat {
  format: "csv";
  name?: string;
  encoding: TextEncoding;
  bom: boolean;
  lineEnding: "crlf" | "lf";
  separator: string;
  quote: string;
  quoting: "minimal" | "all" | "none";
  decimalMark: DecimalMark;
  files: CsvFile[];
}

/** A file written by a renderer. */
export interface RenderedFile {
  name: string;
  bytes: Uint8Array;
}

interface CsvConfig extends Partial<Omit<CsvFormat, "files">> {
  files: {
    name: string;
    header?: boolean;
    records: (Omit<RecordType, "columns"> & { columns: ColumnConfig[] })[];
  }[];
}

/**
 * Checks a CSV format configuration (parsed from JSON or YAML) against its schema and the rules
 * a schema cannot say, and fills in the defaults. Throws a LayoutError listing every problem.
 */
export function loadCsvFormat(config: unknown): CsvFormat {
  throwIfAny(validateSchema("csv", config));
  const raw = config as CsvConfig;
  const decimalMark = raw.decimalMark ?? ".";
  const format: CsvFormat = {
    format: "csv",
    ...(raw.name === undefined ? {} : { name: raw.name }),
    encoding: raw.encoding ?? "utf-8",
    bom: raw.bom ?? false,
    lineEnding: raw.lineEnding ?? "crlf",
    separator: raw.separator ?? ",",
    quote: raw.quote ?? '"',
    quoting: raw.quoting ?? "minimal",
    decimalMark,
    files: raw.files.map((file) => ({
      name: file.name,
      header: file.header ?? false,
      records: file.records.map((record) => ({
        ...record,
        columns: record.columns.map((column) => normalizeColumn(column, decimalMark)),
      })),
    })),
  };
  const problems = checkRecordFiles(format.files, (_record, index) => String(index), raw);
  if (format.bom && format.encoding !== "utf-8") {
    problems.push({ path: "/bom", message: "a byte order mark exists in UTF-8 only" });
  }
  if (format.separator === format.quote) {
    problems.push({ path: "/quote", message: "must differ from the separator" });
  }
  throwIfAny(problems);
  return format;
}

function escapeValue(format: CsvFormat, text: string, where: Position): string {
  const { separator, quote, quoting } = format;
  const bad = firstUnencodable(text, format.encoding);
  if (bad >= 0) {
    throw new FormatError(
      `${describeCharacter(text, bad)} cannot be written in ${format.encoding}`,
      where,
    );
  }
  const special = text.includes(separator) || text.includes("\r") || text.includes("\n");
  if (quoting === "none") {
    if (special) {
      throw new FormatError(
        `${JSON.stringify(text)} holds the separator or a line break, and the format never quotes`,
        where,
      );
    }
    return text;
  }
  if (quoting === "all" || special || text.includes(quote)) {
    return `${quote}${text.replaceAll(quote, quote + quote)}${quote}`;
  }
  return text;
}

/**
 * Writes documents (canonical documents, or what an outbound mapping gives) to the files of a
 * CSV format, in the order of the format. Each file holds the records of every document.
 */
export function renderCsv(format: CsvFormat, documents: readonly unknown[]): RenderedFile[] {
  const eol = format.lineEnding === "crlf" ? "\r\n" : "\n";
  return format.files.map((file) => {
    const lines: string[] = [];
    const add = (cells: string[], where: (index: number) => Position) => {
      const line = cells.map((cell, index) => escapeValue(format, cell, where(index)));
      // A record of one empty value would be an empty line, which a reader refuses.
      if (line.length === 1 && line[0] === "") {
        if (format.quoting === "none") {
          throw new FormatError("would be an empty line, and the format never quotes", where(0));
        }
        line[0] = format.quote + format.quote;
      }
      lines.push(line.join(format.separator));
    };
    if (file.header) {
      const columns = (file.records[0] as RecordType).columns;
      add(
        columns.map((column) => column.name),
        (index) => ({ file: file.name, line: 1, column: columns[index]?.name ?? "" }),
      );
    }
    for (const rendered of renderRecords(file, documents)) {
      add(rendered.cells, (index) => rendered.cellWhere[index] ?? rendered.where);
    }
    const text = lines.length === 0 ? "" : lines.join(eol) + eol;
    refuseBomLike(text, format.encoding, { file: file.name, line: 1, character: 1 });
    return { name: file.name, bytes: encode(text, format.encoding, format.bom) };
  });
}

/** One line of a CSV file cut into values, with the index of each value in the text. */
interface Row {
  cells: string[];
  starts: number[];
  line: number;
  /** Line and index in the text where each value starts (a quoted value can span lines). */
  lines: number[];
  lineStarts: number[];
}

/** Cuts the text of a CSV file into rows, refusing anything RFC 4180 does not allow. */
function* parseRows(
  text: string,
  format: CsvFormat,
  at: (index: number, line: number, lineStart: number) => Position,
): Generator<Row> {
  const { separator } = format;
  const quote = format.quoting === "none" ? undefined : format.quote;
  let index = 0;
  let line = 1;
  let lineStart = 0;
  while (index < text.length) {
    const row: Row = { cells: [], starts: [], line, lines: [], lineStarts: [] };
    for (;;) {
      row.starts.push(index);
      row.lines.push(line);
      row.lineStarts.push(lineStart);
      let value = "";
      if (quote !== undefined && text[index] === quote) {
        const opening = at(index, line, lineStart);
        index++;
        for (;;) {
          const next = text.indexOf(quote, index);
          if (next < 0) throw new FormatError("a quoted value is never closed", opening);
          const chunk = text.slice(index, next);
          for (let i = chunk.indexOf("\n"); i >= 0; i = chunk.indexOf("\n", i + 1)) {
            line++;
            lineStart = index + i + 1;
          }
          value += chunk;
          index = next + 1;
          if (text[index] !== quote) break;
          value += quote;
          index++;
        }
        const after = text[index];
        if (after !== undefined && after !== separator && after !== "\r" && after !== "\n") {
          throw new FormatError(
            `${describeCharacter(text, index)} follows a closing quote; expected the separator or the end of the line`,
            at(index, line, lineStart),
          );
        }
      } else {
        const start = index;
        while (index < text.length) {
          const char = text[index];
          if (char === separator || char === "\n" || char === "\r") break;
          if (char === quote) {
            throw new FormatError(
              "a quote inside a value that does not start with one; quote the whole value and double the quote",
              at(index, line, lineStart),
            );
          }
          index++;
        }
        value = text.slice(start, index);
      }
      row.cells.push(value);
      const char = text[index];
      if (char === separator) {
        index++;
        continue;
      }
      if (char === "\r") {
        if (text[index + 1] !== "\n") {
          throw new FormatError(
            "a carriage return not followed by a line feed",
            at(index, line, lineStart),
          );
        }
        index++;
      }
      if (index < text.length) index++;
      line++;
      lineStart = index;
      break;
    }
    yield row;
  }
}

function matchRecord(file: CsvFile, row: Row, where: Position): RecordType {
  const records = file.records;
  if (records.length === 1) return records[0] as RecordType;
  const found = records.find((record) =>
    record.columns.every(
      (column, index) => column.value === undefined || row.cells[index] === column.value,
    ),
  );
  if (found) return found;
  const expected = records.map((record) => {
    const codes = record.columns.flatMap((column, index) =>
      column.value === undefined ? [] : [`"${column.value}" in value ${index + 1}`],
    );
    return `${codes.join(" and ")} for ${record.name}`;
  });
  throw new FormatError(`matches no record type: expected ${expected.join(", or ")}`, where);
}

/**
 * Reads the files of a CSV format back into documents, one per document they hold, in the order
 * of the first file. `files` maps the name of each file of the format to its bytes. Anything the
 * format does not allow is an error with its position; nothing is guessed.
 */
export function readCsv(
  format: CsvFormat,
  files: Readonly<Record<string, Uint8Array>>,
): JsonObject[] {
  for (const name of Object.keys(files)) {
    if (!format.files.some((file) => file.name === name)) {
      throw new FormatError(`is not a file of this format`, { file: name });
    }
  }
  const assemblers = format.files.map((file) => {
    const bytes = Object.hasOwn(files, file.name) ? files[file.name] : undefined;
    if (!bytes) throw new FormatError("is missing", { file: file.name });
    const { text, offsetOf } = decode(bytes, format.encoding, file.name);
    const at = (index: number, line: number, lineStart: number): Position => ({
      file: file.name,
      line,
      character: [...text.slice(lineStart, index)].length + 1,
      offset: offsetOf(index),
    });
    const assembler = new FileAssembler<Column>(file);
    let first = true;
    for (const row of parseRows(text, format, at)) {
      const cellAt = (index: number) =>
        at(row.starts[index] ?? 0, row.lines[index] ?? row.line, row.lineStarts[index] ?? 0);
      const where = cellAt(0);
      if (
        row.cells.length === 1 &&
        row.cells[0] === "" &&
        text[row.starts[0] ?? 0] !== format.quote
      ) {
        throw new FormatError("is empty", {
          file: file.name,
          line: row.line,
          character: 1,
          offset: where.offset ?? 0,
        });
      }
      if (first && file.header) {
        first = false;
        const columns = (file.records[0] as RecordType).columns;
        columns.forEach((column, index) => {
          if (row.cells[index] !== column.name) {
            throw new FormatError(
              `the header has ${JSON.stringify(row.cells[index] ?? "nothing")} where the format expects ${JSON.stringify(column.name)}`,
              cellAt(Math.min(index, row.cells.length - 1)),
            );
          }
        });
        if (row.cells.length > columns.length) {
          throw new FormatError(
            `the header has ${row.cells.length} names, the format ${columns.length}`,
            cellAt(columns.length),
          );
        }
        continue;
      }
      first = false;
      const record = matchRecord(file, row, where);
      if (row.cells.length !== record.columns.length) {
        throw new FormatError(
          `has ${row.cells.length} values, record type ${record.name} has ${record.columns.length} columns`,
          { ...where, record: record.name },
        );
      }
      assembler.add({
        record,
        cells: row.cells,
        where: { ...where, record: record.name },
        cellWhere: (index) => ({
          ...cellAt(index),
          record: record.name,
          column: record.columns[index]?.name ?? "",
        }),
      });
    }
    if (first && file.header) {
      throw new FormatError("the header line is missing", { file: file.name, line: 1, offset: 0 });
    }
    return assembler;
  });
  return joinFiles(assemblers);
}
