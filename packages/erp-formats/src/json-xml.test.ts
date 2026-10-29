import { describe, expect, it } from "vitest";
import { loadJsonFormat, renderJson } from "./json.ts";
import { CANONICAL_EXAMPLES, canonicalExample, formatExample, text } from "./test-support.ts";
import { loadXmlFormat, renderXml } from "./xml.ts";

const json = (overrides: object = {}) =>
  loadJsonFormat({ formatVersion: 1, format: "json", ...overrides });
const xml = (overrides: object = {}) =>
  loadXmlFormat({ formatVersion: 1, format: "xml", root: "Doc", ...overrides });

describe("renderJson", () => {
  it.each(CANONICAL_EXAMPLES)("writes the canonical %s as it is", (name) => {
    const document = canonicalExample(name);
    const written = text(renderJson(json(), [document]));
    expect(written).toBe(`${JSON.stringify(document, null, 2)}\n`);
    expect(JSON.parse(written)).toEqual(document);
  });

  it("writes JSON Lines, arrays, CRLF and a byte order mark", () => {
    const documents = CANONICAL_EXAMPLES.map(canonicalExample);
    const lines = text(renderJson(loadJsonFormat(formatExample("order.json.yaml")), documents));
    expect(
      lines
        .split("\n")
        .slice(0, -1)
        .map((line) => JSON.parse(line)),
    ).toEqual(documents);
    expect(text(renderJson(json({ layout: "array", indent: 0 }), [{ a: "1" }, { b: [] }]))).toBe(
      '[{"a":"1"},{"b":[]}]\n',
    );
    expect(text(renderJson(json({ indent: 1, lineEnding: "crlf" }), [{ a: "x\ny" }]))).toBe(
      '{\r\n "a": "x\\ny"\r\n}\r\n',
    );
    expect([...renderJson(json({ bom: true }), [{}]).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("refuses what JSON would drop or change", () => {
    const render =
      (document: unknown, format = json()) =>
      () =>
        renderJson(format, [document]);
    expect(render({ lines: [{ price: Number.NaN }] })).toThrow(
      "document 1, lines[0].price: NaN cannot be written",
    );
    expect(render({ a: undefined })).toThrow("document 1, a: is undefined, which JSON cannot hold");
    expect(render({ a: new Date(0) })).toThrow("a: is not a plain object");
    expect(() => renderJson(json(), [{}, {}])).toThrow("one document per file, not 2");
    const holes = new Array<number>(3); // item 1 is a hole, which JSON.stringify writes as null
    holes[0] = 1;
    holes[2] = 3;
    expect(render({ a: holes })).toThrow("document 1, a: has no item 1");
    expect(render({ a: -0 })).toThrow("a: 0 cannot be written in JSON");
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(render(cycle)).toThrow("document 1, self: contains itself");
  });
});

describe("renderXml", () => {
  it("writes a small document exactly", () => {
    const format = xml({
      names: { lines: "Lines", note: "Note" },
      items: { lines: "Line" },
      attributes: ["n"],
      namespace: "urn:example",
    });
    const document = {
      number: "A&B <1>",
      lines: [{ n: 1, note: 'say "hi"' }, { n: 2 }],
      empty: {},
      tags: ["x", "y"],
      ok: true,
    };
    expect(text(renderXml(format, [document]))).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Doc xmlns="urn:example">',
        "  <number>A&amp;B &lt;1&gt;</number>",
        "  <Lines>",
        '    <Line n="1">',
        '      <Note>say "hi"</Note>',
        "    </Line>",
        '    <Line n="2"/>',
        "  </Lines>",
        "  <empty/>",
        "  <tags>x</tags>",
        "  <tags>y</tags>",
        "  <ok>true</ok>",
        "</Doc>",
        "",
      ].join("\n"),
    );
    expect(
      text(renderXml(xml({ indent: 0, declaration: false }), [{ a: "1", b: { c: "2" } }])),
    ).toBe("<Doc><a>1</a><b><c>2</c></b></Doc>\n");
  });

  it.each(CANONICAL_EXAMPLES)("writes the canonical %s with the example format", (name) => {
    const format = loadXmlFormat(formatExample("orders.xml.yaml"));
    const written = renderXml(format, [canonicalExample(name)]);
    const content = text(written, "iso-8859-1");
    expect(
      content.startsWith(
        '<?xml version="1.0" encoding="ISO-8859-1"?>\r\n<Orders xmlns="urn:example:erp:orders">\r\n  <Order>\r\n',
      ),
    ).toBe(true);
    expect(content.endsWith("  </Order>\r\n</Orders>\r\n")).toBe(true);
    // Every start tag is closed, in order.
    const open: string[] = [];
    for (const [, close, tag, selfClosing] of content.matchAll(
      /<(\/?)([A-Za-z_][\w.-]*)[^>]*?(\/?)>/g,
    )) {
      if (selfClosing) continue;
      if (close) expect(open.pop()).toBe(tag);
      else open.push(tag as string);
    }
    expect(open).toEqual([]);
  });

  it("writes the order example as the ERP expects it", () => {
    const format = loadXmlFormat(formatExample("orders.xml.yaml"));
    const content = text(renderXml(format, [canonicalExample("order")]), "iso-8859-1");
    expect(content).toContain(
      [
        '      <Line number="1">',
        "        <Product>",
        "          <Gtin>9520000010010</Gtin>",
        "          <SupplierItem>SUP-001</SupplierItem>",
        "          <Description>SAMPLE BISCUITS 200G</Description>",
        "        </Product>",
        "        <Quantity>",
        "          <Value>12</Value>",
        "          <Unit>PCE</Unit>",
        "        </Quantity>",
        "        <UnitPrice>",
        "          <Amount>1.00</Amount>",
        "        </UnitPrice>",
        "      </Line>",
      ].join("\r\n"),
    );
    expect(content).toContain("<References>\r\n      <Reference>\r\n        <Type>contract</Type>");
  });

  it("writes what the encoding lacks as character references", () => {
    const format = xml({ encoding: "windows-1252", indent: 0, declaration: true });
    const written = renderXml(format, [{ a: "€ é Ω 😀", b: { c: "x\ty\nz" } }]);
    expect(text(written, "windows-1252")).toBe(
      '<?xml version="1.0" encoding="windows-1252"?>\n<Doc><a>€ é &#x3A9; &#x1F600;</a><b><c>x\ty\nz</c></b></Doc>\n',
    );
    expect(written.includes(0x80)).toBe(true);
    const attribute = xml({ attributes: ["c"], indent: 0, declaration: false });
    expect(text(renderXml(attribute, [{ c: 'x\ty\n"z"' }]))).toBe(
      '<Doc c="x&#x9;y&#xA;&quot;z&quot;"/>\n',
    );
  });

  it("refuses what XML cannot hold, saying where", () => {
    const render =
      (document: unknown, format = xml()) =>
      () =>
        renderXml(format, [document]);
    expect(render({ a: "\u0001" })).toThrow(
      "document 1, a: holds U+0001, which XML 1.0 does not allow",
    );
    expect(render({ a: "\uD800" })).toThrow("holds U+D800");
    expect(render({ "order-number": "1", "1st": "x" })).toThrow(
      'document 1, 1st: "1st" is not an XML name',
    );
    expect(render({ a: null })).toThrow("a: is null");
    expect(render({ a: [[1]] })).toThrow("a[0]: is an array inside an array");
    expect(render({ c: { d: 1 } }, xml({ attributes: ["c"] }))).toThrow(
      "c: is an attribute, so it must be",
    );
    expect(() => renderXml(xml(), [{}, {}])).toThrow(
      "without a wrapper element, an XML file holds one document, not 2",
    );
    expect(text(renderXml(xml({ wrapper: "All", declaration: false }), []))).toBe("<All/>\n");
    const twice = xml({ attributes: ["a", "b"], names: { a: "x", b: "x" } });
    expect(render({ a: "1", b: "2" }, twice)).toThrow(
      "document 1, b: would be a second attribute named x",
    );
    expect(render({ xmlns: "2" }, xml({ attributes: ["xmlns"], namespace: "urn:x" }))).toThrow(
      "would be a second attribute named xmlns",
    );
    expect(render({ a: 1e21 })).toThrow("a: 1e+21 would not be written as a plain decimal number");
    expect(render({ a: 0.0000001 })).toThrow("1e-7 would not be written");
  });
});
