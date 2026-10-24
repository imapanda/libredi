import { describeByte, TokenizeError, TokenizeErrorCode } from "./errors.ts";
import { type LineColumn, LineIndex, scanLocate } from "./line-index.ts";
import {
  announcesSyntax4,
  DEFAULT_SEPARATORS,
  matchesServiceString,
  readServiceStringAdvice,
  SERVICE_STRING_LENGTH,
  type Separators,
  SYNTAX_4_SEPARATORS,
} from "./separators.ts";
import { type TokenBatch, TokenKind } from "./tokens.ts";

export interface TokenizerOptions {
  /** Tokens per batch, from 2 to 1,048,576. Default 4096: 36 KiB of arrays. */
  readonly batchSize?: number;
}

export const DEFAULT_BATCH_SIZE = 4096;
const MAX_BATCH_SIZE = 1 << 20;
/** Offsets are signed 32-bit integers: V8 reads those faster than unsigned ones (+3 to 5 %). */
const MAX_INPUT_LENGTH = 0x7fff_ffff;

// What the scanner knows about a byte: one lookup per byte of a value.
const DATA = 0;
const COMPONENT = 1;
const ELEMENT = 2;
const REPETITION = 3;
const TERMINATOR = 4;
const RELEASE = 5;

const AT_SEGMENT_START = 0;
const IN_SEGMENT = 1;
const FINISHED = 2;

const LF = 0x0a;
const CR = 0x0d;

/** The token that ends a run of text, by the class of the byte that ended it. */
const SEPARATOR_KIND = Uint8Array.of(
  0,
  TokenKind.ComponentSeparator,
  TokenKind.ElementSeparator,
  TokenKind.RepetitionSeparator,
  TokenKind.SegmentTerminator,
);

function classTable(separators: Separators): Uint8Array {
  const table = new Uint8Array(256);
  table[separators.component] = COMPONENT;
  table[separators.element] = ELEMENT;
  if (separators.repetition !== null) {
    table[separators.repetition] = REPETITION;
  }
  table[separators.terminator] = TERMINATOR;
  table[separators.release] = RELEASE;
  return table;
}

// One table per set of separators: a file that repeats its UNA string must not rebuild it.
const TABLES = new WeakMap<Separators, Uint8Array>();

function tableFor(separators: Separators): Uint8Array {
  let table = TABLES.get(separators);
  if (table === undefined) {
    table = classTable(separators);
    TABLES.set(separators, table);
  }
  return table;
}

const DEFAULT_TABLE = tableFor(DEFAULT_SEPARATORS);

/** A segment tag is made of capital letters and digits. */
function isTagByte(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x30 && byte <= 0x39);
}

class Batch implements TokenBatch {
  readonly kinds: Uint8Array;
  readonly starts: Int32Array;
  readonly ends: Int32Array;
  readonly capacity: number;
  length = 0;
  separators: Separators = DEFAULT_SEPARATORS;

  constructor(capacity: number) {
    this.capacity = capacity;
    // One allocation, not three: for a tokenizer per message it is most of the fixed cost.
    // The 4-byte views come first so that they stay aligned.
    const buffer = new ArrayBuffer(capacity * 9);
    this.starts = new Int32Array(buffer, 0, capacity);
    this.ends = new Int32Array(buffer, capacity * 4, capacity);
    this.kinds = new Uint8Array(buffer, capacity * 8, capacity);
  }
}

/**
 * Splits an EDIFACT file into tokens. Bytes in, tokens out: nothing is decoded, validated or
 * built into a tree, and the memory used does not depend on the size of the input.
 *
 * ```ts
 * for (const batch of new Tokenizer(bytes)) {
 *   for (let i = 0; i < batch.length; i++) {
 *     const kind = batch.kinds[i], start = batch.starts[i], end = batch.ends[i];
 *   }
 * }
 * ```
 *
 * What it does, following ISO 9735:
 *
 * - reads the UNA string, or uses the default service characters `:+.? '`, plus the asterisk as
 *   repetition separator when there is no UNA string and the UNB announces syntax version 4
 *   (`UNB+UNOC:4+...`), which is what that version assumes;
 * - honours the release character: a released byte is data, whatever it is;
 * - skips CR and LF between segments (and before the first one, after UNA, at the end);
 * - treats a UNA string anywhere between segments as the start of a new interchange, and goes
 *   back to the default characters after UNZ;
 * - stops with a {@link TokenizeError} on a bad UNA string, a bad segment tag, or a file that
 *   ends inside a segment. Everything before the error has been delivered by then; the error
 *   itself is thrown by the loop's next step, so a loop that stops early never sees it.
 *
 * What it leaves to others: reading values as text and checking them against the character set
 * (`charset.ts`), finding messages (`splitMessages`), and the meaning of segments and the
 * validation of the envelope and the data (issues #43 to #45).
 *
 * A tokenizer reads its input once and has one live loop at a time: all loops share one batch.
 * Iterating it again carries on where the last loop stopped (after the end, it yields nothing).
 * The input must not be modified, resized or detached while a loop is running.
 */
