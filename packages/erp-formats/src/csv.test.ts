import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type CsvFormat, loadCsvFormat, readCsv, renderCsv } from "./csv.ts";
import { FormatError } from "./errors.ts";
import { bytes, canonicalExample, formatExample, text } from "./test-support.ts";
import type { JsonObject } from "./values.ts";

const example = (name: string) => loadCsvFormat(formatExample(name));

/** A small format with one record type, for the reader's error cases. */
const simple = (overrides: object = {}) =>
  loadCsvFormat({
    formatVersion: 1,
    format: "csv",
    separator: ";",
    decimalMark: ",",
    lineEnding: "lf",
    files: [
      {
        name: "lines.csv",
        records: [
          {
            name: "line",
            source: "lines",
            columns: [
              { name: "ORDER", documentField: "documentNumber" },
              { name: "TEXT", field: "text" },
              { name: "PRICE", field: "price", type: "decimal" },
            ],
          },
        ],
      },
    ],
    ...overrides,
  });

const fail = (format: CsvFormat, files: Record<string, Uint8Array>): FormatError => {
  try {
    readCsv(format, files);
  } catch (error) {
    if (error instanceof FormatError) return error;
    throw error;
  }
  throw new Error("readCsv did not fail");
};

const orderRows = {
  rows: [
    {
      order_number: "PO-0100",
      order_date: "2030-10-15",
      buyer_gln: "9520000000011",
      line: "1",
      gtin: "9520000010010",
      supplier_item: "SUP-001",
      quantity: "12",
      unit: "ST",
      unit_price: "1.00",
    },
    {
      order_number: "PO-0100",
      order_date: "2030-10-15",
      buyer_gln: "9520000000011",
      line: "2",
      gtin: "9520000010027",
      quantity: "24.5",
      unit: "ST",
      unit_price: "2.50",
    },
  ],
};

