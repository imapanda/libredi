import type { CharacterSet } from "./charset.ts";
import {
  CharacterChecker,
  characterSetOf,
  decodeText,
  explainInvalidCharacter,
} from "./charset.ts";
import { ParseError, ParseErrorCode } from "./errors.ts";
import { type LineColumn, LineCursor } from "./line-index.ts";
import type { Separators } from "./separators.ts";
import { Source } from "./source.ts";
import { BudgetExceeded, MAX_REPETITIONS, type Store, type StoreBuilder } from "./store.ts";
import { Tokenizer } from "./tokenizer.ts";
import { TokenKind } from "./tokens.ts";
import {
  type InterchangeInfo,
  type ParseIssue,
  ParseIssueCode,
  type Position,
  type ServiceStringAdvice,
  type Span,
} from "./types.ts";

export interface SplitOptions {
  /** Check every value against the character set of the interchange. Default true. */
  readonly checkCharacters?: boolean;
  /** Most issues to keep (all are counted). Default 100. */
  readonly maxIssues?: number;
  /** Tokens per batch of the tokenizer underneath. */
  readonly batchSize?: number;
  /**
   * Called for every issue found in a value, kept or not, as the value is read: that is, before
   * the message that holds it is handed out. For a caller that needs to count the issues of each
   * message without keeping them.
   */
  readonly onIssue?: (code: ParseIssue["code"], position: Position, offset: number) => void;
}

/** A message located in the file: where it is and which interchange and group it is in. */
export interface MessageSlice extends Span {
  readonly kind: "message";
  readonly interchange: InterchangeInfo;
  /** The UNG segment of the group that the message is in, if it is in one. */
  readonly ung: Span | null;
  /** Segments, from UNH to UNT. */
  readonly segmentCount: number;
  /** The message ends with UNT. False when it runs into the next UNH, UNG, UNE, UNZ or the end of the file. */
  readonly closed: boolean;
}

/**
 * What the tree adds to the splitter: the arrays that hold the segments of a unit, and the nodes
 * that are made from them. `tree.ts` provides it; the splitter alone has none and keeps nothing.
 */
export interface TreeFactory {
  readonly builder: StoreBuilder;
  /** The most memory the builder may use, in bytes, for the message of the error. */
  readonly budget: number;
  interchange(index: number, source: Source, separators: Separators): InterchangeFacts;
  message(
    interchange: InterchangeFacts,
    store: Store,
    ung: Span | null,
    closed: boolean,
  ): MessageSlice;
  /** The segment `index` of a store, for the nodes that point at one (UNB, UNG). */
  segment(interchange: InterchangeFacts, store: Store, index: number): Span;
}

/**
 * What the engine hands out in tree mode: an interchange as soon as it starts (so that one with
 * nothing but a UNA is not lost), a message, or the segments between messages (UNB, UNG, UNE,
 * UNZ). Without a tree there are only messages.
 */
export type Unit =
  | { readonly kind: "interchange"; readonly interchange: InterchangeFacts }
  | { readonly kind: "run"; readonly interchange: InterchangeFacts; readonly store: Store }
  | {
      readonly kind: "message";
      readonly interchange: InterchangeFacts;
      readonly message: MessageSlice;
    };

const UNB = 0x554e42;
const UNG = 0x554e47;
const UNE = 0x554e45;
const UNH = 0x554e48;
const UNT = 0x554e54;
const UNZ = 0x554e5a;

/** An interchange while it is read: what UNA and UNB say, as they are met. */
export class InterchangeFacts implements InterchangeInfo {
  readonly index: number;
  readonly source: Uint8Array;
  una: ServiceStringAdvice | null = null;
  separators: Separators;
  syntaxIdentifier: string | null = null;
  syntaxVersion: string | null = null;
  characterSet: CharacterSet | null = null;
  /** Checks values against `characterSet`; made once, when UNB names the set. */
  checker: CharacterChecker | null = null;
  unb: Span | null = null;
  readonly #sourceOf: Source;

