import { FormatError, type Position } from "./errors.ts";

export type TextEncoding = "utf-8" | "windows-1252" | "iso-8859-1";

/** Text decoded from a file, and how to find the byte of one of its characters. */
export interface DecodedText {
  text: string;
  /** Byte offset in the file of the UTF-16 index `index` of `text`. */
  offsetOf(index: number): number;
}

const BOM = [0xef, 0xbb, 0xbf];

// Windows-1252 differs from ISO-8859-1 between 0x80 and 0x9F only. Five of those bytes are not
// assigned; they are written here as U+FFFF and refused when read.
const CP1252_HIGH = [
  0x20ac, 0xffff, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0xffff, 0x017d, 0xffff, 0xffff, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xffff, 0x017e, 0x0178,
];
const CP1252_BYTES = new Map(CP1252_HIGH.map((code, index) => [code, 0x80 + index]));
CP1252_BYTES.delete(0xffff);

const hasBom = (bytes: Uint8Array) => BOM.every((byte, index) => bytes[index] === byte);

/** First byte at which `bytes` stops being valid UTF-8 (they are known not to be). */
function firstInvalidUtf8(bytes: Uint8Array): number {
  // A streaming decoder accepts every valid prefix, so the longest accepted prefix is found by
  // bisection, with a dozen passes instead of a hand-written UTF-8 validator.
  const accepts = (length: number) => {
    try {
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length), {
        stream: true,
      });
      return true;
    } catch {
      return false;
    }
  };
  if (accepts(bytes.length)) {
    // Only the end is cut, in the middle of a character: point at its first byte.
    let start = bytes.length - 1;
    while (start > 0 && ((bytes[start] as number) & 0xc0) === 0x80) start--;
    return start;
  }
  let good = 0; // longest prefix known to be accepted
  let bad = bytes.length; // shortest prefix known to be refused
  while (bad - good > 1) {
    const middle = Math.floor((good + bad) / 2);
    if (accepts(middle)) good = middle;
    else bad = middle;
  }
  // The decoder notices a broken sequence at the byte that breaks it: point at its first byte.
  for (let start = good - 1; start >= 0 && start >= good - 3; start--) {
    const byte = bytes[start] as number;
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return start + length > good ? start : good;
  }
  return good;
}

/** Decodes a whole file. Refuses, with its byte offset, any byte the encoding does not define. */
export function decode(bytes: Uint8Array, encoding: TextEncoding, file?: string): DecodedText {
  const where = (offset: number) => (file === undefined ? { offset } : { file, offset });
  if (encoding === "utf-8") {
    const start = hasBom(bytes) ? BOM.length : 0;
    const body = bytes.subarray(start);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      throw new FormatError("is not valid UTF-8", where(start + firstInvalidUtf8(body)));
    }
    // Positions are asked for in order, so each call counts only the bytes since the last one.
    let lastIndex = 0;
    let lastOffset = start;
    const offsetOf = (index: number) => {
      if (index < lastIndex) {
        lastIndex = 0;
        lastOffset = start;
      }
      lastOffset += Buffer.byteLength(text.slice(lastIndex, index), "utf8");
      lastIndex = index;
      return lastOffset;
    };
    return { text, offsetOf };
  }
  if (hasBom(bytes)) {
    throw new FormatError(
      `starts with a UTF-8 byte order mark, but the format says ${encoding}`,
      where(0),
    );
  }
  const codes = new Array<number>(bytes.length);
  for (let offset = 0; offset < bytes.length; offset++) {
    const byte = bytes[offset] as number;
    const code =
      encoding === "windows-1252" && byte >= 0x80 && byte < 0xa0
        ? (CP1252_HIGH[byte - 0x80] as number)
        : byte;
    if (code === 0xffff) {
      throw new FormatError(
        `byte 0x${byte.toString(16).toUpperCase()} is not a character in windows-1252`,
        where(offset),
      );
    }
    codes[offset] = code;
  }
  let text = "";
  for (let start = 0; start < codes.length; start += 8192) {
    text += String.fromCharCode(...codes.slice(start, start + 8192));
  }
  return { text, offsetOf: (index) => index };
}

/** Index of the first character of `text` that `encoding` cannot write, or -1. */
export function firstUnencodable(text: string, encoding: TextEncoding): number {
  if (encoding === "utf-8") {
    if (text.isWellFormed()) return -1;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 0xd800 || code > 0xdfff) continue;
      const next = text.charCodeAt(index + 1);
      if (code > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) return index;
      index++;
    }
    return -1;
  }
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (!encodableSingleByte(code, encoding)) return index;
  }
  return -1;
}

function encodableSingleByte(code: number, encoding: TextEncoding): boolean {
  if (encoding === "windows-1252") {
    return code < 0x80 || (code >= 0xa0 && code <= 0xff) || CP1252_BYTES.has(code);
  }
  return code <= 0xff;
}

/** A character as people read it in an error message: the character and its code point. */
export function describeCharacter(text: string, index: number): string {
  const code = text.codePointAt(index) ?? 0;
  const hex = code.toString(16).toUpperCase().padStart(4, "0");
  return code >= 0xd800 && code <= 0xdfff
    ? `U+${hex} (a lone surrogate)`
    : `"${String.fromCodePoint(code)}" (U+${hex})`;
}

/**
 * Refuses a file whose text starts with what a reader takes for a UTF-8 byte order mark: it
 * would strip it in UTF-8, and refuse the file in another encoding.
 */
export function refuseBomLike(text: string, encoding: TextEncoding, where: Position): void {
  if (text.startsWith(encoding === "utf-8" ? "\uFEFF" : "\u00EF\u00BB\u00BF")) {
    throw new FormatError(
      "the file would start with a byte order mark, which a reader drops",
      where,
    );
  }
}

/**
 * Encodes a whole file. Call `firstUnencodable` on each value first, to report a problem where it
 * is; this function only refuses, by index, what slipped through.
 */
export function encode(text: string, encoding: TextEncoding, bom = false): Uint8Array {
  const bad = firstUnencodable(text, encoding);
  if (bad >= 0) {
    throw new FormatError(`${describeCharacter(text, bad)} cannot be written in ${encoding}`);
  }
  if (encoding === "utf-8") {
    const body = new TextEncoder().encode(text);
    if (!bom) return body;
    const bytes = new Uint8Array(body.length + BOM.length);
    bytes.set(BOM);
    bytes.set(body, BOM.length);
    return bytes;
  }
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    bytes[index] = code < 0x80 || code > 0xff ? (CP1252_BYTES.get(code) ?? code) : code;
  }
  return bytes;
}