describe("renderCsv", () => {
  it("writes the rows of a mapping with French conventions", () => {
    const [file] = renderCsv(example("order-lines.csv.yaml"), [orderRows]);
    expect(file?.name).toBe("order-lines.csv");
    expect(text(file?.bytes ?? new Uint8Array(), "windows-1252")).toBe(
      "ORDER_NO;ORDER_DATE;BUYER_GLN;SHIP_TO_GLN;LINE;GTIN;SUPPLIER_ITEM;QUANTITY;UNIT;UNIT_PRICE\r\n" +
        "PO-0100;2030-10-15;9520000000011;;1;9520000010010;SUP-001;12;ST;1,00\r\n" +
        "PO-0100;2030-10-15;9520000000011;;2;9520000010027;;24,5;ST;2,50\r\n",
    );
  });

  it("writes a canonical order as header and line records, with a byte order mark", () => {
    const [file] = renderCsv(example("order-header-lines.csv.yaml"), [canonicalExample("order")]);
    const written = file?.bytes ?? new Uint8Array();
    expect([...written.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text(written).split("\r\n")).toEqual([
      "H;order;1;PO-0100;2030-10-15;2030-10-22;EUR;9520000000011;SAMPLE RETAIL SA;9520000000035;9520000000028",
      "L;1;9520000010010;SUP-001;SAMPLE BISCUITS 200G;12;PCE;1,00",
      "L;2;9520000010027;SUP-002;SAMPLE JUICE 1L;24;PCE;2,50",
      "L;3;9520000010034;SUP-003;SAMPLE COFFEE 250G;6;PCE;12,00",
      "",
    ]);
  });

  it("writes one document to two files", () => {
    const files = renderCsv(example("order-two-files.csv.yaml"), [canonicalExample("order")]);
    expect(files.map((file) => [file.name, text(file.bytes)])).toEqual([
      [
        "order-headers.csv",
        "order_number,order_date,buyer_gln,buyer_name,supplier_gln\n" +
          "PO-0100,2030-10-15,9520000000011,SAMPLE RETAIL SA,9520000000035\n",
      ],
      [
        "order-lines.csv",
        "order_number,line,gtin,description,quantity,unit,unit_price\n" +
          "PO-0100,1,9520000010010,SAMPLE BISCUITS 200G,12,PCE,1.00\n" +
          "PO-0100,2,9520000010027,SAMPLE JUICE 1L,24,PCE,2.50\n" +
          "PO-0100,3,9520000010034,SAMPLE COFFEE 250G,6,PCE,12.00\n",
      ],
    ]);
  });

  it("quotes what needs it, and every value when asked", () => {
    const document = { documentNumber: "A;B", lines: [{ text: 'say "hi"\nbye', price: "1" }] };
    const [minimal] = renderCsv(simple(), [document]);
    expect(text(minimal?.bytes ?? new Uint8Array())).toBe('"A;B";"say ""hi""\nbye";1\n');
    const [all] = renderCsv(simple({ quoting: "all" }), [{ documentNumber: "A", lines: [{}] }]);
    expect(text(all?.bytes ?? new Uint8Array())).toBe('"A";"";""\n');
  });

  it("refuses what it cannot write faithfully, saying where", () => {
    const render = (format: CsvFormat, document: unknown) => () => renderCsv(format, [document]);
    expect(render(simple(), { lines: [{ price: "1.234" }] })).not.toThrow();
    expect(render(simple({ quoting: "none" }), { lines: [{ text: "a;b" }] })).toThrow(
      'file lines.csv, document 1, record line, column TEXT, lines[0].text: "a;b" holds the separator',
    );
    expect(render(simple(), { lines: [{ price: 2.5 }] })).toThrow(
      "lines[0].price: is a number; decimal numbers must be strings",
    );
    expect(render(simple(), { lines: [{ price: "1e3" }] })).toThrow("is not a decimal number");
    expect(render(simple(), { lines: [{ text: 12 }] })).toThrow("give the column a type");
    expect(render(simple(), { lines: "none" })).toThrow("lines: is a string, not an array");
    expect(render(simple(), { lines: [{ text: { a: 1 } }] })).toThrow("is an object, not a string");
    expect(render(simple(), [])).toThrow("document 1: is an array, not an object");
    const cp1252 = simple({ encoding: "windows-1252" });
    expect(render(cp1252, { lines: [{ text: "café €" }] })).not.toThrow();
    expect(render(cp1252, { lines: [{ text: "Ω" }] })).toThrow(
      'column TEXT, lines[0].text: "Ω" (U+03A9) cannot be written in windows-1252',
    );
    const required = example("order-lines.csv.yaml");
    expect(() => renderCsv(required, [{ rows: [{ line: "1", quantity: "1" }] }])).toThrow(
      "column ORDER_NO, rows[0].order_number: is required but missing",
    );
    const scaled = example("order-lines.csv.yaml");
    expect(() =>
      renderCsv(scaled, [
        { rows: [{ order_number: "A", line: "1", quantity: "1", unit_price: "1.005" }] },
      ]),
    ).toThrow('"1.005" has 3 decimals, the format writes 2: it would be rounded');
  });
});

describe("readCsv", () => {
  it("reads back what it wrote, for each example", () => {
    const order = canonicalExample("order");
    const headerLines = example("order-header-lines.csv.yaml");
    const [read] = readCsv(headerLines, {
      "orders.csv": renderCsv(headerLines, [order])[0]?.bytes ?? new Uint8Array(),
    });
    expect(read).toEqual({
      documentType: "order",
      schemaVersion: 1,
      documentNumber: "PO-0100",
      issueDate: "2030-10-15",
      requestedDeliveryDate: "2030-10-22",
      currency: "EUR",
      parties: {
        buyer: { gln: "9520000000011", name: "SAMPLE RETAIL SA" },
        supplier: { gln: "9520000000035" },
        shipTo: { gln: "9520000000028" },
      },
      lines: (order["lines"] as JsonObject[]).map(
        ({ lineNumber, product, quantity, unitPrice }) => ({
          lineNumber,
          product,
          quantity,
          unitPrice,
        }),
      ),
    });

    const twoFiles = example("order-two-files.csv.yaml");
    const rendered = renderCsv(twoFiles, [order, { ...order, documentNumber: "PO-0101" }]);
    const files = Object.fromEntries(rendered.map((file) => [file.name, file.bytes]));
    const documents = readCsv(twoFiles, files);
    expect(documents.map((document) => document["documentNumber"])).toEqual(["PO-0100", "PO-0101"]);
    expect(renderCsv(twoFiles, documents)).toEqual(rendered);

    const rows = example("order-lines.csv.yaml");
    const second = { rows: [{ ...orderRows.rows[0], order_number: "PO-0101" }] };
    const lines = renderCsv(rows, [orderRows, second])[0]?.bytes ?? new Uint8Array();
    expect(readCsv(rows, { "order-lines.csv": lines })).toEqual([orderRows, second]);
  });

  it("round-trips any document the format can hold", () => {
    const value = fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 });
    const decimal = fc
      .tuple(
        fc.boolean(),
        fc.bigInt({ min: 0n, max: 10n ** 20n }),
        fc.option(fc.stringMatching(/^[0-9]{1,6}$/)),
      )
      .map(
        ([negative, whole, decimals]) =>
          `${negative ? "-" : ""}${whole}${decimals === null ? "" : `.${decimals}`}`,
      );
    const document = fc.record({
      documentNumber: value,
      lines: fc.array(fc.record({ text: value, price: decimal }, { requiredKeys: [] }), {
        minLength: 1,
        maxLength: 5,
      }),
    });
    const settings = fc.record({
      separator: fc.constantFrom(";", ",", "\t", "|"),
      quoting: fc.constantFrom("minimal", "all"),
      lineEnding: fc.constantFrom("crlf", "lf"),
      encoding: fc.constantFrom("utf-8", "windows-1252"),
    });
    fc.assert(
      fc.property(
        fc.array(document, { minLength: 1, maxLength: 4 }),
        settings,
        (documents, options) => {
          const format = simple(options);
          // Documents in a row with the same number are one document to a reader: keep them apart.
          const distinct = documents.map((d, i) => ({
            ...d,
            documentNumber: `${i}${d.documentNumber}`,
          }));
          const encodable = distinct.filter(
            (d) =>
              options.encoding === "utf-8" ||
              JSON.stringify(d)
                .split("")
                .every((c) => c.charCodeAt(0) < 0x100),
          );
          fc.pre(encodable.length === distinct.length);
          const [file] = renderCsv(format, distinct);
          const read = readCsv(format, { "lines.csv": file?.bytes ?? new Uint8Array() });
          expect(read).toEqual(distinct);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("reads values the way the format writes them", () => {
    const read = (content: string) => readCsv(simple(), { "lines.csv": bytes(content) });
    expect(read('A;x;007,50\nA;;-0\nA;"q;""";\r\n')).toEqual([
      {
        documentNumber: "A",
        lines: [{ text: "x", price: "7.50" }, { price: "-0" }, { text: 'q;"' }],
      },
    ]);
    expect(read("")).toEqual([]);
    expect(read("A;x;1")).toEqual([{ documentNumber: "A", lines: [{ text: "x", price: "1" }] }]);
    expect(read('A;"two\nlines";1\n')).toEqual([
      { documentNumber: "A", lines: [{ text: "two\nlines", price: "1" }] },
    ]);
    expect(read("A;x;1\nB;y;2\n").map((document) => document["documentNumber"])).toEqual([
      "A",
      "B",
    ]);
  });

  it("strips a UTF-8 byte order mark and refuses one in another encoding", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("A;é;1\n")]);
    expect(readCsv(simple(), { "lines.csv": withBom })).toEqual([
      { documentNumber: "A", lines: [{ text: "é", price: "1" }] },
    ]);
    expect(fail(simple({ encoding: "windows-1252" }), { "lines.csv": withBom }).message).toBe(
      "file lines.csv, byte 0: starts with a UTF-8 byte order mark, but the format says windows-1252",
    );
  });

  it.each([
    ['A;"open;1\n', "file lines.csv, line 1, character 3, byte 2: a quoted value is never closed"],
    [
      'A;"x"y;1\n',
      'file lines.csv, line 1, character 6, byte 5: "y" (U+0079) follows a closing quote',
    ],
    ['A;x"y;1\n', "file lines.csv, line 1, character 4, byte 3: a quote inside a value"],
    [
      "A;x;1\rB;y;2\n",
      "file lines.csv, line 1, character 6, byte 5: a carriage return not followed",
    ],
    ["A;x;1\n\nA;y;2\n", "file lines.csv, line 2, character 1, byte 6: is empty"],
    [
      "A;x\n",
      "file lines.csv, line 1, character 1, byte 0, record line: has 2 values, record type line has 3",
    ],
    [
      "A;é;1.5\n",
      'file lines.csv, line 1, character 5, byte 5, record line, column PRICE: "1.5" is not a decimal number with "," as decimal mark',
    ],
    [
      "A;x;1\nB;y;2\nA;z;3\n",
      "file lines.csv, line 3, character 1, byte 12, record line: continues the document that started at line 1",
    ],
  ])("refuses %j with a positioned error", (content, message) => {
    expect(fail(simple(), { "lines.csv": bytes(content) }).message).toContain(message);
  });

  it("refuses bytes the encoding does not define, at their offset", () => {
    const utf8 = new Uint8Array([...bytes("A;ok;1\nA;"), 0xc3, 0x28, ...bytes(";1\n")]);
    expect(fail(simple(), { "lines.csv": utf8 }).message).toBe(
      "file lines.csv, byte 9: is not valid UTF-8",
    );
    const cut = new Uint8Array([...bytes("A;"), 0xe2, 0x82]);
    expect(fail(simple(), { "lines.csv": cut }).message).toBe(
      "file lines.csv, byte 2: is not valid UTF-8",
    );
    const cp1252 = new Uint8Array([...bytes("A;"), 0x81, ...bytes(";1\n")]);
    expect(fail(simple({ encoding: "windows-1252" }), { "lines.csv": cp1252 }).message).toBe(
      "file lines.csv, byte 2: byte 0x81 is not a character in windows-1252",
    );
  });

  it("checks the header, the record codes and the files", () => {
    const rows = example("order-lines.csv.yaml");
    expect(fail(rows, { "order-lines.csv": bytes("ORDER_NO;DATE\r\n") }).message).toBe(
      'file order-lines.csv, line 1, character 10, byte 9: the header has "DATE" where the format expects "ORDER_DATE"',
    );
    const headerLines = example("order-header-lines.csv.yaml");
    const read = (content: string) => fail(headerLines, { "orders.csv": bytes(content) }).message;
    expect(read("X;1\r\n")).toBe(
      'file orders.csv, line 1, character 1, byte 0: matches no record type: expected "H" in value 1 for header, or "L" in value 1 for line',
    );
    expect(read("L;1;;;;1;;\r\n")).toBe(
      "file orders.csv, line 1, character 1, byte 0, record line: comes before any header record, which starts a document",
    );
    expect(read("H;order;one;PO-1;2030-01-01;;;;;;\r\n")).toContain(
      'character 9, byte 8, record header, column SCHEMA_VERSION: "one" is not a whole number',
    );
    expect(read("H;order;1;;2030-01-01;;;;;;\r\n")).toContain(
      "column ORDER_NO: is required but empty",
    );

    const twoFiles = example("order-two-files.csv.yaml");
    const header =
      "order_number,order_date,buyer_gln,buyer_name,supplier_gln\nPO-1,2030-01-01,1,,2\n";
    const lines = "order_number,line,gtin,description,quantity,unit,unit_price\n";
    expect(fail(twoFiles, { "order-headers.csv": bytes(header) }).message).toBe(
      "file order-lines.csv: is missing",
    );
    expect(
      fail(twoFiles, {
        "order-headers.csv": bytes(header),
        "order-lines.csv": bytes(lines),
        "x.csv": bytes(""),
      }).message,
    ).toBe("file x.csv: is not a file of this format");
    // A document without lines writes nothing to the lines file, and reads back without them.
    expect(
      readCsv(twoFiles, { "order-headers.csv": bytes(header), "order-lines.csv": bytes(lines) }),
    ).toEqual([
      {
        documentNumber: "PO-1",
        issueDate: "2030-01-01",
        parties: { buyer: { gln: "1" }, supplier: { gln: "2" } },
      },
    ]);
    expect(
      fail(twoFiles, { "order-headers.csv": bytes(""), "order-lines.csv": bytes(lines) }).message,
    ).toBe("file order-headers.csv, line 1, byte 0: the header line is missing");
    expect(
      fail(twoFiles, {
        "order-headers.csv": bytes(header),
        "order-lines.csv": bytes(`${lines}PO-1,1,,,1,,\nPO-2,1,,,1,,\n`),
      }).message,
    ).toContain(
      'line 3, character 1, byte 73, record line: the document with documentNumber "PO-2" is not in file order-headers.csv',
    );
  });

  it("keeps the documents of mixed record types together, and the file fast", () => {
    const format = loadCsvFormat({
      formatVersion: 1,
      format: "csv",
      files: [
        {
          name: "f.csv",
          records: [
            {
              name: "L",
              source: "lines",
              columns: [
                { name: "T", value: "L" },
                { name: "N", documentField: "n" },
                { name: "Q", field: "q" },
              ],
            },
            {
              name: "C",
              source: "charges",
              columns: [
                { name: "T", value: "C" },
                { name: "N", documentField: "n" },
                { name: "K", field: "k", groupBy: true },
              ],
            },
          ],
        },
      ],
    });
    const documents = [
      { n: "1", lines: [{ q: "5" }], charges: [{ k: "x" }] },
      { n: "2", lines: [{ q: "6" }], charges: [{ k: "y" }, { k: "y" }] },
    ];
    const [file] = renderCsv(format, documents);
    expect(readCsv(format, { "f.csv": file?.bytes ?? new Uint8Array() })).toEqual(documents);

    // Positions cost nothing until an error needs one: a 60,000-row UTF-8 file reads at once.
    const big = {
      documentNumber: "A",
      lines: Array.from({ length: 60_000 }, (_, i) => ({ text: `é${i}`, price: "1" })),
    };
    const [rendered] = renderCsv(simple(), [big]);
    const started = performance.now();
    expect(readCsv(simple(), { "lines.csv": rendered?.bytes ?? new Uint8Array() })).toEqual([big]);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("refuses the values it could not read back", () => {
    expect(() => renderCsv(simple(), [{ documentNumber: "\uFEFFA", lines: [{}] }])).toThrow(
      "file lines.csv, line 1, character 1: the file would start with a byte order mark",
    );
    expect(() =>
      renderCsv(simple({ encoding: "windows-1252" }), [
        { documentNumber: "\u00EF\u00BB\u00BFA", lines: [{}] },
      ]),
    ).toThrow("would start with a byte order mark");
    const integer = loadCsvFormat({
      formatVersion: 1,
      format: "csv",
      files: [
        {
          name: "f",
          records: [
            { name: "l", source: "lines", columns: [{ name: "N", field: "n", type: "integer" }] },
          ],
        },
      ],
    });
    expect(() => renderCsv(integer, [{ lines: [{ n: "9007199254740993" }] }])).toThrow(
      '"9007199254740993" is not a whole number',
    );
  });

  it("counts characters as people do", () => {
    expect(fail(simple(), { "lines.csv": bytes('😀;é"y;1\n') }).message).toBe(
      "file lines.csv, line 1, character 4, byte 7: a quote inside a value that does not start with one; quote the whole value and double the quote",
    );
  });
});
