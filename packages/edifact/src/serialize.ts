import {
  CharacterChecker,
  type CharacterSet,
  decodeText,
  encodeText,
  explainInvalidCharacter,
  findUnencodable,
} from "./charset.ts";
import { describeByte, SerializeError, SerializeErrorCode } from "./errors.ts";
import type { ParseResult } from "./parser.ts";
import {
  announcesSyntax4,
  DEFAULT_SEPARATORS,
  readServiceStringAdvice,
  type Separators,
  SYNTAX_4_SEPARATORS,
} from "./separators.ts";
import type { Component, Element, Envelope, Interchange, Message } from "./tree.ts";

/*
 * Writing EDIFACT: two ways, for two jobs.
 *
 * - `serialize` writes a tree that was parsed. Nothing in it has changed, so its bytes are the
 *   bytes it was read from: each node knows its span and the input is kept. Release characters,
 *   line breaks, a byte order mark, a missing UNA string, spaces that nobody would write today:
 *   all come back as they were, and it costs a copy.
 * - `serializeData` writes a tree that was built or edited, described as plain data
 *   ({@link InterchangeData}). It writes what the data says, with the service characters and the
 *   character set it is given: values are escaped with the release character, text is encoded
 *   for the set, and the UNA string says which characters were used. `interchangeData` turns a
 *   parsed tree into such data, to be edited and written again.
 *
 * Both are about representation. Neither knows what a segment means or whether an interchange
 * is valid; repetition is the one rule they apply, because the service characters decide it: an
 * element can only be repeated when there is a repetition separator (syntax version 4).
 */

/** One component: text, which is encoded for the character set, or bytes, which are written as they are. Not escaped. */
export type ValueData = string | Uint8Array;

/**
 * One data element: a single value, a list of components (a composite), or, with a repetition
 * separator, `{ repetitions }` with one list of components per repetition. Empty is `[]` or `""`.
 */
export type ElementData =
  | ValueData
  | readonly ValueData[]
  | { readonly repetitions: readonly (readonly ValueData[])[] };

export interface SegmentData {
  /** Three capital letters or digits. */
  readonly tag: string;
  /** The elements, the tag excluded. */
  readonly elements?: readonly ElementData[];
}

/** A whole interchange, as data. */
export interface InterchangeData {
  /** The segments in order, UNB and UNZ among them. */
  readonly segments: readonly SegmentData[];
  /**
   * The service characters (`declared` is not needed). Default: those that a reader assumes
   * without a UNA string, which are `UNA:+.? '` unless the UNB announces syntax version 4 in a way
   * that a reader sees (see the README), and then `UNA:+.?*'`.
   */
  readonly separators?: Omit<Separators, "declared"> & { readonly declared?: boolean };
  /**
   * The character set that text is encoded with and values are checked against. Default: the one
   * the UNB names (the first component of its first element), or UNOA when there is none.
   */
  readonly characterSet?: CharacterSet;
  /**
   * Whether to write the UNA string. Default true. Without one, the service characters must be
   * those that a reader assumes (see `separators`), or the file could not be read back.
   */
  readonly una?: boolean;
  /** CR and LF written after the UNA string and after every segment. Default: none. */
  readonly lineBreak?: string;
  /** Write a UTF-8 byte order mark first. Default false. */
  readonly bom?: boolean;
}

