import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type ElementData,
  type InterchangeData,
  interchangeData,
  parseInterchanges,
  type SegmentData,
  serialize,
  serializeData,
  type ValueData,
} from "./index.ts";
import {
  buildInterchange,
  type ElementSpec,
  type InterchangeSpec,
  interchangeArbitrary,
  syntax4WithoutUnaArbitrary,
} from "./testing/writer.ts";

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

describe("a parsed tree is written as it was read", () => {
  it("whatever the service characters, the line breaks and what the values hold", () => {
    fc.assert(
      fc.property(
        fc.oneof(interchangeArbitrary, syntax4WithoutUnaArbitrary),
        fc.constantFrom("", "\n", "\r\n", "\r", "\n\n"),
        fc.boolean(),
        (spec, between, bom) => {
          // One or two interchanges, with line breaks around and between them.
          const one = buildInterchange(spec).bytes;
          const parts: Uint8Array[] = [];
          if (bom) {
            parts.push(Uint8Array.of(0xef, 0xbb, 0xbf));
          }
          parts.push(Buffer.from(between), one, Buffer.from(between), one, Buffer.from(between));
          const bytes = Buffer.concat(parts);
          const result = parseInterchanges(new Uint8Array(bytes));
          expect(same(serialize(result), bytes)).toBe(true);
          for (const interchange of result.interchanges) {
            expect(
              same(serialize(interchange), bytes.subarray(interchange.start, interchange.end)),
            ).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

/** The data that writes the same bytes as the oracle of the tests. */
function dataOf(spec: InterchangeSpec, lineBreak: string): InterchangeData {
  const element = (repetitions: ElementSpec): ElementData =>
    repetitions.length > 1 ? { repetitions } : (repetitions[0] ?? []);
  return {
    separators: spec.separators,
    characterSet: "UNOC",
    una: spec.declareUna,
    lineBreak,
    segments: spec.segments.map(
      (segment): SegmentData => ({ tag: segment.tag, elements: segment.elements.map(element) }),
    ),
  };
}

describe("serializeData against the independent writer of the tests", () => {
  it("writes the bytes that the model says: UNA string, escapes, repetitions, line breaks", () => {
    fc.assert(
      fc.property(
        fc.oneof(interchangeArbitrary, syntax4WithoutUnaArbitrary),
        fc.constantFrom("", "\n", "\r\n", "\r\r"),
        (spec, lineBreak) => {
          const expected = buildInterchange({ ...spec, breaks: [lineBreak] }).bytes;
          const out = serializeData(dataOf(spec, lineBreak), { checkCharacters: false });
          expect(same(out, expected)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("is read back as the same data, and written again as the same bytes", () => {
    fc.assert(
      fc.property(
        fc.oneof(interchangeArbitrary, syntax4WithoutUnaArbitrary),
        fc.constantFrom("", "\n", "\r\n"),
        (spec, lineBreak) => {
          const data = dataOf(spec, lineBreak);
          const bytes = serializeData(data, { checkCharacters: false });
          const [interchange] = parseInterchanges(bytes).interchanges;
          if (interchange === undefined) {
            throw new Error("no interchange");
          }
          const back = interchangeData(interchange, { values: "bytes" });
          expect(back.una).toBe(spec.declareUna);
          expect(back.separators).toMatchObject({
            component: spec.separators.component,
            element: spec.separators.element,
            release: spec.separators.release,
            terminator: spec.separators.terminator,
            repetition: spec.separators.repetition,
          });
          expect(back.segments.map((segment) => segment.tag)).toEqual(
            spec.segments.map((segment) => segment.tag),
          );
          expect(same(serializeData(back, { checkCharacters: false }), bytes)).toBe(true);
          expect(same(serialize(parseInterchanges(bytes)), bytes)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// --- Text ---------------------------------------------------------------------------------

const unitsOf = (...ranges: [number, number][]) =>
  fc
    .oneof(...ranges.map(([min, max]) => fc.integer({ min, max })))
    .map((code) => String.fromCodePoint(code));

const text = (unit: fc.Arbitrary<string>) => fc.string({ unit, maxLength: 12 });

/** Text of each character set, with all the characters that set allows in data. */
const TEXTS = {
  UNOA: text(
    unitsOf(
      [0x41, 0x5a],
      [0x30, 0x39],
      [0x20, 0x20],
      [0x2b, 0x2b],
      [0x27, 0x27],
      [0x3a, 0x3a],
      [0x3f, 0x3f],
      [0x2a, 0x2a],
    ),
  ),
  UNOB: text(unitsOf([0x20, 0x7e])),
  UNOC: text(unitsOf([0x20, 0x7e], [0xa0, 0xff])),
  UNOW: text(unitsOf([0x20, 0x7e], [0xa0, 0xd7ff], [0xe000, 0xfffd], [0x10000, 0x10ffff])),
} as const;

describe("text is encoded for the character set and read back as the same text", () => {
  it.each(["UNOA", "UNOB", "UNOC", "UNOW"] as const)("%s", (set) => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.array(TEXTS[set], { minLength: 1, maxLength: 3 }), {
            minLength: 1,
            maxLength: 3,
          }),
          { minLength: 1, maxLength: 4 },
        ),
        fc.boolean(),
        (elements, withUna) => {
          const separatorsAreOurs = withUna;
          const data: InterchangeData = {
            characterSet: set,
            una: separatorsAreOurs,
            separators: { ...syntax4Separators(), declared: separatorsAreOurs },
            segments: [
              { tag: "UNB", elements: [[set, "4"]] },
              {
                tag: "FTX",
                elements: elements.map((repetitions) =>
                  repetitions.length > 1 ? { repetitions } : (repetitions[0] as ValueData[]),
                ),
              },
            ],
          };
          const bytes = serializeData(data);
          const result = parseInterchanges(bytes);
          expect(result.issues).toEqual([]);
          const [interchange] = result.interchanges;
          const back = interchange === undefined ? undefined : interchangeData(interchange);
          expect(back?.segments[1]?.elements).toEqual(
            elements.map((repetitions) =>
              repetitions.length > 1
                ? { repetitions: repetitions.map(trimEmpty) }
                : trimEmpty(repetitions[0] as string[]),
            ),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

/** A repetition whose only component is empty holds no component at all once it is read. */
function trimEmpty(components: string[]): string[] {
  return components.length === 1 && components[0] === "" ? [] : components;
}

function syntax4Separators() {
  return {
    component: 0x3a,
    element: 0x2b,
    decimalMark: 0x2e,
    release: 0x3f,
    repetition: 0x2a,
    terminator: 0x27,
  };
}
