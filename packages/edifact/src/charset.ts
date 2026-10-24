import { describeByte } from "./errors.ts";
import type { Separators } from "./separators.ts";

/**
 * The character sets Libredi reads: the four of the roadmap. The identifier is the first
 * component of S001 in UNB. All four keep the service characters in the ASCII range, so the
 * tokenizer can split the bytes before anything is known about the set.
 */
export type CharacterSet = "UNOA" | "UNOB" | "UNOC" | "UNOW";

const SETS: ReadonlySet<string> = new Set(["UNOA", "UNOB", "UNOC", "UNOW"]);

/**
 * The set named by the bytes `start` to `end`, read as ISO 646 (plain ASCII), which is how the
 * start of UNB is always written whatever the set; null for a name Libredi does not support.
 */
export function characterSetOf(bytes: Uint8Array, start: number, end: number): CharacterSet | null {
  if (end - start !== 4) {
    return null;
  }
  const name = String.fromCharCode(
    bytes[start] as number,
    bytes[start + 1] as number,
    bytes[start + 2] as number,
    bytes[start + 3] as number,
  );
  return SETS.has(name) ? (name as CharacterSet) : null;
}

// --- What is valid ----------------------------------------------------------------------------

/** Level A of ISO 9735: capital letters, digits, space and these marks (`'+:?` are service marks). */
const UNOA_MARKS = " .,-()/=!\"%&*;<>'+:?";

function baseTable(set: CharacterSet): Uint8Array {
  const table = new Uint8Array(256);
  if (set === "UNOA") {
    for (const mark of UNOA_MARKS) {
      table[mark.charCodeAt(0)] = 1;
    }
    table.fill(1, 0x30, 0x3a);
    table.fill(1, 0x41, 0x5b);
    return table;
  }
  table.fill(1, 0x20, 0x7f); // printable ISO 646: UNOB, and the ASCII part of UNOC and UNOW
  if (set === "UNOC") {
    table.fill(1, 0xa0, 0x100); // the rest of ISO 8859-1, without the C1 controls 0x80 to 0x9F
  }
  return table;
}

const TABLES = new Map<CharacterSet, WeakMap<Separators, Uint8Array>>();

/** One table per set and per set of separators: 1 for a byte that may appear in data. */
function validBytes(set: CharacterSet, separators: Separators): Uint8Array {
  let bySeparators = TABLES.get(set);
  if (bySeparators === undefined) {
    bySeparators = new WeakMap();
    TABLES.set(set, bySeparators);
  }
  let table = bySeparators.get(separators);
  if (table === undefined) {
    table = baseTable(set);
    // The service characters of the interchange are always allowed: released, they are data.
    for (const byte of [
      separators.component,
      separators.element,
      separators.decimalMark,
      separators.release,
      separators.repetition,
      separators.terminator,
    ]) {
      if (byte !== null) {
        table[byte] = 1;
      }
    }
    bySeparators.set(separators, table);
  }
  return table;
}

/**
 * Length of the well-formed UTF-8 character at `at` (1 to 4) that may appear in data, or 0 when
 * the bytes there are not one: ill-formed (overlong, surrogate, above U+10FFFF, cut short at
 * `end`) or a C1 control character.
 */
function utf8Length(bytes: Uint8Array, at: number, end: number): number {
  const lead = bytes[at] as number;
  if (lead < 0xc2 || lead > 0xf4) {
    return 0;
  }
  const length = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  if (at + length > end) {
    return 0;
  }
  const second = bytes[at + 1] as number;
  // The second byte is the one with the extra rules that rule out overlong forms and surrogates.
  const low = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80;
  const high = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf;
  if (second < low || second > high) {
    return 0;
  }
  if (lead === 0xc2 && second < 0xa0) {
    return 0; // U+0080 to U+009F
  }
  for (let i = 2; i < length; i++) {
    const next = bytes[at + i] as number;
    if (next < 0x80 || next > 0xbf) {
      return 0;
    }
  }
  return length;
}

/**
 * Checks values against a character set, for one interchange: the table of valid bytes is made
 * once, so a check costs a loop over the value and nothing else.
 */
export class CharacterChecker {
  readonly set: CharacterSet;
  readonly #valid: Uint8Array;

  constructor(set: CharacterSet, separators: Separators) {
    this.set = set;
    this.#valid = validBytes(set, separators);
  }