export interface SerializeOptions {
  /** Check text and bytes against the character set, as the parser does. Default true. */
  readonly checkCharacters?: boolean;
  /** Most bytes to write; more stops with `OUTPUT_TOO_LARGE`. Default 512 MiB. */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const SETS: readonly string[] = ["UNOA", "UNOB", "UNOC", "UNOW"];
const TAG = /^[A-Z0-9]{3}$/;
const UNA_TAG = "UNA";

// --- Writing a tree that was parsed -----------------------------------------------------------

/**
 * The bytes of a tree that was parsed, as they were read: a whole file with {@link ParseResult}
 * (byte order mark, line breaks between interchanges and at the end included), or one interchange,
 * message, or run of envelope segments, from its first byte to its last. Always a copy: the input
 * is not shared with the result.
 */
export function serialize(tree: ParseResult | Interchange | Message | Envelope): Uint8Array {
  if ("interchanges" in tree) {
    return new Uint8Array(tree.source);
  }
  const source = tree.kind === "interchange" ? tree.source : tree.interchange.source;
  return new Uint8Array(source.subarray(tree.start, tree.end));
}

// --- Parsed tree to data ----------------------------------------------------------------------

export interface InterchangeDataOptions {
  /** `text` (default) decodes values with the character set; `bytes` keeps them exactly. */
  readonly values?: "text" | "bytes";
}

const MAX_LINE_BREAK = 16;

function lineBreakAt(source: Uint8Array, offset: number): string {
  let end = offset;
  while (
    end < source.length &&
    end - offset < MAX_LINE_BREAK &&
    (source[end] === 0x0a || source[end] === 0x0d)
  ) {
    end++;
  }
  return String.fromCharCode(...source.subarray(offset, end));
}

/**
 * A parsed interchange as plain data, to edit and write with {@link serializeData}: the segments
 * with their values (release characters removed), and what is needed to write them as they were
 * found: the service characters, the character set, whether there was a UNA string or a byte
 * order mark, and the line break after the first line. A file that escapes more than it needs, or
 * mixes line breaks, is written with the escapes it needs and one line break: use
 * {@link serialize} for the file as it was. The result is a copy that shares nothing with the tree.
 */
export function interchangeData(
  interchange: Interchange,
  options: InterchangeDataOptions = {},
): InterchangeData {
  const read = options.values === "bytes" ? bytesOf : textOf;
  const segments = [...interchange.segments()];
  const source = interchange.source;
  // The line after the UNA string, or if that is not followed by a break, the line of the first segment.
  const afterUna = interchange.una === null ? "" : lineBreakAt(source, interchange.una.end);
  const lineBreak =
    afterUna !== "" || segments[0] === undefined ? afterUna : lineBreakAt(source, segments[0].end);
  return {
    segments: segments.map((segment) => ({
      tag: segment.tag,
      elements: segment.elements.map((element) => elementData(element, read)),
    })),
    separators: interchange.separators,
    // When the UNB names the set it stays out, so that an edited S001 is followed. Otherwise
    // (no UNB, or a set that is not supported) values were read as ISO 8859-1: so they are written.
    ...(interchange.characterSet === null ? { characterSet: "UNOC" as const } : {}),
    una: interchange.una !== null,
    lineBreak,
    bom: interchange.index === 0 && source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf,
  };
}

const textOf = (component: Component): ValueData => component.text();
const bytesOf = (component: Component): ValueData => component.bytes();

function elementData(element: Element, read: (component: Component) => ValueData): ElementData {
  const repetitions = element.repetitions;
  return repetitions.length > 1
    ? { repetitions: repetitions.map((components) => components.map(read)) }
    : (repetitions[0] ?? []).map(read);
}

// --- Data to bytes ----------------------------------------------------------------------------

type Where = SerializeError["position"];

function isList(element: ElementData): element is readonly ValueData[] {
  return Array.isArray(element);
}

function isValue(element: ElementData): element is ValueData {
  // Not `instanceof Uint8Array`, which a typed array from another realm is not.
  return typeof element === "string" || ArrayBuffer.isView(element);
}

/** The components of the first repetition of an element. */
function firstComponents(element: ElementData | undefined): readonly ValueData[] {
  if (element === undefined) {
    return [];
  }
  return isValue(element) ? [element] : isList(element) ? element : (element.repetitions[0] ?? []);
}

/** The text of the component `index` of the first repetition of an element, or null. */
function componentText(element: ElementData | undefined, index: number): string | null {
  const value = firstComponents(element)[index];
  if (value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : decodeText(value, 0, value.length, null);
}

const UTF8 = new TextEncoder();

/**
 * Whether a reader with no UNA string would take this segment for the UNB of syntax version 4,
 * which is what makes the asterisk the repetition separator: it asks the tokenizer's own test,
 * on the bytes the segment would have with the default characters, and not on the text of the
 * version alone (an identifier of more than 32 bytes, or a version that is not a whole component,
 * is not seen).
 */
function readerSeesSyntax4(unb: SegmentData | undefined): boolean {
  const components = firstComponents(unb?.elements?.[0]);
  if (unb === undefined || components.length < 2) {
    return false;
  }
  const { component, element, release, terminator } = DEFAULT_SEPARATORS;
  const bytes: number[] = [0x55, 0x4e, 0x42, element];
  for (let c = 0; c < 2; c++) {
    if (c > 0) {
      bytes.push(component);
    }
    const value = components[c] as ValueData;
    for (const byte of typeof value === "string" ? UTF8.encode(value) : (value as Uint8Array)) {
      if (byte === component || byte === element || byte === release || byte === terminator) {
        bytes.push(release);
      }
      bytes.push(byte);
    }
  }
  const following =
    components.length > 2 ? component : (unb.elements?.length ?? 0) > 1 ? element : terminator;
  bytes.push(following);
  return announcesSyntax4(Uint8Array.from(bytes), 0);
}

function characterSetOfData(data: InterchangeData, name: string | null): CharacterSet {
  if (data.characterSet !== undefined) {
    return data.characterSet;
  }
  return name !== null && SETS.includes(name) ? (name as CharacterSet) : "UNOA";
}

/** The nine bytes of the UNA string for these service characters. */
function serviceString(separators: Separators): Uint8Array {
  return Uint8Array.from([
    0x55,
    0x4e,
    0x41,
    separators.component,
    separators.element,
    separators.decimalMark,
    separators.release,
    separators.repetition ?? 0x20,
    separators.terminator,
  ]);
}

function sameCharacters(a: Separators, b: Separators): boolean {
  return (
    a.component === b.component &&
    a.element === b.element &&
    a.decimalMark === b.decimalMark &&
    a.release === b.release &&
    a.repetition === b.repetition &&
    a.terminator === b.terminator
  );
}

class Writer {
  bytes = new Uint8Array(1024);
  length = 0;
  readonly #separators: Separators;
  readonly #set: CharacterSet;
  readonly #checker: CharacterChecker | null;
  readonly #max: number;
  /** 1 for a byte that a value must not hold unreleased. */
  readonly #special = new Uint8Array(256);
  #where: Where = { segment: 0, tag: null, element: null, component: null };

  constructor(
    separators: Separators,
    set: CharacterSet,
    checker: CharacterChecker | null,
    max: number,
  ) {
    this.#separators = separators;
    this.#set = set;
    this.#checker = checker;
    this.#max = max;
    for (const byte of [
      separators.component,
      separators.element,
      separators.release,
      separators.terminator,
      separators.repetition,
    ]) {
      if (byte !== null) {
        this.#special[byte] = 1;
      }
    }
  }

  at(segment: number, tag: string | null, element: number | null, component: number | null): void {
    this.#where = { segment, tag, element, component };
  }

  error(code: SerializeErrorCode, detail: string): SerializeError {
    return new SerializeError(code, detail, this.#where);
  }

  /** Makes room for `extra` more bytes, never growing past what the limit allows unless it must. */
  #room(extra: number): void {
    const needed = this.length + extra;
    if (needed > this.bytes.length) {
      const doubled = Math.min(this.bytes.length * 2, this.#max);
      const grown = new Uint8Array(Math.max(needed, doubled));
      grown.set(this.bytes.subarray(0, this.length));
      this.bytes = grown;
    }
  }

  /** Stops when the output is over the limit. */
  checkSize(): void {
    this.#fits(0);
  }

  /** Stops, before anything is allocated, when `extra` more bytes would be over the limit. */
  #fits(extra: number): void {
    if (this.length + extra > this.#max) {
      throw this.error(
        SerializeErrorCode.OutputTooLarge,
        `The output is larger than maxBytes (${this.#max} bytes); raise maxBytes, or write the interchange in smaller parts`,
      );
    }
  }

  byte(value: number): void {
    this.#fits(1);
    this.#room(1);
    this.bytes[this.length++] = value;
  }

  raw(bytes: Uint8Array): void {
    this.#fits(bytes.length);
    this.#room(bytes.length);
    this.bytes.set(bytes, this.length);
    this.length += bytes.length;
  }

  ascii(text: string): void {
    this.#fits(text.length);
    this.#room(text.length);
    for (let i = 0; i < text.length; i++) {
      this.bytes[this.length++] = text.charCodeAt(i);
    }
  }

  /** One value: encoded if it is text, checked against the set, and released where it needs to be. */
  value(value: ValueData): void {
    let bytes: Uint8Array;
    if (typeof value === "string") {
      const bad = findUnencodable(value, this.#set);
      if (bad !== -1) {
        const code = value.codePointAt(bad) as number;
        throw this.error(
          SerializeErrorCode.InvalidCharacter,
          `The character U+${code.toString(16).toUpperCase().padStart(4, "0")} cannot be written in ${this.#set}`,
        );
      }
      bytes = encodeText(value, this.#set);
    } else {
      bytes = value;
    }
    if (this.#checker !== null) {
      const bad = this.#checker.find(bytes, 0, bytes.length);
      if (bad !== -1) {
        throw this.error(
          SerializeErrorCode.InvalidCharacter,
          `A value has a character that ${this.#set} does not allow: ${explainInvalidCharacter(bytes, bad, this.#set)}; use another character set, or checkCharacters: false`,
        );
      }
    }
    // At least as many bytes as the value has; twice as many if every one of them is released.
    this.#fits(bytes.length);
    this.#room(bytes.length * 2);
    const out = this.bytes;
    const special = this.#special;
    const release = this.#separators.release;
    let n = this.length;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i] as number;
      if (special[byte] === 1) {
        out[n++] = release;
      }
      out[n++] = byte;
    }
    this.length = n;
    this.checkSize();
  }
}

/**
 * Writes an interchange described as data: UNA string, segments, elements, components, with the
 * service characters and the character set of the data. Values are escaped with the release
 * character wherever they hold a service character; empty elements and components are written
 * as nothing between their separators, and nothing is left out or added. Throws a
 * {@link SerializeError} for a tag that is not valid, service characters that a tokenizer would
 * refuse, text that the character set cannot hold, or a repetition when there is no repetition
 * separator.
 */
export function serializeData(data: InterchangeData, options: SerializeOptions = {}): Uint8Array {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(`maxBytes must be a positive integer, not ${maxBytes}`);
  }
  const lineBreak = data.lineBreak ?? "";
  if (!/^[\r\n]*$/.test(lineBreak)) {
    throw new SerializeError(
      SerializeErrorCode.InvalidLineBreak,
      "The line break can only be made of CR and LF characters",
      { segment: 0, tag: null, element: null, component: null },
    );
  }

  const unb = data.segments[0]?.tag === "UNB" ? data.segments[0] : undefined;
  const announced = {
    set: componentText(unb?.elements?.[0], 0),
    version: componentText(unb?.elements?.[0], 1),
  };
  const implied = readerSeesSyntax4(unb) ? SYNTAX_4_SEPARATORS : DEFAULT_SEPARATORS;
  // Versions 1 to 3 have no repetition, whatever a UNA string says; a fragment with no UNB may.
  const syntaxRepeats = announced.version === null || announced.version === "4";
  const given = data.separators;
  const separators: Separators =
    given === undefined
      ? implied
      : typeof given.declared === "boolean"
        ? (given as Separators)
        : { ...given, declared: false };
  const set = characterSetOfData(data, announced.set);
  const writeUna = data.una ?? true;

  const chars = [
    separators.component,
    separators.element,
    separators.decimalMark,
    separators.release,
    separators.repetition ?? 0x20,
    separators.terminator,
  ];
  if (!chars.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0xff)) {
    throw new SerializeError(
      SerializeErrorCode.InvalidSeparators,
      "The service characters must be byte values, integers from 0 to 255",
      { segment: 0, tag: UNA_TAG, element: null, component: null },
    );
  }
  const probe = readServiceStringAdvice(serviceString(separators), 0);
  if (!probe.ok) {
    throw new SerializeError(
      SerializeErrorCode.InvalidSeparators,
      `The service characters cannot be written: ${probe.reason}`,
      { segment: 0, tag: UNA_TAG, element: null, component: null },
    );
  }
  if (!writeUna && !sameCharacters(separators, implied)) {
    throw new SerializeError(
      SerializeErrorCode.InvalidSeparators,
      `These service characters need a UNA string: without one, a reader assumes ${describeAssumed(implied)}`,
      { segment: 0, tag: UNA_TAG, element: null, component: null },
    );
  }