  constructor(index: number, source: Source, separators: Separators) {
    this.index = index;
    this.source = source.bytes;
    this.#sourceOf = source;
    this.separators = separators;
  }

  locate(offset: number): LineColumn {
    return this.#sourceOf.locate(offset);
  }
}

const MAX_SHOWN = 32;

/**
 * Up to 32 bytes read as ISO 646: a printable ASCII byte as itself, any other as "?", and "..."
 * after a cut. The name of a character set comes from a file that nobody has checked yet, and
 * ends up in messages: it is kept short and printable.
 */
function iso646(bytes: Uint8Array, start: number, end: number): string {
  const shown = Math.min(end - start, MAX_SHOWN);
  let text = "";
  for (let i = 0; i < shown; i++) {
    const byte = bytes[start + i] as number;
    text += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "?";
  }
  return end - start > shown ? `${text}...` : text;
}

function tagName(code: number): string {
  return String.fromCharCode((code >> 16) & 0xff, (code >> 8) & 0xff, code & 0xff);
}

/**
 * Reads the tokens of the tokenizer once, cuts them into messages, and keeps what the envelope
 * says. On its own it holds no segment: the memory it uses is a few numbers, whatever the size
 * of the file. With a {@link TreeFactory} it also builds the segments of one message at a time
 * (or of one run of segments between messages), so that the memory used is that of the largest.
 */
export class Splitter {
  readonly source: Source;
  readonly issues: ParseIssue[] = [];
  issueCount = 0;
  messageCount = 0;
  readonly #check: boolean;
  readonly #maxIssues: number;
  readonly #onIssue: SplitOptions["onIssue"] | null;
  readonly #tokenizer: Tokenizer;
  /** Issues come in file order, so their lines and columns are found in one pass in all. */
  readonly #lines: LineCursor;
  readonly #tree: TreeFactory | null;
  readonly #builder: StoreBuilder | null;

  node: InterchangeFacts | null = null;
  nodeUsed = false;
  interchangeCount = 0;
  ung: Span | null = null;
  inMessage = false;
  messageStart = 0;
  messageEnd = 0;
  messageSegments = 0;
  segmentStart = 0;
  tagCode = 0;
  segmentNumber = 0;
  elementNo = 0;
  componentNo = 0;
  /** Repetition separators met in the element being read. */
  repetitionNo = 0;
  /** With a tree: the builder holds the segments of a unit that is not finished. */
  unitOpen = false;
  unitStart = 0;
  unitSegment = 0;
  unitTag = 0;
  /** With a tree: an interchange that has started and has not been handed out yet. */
  created: InterchangeFacts | null = null;

