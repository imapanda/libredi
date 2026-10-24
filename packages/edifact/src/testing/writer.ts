import fc from "fast-check";
import { DEFAULT_SEPARATORS, type Separators, TokenKind } from "../index.ts";
import type { Token } from "./helpers.ts";

/*
 * A throwaway writer for the property tests. It builds an interchange from a model and knows,
 * byte by byte, which tokens the tokenizer must find. Serialization proper is issue #40: this is
 * the oracle of the tests, not a part of the package.
 */

export interface ExpectedToken extends Token {
  /** The original, unescaped bytes of a text token. */
  readonly value?: Uint8Array;
}

/** An element is a list of repetitions, each a list of components, each a run of bytes. */
export type ElementSpec = Uint8Array[][];

export interface SegmentSpec {
  readonly tag: string;
  readonly elements: ElementSpec[];
}

export interface InterchangeSpec {
  readonly separators: Separators;
  /** Whether the file starts with a UNA string; without one, `separators` must be the defaults. */
  readonly declareUna: boolean;
  readonly segments: SegmentSpec[];
  /** Line breaks written after the segments (and after UNA), in turn. */
  readonly breaks: string[];
}

export interface Built {
  readonly bytes: Uint8Array;
  readonly tokens: ExpectedToken[];
}

/** Escapes a value for the given separators; `escaped` tells whether a release was inserted. */
export function escapeValue(
  value: Uint8Array,
  separators: Separators,
): { bytes: number[]; escaped: boolean } {
  const special = new Set([
    separators.component,
    separators.element,
    separators.release,
    separators.terminator,
  ]);
  if (separators.repetition !== null) {
    special.add(separators.repetition);
  }
  const bytes: number[] = [];
  let escaped = false;
  for (const byte of value) {
    if (special.has(byte)) {
      bytes.push(separators.release);
      escaped = true;
    }
    bytes.push(byte);
  }
  return { bytes, escaped };
}

/** The nine bytes of the UNA string that declares `separators`. */
export function serviceStringOf(separators: Separators): number[] {
  return [
    0x55,
    0x4e,
    0x41,
    separators.component,
    separators.element,
    separators.decimalMark,
    separators.release,
    separators.repetition ?? 0x20,
    separators.terminator,
  ];
}

export function buildInterchange(spec: InterchangeSpec): Built {
  const { separators } = spec;
  const out: number[] = [];
  const tokens: ExpectedToken[] = [];
  let nextBreak = 0;

  const put = (kind: number, bytes: number[], value?: Uint8Array): void => {
    const start = out.length;
    out.push(...bytes);
    tokens.push(
      value === undefined
        ? { kind, start, end: out.length }
        : { kind, start, end: out.length, value },
    );
  };
  const lineBreak = (): void => {
    if (spec.breaks.length > 0) {
      for (const char of spec.breaks[nextBreak++ % spec.breaks.length] as string) {
        out.push(char.charCodeAt(0));
      }
    }
  };

  if (spec.declareUna) {
    put(TokenKind.ServiceStringAdvice, serviceStringOf(separators));
    lineBreak();
  }
  for (const segment of spec.segments) {
    put(TokenKind.SegmentTag, [...Buffer.from(segment.tag, "latin1")]);
    for (const element of segment.elements) {
      put(TokenKind.ElementSeparator, [separators.element]);
      element.forEach((repetition, r) => {
        if (r > 0) {
          put(TokenKind.RepetitionSeparator, [separators.repetition as number]);
        }
        repetition.forEach((component, c) => {
          if (c > 0) {
            put(TokenKind.ComponentSeparator, [separators.component]);
          }
          if (component.length > 0) {
            const { bytes, escaped } = escapeValue(component, separators);
            put(escaped ? TokenKind.EscapedText : TokenKind.Text, bytes, component);
          }
        });
      });
    }
    put(TokenKind.SegmentTerminator, [separators.terminator]);
    lineBreak();
  }
  return { bytes: Uint8Array.from(out), tokens };
}