export class Tokenizer implements Iterable<TokenBatch> {
  readonly #bytes: Uint8Array;
  readonly #batch: Batch;
  #pos: number;
  #state = AT_SEGMENT_START;
  #separators: Separators = DEFAULT_SEPARATORS;
  #table: Uint8Array = DEFAULT_TABLE;
  /** Number of the segment being read in the current interchange; UNA is 0. */
  #segment = 0;
  #tagStart = 0;
  #isUnz = false;
  #resetPending = false;
  #iterating = false;
  #failure: TokenizeError | null = null;
  #lineIndex: LineIndex | null = null;

  constructor(bytes: Uint8Array, options: TokenizerOptions = {}) {
    // Checked by tag, not by `instanceof`, so that a Uint8Array from another realm passes and
    // an ArrayBuffer, a DataView or an Int8Array (no `length`, or the wrong values) does not.
    if (
      !ArrayBuffer.isView(bytes) ||
      Object.prototype.toString.call(bytes) !== "[object Uint8Array]"
    ) {
      throw new TypeError("bytes must be a Uint8Array (a Node.js Buffer is one)");
    }
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 2 || batchSize > MAX_BATCH_SIZE) {
      throw new RangeError(
        `batchSize must be an integer from 2 to ${MAX_BATCH_SIZE}, not ${batchSize}`,
      );
    }
    if (bytes.length > MAX_INPUT_LENGTH) {
      throw new RangeError(
        "the input is 2 GiB or more, which the 32-bit token offsets cannot address",
      );
    }
    this.#bytes = bytes;
    // A token is at least one byte, so a small input never needs the arrays of a big one: the
    // fixed cost of a tokenizer matters when there is one per message. The two extra cells are
    // not slack: a pass of #fill writes up to two tokens, so a capacity under 2 would never run.
    this.#batch = new Batch(Math.min(batchSize, bytes.length + 2));
    // A UTF-8 byte order mark (UNOW files from some tools) comes before the first segment.
    this.#pos = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  }

  *[Symbol.iterator](): Generator<TokenBatch, void, undefined> {
    if (this.#iterating) {
      throw new Error(
        "This tokenizer is already being iterated, and its loops share one batch: finish or stop the first loop before starting another",
      );
    }
    this.#iterating = true;
    try {
      const batch = this.#batch;
      for (;;) {
        this.#fill();
        if (batch.length > 0) {
          yield batch;
        } else if (this.#state !== FINISHED) {
          throw new Error("The tokenizer made no progress: this is a bug in @libredi/edifact");
        }
        if (this.#state === FINISHED) {
          if (this.#failure !== null) {
            throw this.#failure;
          }
          return;
        }
      }
    } finally {
      this.#iterating = false;
    }
  }

