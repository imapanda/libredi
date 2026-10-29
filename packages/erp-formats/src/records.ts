// The record model shared by CSV and fixed width: which records a document gives, what text each
// column holds, and, when reading, how records become documents again.
import { FormatError, type Position } from "./errors.ts";
import {
  type Column,
  documentPaths,
  groupKeys,
  type RecordFile,
  type RecordType,
} from "./layout.ts";
import {
  formatDecimal,
  formatInteger,
  getPath,
  isObject,
  type JsonObject,
  type JsonValue,
  parseDecimal,
  parseInteger,
  setPath,
} from "./values.ts";

/** The text of each column of one record, before the syntax of the file. */
export interface RenderedRecord<C extends Column> {
  record: RecordType<C>;
  cells: string[];
  /** Where the record, and each of its cells, come from, for an error found while writing it. */
  where: Position;
  cellWhere: Position[];
}

function kind(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** The text of a column for the value found in the document. */
export function formatCell(column: Column, value: unknown, where: Position): string {
  if (column.value !== undefined) return column.value;
  if (value === undefined || value === null || value === "") {
    if (column.required) throw new FormatError("is required but missing", where);
    return "";
  }
  switch (column.type) {
    case "integer":
      return formatInteger(value, where);
    case "decimal":
      if (typeof value !== "string") {
        throw new FormatError(
          `is ${kind(value)}; decimal numbers must be strings, so that no digit is lost`,
          where,
        );
      }
      return formatDecimal(value, column.decimalMark, column.scale, where);
    default:
      if (typeof value !== "string") {
        const hint =
          typeof value === "number" ? " (give the column a type: integer or decimal)" : "";
        throw new FormatError(`is ${kind(value)}, not a string${hint}`, where);
      }
      return value;
  }
}

/** Every record that `documents` give in `file`, in order: per document, per record type. */
export function* renderRecords<C extends Column>(
  file: RecordFile<C>,
  documents: readonly unknown[],
): Generator<RenderedRecord<C>> {
  for (const [d, document] of documents.entries()) {
    const at: Position = { file: file.name, document: d + 1 };
    if (!isObject(document)) throw new FormatError(`is ${kind(document)}, not an object`, at);
    for (const record of file.records) {
      const items: [unknown, string][] = [];
      if (record.source === undefined) {
        items.push([document, ""]);
      } else {
        const list = getPath(document, record.source, { ...at, path: record.source });
        if (list !== undefined && !Array.isArray(list)) {
          throw new FormatError(`is ${kind(list)}, not an array`, { ...at, path: record.source });
        }
        for (const [i, item] of (list ?? []).entries())
          items.push([item, `${record.source}[${i}]`]);
      }
      for (const [item, prefix] of items) {
        const where: Position = { ...at, record: record.name };
        const cellWhere: Position[] = [];
        const cells = record.columns.map((column) => {
          const fromDocument = column.documentField !== undefined;
          const path = (fromDocument ? column.documentField : column.field) ?? "";
          const full = fromDocument || prefix === "" ? path : `${prefix}.${path}`;
          const cellAt: Position = { ...where, column: column.name, path: full };
          cellWhere.push(cellAt);
          const value =
            column.value === undefined
              ? getPath(fromDocument ? document : item, path, cellAt)
              : undefined;
          return formatCell(column, value, cellAt);
        });
        yield { record, cells, where, cellWhere };
      }
    }
  }
}

/** The value a column holds, read back as the document has it; undefined for nothing. */
export function parseCell(column: Column, text: string, where: Position): JsonValue | undefined {
  if (column.value !== undefined) {
    if (text !== column.value) {
      throw new FormatError(`"${text}" found where the format expects "${column.value}"`, where);
    }
    return undefined;
  }
  if (text === "") {
    if (column.required) throw new FormatError("is required but empty", where);
    return undefined;
  }
  if (column.type === "decimal") return parseDecimal(text, column.decimalMark, where);
  if (column.type === "integer") return parseInteger(text, where);
  return text;
}

/** One record found in a file, cut into the text of its columns. */
export interface ReadRecord<C extends Column> {
  record: RecordType<C>;
  cells: string[];
  /** Position of the record, and of each of its cells. */
  where: Position;
  cellWhere(index: number): Position;
}

/** The part of a document that one file holds. */
interface Part {
  document: JsonObject;
  /** The values that every record of the document repeats, by path. */
  values: Map<string, JsonValue>;
  /** The values that tell this document from the next one in its file (see groupKeys). */
  group: Map<string, JsonValue | undefined>;
  where: Position;
}

const show = (value: JsonValue | undefined) =>
  value === undefined ? "nothing" : JSON.stringify(value);

/** Turns the records of one file into the parts of documents it holds, in order. */
export class FileAssembler<C extends Column> {
  readonly parts: Part[] = [];
  readonly #file: RecordFile<C>;
  readonly #documentRecord: RecordType<C> | undefined;
  readonly #seen = new Map<string, Position>();

  constructor(file: RecordFile<C>) {
    this.#file = file;
    const first = file.records[0];
    this.#documentRecord = first?.source === undefined ? first : undefined;
  }

  add(read: ReadRecord<C>): void {
    const { record } = read;
    const values = new Map<string, JsonValue>();
    const parsed = new Map<number, JsonValue>();
    const item: JsonObject = {};
    record.columns.forEach((column, index) => {
      const value = parseCell(column, read.cells[index] ?? "", read.cellWhere(index));
      if (value === undefined) return;
      parsed.set(index, value);
      if (record.source === undefined && column.field !== undefined)
        values.set(column.field, value);
      else if (column.documentField !== undefined) values.set(column.documentField, value);
      else if (column.field !== undefined) setPath(item, column.field, value);
    });

    const group = new Map(groupKeys(record).map(({ key, column }) => [key, parsed.get(column)]));
    let part = this.parts[this.parts.length - 1];
    if (record.source === undefined) {
      part = this.#start(values, group, read.where);
    } else if (!part) {
      if (this.#documentRecord) {
        throw new FormatError(
          `comes before any ${this.#documentRecord.name} record, which starts a document`,
          read.where,
        );
      }
      part = this.#start(values, group, read.where);
    } else if (
      !this.#documentRecord &&
      [...group].some(([key, value]) => part?.group.has(key) && part.group.get(key) !== value)
    ) {
      part = this.#start(values, group, read.where);
    } else {
      // A record type seen for the first time in this document adds its own keys.
      for (const [key, value] of group) if (!part.group.has(key)) part.group.set(key, value);
      for (const [path, value] of values) {
        const known = part.values.get(path);
        if (known === undefined) {
          part.values.set(path, value);
          setPath(part.document, path, value);
        } else if (known !== value) {
          throw new FormatError(
            `${path} is ${show(value)}, but the document it belongs to has ${show(known)}`,
            read.where,
          );
        }
      }
    }
    if (record.source !== undefined) {
      const list = this.#list(part.document, record.source);
      list.push(item);
    }
  }

  #start(
    values: Map<string, JsonValue>,
    group: Map<string, JsonValue | undefined>,
    where: Position,
  ): Part {
    const document: JsonObject = {};
    for (const [path, value] of values) setPath(document, path, value);
    if (!this.#documentRecord) {
      // Without a record that opens each document, a document is a run of records repeating the
      // same values: a run that comes back later would silently become a second document.
      const key = JSON.stringify([...group].sort(([a], [b]) => (a < b ? -1 : 1)));
      const earlier = this.#seen.get(key);
      if (earlier) {
        throw new FormatError(
          `continues the document that started at line ${earlier.line}, after another document: its records must follow each other`,
          where,
        );
      }
      this.#seen.set(key, where);
    }
    const part = { document, values, group, where };
    this.parts.push(part);
    return part;
  }

  #list(document: JsonObject, source: string): JsonValue[] {
    const existing = getPath(document, source, {});
    if (Array.isArray(existing)) return existing;
    const list: JsonValue[] = [];
    setPath(document, source, list);
    return list;
  }

  get file(): RecordFile<C> {
    return this.#file;
  }
}

