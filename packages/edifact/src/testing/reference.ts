import { DEFAULT_SEPARATORS, type Separators, TokenKind } from "../index.ts";
import { readServiceStringAdvice } from "../separators.ts";
import type { Token } from "./helpers.ts";

/*
 * A deliberately simple second tokenizer, written from the rules in README.md and not from
 * src/tokenizer.ts: one byte at a time, no lookup table, no batches, no state machine. The
 * property tests feed both the same arbitrary bytes and require the same tokens and the same
 * error, which finds the cases that examples do not think of. It reuses only the reading of the
 * UNA string, which has tests of its own.
 */

export interface ReferenceError {
  readonly code: "INVALID_UNA" | "UNEXPECTED_END_OF_FILE" | "INVALID_SEGMENT_TAG";
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly segment: number;
  readonly tag: string | null;
}

export interface ReferenceResult {
  readonly tokens: Token[];
  readonly error: ReferenceError | null;
  /** The separators in force for each token, in order. */
  readonly separatorsOfToken: Separators[];
}

const isTagByte = (b: number): boolean => (b >= 65 && b <= 90) || (b >= 48 && b <= 57);

export function referenceTokenize(bytes: Uint8Array): ReferenceResult {
  const tokens: Token[] = [];
  const separatorsOfToken: Separators[] = [];
  let separators: Separators = DEFAULT_SEPARATORS;
  let pos = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  let segment = 0;

  const push = (kind: number, start: number, end: number): void => {
    tokens.push({ kind, start, end });
    separatorsOfToken.push(separators);
  };
  const fail = (
    code: ReferenceError["code"],
    offset: number,
    atSegment: number,
    tag: string | null,
  ): ReferenceResult => {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < offset; i++) {
      if (bytes[i] === 0x0a || (bytes[i] === 0x0d && bytes[i + 1] !== 0x0a)) {
        line++;
        lineStart = i + 1;
      }
    }
    const error = { code, offset, line, column: offset - lineStart + 1, segment: atSegment, tag };
    return { tokens, error, separatorsOfToken };
  };

  for (;;) {
    while (pos < bytes.length && (bytes[pos] === 0x0a || bytes[pos] === 0x0d)) {
      pos++;
    }
    if (pos >= bytes.length) {
      return { tokens, error: null, separatorsOfToken };
    }

    if (bytes[pos] === 0x55 && bytes[pos + 1] === 0x4e && bytes[pos + 2] === 0x41) {
      const advice = readServiceStringAdvice(bytes, pos);
      if (!advice.ok) {
        return fail(
          advice.truncated ? "UNEXPECTED_END_OF_FILE" : "INVALID_UNA",
          advice.offset,
          0,
          "UNA",
        );
      }
      separators = advice.separators;
      segment = 0;
      push(TokenKind.ServiceStringAdvice, pos, pos + 9);
      pos += 9;
      continue;
    }

    // The tag: three capital letters or digits.
    segment++;
    let tag = "";
    for (let i = 0; i < 3; i++) {
      const byte = bytes[pos + i];
      if (byte === undefined) {
        return fail("UNEXPECTED_END_OF_FILE", bytes.length, segment, tag === "" ? null : tag);
      }
      if (!isTagByte(byte)) {
        return fail("INVALID_SEGMENT_TAG", pos + i, segment, null);
      }
      tag += String.fromCharCode(byte);
    }
    const after = bytes[pos + 3];
    if (after === undefined) {
      return fail("UNEXPECTED_END_OF_FILE", bytes.length, segment, tag);
    }
    if (after !== separators.element && after !== separators.terminator) {
      return fail("INVALID_SEGMENT_TAG", pos + 3, segment, null);
    }
    if (segment === 1 && tag === "UNB" && !separators.declared) {
      // Without a UNA string, a UNB that announces syntax version 4 brings the asterisk as
      // repetition separator: `UNB+`, an identifier of up to 32 bytes with no service character
      // in it, `:4`, and then the end of the component.
      const head = Buffer.from(bytes.subarray(pos, pos + 39)).toString("latin1");
      if (/^UNB\+[^+:?']{0,32}:4[+:']/.test(head)) {
        separators = { ...DEFAULT_SEPARATORS, repetition: 0x2a };
      }
    }
    push(TokenKind.SegmentTag, pos, pos + 3);
    pos += 3;

    // The body, up to the segment terminator.
    let valueStart = pos;
    let escaped = false;
    for (;;) {
      const byte = bytes[pos];
      if (byte === undefined) {
        return fail("UNEXPECTED_END_OF_FILE", bytes.length, segment, tag);
      }
      if (byte === separators.release) {
        if (pos + 1 >= bytes.length) {
          return fail("UNEXPECTED_END_OF_FILE", bytes.length, segment, tag);
        }
        escaped = true;
        pos += 2;
        continue;
      }
      let kind: number | null = null;
      if (byte === separators.component) {
        kind = TokenKind.ComponentSeparator;
      } else if (byte === separators.element) {
        kind = TokenKind.ElementSeparator;
      } else if (separators.repetition !== null && byte === separators.repetition) {
        kind = TokenKind.RepetitionSeparator;
      } else if (byte === separators.terminator) {
        kind = TokenKind.SegmentTerminator;
      }
      if (kind === null) {
        pos++;
        continue;
      }
      if (pos > valueStart) {
        push(escaped ? TokenKind.EscapedText : TokenKind.Text, valueStart, pos);
      }
      push(kind, pos, pos + 1);
      pos++;
      valueStart = pos;
      escaped = false;
      if (kind === TokenKind.SegmentTerminator) {
        break;
      }
    }

    if (tag === "UNZ") {
      separators = DEFAULT_SEPARATORS;
      segment = 0;
    }
  }
}
