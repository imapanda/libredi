import Ajv2020 from "ajv/dist/2020.js";
import common from "../../../contracts/erp-formats/v1/common.schema.json" with { type: "json" };
import csv from "../../../contracts/erp-formats/v1/csv.schema.json" with { type: "json" };
import fixedWidth from "../../../contracts/erp-formats/v1/fixed-width.schema.json" with {
  type: "json",
};
import json from "../../../contracts/erp-formats/v1/json.schema.json" with { type: "json" };
import xml from "../../../contracts/erp-formats/v1/xml.schema.json" with { type: "json" };
import { LayoutError, type LayoutProblem } from "./errors.ts";
import type { ColumnType, DecimalMark } from "./values.ts";

/** One column of a record type, with the defaults of its format filled in. */
export interface Column {
  name: string;
  field?: string;
  documentField?: string;
  value?: string;
  type: ColumnType;
  groupBy: boolean;
  required: boolean;
  scale?: number;
  decimalMark: DecimalMark;
}

export interface RecordType<C extends Column = Column> {
  name: string;
  source?: string;
  columns: C[];
}

export interface RecordFile<C extends Column = Column> {
  name: string;
  records: RecordType<C>[];
}

/** A column as written in a configuration, before defaults. */
export type ColumnConfig = Omit<Column, "type" | "groupBy" | "required" | "decimalMark"> &
  Partial<Pick<Column, "type" | "groupBy" | "required" | "decimalMark">>;

const SCHEMAS = { csv, "fixed-width": fixedWidth, json, xml } as const;
type SchemaName = keyof typeof SCHEMAS;

let ajv: Ajv2020 | undefined;

/**
 * Checks a configuration against its schema in contracts/erp-formats/v1. The schemas are
 * imported, not read from disk, so that a bundled service carries them.
 */
export function validateSchema(name: SchemaName, config: unknown): LayoutProblem[] {
  if (!ajv) {
    // strictRequired would refuse the `required` inside the `oneOf` of a column.
    ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    ajv.addSchema(common);
    for (const schema of Object.values(SCHEMAS)) ajv.addSchema(schema);
  }
  const validate = ajv.getSchema(SCHEMAS[name].$id);
  if (!validate) throw new Error(`schema ${name} is not loaded`);
  if (validate(config)) return [];
  return (validate.errors ?? []).map((error) => ({
    path: error.instancePath,
    message: error.message ?? "is invalid",
  }));
}

export function normalizeColumn<C extends ColumnConfig>(
  column: C,
  decimalMark: DecimalMark,
): C & Column {
  return {
    ...column,
    type: column.type ?? "string",
    groupBy: column.groupBy ?? false,
    required: column.required ?? false,
    decimalMark: column.decimalMark ?? decimalMark,
  };
}

/**
 * What tells the documents of a file apart, for the records of one type: its document fields
 * and its groupBy fields, by a key that does not mix the two.
 */
export function groupKeys(record: RecordType): { key: string; column: number }[] {
  return record.columns.flatMap((column, index) => {
    if (column.documentField !== undefined)
      return [{ key: `document:${column.documentField}`, column: index }];
    if (column.groupBy && column.field !== undefined)
      return [{ key: `item:${column.field}`, column: index }];
    return [];
  });
}

/** Paths a column sets on the document itself, whatever the record. */
export function documentPaths(record: RecordType): string[] {
  return record.columns.flatMap((column) => {
    if (column.documentField !== undefined) return [column.documentField];
    if (record.source === undefined && column.field !== undefined) return [column.field];
    return [];
  });
}

const overlaps = (a: string, b: string) => a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

function duplicates(names: string[]): string[] {
  return names.filter((name, index) => names.indexOf(name) !== index);
}

/**
 * The checks a schema cannot express, shared by the record-based formats (CSV and fixed width).
 * `slot` says where a column sits, so that two constants at the same slot can tell record types
 * apart: its index for CSV, its range of characters for fixed width.
 */