/**
 * Puts together the parts of each document that several files hold, matched by the document
 * fields that every file carries. A file whose first record type opens each document must hold
 * every document; a file of items only holds nothing for a document without items.
 */
export function joinFiles<C extends Column>(assemblers: FileAssembler<C>[]): JsonObject[] {
  const opening = (assembler: FileAssembler<C>) => assembler.file.records[0]?.source === undefined;
  const primary = assemblers.find(opening) ?? assemblers[0];
  if (!primary) return [];
  if (assemblers.length === 1) return primary.parts.map((part) => part.document);

  const pathsOf = (assembler: FileAssembler<C>) =>
    new Set(assembler.file.records.flatMap((record) => documentPaths(record)));
  const shared = [...pathsOf(primary)].filter((path) =>
    assemblers.every((assembler) => pathsOf(assembler).has(path)),
  );
  const keyOf = (part: Part) => JSON.stringify(shared.map((path) => part.values.get(path) ?? null));
  const describe = (part: Part) =>
    shared.map((path) => `${path} ${show(part.values.get(path))}`).join(", ");
  const indexes = assemblers.map((assembler) => {
    const byKey = new Map<string, Part>();
    for (const part of assembler.parts) {
      const earlier = byKey.get(keyOf(part));
      if (earlier) {
        throw new FormatError(
          `holds a second document with ${describe(part)}, after line ${earlier.where.line}`,
          part.where,
        );
      }
      byKey.set(keyOf(part), part);
    }
    return byKey;
  });

  const documents = primary.parts.map((part) => {
    const key = keyOf(part);
    const document = part.document;
    assemblers.forEach((assembler, i) => {
      if (assembler === primary) return;
      const byKey = indexes[i] as Map<string, Part>;
      const other = byKey.get(key);
      if (!other) {
        if (!opening(assembler)) return;
        throw new FormatError(
          `the document with ${describe(part)} has no record in file ${assembler.file.name}`,
          part.where,
        );
      }
      byKey.delete(key);
      for (const [path, value] of other.values) {
        const known = part.values.get(path);
        if (known !== undefined && known !== value) {
          throw new FormatError(
            `${path} is ${show(value)} here and ${show(known)} in file ${primary.file.name}`,
            other.where,
          );
        }
        part.values.set(path, value);
        setPath(document, path, value);
      }
      for (const record of assembler.file.records) {
        if (record.source === undefined) continue;
        const list = getPath(other.document, record.source, {});
        if (list !== undefined) setPath(document, record.source, list as JsonValue);
      }
    });
    return document;
  });
  assemblers.forEach((assembler, i) => {
    if (assembler === primary) return;
    for (const part of (indexes[i] as Map<string, Part>).values()) {
      throw new FormatError(
        `the document with ${describe(part)} is not in file ${primary.file.name}`,
        part.where,
      );
    }
  });
  return documents;
}
