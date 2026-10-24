import { ParseError, ParseErrorCode } from "./errors.ts";
import { type SplitOptions, Splitter, type TreeFactory, type Unit } from "./split.ts";
import { MIN_BUDGET, type Store, StoreBuilder } from "./store.ts";
import {
  type Envelope,
  type Group,
  type Interchange,
  InterchangeNode,
  type Message,
  MessageNode,
  type Segment,
  SegmentView,
} from "./tree.ts";
import type { ParseIssue } from "./types.ts";

export interface ParseOptions extends SplitOptions {
  /**
   * Most memory, in bytes, that the arrays of one message may use (a message is also the unit
   * for the segments between messages, such as UNB and UNZ). The arrays of a message take about
   * four times its size, so the default of 64 MiB allows messages of about 16 MB. A larger one
   * stops the parse with `MESSAGE_TOO_LARGE`. Between 4096 and 2 GiB. The builder's arrays count;
   * while a message is copied out, the arrays and the copy exist together, so the peak is up to
   * about twice the budget.
   */
  readonly memoryBudget?: number;
  /**
   * `parseInterchanges` only: most memory, in bytes, that the whole tree may keep. It counts the
   * arrays of every message and about 2 KiB of nodes for each message and each run of segments
   * between messages, so that a file of tiny messages cannot cost hundreds of times its size. A
   * bigger tree stops the parse with `TREE_TOO_LARGE`; read such a file with `parseMessages`.
   * Default 256 MiB, which is a file of about 60 MB of ordinary messages.
   */
  readonly maxTreeBytes?: number;
}

const DEFAULT_BUDGET = 64 * 1024 * 1024;
const MAX_BUDGET = 2 ** 31;
const DEFAULT_TREE_BYTES = 256 * 1024 * 1024;
/** What a message or a run costs besides its arrays: its store, nodes and typed array views. */
const UNIT_OVERHEAD = 2048;

/** A splitter that builds the tree of one message at a time. */
function treeSplitter(
  bytes: Uint8Array,
  options: ParseOptions,
): { splitter: Splitter; builder: StoreBuilder } {
  const budget = options.memoryBudget ?? DEFAULT_BUDGET;
  if (!Number.isInteger(budget) || budget < MIN_BUDGET || budget > MAX_BUDGET) {
    throw new RangeError(
      `memoryBudget must be an integer from ${MIN_BUDGET} to ${MAX_BUDGET}, not ${budget}`,
    );
  }
  const builder = new StoreBuilder(budget);
  const tree: TreeFactory = {
    builder,
    budget,
    interchange: (index, source, separators) => new InterchangeNode(index, source, separators),
    message: (interchange, store, ung, closed) =>
      new MessageNode(interchange as InterchangeNode, store, ung as Segment | null, closed),
    segment: (interchange, store, index) =>
      new SegmentView(interchange as InterchangeNode, store, index),
  };
  return { splitter: new Splitter(bytes, options, tree), builder };
}

/** The messages of a file, one at a time, with the memory of the largest one. */
export class MessageStream implements Iterable<Message> {
  readonly #splitter: Splitter;
  readonly #builder: StoreBuilder;
  #units: Generator<Unit> | null = null;
  #messages: Generator<Message> | null = null;
  #items: Generator<Message | Envelope> | null = null;

  constructor(bytes: Uint8Array, options: ParseOptions) {
    const { splitter, builder } = treeSplitter(bytes, options);
    this.#splitter = splitter;
    this.#builder = builder;
  }

  /** Problems found so far in the values (at most `maxIssues`). Complete once the stream has ended. */
  get issues(): readonly ParseIssue[] {
    return this.#splitter.issues;
  }

  /** How many problems were found, including the ones that were not kept. */
  get issueCount(): number {
    return this.#splitter.issueCount;
  }

  /** Messages delivered so far. */
  get messageCount(): number {
    return this.#splitter.messageCount;
  }

  /** The most memory the arrays of a message needed, in bytes: never above the budget. */
  get peakWorkingBytes(): number {
    return this.#builder.peakBytes;
  }

  /**
   * Every message, in file order. A file that is cut inside a message ends the loop with a
   * `TokenizeError`, after the messages before it; the cut message is not delivered. A stream
   * reads its input once: after a first loop, even one that stopped early, another yields nothing.
   */
  [Symbol.iterator](): Generator<Message> {
    this.#messages ??= this.#onlyMessages();
    return this.#messages;
  }

  /**
   * The messages and, between them, the segments that are not in a message (UNB, UNG, UNE, UNZ,
   * loose segments) as `Envelope` items, in file order: all of the file but the UNA strings.
   * Same rules as the loop over the stream itself, which is the same single pass.
   */
  items(): Generator<Message | Envelope> {
    this.#items ??= this.#everything();
    return this.#items;
  }

  #pass(): Generator<Unit> {
    this.#units ??= this.#splitter.units();
    return this.#units;
  }

  *#onlyMessages(): Generator<Message> {
    for (const unit of this.#pass()) {
      if (unit.kind === "message") {
        yield unit.message as Message;
      }
    }
  }

  *#everything(): Generator<Message | Envelope> {
    for (const unit of this.#pass()) {
      if (unit.kind === "message") {
        yield unit.message as Message;
      } else if (unit.kind === "run") {
        yield envelopeOf(unit.interchange as InterchangeNode, unit.store);
      }
    }
  }
}

