import { describe, expect, it } from "vitest";
import { loadCsvFormat } from "./csv.ts";
import { LayoutError } from "./errors.ts";
import { loadJsonFormat } from "./json.ts";
import { formatExample, formatExamples } from "./test-support.ts";
import { loadXmlFormat } from "./xml.ts";

const LOADERS: Record<string, (config: unknown) => unknown> = {
  csv: loadCsvFormat,
  json: loadJsonFormat,
  xml: loadXmlFormat,
};

const problems = (load: (config: unknown) => unknown, config: unknown): string[] => {
  try {
    load(config);
  } catch (error) {
    if (error instanceof LayoutError) return error.problems.map((p) => `${p.path} ${p.message}`);
    throw error;
  }
  return [];
};

const csv = (files: unknown[], extra: object = {}) => ({
  formatVersion: 1,
  format: "csv",
  files,
  ...extra,
});
const lineFile = (columns: unknown[], extra: object = {}) => ({
  name: "f",
  records: [{ name: "line", source: "lines", columns }],
  ...extra,
});

describe("format configurations", () => {
  it("has examples for every format, and they load", () => {
    expect(formatExamples.length).toBeGreaterThanOrEqual(5);
    for (const name of formatExamples) {
      const config = formatExample(name) as { format: string };
      const load = LOADERS[config.format];
      expect(load, name).toBeDefined();
      expect(problems(load as (config: unknown) => unknown, config), name).toEqual([]);
      expect(name.endsWith(`.${config.format}.yaml`), name).toBe(true);
    }
  });

  it("refuses what the schema does not allow", () => {
    const column = { name: "A", field: "a" };
    expect(problems(loadCsvFormat, csv([lineFile([column])], { extra: 1 }))).toContain(
      " must NOT have additional properties",
    );
    expect(problems(loadCsvFormat, csv([lineFile([{ ...column, value: "X" }])]))).toContain(
      "/files/0/records/0/columns/0 must match exactly one schema in oneOf",
    );
    expect(problems(loadCsvFormat, csv([lineFile([{ ...column, separatr: ";" }])]))).toContain(
      "/files/0/records/0/columns/0 must NOT have unevaluated properties",
    );
    expect(
      problems(loadCsvFormat, csv([lineFile([{ name: "A", field: "a.__proto__.b" }])])),
    ).toContain("/files/0/records/0/columns/0/field must NOT be valid");
    expect(problems(loadCsvFormat, csv([lineFile([column])], { separator: ";;" }))).toContain(
      "/separator must NOT have more than 1 characters",
    );
    expect(problems(loadCsvFormat, csv([]))).toContain("/files must NOT have fewer than 1 items");
    expect(problems(loadJsonFormat, { formatVersion: 1, format: "json", indent: 9 })).toContain(
      "/indent must be <= 8",
    );
    expect(problems(loadXmlFormat, { formatVersion: 1, format: "xml", root: "1x" })).toContain(
      '/root must match pattern "^[A-Za-z_][A-Za-z0-9._-]*$"',
    );
    expect(
      problems(
        loadXmlFormat,
        JSON.parse('{"formatVersion":1,"format":"xml","root":"R","names":{"__proto__":"x"}}'),
      ),
    ).toContain("/names property name must be valid");
  });

  it("refuses what a schema cannot say", () => {
    const header = { name: "header", columns: [{ name: "N", field: "number" }] };
    const line = (columns: unknown[], extra: object = {}) => ({
      name: "line",
      source: "lines",
      columns,
      ...extra,
    });
    const cases: [unknown, string][] = [
      [
        csv([lineFile([{ name: "A", field: "a" }]), lineFile([{ name: "A", field: "b" }])]),
        "/files has two files named f",
      ],
      [
        csv([{ name: "f", header: true, records: [header, line([{ name: "A", field: "a" }])] }]),
        "/files/0/header a header line needs a file with one record type",
      ],
      [
        csv([
          {
            name: "f",
            records: [
              line([{ name: "T", value: "L" }]),
              { ...header, columns: [{ name: "T", value: "H" }] },
            ],
          },
        ]),
        "/files/0/records/1 a record without source starts each document: it must be the first record type",
      ],
      [
        csv([{ name: "f", records: [header, line([{ name: "A", field: "a" }])] }]),
        "/files/0/records/0 needs a column with a value, such as a record code, to be told apart from the other record types",
      ],
      [
        csv([
          {
            name: "f",
            records: [
              { ...header, columns: [{ name: "T", value: "X" }] },
              line([{ name: "T", value: "X" }]),
            ],
          },
        ]),
        "/files/0/records/1 cannot be told apart from record type header: give both a different value at the same place",
      ],
      [
        csv([lineFile([{ name: "A", field: "a", scale: 2 }])]),
        "/files/0/records/0/columns/0/scale applies to decimal columns only",
      ],
      [
        csv([lineFile([{ name: "A", value: "a", type: "integer" }])]),
        "/files/0/records/0/columns/0/type a column with a value writes it as is: leave the type out",
      ],
      [
        csv([lineFile([{ name: "A", documentField: "a", groupBy: true }])]),
        "/files/0/records/0/columns/0/groupBy applies to the field of a record with a source only",
      ],
      [
        csv([
          { name: "f", records: [{ name: "h", columns: [{ name: "A", documentField: "a" }] }] },
        ]),
        "/files/0/records/0/columns/0/documentField a record without source reads the document itself: use field",
      ],
      [
        csv([
          lineFile([
            { name: "A", field: "a" },
            { name: "B", field: "a" },
          ]),
        ]),
        "/files/0/records/0/columns has two columns for a",
      ],
      [
        csv([
          lineFile([
            { name: "A", field: "a" },
            { name: "A", field: "a.b" },
          ]),
        ]),
        "/files/0/records/0/columns has two columns named A",
      ],
      [
        csv([
          lineFile([
            { name: "A", field: "a" },
            { name: "B", field: "a.b" },
          ]),
        ]),
        "/files/0/records/0/columns a and a.b overlap",
      ],
      [
        csv([
          {
            name: "f",
            records: [
              {
                name: "h",
                columns: [
                  { name: "A", field: "n" },
                  { name: "B", field: "n" },
                ],
              },
            ],
          },
        ]),
        "/files/0/records/0/columns has two columns for the document field n",
      ],
      [
        csv([
          {
            name: "f",
            records: [
              { name: "h", columns: [{ name: "T", value: "H" }] },
              { name: "l", source: "lines", columns: [{ name: "T", value: "L" }] },
              { name: "c", source: "lines.charges", columns: [{ name: "T", value: "C" }] },
            ],
          },
        ]),
        "/files sources lines and lines.charges overlap",
      ],
      [
        csv([lineFile([{ name: "A", field: "a", decimalMark: "," }])]),
        "/files/0/records/0/columns/0/decimalMark applies to decimal columns only",
      ],
      [
        csv([lineFile([{ name: "A", documentField: "lines.count" }])]),
        "/files document field lines.count overlaps the source lines",
      ],
      [
        csv([
          lineFile([{ name: "A", documentField: "number" }]),
          {
            name: "g",
            records: [{ name: "x", source: "lines", columns: [{ name: "B", field: "b" }] }],
          },
        ]),
        "/files/1/records/0/source lines is already the source of record type line",
      ],
      [
        csv([
          { name: "f", records: [header] },
          {
            name: "g",
            records: [
              { name: "x", source: "lines", columns: [{ name: "B", documentField: "other" }] },
            ],
          },
        ]),
        "/files several files are matched by a document field they all carry, such as documentNumber: none is common to every file",
      ],
      [
        csv([lineFile([{ name: "A", field: "a" }])], { encoding: "windows-1252", bom: true }),
        "/bom a byte order mark exists in UTF-8 only",
      ],
      [
        csv([lineFile([{ name: "A", field: "a" }])], { separator: "'", quote: "'" }),
        "/quote must differ from the separator",
      ],
    ];
    for (const [config, expected] of cases)
      expect(problems(loadCsvFormat, config)).toContain(expected);
    expect(
      problems(loadXmlFormat, {
        formatVersion: 1,
        format: "xml",
        root: "R",
        encoding: "windows-1252",
        declaration: false,
      }),
    ).toContain(
      "/declaration an XML file without a declaration is read as UTF-8: keep it to write another encoding",
    );
  });

  it("fills in the defaults", () => {
    const format = loadCsvFormat(csv([lineFile([{ name: "A", field: "a", type: "decimal" }])]));
    expect(format).toMatchObject({
      encoding: "utf-8",
      bom: false,
      lineEnding: "crlf",
      separator: ",",
      quote: '"',
      quoting: "minimal",
      decimalMark: ".",
    });
    expect(format.files[0]?.records[0]?.columns[0]).toEqual({
      name: "A",
      field: "a",
      type: "decimal",
      groupBy: false,
      required: false,
      decimalMark: ".",
    });
  });
});