  constructor(bytes: Uint8Array, options: SplitOptions, tree: TreeFactory | null = null) {
    const maxIssues = options.maxIssues ?? 100;
    if (!Number.isInteger(maxIssues) || maxIssues < 0) {
      throw new RangeError(`maxIssues must be a whole number, not ${maxIssues}`);
    }
    this.source = new Source(bytes);
    this.#check = options.checkCharacters ?? true;
    this.#maxIssues = maxIssues;
    this.#onIssue = options.onIssue ?? null;
    this.#lines = new LineCursor(bytes);
    this.#tree = tree;
    this.#builder = tree === null ? null : tree.builder;
    // Made now, so that an input or a batch size that is not valid is refused by the call.
    this.#tokenizer = new Tokenizer(
      bytes,
      options.batchSize === undefined ? {} : { batchSize: options.batchSize },
    );
  }

  *messages(): Generator<MessageSlice> {
    for (const unit of this.units()) {
      if (unit.kind === "message") {
        yield unit.message;
      }
    }
  }

  *units(): Generator<Unit> {
    const builder = this.#builder;
    try {
      for (const batch of this.#tokenizer) {
        const { kinds, starts, ends, length, separators } = batch;
        for (let i = 0; i < length; i++) {
          const start = starts[i] as number;
          let done: Unit | null = null;
          switch (kinds[i]) {
            case TokenKind.Text:
              this.text(start, ends[i] as number, false);
              break;
            case TokenKind.EscapedText:
              this.text(start, ends[i] as number, true);
              break;
            case TokenKind.ElementSeparator:
              builder?.beginElement(start, ends[i] as number);
              this.elementNo++;
              this.componentNo = 1;
              this.repetitionNo = 0;
              break;
            case TokenKind.ComponentSeparator:
              builder?.componentSeparator(start);
              this.componentNo++;
              break;
            case TokenKind.RepetitionSeparator:
              builder?.repetitionSeparator(start);
              this.componentNo = 1;
              this.repetitionNo++;
              break;
            case TokenKind.SegmentTag:
              done = this.tag(start, separators);
              if (this.created !== null) {
                if (done !== null) {
                  yield done;
                  done = null;
                }
                yield this.takeCreated();
              }
              break;
            case TokenKind.SegmentTerminator:
              builder?.endSegment(start, ends[i] as number);
              done = this.terminator(ends[i] as number);
              break;
            case TokenKind.ServiceStringAdvice:
              done = this.una(start, ends[i] as number, separators);
              if (this.created !== null) {
                if (done !== null) {
                  yield done;
                  done = null;
                }
                yield this.takeCreated();
              }
              break;
          }
          if (done !== null) {
            yield done;
          }
        }
      }
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        throw this.tooLarge(error.reason);
      }
      throw error;
    }
    const last = this.finishUnit(false);
    if (last !== null) {
      yield last;
    }
  }

  una(start: number, end: number, separators: Separators): Unit | null {
    const done = this.finishUnit(false);
    this.node = this.newNode(separators);
    this.nodeUsed = false;
    this.node.una = {
      kind: "una",
      start,
      end,
      text: decodeText(this.source.bytes, start + 3, end, null),
    };
    this.segmentNumber = 0;
    this.ung = null;
    return done;
  }

  tag(start: number, separators: Separators): Unit | null {
    const bytes = this.source.bytes;
    const code =
      ((bytes[start] as number) << 16) |
      ((bytes[start + 1] as number) << 8) |
      (bytes[start + 2] as number);
    let done: Unit | null = null;
    if (this.node === null) {
      this.node = this.newNode(separators);
    } else if (code === UNB && this.nodeUsed) {
      // A new interchange that has no UNA, after one that has no UNZ.
      done = this.finishUnit(false);
      this.node = this.newNode(separators);
      this.segmentNumber = 0;
      this.ung = null;
    }
    if (code === UNH) {
      done = this.finishUnit(false);
      this.inMessage = true;
      this.messageStart = start;
      this.messageSegments = 0;
    } else if (this.inMessage && (code === UNG || code === UNE || code === UNZ)) {
      done = this.finishUnit(false);
    }
    if (!this.unitOpen) {
      this.unitOpen = true;
      this.unitStart = start;
      this.unitSegment = this.segmentNumber + 1;
      this.unitTag = code;
    }
    this.nodeUsed = true;
    this.segmentStart = start;
    this.tagCode = code;
    this.segmentNumber++;
    this.elementNo = 0;
    this.componentNo = 0;
    this.repetitionNo = 0;
    this.#builder?.beginSegment(start, this.segmentNumber);
    return done;
  }

  terminator(end: number): Unit | null {
    let done: Unit | null = null;
    if (this.inMessage) {
      this.messageSegments++;
      this.messageEnd = end;
      if (this.tagCode === UNT) {
        done = this.finishUnit(true);
      }
    }
    const node = this.node as InterchangeFacts;
    if (this.tagCode === UNB) {
      node.unb = { start: this.segmentStart, end };
    } else if (this.tagCode === UNG) {
      this.ung = { start: this.segmentStart, end };
    } else if (this.tagCode === UNE) {
      this.ung = null;
    } else if (this.tagCode === UNZ) {
      // The interchange is over, and so is the run of segments that holds its UNZ.
      done = this.finishUnit(false) ?? done;
      this.node = null;
      this.ung = null;
      this.segmentNumber = 0;
    }
    return done;
  }

  text(start: number, end: number, escaped: boolean): void {
    this.#builder?.addValue(start, end, escaped);
    const node = this.node as InterchangeFacts;
    if (
      this.tagCode === UNB &&
      this.elementNo === 1 &&
      this.componentNo <= 2 &&
      this.repetitionNo === 0
    ) {
      // The start of UNB is ISO 646 whatever the character set: read S001 as plain ASCII.
      const bytes = this.source.bytes;
      if (this.componentNo === 1) {
        node.syntaxIdentifier = iso646(bytes, start, end);
        node.characterSet = characterSetOf(bytes, start, end);
        node.checker =
          node.characterSet === null
            ? null
            : new CharacterChecker(node.characterSet, node.separators);
        if (node.characterSet === null) {
          this.report(
            ParseIssueCode.UnsupportedCharset,
            `The character set "${node.syntaxIdentifier}" is not supported (UNOA, UNOB, UNOC and UNOW are); values are read as ISO 8859-1 and not checked`,
            start,
            "UNOA, UNOB, UNOC or UNOW",
            node.syntaxIdentifier,
          );
        }
      } else {
        node.syntaxVersion = iso646(bytes, start, end);
      }
      return;
    }
    const checker = node.checker;
    if (this.#check && checker !== null) {
      const bytes = this.source.bytes;
      const bad = checker.find(bytes, start, end);
      if (bad >= 0) {
        // The explanation is only worth building for an issue that is kept.
        if (this.issues.length < this.#maxIssues) {
          const why = explainInvalidCharacter(bytes, bad, checker.set);
          this.report(
            ParseIssueCode.InvalidCharacter,
            `Invalid character in ${checker.set}: ${why}`,
            bad,
            `a character of ${checker.set}`,
            why,
          );
        } else {
          this.issueCount++;
          this.#onIssue?.(ParseIssueCode.InvalidCharacter, this.#where(), bad);
        }
      }
    }
  }

  newNode(separators: Separators): InterchangeFacts {
    const index = this.interchangeCount++;
    if (this.#tree === null) {
      return new InterchangeFacts(index, this.source, separators);
    }
    const node = this.#tree.interchange(index, this.source, separators);
    this.created = node;
    return node;
  }

  takeCreated(): Unit {
    const interchange = this.created as InterchangeFacts;
    this.created = null;
    return { kind: "interchange", interchange };
  }

  /** Ends the unit being read, if there is one, and hands it out. */
  finishUnit(closed: boolean): Unit | null {
    const tree = this.#tree;
    if (tree === null) {
      if (!this.inMessage) {
        return null;
      }
      this.inMessage = false;
      this.messageCount++;
      const node = this.node as InterchangeFacts;
      return {
        kind: "message",
        interchange: node,
        message: {
          kind: "message",
          interchange: node,
          ung: this.ung,
          start: this.messageStart,
          end: this.messageEnd,
          segmentCount: this.messageSegments,
          closed,
        },
      };
    }
    if (!this.unitOpen) {
      return null;
    }
    const node = this.node as InterchangeFacts;
    const store = tree.builder.finish();
    tree.builder.reset();
    this.unitOpen = false;
    if (this.inMessage) {
      this.inMessage = false;
      this.messageCount++;
      return {
        kind: "message",
        interchange: node,
        message: tree.message(node, store, this.ung, closed),
      };
    }
    const bytes = this.source.bytes;
    for (let s = 0; s < store.segmentCount; s++) {
      const at = store.segmentStart[s] as number;
      const code =
        ((bytes[at] as number) << 16) |
        ((bytes[at + 1] as number) << 8) |
        (bytes[at + 2] as number);
      if (code === UNB) {
        node.unb = tree.segment(node, store, s);
      } else if (code === UNG) {
        this.ung = tree.segment(node, store, s);
      } else if (code === UNE) {
        this.ung = null;
      }
    }
    return { kind: "run", interchange: node, store };
  }

  /** The error for a unit that the arrays cannot hold, placed where that unit starts. */
  tooLarge(reason: BudgetExceeded["reason"]): ParseError {
    const { line, column } = this.source.locate(this.unitStart);
    const what = this.inMessage ? "The message" : "The run of segments outside any message";
    const position = {
      offset: this.unitStart,
      line,
      column,
      segment: this.unitSegment,
      tag: tagName(this.unitTag),
    };
    if (reason === "repetitions") {
      return new ParseError(
        ParseErrorCode.TooManyElementRepetitions,
        `${what} that starts here has an element with more than ${MAX_REPETITIONS} repetitions, which is more than the parser counts`,
        position,
      );
    }
    return new ParseError(
      ParseErrorCode.MessageTooLarge,
      `${what} that starts here needs more than the memory budget of ${this.#tree?.budget} bytes; raise memoryBudget, or check that the file has the UNH and UNT segments it should`,
      position,
    );
  }

  /** Where the value being read is, in the terms of an issue. */
  #where(): Position {
    return {
      segment: this.segmentNumber,
      tag: tagName(this.tagCode),
      element: this.elementNo,
      component: this.componentNo,
    };
  }

  report(
    code: ParseIssue["code"],
    message: string,
    offset: number,
    expected: string,
    found: string,
  ): void {
    this.issueCount++;
    this.#onIssue?.(code, this.#where(), offset);
    if (this.issues.length < this.#maxIssues) {
      const { line, column } = this.#lines.advanceTo(offset);
      this.issues.push({
        code,
        message,
        expected,
        found,
        repetition: this.repetitionNo > 0 ? this.repetitionNo + 1 : null,
        offset,
        line,
        column,
        position: {
          segment: this.segmentNumber,
          tag: tagName(this.tagCode),
          element: this.elementNo,
          component: this.componentNo,
        },
      });
    }
  }
}