  /**
   * Offset of the first byte in `start` to `end` that the set does not allow in data, or -1. For
   * UNOW it is the first byte of the ill-formed sequence. Control characters (C0, DEL and, in
   * UNOC and UNOW, C1) are never allowed: a line break inside a value is an error here. The
   * separators of the interchange are allowed whatever the set.
   */
  find(bytes: Uint8Array, start: number, end: number): number {
    const valid = this.#valid;
    if (this.set !== "UNOW") {
      for (let i = start; i < end; i++) {
        if (valid[bytes[i] as number] === 0) {
          return i;
        }
      }
      return -1;
    }
    let i = start;
    while (i < end) {
      const byte = bytes[i] as number;
      if (byte < 0x80) {
        if (valid[byte] === 0) {
          return i;
        }
        i++;
      } else {
        const length = utf8Length(bytes, i, end);
        if (length === 0) {
          return i;
        }
        i += length;
      }
    }
    return -1;
  }
}

/** {@link CharacterChecker.find} for a single value; use a checker for many. */
export function findInvalidCharacter(
  bytes: Uint8Array,
  start: number,
  end: number,
  set: CharacterSet,
  separators: Separators,
): number {
  return new CharacterChecker(set, separators).find(bytes, start, end);
}

const hexByte = (byte: number): string =>
  `byte 0x${byte.toString(16).toUpperCase().padStart(2, "0")}`;

/** Why the byte at `offset`, found by {@link findInvalidCharacter}, is not allowed, in plain words. */
export function explainInvalidCharacter(
  bytes: Uint8Array,
  offset: number,
  set: CharacterSet,
): string {
  const lead = bytes[offset] as number;
  if (set !== "UNOW" || lead < 0x80) {
    return `${describeByte(lead)} is not a character of ${set}`;
  }
  const hex = hexByte(lead);
  if (lead <= 0xbf) {
    return `${hex} is not the start of a UTF-8 character`;
  }
  if (lead < 0xc2 || lead > 0xf4) {
    return `the UTF-8 sequence that starts with ${hex} is not well formed`;
  }
  const length = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  for (let i = 1; i < length; i++) {
    const next = bytes[offset + i];
    if (next === undefined) {
      return `the UTF-8 sequence that starts with ${hex} is cut short`;
    }
    if (next < 0x80 || next > 0xbf) {
      return `${hexByte(next)} after lead ${hex} does not continue a UTF-8 sequence`;
    }
  }
  return lead === 0xc2
    ? `the UTF-8 sequence that starts with ${hex} is a control character`
    : `the UTF-8 sequence that starts with ${hex} is not well formed`;
}

// --- Decoding ---------------------------------------------------------------------------------

const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });
const CHUNK = 4096;

function latin1(bytes: Uint8Array, start: number, end: number): string {
  if (end - start <= CHUNK) {
    return String.fromCharCode(...bytes.subarray(start, end));
  }
  let text = "";
  for (let i = start; i < end; i += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + CHUNK)));
  }
  return text;
}

/**
 * The text of the bytes `start` to `end`, release characters already removed. UNOC and the
 * single-byte sets are read one byte per character (ISO 8859-1, a superset of ASCII); UNOW is
 * read as UTF-8, with U+FFFD in place of a broken sequence; a byte order mark that is part of
 * the text is kept. A null set (unknown or unsupported) is read as ISO 8859-1 so that no byte is
 * ever refused.
 */
export function decodeText(
  bytes: Uint8Array,
  start: number,
  end: number,
  set: CharacterSet | null,
): string {
  if (set === "UNOW") {
    return UTF8.decode(bytes.subarray(start, end));
  }
  return latin1(bytes, start, end);
}

// --- Encoding ---------------------------------------------------------------------------------

const UTF8_ENCODER = new TextEncoder();

/**
 * Index of the first character of `text` that `set` cannot hold, or -1: above U+00FF in UNOC,
 * above U+007F in UNOA and UNOB, a lone surrogate in UNOW. Whether the set also *allows* the
 * character in data (lowercase letters in UNOA, say) is the job of {@link CharacterChecker}.
 */
export function findUnencodable(text: string, set: CharacterSet): number {
  const limit = set === "UNOC" ? 0xff : set === "UNOW" ? 0x10ffff : 0x7f;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) {
      if (code > limit) {
        return i;
      }
    } else if (set !== "UNOW") {
      return i;
    } else if (
      code >= 0xdc00 ||
      !(text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff)
    ) {
      return i; // a low surrogate on its own, or a high one with no low one after it
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * The bytes of `text` in the set: one byte per character in UNOA, UNOB and UNOC, UTF-8 in UNOW.
 * The text must hold only characters that {@link findUnencodable} accepts.
 */
export function encodeText(text: string, set: CharacterSet): Uint8Array {
  if (set === "UNOW") {
    return UTF8_ENCODER.encode(text);
  }
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i);
  }
  return bytes;
}
