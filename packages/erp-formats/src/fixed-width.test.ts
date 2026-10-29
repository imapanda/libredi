import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LayoutError } from "./errors.ts";
import {
  type FixedWidthFormat,
  loadFixedWidthFormat,
  readFixedWidth,
  renderFixedWidth,
} from "./fixed-width.ts";
import { bytes, canonicalExample, formatExample, text } from "./test-support.ts";

const example = () => loadFixedWidthFormat(formatExample("order.fixed-width.yaml"));

/** One record type with every kind of column, for the round trip and the error cases. */
const simple = (overrides: object = {}) =>
  loadFixedWidthFormat({
    formatVersion: 1,
    format: "fixed-width",
    lineEnding: "lf",
    decimalMark: ",",
    files: [
      {
        name: "f.txt",
        records: [
          {
            name: "line",
            source: "lines",
            columns: [
              { name: "DOC", documentField: "number", width: 6 },
              { name: "CODE", field: "code", width: 5 },
              { name: "REF", field: "ref", width: 4, align: "right", pad: "0" },
              { name: "QTY", field: "qty", type: "integer", width: 5, pad: "0" },
              { name: "AMOUNT", field: "amount", type: "decimal", width: 8 },
              {
                name: "PRICE",
                field: "price",
                type: "decimal",
                scale: 2,
                width: 7,
                pad: "0",
                impliedDecimals: true,
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  });

const lines = (format: FixedWidthFormat, documents: unknown[]) =>
  renderFixedWidth(format, documents).map((file) => text(file.bytes, "windows-1252"));

const fail = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error("did not fail");
};

describe("renderFixedWidth", () => {
  it("writes a canonical order with the example layout", () => {
    expect(lines(example(), [canonicalExample("order")])).toEqual([
      [
        `01${"PO-0100".padEnd(15)}2030-10-152030-10-229520000000011${"SAMPLE RETAIL SA".padEnd(30)}     `,
        `020001${"9520000010010".padEnd(14)}${"SAMPLE BISCUITS 200G".padEnd(30)}000012.000PCE000000100`,
        `020002${"9520000010027".padEnd(14)}${"SAMPLE JUICE 1L".padEnd(30)}000024.000PCE000000250`,
        `020003${"9520000010034".padEnd(14)}${"SAMPLE COFFEE 250G".padEnd(30)}000006.000PCE000001200`,
        "",
      ].join("\r\n"),
    ]);
  });

  it("pads, aligns, signs and truncates as configured", () => {
    const document = {
      number: "D1",
      lines: [{ code: "AB", ref: "7", qty: -12, amount: "-3.5", price: "-0.05" }, {}],
    };
    expect(lines(simple(), [document])).toEqual([
      `D1    AB   0007-0012    -3,5-000005
${"D1".padEnd(35)}
`,
    ]);
    const long = { lines: [{ description: "A DESCRIPTION TOO LONG" }] };
    const truncating = loadFixedWidthFormat({
      formatVersion: 1,
      format: "fixed-width",
      files: [
        {
          name: "f",
          records: [
            {
              name: "l",
              source: "lines",
              columns: [{ name: "D", field: "description", width: 6, overflow: "truncate" }],
            },
          ],
        },
      ],
    });
    expect(lines(truncating, [long])).toEqual(["A DESC\r\n"]);
  });

  it("refuses what a reader could not get back", () => {
    const render = (line: object) => () =>
      renderFixedWidth(simple(), [{ number: "D", lines: [line] }]);
    expect(fail(render({ code: "ABCDEF" }))).toBe(
      'file f.txt, document 1, record line, column CODE, lines[0].code: "ABCDEF" is 6 characters long, the column holds 5',
    );
    expect(fail(render({ code: "AB " }))).toContain(
      '"AB " ends with the padding character, which a reader would drop',
    );
    expect(fail(render({ ref: "012" }))).toContain('"012" starts with the padding character');
    expect(fail(render({ code: " " }))).toContain("which a reader would drop");
    expect(fail(render({ price: "1.234" }))).toContain(
      '"1.234" has 3 decimals, the format writes 2',
    );
    expect(fail(render({ amount: "123456.75" }))).toContain('"123456,75" is 9 characters long');
    expect(render({ code: "Ω" })).not.toThrow();
    expect(fail(() => renderFixedWidth(simple(), [{ number: "\uFEFFA", lines: [{}] }]))).toContain(
      "would start with a byte order mark",
    );
    const cp1252 = simple({ encoding: "windows-1252" });
    expect(fail(() => renderFixedWidth(cp1252, [{ lines: [{ code: "Ω" }] }]))).toContain(
      '"Ω" (U+03A9) cannot be written in windows-1252',
    );
  });
});

describe("readFixedWidth", () => {
  it("reads back what it wrote", () => {
    const format = example();
    const order = canonicalExample("order");
    const files = Object.fromEntries(
      renderFixedWidth(format, [order]).map((file) => [file.name, file.bytes]),
    );
    const [read] = readFixedWidth(format, files);
    expect(read).toMatchObject({
      documentNumber: "PO-0100",
      issueDate: "2030-10-15",
      requestedDeliveryDate: "2030-10-22",
      parties: { buyer: { gln: "9520000000011", name: "SAMPLE RETAIL SA" } },
    });
    expect(read?.["lines"]).toEqual([
      {
        lineNumber: 1,
        product: { gtin: "9520000010010", description: "SAMPLE BISCUITS 200G" },
        quantity: { value: "12.000", unit: "PCE" },
        unitPrice: { amount: "1.00" },
      },
      {
        lineNumber: 2,
        product: { gtin: "9520000010027", description: "SAMPLE JUICE 1L" },
        quantity: { value: "24.000", unit: "PCE" },
        unitPrice: { amount: "2.50" },
      },
      {
        lineNumber: 3,
        product: { gtin: "9520000010034", description: "SAMPLE COFFEE 250G" },
        quantity: { value: "6.000", unit: "PCE" },
        unitPrice: { amount: "12.00" },
      },
    ]);
    expect(renderFixedWidth(format, readFixedWidth(format, files))).toEqual(
      renderFixedWidth(format, [order]),
    );
  });

  it("round-trips any document the layout can hold", () => {
    const code = fc.stringMatching(/^[A-Za-zéà0-9]([A-Za-z0-9 .-]{0,3}[A-Za-z0-9])?$/);
    const ref = fc.stringMatching(/^[1-9][0-9]{0,3}$/);
    const decimal = (whole: number, scale: number) =>
      fc
        .tuple(
          fc.boolean(),
          fc.integer({ min: 0, max: 10 ** whole - 1 }),
          fc.integer({ min: 0, max: 10 ** scale - 1 }),
        )
        .map(
          ([negative, w, d]) =>
            `${negative ? "-" : ""}${w}${scale ? `.${String(d).padStart(scale, "0")}` : ""}`,
        );
    const line = fc.record(
      {
        code,
        ref,
        qty: fc.integer({ min: -999, max: 9999 }),
        amount: fc.oneof(decimal(4, 0), decimal(3, 2), decimal(2, 4)),
        price: decimal(3, 2),
      },
      { requiredKeys: [] },
    );
    const document = fc.record({
      number: fc.stringMatching(/^[A-Z][A-Z0-9]{0,5}$/),
      lines: fc.array(line, { minLength: 1, maxLength: 4 }),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(document, { selector: (d) => d.number, minLength: 1, maxLength: 3 }),
        (documents) => {
          const format = simple({ encoding: "windows-1252", lineEnding: "crlf" });
          const files = Object.fromEntries(
            renderFixedWidth(format, documents).map((file) => [file.name, file.bytes]),
          );
          expect(readFixedWidth(format, files)).toEqual(documents);
        },
      ),
      { numRuns: 300 },
    );
  });

  it.each([
    [
      "D1    AB   0007\n",
      "file f.txt, line 1, character 16, byte 15, record line: is 15 characters long, record type line is 35",
    ],
    [
      "D1    AB   0007-0012    -3,5-000005X\n",
      "line 1, character 36, byte 35, record line: is 36 characters long",
    ],
    [
      "D1    AB   0007-0012    -3.5-000005\n",
      'character 21, byte 20, record line, column AMOUNT: "-3.5" is not a decimal number with "," as decimal mark',
    ],
    [
      "D1    AB   0007-0012    -3,5-0000,5\n",
      'character 29, byte 28, record line, column PRICE: "-0000,5" is not a number written with implied decimals',
    ],
    ["D1    AB   0007-00x2    -3,5-000005\n", 'column QTY: "-x2" is not a whole number'],
    ["\n", "file f.txt, line 1, character 1, byte 0: is empty"],
    [
      "D1    AB   0007-0012    -3,5-000005\rD2\n",
      "line 1, character 36, byte 35: a carriage return not followed by a line feed",
    ],
  ])("refuses %j with a positioned error", (content, message) => {
    expect(fail(() => readFixedWidth(simple(), { "f.txt": bytes(content) }))).toContain(message);
  });

  it("tells record types apart and counts characters, not bytes", () => {
    const format = example();
    const read = (content: string) => () =>
      readFixedWidth(format, { "ORDERS.TXT": bytes(content) });
    expect(fail(read("03xx\r\n"))).toBe(
      'file ORDERS.TXT, line 1, character 1, byte 0: matches no record type: expected "01" at character 1 for header, or "02" at character 1 for line',
    );
    expect(fail(read(`020001${" ".repeat(66)}\r\n`))).toContain("comes before any header record");
    const utf8 = simple();
    const document = { number: "É", lines: [{ code: "été", qty: 5 }] };
    const [file] = renderFixedWidth(utf8, [document]);
    const written = text(file?.bytes ?? new Uint8Array());
    expect(readFixedWidth(utf8, { "f.txt": file?.bytes ?? new Uint8Array() })).toEqual([document]);
    expect(
      fail(() => readFixedWidth(utf8, { "f.txt": bytes(written.replace("00005", "000x5")) })),
    ).toBe(
      'file f.txt, line 1, character 16, byte 18, record line, column QTY: "x5" is not a whole number between -9007199254740991 and 9007199254740991',
    );
  });
});

describe("loadFixedWidthFormat", () => {
  it("refuses what cannot be read back", () => {
    const problems = (column: object) => {
      try {
        loadFixedWidthFormat({
          formatVersion: 1,
          format: "fixed-width",
          files: [
            {
              name: "f",
              records: [
                { name: "l", source: "lines", columns: [{ name: "A", width: 3, ...column }] },
              ],
            },
          ],
        });
      } catch (error) {
        if (error instanceof LayoutError)
          return error.problems.map((p) => `${p.path} ${p.message}`);
      }
      return [];
    };
    const at = "/files/0/records/0/columns/0";
    expect(problems({ field: "a", pad: "*" })).toEqual([
      `${at}/pad a pad other than a space needs align: right`,
    ]);
    expect(problems({ field: "a", type: "decimal", impliedDecimals: true })).toEqual([
      `${at}/impliedDecimals needs a decimal column with a scale`,
    ]);
    expect(problems({ field: "a", type: "integer", overflow: "truncate" })).toEqual([
      `${at}/overflow only a string field can be truncated`,
    ]);
    expect(problems({ value: "ABCD" })).toEqual([`${at}/value is longer than the width, 3`]);
    expect(problems({ field: "a" })).toEqual([]);
    expect(problems({ field: "a", width: 0 })).toEqual([`${at}/width must be >= 1`]);
    expect(problems({ field: "a", separator: ";" })).toEqual([
      `${at} must NOT have unevaluated properties`,
    ]);
  });
});