/** The messages of a file, located but not parsed, one at a time. */
export class SliceStream implements Iterable<MessageSlice> {
  readonly #splitter: Splitter;
  #slices: Generator<MessageSlice> | null = null;

  constructor(bytes: Uint8Array, options: SplitOptions) {
    this.#splitter = new Splitter(bytes, options);
  }

  /** Problems found so far in the values (at most `maxIssues`). Complete once the stream has ended. */
  get issues(): readonly ParseIssue[] {
    return this.#splitter.issues;
  }

  /** How many problems were found, including the ones that were not kept. */
  get issueCount(): number {
    return this.#splitter.issueCount;
  }

  /** Messages handed out so far. */
  get messageCount(): number {
    return this.#splitter.messageCount;
  }

  /**
   * Every message, in file order. A file that is cut inside a message ends the loop with a
   * `TokenizeError`, after the messages before it; the cut message is not handed out. A stream
   * reads its input once: after a first loop, even one that stopped early, another yields nothing.
   */
  [Symbol.iterator](): Generator<MessageSlice> {
    this.#slices ??= this.#splitter.messages();
    return this.#slices;
  }
}

/**
 * Locates the messages of a file: for each, where it starts and ends, how many segments it has,
 * and the facts of its interchange (UNA, separators, syntax identifier, character set, UNB) and
 * group. Nothing but the envelope is read, so the memory used is a few numbers whatever the size
 * of the file, and the slices can be handed to workers that parse them. While it reads, it
 * checks every value against the character set that UNB declares (`issues`).
 */
export function splitMessages(bytes: Uint8Array, options: SplitOptions = {}): SliceStream {
  return new SliceStream(bytes, options);
}
