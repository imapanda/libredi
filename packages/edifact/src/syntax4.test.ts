import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_SEPARATORS, parseInterchanges, SYNTAX_4_SEPARATORS, serialize } from "./index.ts";
import { announcesSyntax4 } from "./separators.ts";
import { readSample, samples } from "./testing/corpus.ts";
import { bytesOf, show, tokenize } from "./testing/helpers.ts";
import { referenceTokenize } from "./testing/reference.ts";
import { treeToModel } from "./testing/segments.ts";
import { buildInterchange, syntax4WithoutUnaArbitrary } from "./testing/writer.ts";

const parse = (text: string) => {
  const [interchange] = parseInterchanges(bytesOf(text)).interchanges;
  if (interchange === undefined) {
    throw new Error("no interchange");
  }
  return interchange;
};

describe("syntax version 4 without a UNA string", () => {
  it("makes the asterisk the repetition separator from the first token on", () => {
    expect(show("UNB+UNOC:4+A*B:C'")).toEqual([
      "tag:UNB",
      "elem:+",
      "text:UNOC",
      "comp::",
      "text:4",
      "elem:+",
      "text:A",
      "rep:*",
      "text:B",
      "comp::",
      "text:C",
      "end:'",
    ]);
    const { batches } = tokenize("UNB+UNOC:4+A*B'");
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual({ ...DEFAULT_SEPARATORS, repetition: 0x2a });
    expect(batches[0]).toBe(SYNTAX_4_SEPARATORS);
  });

  it("keeps an escaped asterisk as data", () => {
    expect(show("UNB+UNOC:4+A?*B'").slice(5)).toEqual(["elem:+", "esc:A?*B", "end:'"]);
  });

  it.each([
    ["syntax version 3", "UNB+UNOC:3+A*B'"],
    ["no version at all", "UNB+UNOC+A*B'"],
    ["a version that only starts with 4", "UNB+UNOC:41+A*B'"],
    ["a version that only ends with 4", "UNB+UNOC:34+A*B'"],
    ["4 as the third component", "UNB+UNOC:3:4+A*B'"],
    ["4 as the second element", "UNB+UNOC+4+A*B'"],
    ["an identifier with a release character", "UNB+UN?:4+A*B'"],
    ["a 4 after the colon of the second element", "UNB+UNOC+X:4+A*B'"],
    ["an identifier of 33 bytes", `UNB+${"X".repeat(33)}:4+A*B'`],
    ["a UNB that is not the first segment", "UNH+1+X'UNB+UNOC:4+A*B'"],
    ["another segment than UNB", "UNH+UNOC:4+A*B'"],
  ])("leaves the asterisk as text for %s", (_name, text) => {
    expect(show(text)).not.toContain("rep:*");
    expect(tokenize(text).batches.every((set) => set.repetition === null)).toBe(true);
  });

  it("accepts an identifier of 32 bytes, and a version that ends the component in any way", () => {
    for (const text of [
      `UNB+${"X".repeat(32)}:4+A*B'`,
      "UNB+UNOC:4:5+A*B'",
      "UNB+UNOC:4'UNZ+0+1'A*B",
    ]) {
      expect(tokenize(text).batches[0]?.repetition).toBe(0x2a);
    }
    expect(show("UNB+UNOC:4+A*B'")).toContain("rep:*");
    expect(show(`\n\r\nUNB+UNOC:4+A*B'`)).toContain("rep:*");
  });

  it("is overridden by a UNA string, which says what applies", () => {
    expect(show("UNA:+.? 'UNB+UNOC:4+A*B'")).not.toContain("rep:*");
    expect(show("UNA:+.?*'UNB+UNOC:3+A*B'")).toContain("rep:*");
    expect(show("UNA:+.?|'UNB+UNOC:4+A*B|C'")).toContain("rep:|");
    expect(show("UNA:+.?|'UNB+UNOC:4+A*B|C'")).not.toContain("rep:*");
  });

  it("applies to one interchange: the next one starts again from its own announcement", () => {
    const text = "UNB+UNOC:4+A*B'UNZ+1+1'UNB+UNOC:3+A*B'UNZ+1+2'UNB+UNOC:4+C*D'UNZ+1+3'";
    const { batches } = tokenize(text);
    expect(batches.map((set) => set.repetition)).toEqual([0x2a, null, 0x2a]);
  });

  it("is decided at the first segment only, wherever the batches end", () => {
    // No UNZ between the two UNB: the second one cannot change the characters under the first,
    // even when it is the first token of a batch.
    for (const size of [2, 3, 4, 5, 6, 7, 8, 9, 10, 4096]) {
      expect(show("UNB+UNOC:3+A'UNB+UNOC:4+A*B'", size)).not.toContain("rep:*");
      expect(show("UNB+UNOC:4+A'UNB+UNOC:3+A*B'", size)).toContain("rep:*");
    }
  });

  it("does not depend on the size of the batches", () => {
    const text = "UNB+UNOC:4+A*B:C*D++E'FTX+AAI+++X*Y'UNZ+1+1'";
    for (const size of [2, 3, 5, 8, 4096]) {
      expect(show(text, size)).toEqual(show(text));
    }
    expect(tokenize(text, 2).batches.every((set) => set === SYNTAX_4_SEPARATORS)).toBe(true);
  });

  it.each([
    ["UNB+UNOC:4+A", true],
    ["UNB+UNOC:4:5+A", true],
    ["UNB+UNOC:4'", true],
    ["UNB+:4+A", true],
    ["UNB+UNOC:4", false], // the input ends before the component does
    ["UNB+UNOC:", false],
    ["UNB", false],
    ["UNB'", false],
    ["UNB+UNOC:44+A", false],
    ["UNB+UNOC:4X+A", false],
    ["UNB:UNOC:4+A", false],
    ["UNB+UNOC'XYZ:4+A", false], // the segment ends before the colon
    ["UNB+UNOC+XYZ:4+A", false], // the colon is in the second element
    ["UNB+UN?:4+A", false], // the colon is released
    ["UNB+UNOC?+X:4+A", false],
    [`UNB+${"X".repeat(32)}:4+A`, true],
    [`UNB+${"X".repeat(33)}:4+A`, false],
  ])("announcesSyntax4 reads %j as %s", (text, expected) => {
    expect(announcesSyntax4(bytesOf(text), 0)).toBe(expected);
    expect(announcesSyntax4(bytesOf(`XX\n${text}`), 3)).toBe(expected);
  });

  it("agrees with the plain second tokenizer on any start of UNB, whatever its identifier and version", () => {
    const piece = fc.constantFrom("A", "UNOC", "?", "+", "'", ":", "*", "4", "3", "?*", " ");
    fc.assert(
      fc.property(
        fc.array(piece, { maxLength: 8 }),
        fc.integer({ min: 0, max: 40 }),
        fc.constantFrom(":4+", ":4:", ":4'", ":43", ":3+", ":+4+", ""),
        fc.array(piece, { maxLength: 6 }),
        (head, padding, version, tail) => {
          const text = `UNB+${head.join("")}${"X".repeat(padding)}${version}${tail.join("")}A*B'UNZ+1+1'`;
          const bytes = bytesOf(text);
          const real = tokenize(bytes);
          const plain = referenceTokenize(bytes);
          expect(real.tokens).toEqual(plain.tokens);
          expect(real.error?.code ?? null).toBe(plain.error?.code ?? null);
          expect(real.separatorsOfToken.map((set) => set.repetition)).toEqual(
            plain.separatorsOfToken.map((set) => set.repetition),
          );
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("reads the same tokens as the plain second tokenizer, for any interchange of that kind", () => {
    fc.assert(
      fc.property(syntax4WithoutUnaArbitrary, (spec) => {
        const built = buildInterchange(spec);
        const { tokens, error, separatorsOfToken } = tokenize(built.bytes);
        expect(error).toBeNull();
        expect(tokens).toEqual(built.tokens.map(({ kind, start, end }) => ({ kind, start, end })));
        expect(separatorsOfToken.every((set) => set === SYNTAX_4_SEPARATORS)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe("syntax version 4 in the tree", () => {
  const ORDER =
    "UNB+UNOC:4+A+B+301015:0830+1'UNH+1+ORDERS:D:01B:UN'FTX+AAI+++ONE*TWO:2*'UNT+3+1'UNZ+1+1'";

  it("keeps the repetitions of an element, with the position of each component", () => {
    const interchange = parse(ORDER);
    expect(interchange.una).toBeNull();
    expect(interchange.syntaxVersion).toBe("4");
    expect(interchange.separators).toBe(SYNTAX_4_SEPARATORS);
    const ftx = [...interchange.segments()][2];
    const element = ftx?.element(4);
    expect(element?.repetitions.map((repetition) => repetition.map((c) => c.text()))).toEqual([
      ["ONE"],
      ["TWO", "2"],
      [],
    ]);
    expect(element?.components.map((c) => c.text())).toEqual(["ONE"]);
    const positions = element?.repetitions.flat().map((component) => component.position);
    expect(positions).toEqual([
      { segment: 3, tag: "FTX", element: 4, component: 1 },
      { segment: 3, tag: "FTX", element: 4, component: 1 },
      { segment: 3, tag: "FTX", element: 4, component: 2 },
    ]);
    expect(ftx?.text(4, 2)).toBeUndefined();
  });

  it("counts a repeated element once, as one element of the segment", () => {
    const ftx = [...parse(ORDER).segments()][2];
    expect(ftx?.elements).toHaveLength(4);
    expect(ftx?.elements.map((element) => element.position.element)).toEqual([1, 2, 3, 4]);
  });

  it("gives an empty list to an empty repetition, and counts the element once", () => {
    const ftx = [...parse("UNB+UNOC:4+A'FTX+A**B*'").segments()][1];
    expect(ftx?.elements).toHaveLength(1);
    expect(ftx?.elements[0]?.repetitions.map((r) => r.map((c) => c.text()))).toEqual([
      ["A"],
      [],
      ["B"],
      [],
    ]);
  });

  it("leaves UGH and UGT, which only version 4 has, as ordinary segments between messages", () => {
    const text = "UNB+UNOC:4+A'UGH+1+X'UNH+1+ORDERS'UNT+2+1'UGT+1'UNZ+1+1'";
    const interchange = parse(text);
    expect(
      interchange.items.map((item) => (item.kind === "segment" ? item.tag : item.kind)),
    ).toEqual(["UGH", "message", "UGT"]);
    expect(Buffer.from(serialize(interchange)).toString("latin1")).toBe(text);
  });

  it("represents what is written, whatever the version: the rule is the validator's", () => {
    // The registry allows repetition only under syntax version 4. A UNA string that declares an
    // asterisk under version 3 is tokenized and parsed as it says; saying that it is not
    // allowed is validation (#43 and after).
    const interchange = parse("UNA:+.?*'UNB+UNOC:3+A*B'");
    expect(interchange.syntaxVersion).toBe("3");
    const unb = [...interchange.segments()][0];
    expect(unb?.element(2)?.repetitions).toHaveLength(2);
  });

  it("is written back as it was read", () => {
    const bytes = bytesOf(`\n${ORDER}\n`);
    expect(Buffer.from(serialize(parseInterchanges(bytes))).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe("syntax version 4 samples", () => {
  const names = samples("valid").filter((name) => name.includes("-s4-"));

  it("are there", () => {
    expect(names.length).toBeGreaterThanOrEqual(5);
  });

  it.each(names)("%s: UNA declares the asterisk, which is also what version 4 assumes", (name) => {
    const bytes = readSample("valid", name);
    const interchange = parseInterchanges(bytes).interchanges[0];
    expect(interchange?.syntaxVersion).toBe("4");
    expect(interchange?.una?.text).toBe(":+.?*'");
    expect(interchange?.separators.repetition).toBe(0x2a);

    // Without its UNA string the file has the same segments, elements and repetitions.
    const withoutUna = bytes.subarray(10); // "UNA:+.?*'" and the line break
    const [stripped] = parseInterchanges(withoutUna).interchanges;
    expect(stripped?.una).toBeNull();
    expect(stripped?.separators).toBe(SYNTAX_4_SEPARATORS);
    if (stripped === undefined || interchange === undefined) {
      throw new Error("no interchange");
    }
    expect(treeToModel(stripped).segments).toEqual(treeToModel(interchange).segments);
    expect(
      Buffer.from(serialize(parseInterchanges(withoutUna))).equals(Buffer.from(withoutUna)),
    ).toBe(true);
  });

  it("orders-d01b-s4-unoc-repetition-separator: one element is repeated three times", () => {
    const interchange = parse(
      Buffer.from(readSample("valid", "orders-d01b-s4-unoc-repetition-separator")).toString(
        "latin1",
      ),
    );
    const ftx = [...interchange.segments()].find((segment) => segment.tag === "FTX");
    expect(
      ftx?.element(4)?.repetitions.map((repetition) => repetition.map((c) => c.text())),
    ).toEqual([["FIRST NOTE"], ["SECOND NOTE", "WITH TWO COMPONENTS"], ["LITERAL * STAR"]]);
  });
});