  const checker = options.checkCharacters === false ? null : new CharacterChecker(set, separators);
  const out = new Writer(separators, set, checker, maxBytes);
  if (data.bom === true) {
    out.raw(Uint8Array.of(0xef, 0xbb, 0xbf));
  }
  if (writeUna) {
    out.at(0, UNA_TAG, null, null);
    out.raw(serviceString(separators));
    out.ascii(lineBreak);
  }

  const { component, element: elementSeparator, repetition, terminator } = separators;
  for (let s = 0; s < data.segments.length; s++) {
    const segment = data.segments[s] as SegmentData;
    const number = s + 1;
    out.at(number, null, null, null);
    if (!TAG.test(segment.tag) || segment.tag === UNA_TAG) {
      throw out.error(
        SerializeErrorCode.InvalidTag,
        segment.tag === UNA_TAG
          ? "UNA is not a segment: the UNA string is written for you, unless una is false"
          : `${JSON.stringify(segment.tag.slice(0, 32))} is not a segment tag: a tag is three capital letters or digits`,
      );
    }
    out.at(number, segment.tag, null, null);
    out.ascii(segment.tag);
    const elements = segment.elements ?? [];
    for (let e = 0; e < elements.length; e++) {
      const content = elements[e] as ElementData;
      out.byte(elementSeparator);
      if (isValue(content) || isList(content)) {
        writeComponents(
          out,
          segment.tag,
          number,
          e + 1,
          isValue(content) ? [content] : content,
          component,
        );
        continue;
      }
      const repetitions = content.repetitions;
      for (let r = 0; r < repetitions.length; r++) {
        if (r > 0) {
          if (repetition === null || !syntaxRepeats) {
            out.at(number, segment.tag, e + 1, null);
            throw out.error(
              SerializeErrorCode.RepetitionNotAllowed,
              repetition === null
                ? "An element is repeated, and these service characters have no repetition separator: only syntax version 4 has one, in the UNA string"
                : `An element is repeated, and the UNB announces syntax version ${JSON.stringify((announced.version ?? "").slice(0, 32))}: only syntax version 4 allows repetition`,
            );
          }
          out.byte(repetition);
        }
        writeComponents(
          out,
          segment.tag,
          number,
          e + 1,
          repetitions[r] as readonly ValueData[],
          component,
        );
      }
    }
    out.byte(terminator);
    out.ascii(lineBreak);
    out.checkSize();
  }
  return out.bytes.slice(0, out.length);
}

function writeComponents(
  out: Writer,
  tag: string,
  segment: number,
  element: number,
  components: readonly ValueData[],
  separator: number,
): void {
  for (let c = 0; c < components.length; c++) {
    if (c > 0) {
      out.byte(separator);
    }
    out.at(segment, tag, element, c + 1);
    out.value(components[c] as ValueData);
  }
}

function describeAssumed(implied: Separators): string {
  const chars = [implied.component, implied.element, implied.decimalMark, implied.release]
    .concat(implied.repetition === null ? [] : [implied.repetition], [implied.terminator])
    .map(describeByte);
  return chars.join(" ");
}