  /**
   * Line and column (both from 1; the column counts bytes) of a byte offset, from 0 to the length
   * of the input. The first call reads the input once to build an index of two numbers per 64 KiB;
   * errors do not use it, they carry their own position.
   */
  locate(offset: number): LineColumn {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.#bytes.length) {
      throw new RangeError(
        `offset must be an integer from 0 to ${this.#bytes.length}, not ${offset}`,
      );
    }
    this.#lineIndex ??= new LineIndex(this.#bytes);
    return this.#lineIndex.locate(offset);
  }

  #fill(): void {
    const batch = this.#batch;
    batch.length = 0;
    if (this.#state === FINISHED) {
      return;
    }
    if (this.#resetPending) {
      this.#resetPending = false;
      this.#separators = DEFAULT_SEPARATORS;
      this.#table = DEFAULT_TABLE;
      this.#segment = 0;
    }
    batch.separators = this.#separators;
    if (this.#segment === 0 && this.#state === AT_SEGMENT_START && !this.#separators.declared) {
      this.#startOfInterchange(batch);
    }

    const bytes = this.#bytes;
    const length = bytes.length;
    const kinds = batch.kinds;
    const starts = batch.starts;
    const ends = batch.ends;
    const capacity = batch.capacity;
    let table = this.#table;
    let pos = this.#pos;
    let state = this.#state;
    let segment = this.#segment;
    let tagStart = this.#tagStart;
    let isUnz = this.#isUnz;
    let n = 0;

    // Each pass adds at most two tokens: a run of text and the separator that ends it.
    while (n + 2 <= capacity) {
      if (state === AT_SEGMENT_START) {
        while (pos < length) {
          const byte = bytes[pos] as number;
          if (byte !== LF && byte !== CR) {
            break;
          }
          pos++;
        }
        if (pos >= length) {
          state = FINISHED;
          break;
        }

        if (
          bytes[pos] === 0x55 &&
          pos + 2 < length &&
          bytes[pos + 1] === 0x4e &&
          bytes[pos + 2] === 0x41
        ) {
          // The same UNA string again changes nothing: no new batch, no new table.
          const repeated =
            batch.separators.declared &&
            pos + SERVICE_STRING_LENGTH <= length &&
            matchesServiceString(bytes, pos, batch.separators);
          if (!repeated) {
            if (n > 0) {
              break; // a batch never mixes two sets of separators
            }
            const advice = readServiceStringAdvice(bytes, pos);
            if (!advice.ok) {
              this.#failure = advice.truncated
                ? this.#error(
                    TokenizeErrorCode.UnexpectedEndOfFile,
                    `The file ends inside the UNA service string: ${advice.reason}.`,
                    advice.offset,
                    0,
                    "UNA",
                  )
                : this.#error(
                    TokenizeErrorCode.InvalidUna,
                    `The UNA service string is not valid: ${advice.reason}.`,
                    advice.offset,
                    0,
                    "UNA",
                  );
              state = FINISHED;
              break;
            }
            this.#separators = advice.separators;
            batch.separators = advice.separators;
            table = tableFor(advice.separators);
          }
          kinds[n] = TokenKind.ServiceStringAdvice;
          starts[n] = pos;
          ends[n] = pos + SERVICE_STRING_LENGTH;
          n++;
          pos += SERVICE_STRING_LENGTH;
          segment = 0;
          continue;
        }

        // A segment tag: three capital letters or digits, then an element separator or the
        // terminator. The bytes are read once, so that what is checked is what is reported.
        const b0 = bytes[pos] as number;
        const b1 = pos + 1 < length ? (bytes[pos + 1] as number) : -1;
        const b2 = pos + 2 < length ? (bytes[pos + 2] as number) : -1;
        const valid = isTagByte(b0) ? (isTagByte(b1) ? (isTagByte(b2) ? 3 : 2) : 1) : 0;
        if (valid < 3) {
          if (pos + valid >= length) {
            this.#failure = this.#error(
              TokenizeErrorCode.UnexpectedEndOfFile,
              "The file ends in the middle of a segment tag.",
              length,
              segment + 1,
              tagText(valid, b0, b1, b2),
            );
          } else {
            this.#failure = this.#invalidTag(
              bytes[pos + valid] as number,
              pos + valid,
              segment + 1,
            );
          }
          state = FINISHED;
          break;
        }
        if (pos + 3 >= length) {
          const tag = tagText(3, b0, b1, b2);
          this.#failure = this.#error(
            TokenizeErrorCode.UnexpectedEndOfFile,
            `The file ends right after the tag of segment ${segment + 1}, which is ${tag}.`,
            length,
            segment + 1,
            tag,
          );
          state = FINISHED;
          break;
        }
        const afterTag = bytes[pos + 3] as number;
        const afterClass = table[afterTag];
        if (afterClass !== ELEMENT && afterClass !== TERMINATOR) {
          this.#failure = this.#invalidTag(afterTag, pos + 3, segment + 1);
          state = FINISHED;
          break;
        }
        segment++;
        tagStart = pos;
        isUnz = b0 === 0x55 && b1 === 0x4e && b2 === 0x5a;
        kinds[n] = TokenKind.SegmentTag;
        starts[n] = pos;
        ends[n] = pos + 3;
        n++;
        pos += 3;
        state = IN_SEGMENT;
        continue;
      }

      // In a segment: a run of text (possibly empty), then the separator that ends it.
      let i = pos;
      let escaped = false;
      let separator = DATA;
      while (i < length) {
        separator = table[bytes[i] as number] as number;
        if (separator === DATA) {
          i++;
        } else if (separator === RELEASE) {
          escaped = true;
          i += 2;
          separator = DATA;
        } else {
          break;
        }
      }
      if (i >= length) {
        const tag = this.#tagText(tagStart);
        this.#failure =
          i > length
            ? this.#error(
                TokenizeErrorCode.UnexpectedEndOfFile,
                `The file ends right after the release character ${describeByte(this.#separators.release)} in the ${tag} segment (segment ${segment}): the character it releases is missing.`,
                length,
                segment,
                tag,
              )
            : this.#error(
                TokenizeErrorCode.UnexpectedEndOfFile,
                `The file ends inside the ${tag} segment (segment ${segment}): the segment terminator ${describeByte(this.#separators.terminator)} is missing.`,
                length,
                segment,
                tag,
              );
        state = FINISHED;
        break;
      }
      if (i > pos) {
        kinds[n] = escaped ? TokenKind.EscapedText : TokenKind.Text;
        starts[n] = pos;
        ends[n] = i;
        n++;
      }
      kinds[n] = SEPARATOR_KIND[separator] as number;
      starts[n] = i;
      ends[n] = i + 1;
      n++;
      pos = i + 1;
      if (separator === TERMINATOR) {
        state = AT_SEGMENT_START;
        if (isUnz) {
          // The interchange is over: the next one starts from the default separators, in a new batch.
          this.#resetPending = true;
          break;
        }
      }
    }

    this.#pos = pos;
    this.#state = state;
    this.#table = table;
    this.#segment = segment;
    this.#tagStart = tagStart;
    this.#isUnz = isUnz;
    batch.length = n;
  }

  /**
   * The start of an interchange with no UNA string. Syntax version 4 assumes the asterisk as
   * repetition separator, and the UNB says whether this is version 4: that is decided here, once,
   * before any token of the interchange, so that no batch mixes two sets of separators. An
   * interchange ends at UNZ: one that has none, followed by a UNB, keeps its characters.
   */
  #startOfInterchange(batch: Batch): void {
    const bytes = this.#bytes;
    let at = this.#pos;
    while (at < bytes.length && (bytes[at] === LF || bytes[at] === CR)) {
      at++;
    }
    if (
      bytes[at] === 0x55 &&
      bytes[at + 1] === 0x4e &&
      bytes[at + 2] === 0x42 &&
      announcesSyntax4(bytes, at)
    ) {
      this.#separators = SYNTAX_4_SEPARATORS;
      this.#table = tableFor(SYNTAX_4_SEPARATORS);
      batch.separators = SYNTAX_4_SEPARATORS;
    }
  }

  /** The tag of the segment that starts at `start`, with anything unexpected shown as "?". */
  #tagText(start: number): string {
    const bytes = this.#bytes;
    let text = "";
    for (let i = start; i < start + 3 && i < bytes.length; i++) {
      const byte = bytes[i] as number;
      text += isTagByte(byte) ? String.fromCharCode(byte) : "?";
    }
    return text;
  }

  #invalidTag(found: number, offset: number, segment: number): TokenizeError {
    const { element, terminator } = this.#separators;
    return this.#error(
      TokenizeErrorCode.InvalidSegmentTag,
      `Segment ${segment} does not start with a valid tag: a tag is three capital letters or digits followed by the element separator ${describeByte(element)} or the segment terminator ${describeByte(terminator)}, but found ${describeByte(found)}.`,
      offset,
      segment,
      null,
    );
  }

  #error(
    code: TokenizeErrorCode,
    detail: string,
    offset: number,
    segment: number,
    tag: string | null,
  ): TokenizeError {
    // A scan, not the line index: an error must not cost memory, even for a file of line breaks.
    const { line, column } = scanLocate(this.#bytes, offset);
    return new TokenizeError(code, detail, { offset, line, column, segment, tag });
  }
}

/** The first `count` characters of a tag, from the bytes that were read (all valid tag bytes). */
function tagText(count: number, b0: number, b1: number, b2: number): string | null {
  if (count === 0) {
    return null;
  }
  const codes = [b0, b1, b2].slice(0, count);
  return String.fromCharCode(...codes);
}