export function checkRecordFiles<C extends Column>(
  files: RecordFile<C>[],
  slot: (record: RecordType<C>, index: number) => string,
  configs: { files?: { header?: boolean; records?: { columns?: { decimalMark?: string }[] }[] }[] },
): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  const problem = (path: string, message: string) => problems.push({ path, message });

  for (const name of duplicates(files.map((file) => file.name))) {
    problem("/files", `has two files named ${name}`);
  }
  const sources = new Map<string, string>();
  const allDocumentPaths = new Set<string>();
  const perFile: Set<string>[] = [];

  files.forEach((file, f) => {
    const at = `/files/${f}`;
    for (const name of duplicates(file.records.map((record) => record.name))) {
      problem(`${at}/records`, `has two record types named ${name}`);
    }
    if (configs.files?.[f]?.header && file.records.length > 1) {
      problem(`${at}/header`, "a header line needs a file with one record type");
    }
    file.records.forEach((record, r) => {
      if (record.source === undefined && r > 0) {
        problem(
          `${at}/records/${r}`,
          "a record without source starts each document: it must be the first record type",
        );
      }
    });

    const discriminators = file.records.map(
      (record) =>
        new Map(
          record.columns.flatMap((column, index) =>
            column.value === undefined ? [] : [[slot(record, index), column.value] as const],
          ),
        ),
    );
    if (file.records.length > 1) {
      discriminators.forEach((own, a) => {
        if (own.size === 0) {
          problem(
            `${at}/records/${a}`,
            "needs a column with a value, such as a record code, to be told apart from the other record types",
          );
          return;
        }
        for (let b = a + 1; b < discriminators.length; b++) {
          const other = discriminators[b] as Map<string, string>;
          const differs = [...own].some(
            ([key, value]) => other.has(key) && other.get(key) !== value,
          );
          if (other.size > 0 && !differs) {
            problem(
              `${at}/records/${b}`,
              `cannot be told apart from record type ${file.records[a]?.name}: give both a different value at the same place`,
            );
          }
        }
      });
    }

    const fileDocumentPaths = new Set<string>();
    file.records.forEach((record, r) => {
      const recordAt = `${at}/records/${r}`;
      if (record.source !== undefined) {
        const earlier = sources.get(record.source);
        if (earlier !== undefined) {
          problem(`${recordAt}/source`, `${record.source} is already the source of ${earlier}`);
        }
        sources.set(record.source, `record type ${record.name}`);
      }
      for (const name of duplicates(record.columns.map((column) => column.name))) {
        problem(`${recordAt}/columns`, `has two columns named ${name}`);
      }
      const itemPaths: string[] = [];
      record.columns.forEach((column, c) => {
        const columnAt = `${recordAt}/columns/${c}`;
        if (column.type !== "decimal" && column.scale !== undefined) {
          problem(`${columnAt}/scale`, "applies to decimal columns only");
        }
        const raw = configs.files?.[f]?.records?.[r]?.columns?.[c];
        if (column.type !== "decimal" && raw?.decimalMark !== undefined) {
          problem(`${columnAt}/decimalMark`, "applies to decimal columns only");
        }
        if (column.value !== undefined && column.type !== "string") {
          problem(`${columnAt}/type`, "a column with a value writes it as is: leave the type out");
        }
        if (column.groupBy && (record.source === undefined || column.field === undefined)) {
          problem(`${columnAt}/groupBy`, "applies to the field of a record with a source only");
        }
        if (record.source === undefined && column.documentField !== undefined) {
          problem(
            `${columnAt}/documentField`,
            "a record without source reads the document itself: use field",
          );
        }
        if (record.source !== undefined && column.field !== undefined) itemPaths.push(column.field);
      });
      for (const path of duplicates(itemPaths)) {
        problem(`${recordAt}/columns`, `has two columns for ${path}`);
      }
      for (const [i, a] of itemPaths.entries()) {
        for (const b of itemPaths.slice(i + 1)) {
          if (overlaps(a, b)) problem(`${recordAt}/columns`, `${a} and ${b} overlap`);
        }
      }
      for (const path of duplicates(documentPaths(record))) {
        problem(`${recordAt}/columns`, `has two columns for the document field ${path}`);
      }
      for (const path of documentPaths(record)) fileDocumentPaths.add(path);
    });
    for (const path of fileDocumentPaths) allDocumentPaths.add(path);
    perFile.push(fileDocumentPaths);
  });

  const sourceList = [...sources.keys()];
  for (const [i, a] of sourceList.entries()) {
    for (const b of sourceList.slice(i + 1)) {
      if (overlaps(a, b)) problem("/files", `sources ${a} and ${b} overlap`);
    }
  }
  const documentList = [...allDocumentPaths];
  for (const [i, a] of documentList.entries()) {
    for (const b of documentList.slice(i + 1)) {
      if (overlaps(a, b)) problem("/files", `document fields ${a} and ${b} overlap`);
    }
    for (const source of sources.keys()) {
      if (a === source || overlaps(a, source)) {
        problem("/files", `document field ${a} overlaps the source ${source}`);
      }
    }
  }
  if (files.length > 1) {
    const shared = documentList.filter((path) => perFile.every((paths) => paths.has(path)));
    if (shared.length === 0) {
      problem(
        "/files",
        "several files are matched by a document field they all carry, such as documentNumber: none is common to every file",
      );
    }
  }
  return problems;
}

export function throwIfAny(problems: LayoutProblem[]): void {
  if (problems.length > 0) throw new LayoutError(problems);
}