const PUNCTUATION: number[] = [];
for (let byte = 0x21; byte <= 0x7e; byte++) {
  const isLetterOrDigit =
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a);
  if (!isLetterOrDigit) {
    PUNCTUATION.push(byte);
  }
}

/** Any legal set of service characters: distinct punctuation, a point or a comma as decimal mark. */
export const separatorsArbitrary: fc.Arbitrary<Separators> = fc
  .record({
    decimalMark: fc.constantFrom(0x2e, 0x2c),
    pool: fc.shuffledSubarray(PUNCTUATION, { minLength: 6, maxLength: 6 }),
    withRepetition: fc.boolean(),
  })
  .map(({ decimalMark, pool, withRepetition }) => {
    const [component, element, release, terminator, repetition] = pool.filter(
      (byte) => byte !== decimalMark,
    ) as [number, number, number, number, number];
    return {
      component,
      element,
      decimalMark,
      release,
      repetition: withRepetition ? repetition : null,
      terminator,
      declared: true,
    };
  });

/** Tags with no meaning for the tokenizer or the parser: not UNA, and none of the UN service tags. */
export const tagArbitrary = fc
  .stringMatching(/^[A-Z0-9]{3}$/)
  .filter((tag) => !["UNA", "UNB", "UNZ", "UNG", "UNE", "UNH", "UNT"].includes(tag));

/** Values of every byte, so that separators, release characters and line breaks all occur. */
const valueArbitrary = fc.uint8Array({ maxLength: 8 });

const breaksArbitrary = fc.array(fc.constantFrom("", "\n", "\r\n", "\r", "\n\n", "\r\n\r\n"), {
  maxLength: 3,
});

/** A whole interchange model: its separators (declared or default), segments and line breaks. */
export const interchangeArbitrary: fc.Arbitrary<InterchangeSpec> = fc
  .oneof(
    separatorsArbitrary.map((separators) => ({ separators, declareUna: true })),
    fc.constant({ separators: DEFAULT_SEPARATORS, declareUna: false }),
    fc.constant({ separators: { ...DEFAULT_SEPARATORS, declared: true }, declareUna: true }),
  )
  .chain(({ separators, declareUna }) => {
    const repetitions = separators.repetition === null ? 1 : 3;
    const element = fc.array(fc.array(valueArbitrary, { minLength: 1, maxLength: 3 }), {
      minLength: 1,
      maxLength: repetitions,
    });
    const segment = fc.record({ tag: tagArbitrary, elements: fc.array(element, { maxLength: 4 }) });
    return fc.record({
      separators: fc.constant(separators),
      declareUna: fc.constant(declareUna),
      segments: fc.array(segment, { minLength: 1, maxLength: 5 }),
      breaks: breaksArbitrary,
    });
  });

/** UNB announcing syntax version 4: what makes the asterisk the repetition separator without a UNA string. */
const unbOf = (identifier: string): SegmentSpec => ({
  tag: "UNB",
  elements: [[[Uint8Array.from(Buffer.from(identifier, "latin1")), Uint8Array.of(0x34)]]],
});

/**
 * Interchanges with no UNA string that announce syntax version 4 in their UNB: the asterisk is
 * the repetition separator, and elements are repeated with it.
 */
export const syntax4WithoutUnaArbitrary: fc.Arbitrary<InterchangeSpec> = fc
  .record({
    identifier: fc.stringMatching(/^[A-Z]{1,8}$/),
    segments: fc.array(
      fc.record({
        tag: tagArbitrary,
        elements: fc.array(
          fc.array(fc.array(valueArbitrary, { minLength: 1, maxLength: 3 }), {
            minLength: 1,
            maxLength: 3,
          }),
          { maxLength: 4 },
        ),
      }),
      { minLength: 1, maxLength: 5 },
    ),
    breaks: breaksArbitrary,
  })
  .map(({ identifier, segments, breaks }) => ({
    separators: { ...DEFAULT_SEPARATORS, repetition: 0x2a },
    declareUna: false,
    segments: [unbOf(identifier), ...segments],
    breaks,
  }));