function envelopeOf(node: InterchangeNode, store: Store): Envelope {
  const segments = Array.from(
    { length: store.segmentCount },
    (_unused, s) => new SegmentView(node, store, s),
  );
  return {
    kind: "envelope",
    interchange: node,
    segments,
    start: segments[0]?.start ?? 0,
    end: segments.at(-1)?.end ?? 0,
  };
}

/**
 * Splits a file into its messages and parses them one at a time. Each `Message` keeps a reference
 * to the input (`bytes` in) but the arrays that describe it are its own, so a message can be kept
 * or dropped on its own. Memory use is that of the largest message, bounded by `memoryBudget`,
 * not that of the file: a 100 MB file of ordinary orders needs a few tens of KiB for the parser.
 */
export function parseMessages(bytes: Uint8Array, options: ParseOptions = {}): MessageStream {
  return new MessageStream(bytes, options);
}

export interface ParseResult {
  /** The input, kept: everything between and around the interchanges (line breaks, a byte order mark) is in it. */
  readonly source: Uint8Array;
  /** Normally one; a file may hold several interchanges one after the other. */
  readonly interchanges: Interchange[];
  readonly issues: readonly ParseIssue[];
  readonly issueCount: number;
}

/**
 * Parses a whole file into trees, one per interchange (an interchange that is only a UNA string
 * is one too). Everything stays in memory, about four times the size of the file for messages of
 * a few KB and more for tiny ones, within `maxTreeBytes`: for large files, loop over
 * {@link parseMessages} instead. A `TokenizeError` or `ParseError` is thrown and nothing is
 * returned.
 */
export function parseInterchanges(bytes: Uint8Array, options: ParseOptions = {}): ParseResult {
  const maxTreeBytes = options.maxTreeBytes ?? DEFAULT_TREE_BYTES;
  if (!Number.isInteger(maxTreeBytes) || maxTreeBytes < MIN_BUDGET) {
    throw new RangeError(
      `maxTreeBytes must be an integer of at least ${MIN_BUDGET}, not ${maxTreeBytes}`,
    );
  }
  const { splitter } = treeSplitter(bytes, options);
  const interchanges: InterchangeNode[] = [];
  let group: { -readonly [K in keyof Group]: Group[K] } | null = null;
  let retained = 0;

  const place = (node: InterchangeNode, item: Message | Segment): void => {
    (group === null ? node.items : group.items).push(item);
    grow(node, item.start, item.end);
  };
  const closeGroup = (): void => {
    if (group !== null) {
      const last = group.une ?? group.items.at(-1) ?? group.ung;
      group.end = last.end;
      group = null;
    }
  };
  const keep = (node: InterchangeNode, memory: number, start: number): void => {
    retained += memory + UNIT_OVERHEAD;
    if (retained > maxTreeBytes) {
      const { line, column } = node.locate(start);
      const tag = String.fromCharCode(...bytes.subarray(start, start + 3));
      throw new ParseError(
        ParseErrorCode.TreeTooLarge,
        `The tree of this file needs more than maxTreeBytes (${maxTreeBytes} bytes) by the time it reaches this point; read a file this size with parseMessages, or raise maxTreeBytes`,
        { offset: start, line, column, segment: 0, tag },
      );
    }
  };

  for (const unit of splitter.units()) {
    const node = unit.interchange as InterchangeNode;
    if (unit.kind === "interchange") {
      closeGroup();
      interchanges.push(node);
      if (node.una !== null) {
        grow(node, node.una.start, node.una.end);
      }
      continue;
    }
    if (unit.kind === "message") {
      const message = unit.message as Message & { memory: number };
      keep(node, message.memory, message.start);
      place(node, message);
      continue;
    }
    keep(node, unit.store.segmentStart.buffer.byteLength, unit.store.segmentStart[0] as number);
    for (let s = 0; s < unit.store.segmentCount; s++) {
      const segment = new SegmentView(node, unit.store, s);
      grow(node, segment.start, segment.end);
      switch (segment.tag) {
        case "UNB":
          break;
        case "UNZ":
          closeGroup();
          node.unz = segment;
          break;
        case "UNG":
          closeGroup();
          group = {
            kind: "group",
            start: segment.start,
            end: segment.end,
            ung: segment,
            items: [],
            une: null,
          };
          node.items.push(group);
          break;
        case "UNE":
          if (group !== null) {
            group.une = segment;
            closeGroup();
          } else {
            node.items.push(segment);
          }
          break;
        default:
          place(node, segment);
      }
    }
  }
  closeGroup();
  return { source: bytes, interchanges, issues: splitter.issues, issueCount: splitter.issueCount };
}

/** An interchange spans from its first byte to its last. */
function grow(node: InterchangeNode, start: number, end: number): void {
  node.start = node.end === 0 ? start : Math.min(node.start, start);
  node.end = Math.max(node.end, end);
}
