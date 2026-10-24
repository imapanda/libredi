import { decodeText } from "./charset.ts";
import { InterchangeFacts, type MessageSlice } from "./split.ts";
import type { Store } from "./store.ts";
import type { InterchangeInfo, Position, Span } from "./types.ts";
import { unescapeValue } from "./unescape.ts";

/*
 * The tree of an interchange: interchange, group, message, segment, element, component.
 *
 * It is lossless. Every node knows the bytes it spans (`start` to `end`, from the start of the
 * input, `end` excluded) and the input is kept (`Interchange.source`), so nothing of the file is
 * lost: values keep their release characters until they are asked for as text, and the bytes
 * between two nodes (the line breaks after a terminator, a byte order mark in front of the first
 * segment) are exactly the bytes between their spans. `serialize` (serialize.ts) writes it back.
 *
 * Nodes are views on compact arrays and are made when they are asked for, so a tree of a
 * million segments costs a few times the size of the file. Ask for `segment.elements` once and
 * keep the result if you read it often.
 */

export interface Component extends Span {
  readonly kind: "component";
  readonly position: Position;
  /** The component has no value: it is empty, or only stands between two separators. */
  readonly empty: boolean;
  /** The value with its release characters removed, decoded with the character set of the interchange. */
  text(): string;
  /** The value with its release characters removed, as bytes. */
  bytes(): Uint8Array;
}

export interface Element extends Span {
  readonly kind: "element";
  readonly position: Position;
  /** The components of the first repetition: all of them unless the interchange repeats elements. */
  readonly components: Component[];
  /** Syntax 4 only: one list of components per repetition. One list otherwise. */
  readonly repetitions: Component[][];
}

export interface Segment extends Span {
  readonly kind: "segment";
  readonly tag: string;
  /** Number in the interchange: UNA is 0, UNB is 1. */
  readonly number: number;
  readonly position: Position;
  /** The elements, the tag excluded. */
  readonly elements: Element[];
  /** Element `n`, counted from 1. */
  element(n: number): Element | undefined;
  /** Component `c` of element `e`, counted from 1, in the first repetition. */
  component(e: number, c: number): Component | undefined;
  /** The text of component `c` (default 1) of element `e`, or undefined when there is none. */
  text(e: number, c?: number): string | undefined;
}

/** What is known about the interchange of a message, with its UNB as a segment. */
export interface MessageInterchange extends InterchangeInfo {
  readonly unb: Segment | null;
}

/** A message of the file, with its segments. It is a {@link MessageSlice} that can be read. */
export interface Message extends MessageSlice {
  readonly interchange: MessageInterchange;
  /** The UNG segment of the group that the message is in, if it is in one. */
  readonly ung: Segment | null;
  /** Every segment, from UNH to UNT. */
  readonly segments: readonly Segment[];
  readonly unh: Segment;
  /** Null when the message runs into the next UNH, UNG, UNE, UNZ, UNA or UNB, or the end of the file. */
  readonly unt: Segment | null;
}

export interface Group extends Span {
  readonly kind: "group";
  readonly ung: Segment;
  /** Messages, and any segment that is not part of a message. */
  readonly items: (Message | Segment)[];
  readonly une: Segment | null;
}

/**
 * The segments that are between messages: UNB, UNG, UNE, UNZ, and any segment outside a message.
 * `parseMessages(...).items()` hands them out, so that a validator that reads a large file message
 * by message still sees the envelope and its counts.
 */
export interface Envelope extends Span {
  readonly kind: "envelope";
  readonly interchange: MessageInterchange;
  readonly segments: readonly Segment[];
}

export interface Interchange extends MessageInterchange, Span {
  readonly kind: "interchange";
  /** Groups, messages, and segments that are in neither, in file order. */
  readonly items: (Group | Message | Segment)[];
  /** Null when the file ends without it. */
  readonly unz: Segment | null;
  /** Every segment of the interchange in file order, UNB and UNZ included. */
  segments(): Generator<Segment>;
}

// --- Implementation -------------------------------------------------------------------------

/** An interchange as the parser finds it: the facts of the splitter, and the items as they are assembled. */
export class InterchangeNode extends InterchangeFacts implements Interchange {
  readonly kind = "interchange";
  start = 0;
  end = 0;
  declare unb: Segment | null;
  unz: Segment | null = null;
  readonly items: (Group | Message | Segment)[] = [];

  *segments(): Generator<Segment> {
    if (this.unb !== null) {
      yield this.unb;
    }
    for (const item of this.items) {
      if (item.kind === "segment") {
        yield item;
      } else if (item.kind === "message") {
        yield* item.segments;
      } else {
        yield item.ung;
        for (const inner of item.items) {
          if (inner.kind === "segment") {
            yield inner;
          } else {
            yield* inner.segments;
          }
        }
        if (item.une !== null) {
          yield item.une;
        }
      }
    }
    if (this.unz !== null) {
      yield this.unz;
    }
  }

  /** The text of a value, decoded with the character set that UNB announced. */
  text(start: number, end: number, escaped: boolean): string {
    if (!escaped) {
      return decodeText(this.source, start, end, this.characterSet);
    }
    const bytes = unescapeValue(this.source, start, end, this.separators.release);
    return decodeText(bytes, 0, bytes.length, this.characterSet);
  }
}

/**
 * Index of the first component of the repetition that `component` is in. The repetitions of an
 * element follow each other, so this is a binary search, not a walk over a long element.
 */
function firstOfRepetition(store: Store, element: number, component: number): number {
  const repetition = store.componentRepetition[component] as number;
  let low = store.elementFirstComponent[element] as number;
  let high = component;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((store.componentRepetition[middle] as number) < repetition) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function tagOf(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] as number, bytes[at + 1] as number, bytes[at + 2] as number);
}

class ComponentView implements Component {
  readonly kind = "component";
  readonly #ctx: InterchangeNode;
  readonly #store: Store;
  readonly #segment: number;
  readonly #element: number;
  readonly #component: number;

  constructor(
    ctx: InterchangeNode,
    store: Store,
    segment: number,
    element: number,
    component: number,
  ) {
    this.#ctx = ctx;
    this.#store = store;
    this.#segment = segment;
    this.#element = element;
    this.#component = component;
  }

  get start(): number {
    return this.#store.componentStart[this.#component] as number;
  }

  get end(): number {
    return this.#store.componentEnd[this.#component] as number;
  }

  get empty(): boolean {
    return this.start === this.end;
  }

  get position(): Position {
    const store = this.#store;
    return {
      segment: store.segmentNumber[this.#segment] as number,
      tag: tagOf(this.#ctx.source, store.segmentStart[this.#segment] as number),
      element: this.#element - (store.segmentFirstElement[this.#segment] as number) + 1,
      component: this.#component - firstOfRepetition(store, this.#element, this.#component) + 1,
    };
  }

  text(): string {
    const escaped = ((this.#store.componentFlags[this.#component] as number) & 1) === 1;
    return this.#ctx.text(this.start, this.end, escaped);
  }

  bytes(): Uint8Array {
    const escaped = ((this.#store.componentFlags[this.#component] as number) & 1) === 1;
    return escaped
      ? unescapeValue(this.#ctx.source, this.start, this.end, this.#ctx.separators.release)
      : new Uint8Array(this.#ctx.source.subarray(this.start, this.end)); // a copy, even of a Buffer
  }
}

class ElementView implements Element {
  readonly kind = "element";
  readonly #ctx: InterchangeNode;
  readonly #store: Store;
  readonly #segment: number;
  readonly #element: number;

  constructor(ctx: InterchangeNode, store: Store, segment: number, element: number) {
    this.#ctx = ctx;
    this.#store = store;
    this.#segment = segment;
    this.#element = element;
  }

  get start(): number {
    return this.#store.elementStart[this.#element] as number;
  }

  /** Just before the separator that opens the next element, or before the terminator. */
  get end(): number {
    const store = this.#store;
    const last = (store.segmentFirstElement[this.#segment + 1] as number) - 1;
    return this.#element === last
      ? (store.segmentEnd[this.#segment] as number) - 1
      : (store.elementStart[this.#element + 1] as number) - 1;
  }

  get position(): Position {
    const store = this.#store;
    return {
      segment: store.segmentNumber[this.#segment] as number,
      tag: tagOf(this.#ctx.source, store.segmentStart[this.#segment] as number),
      element: this.#element - (store.segmentFirstElement[this.#segment] as number) + 1,
      component: null,
    };
  }

  get components(): Component[] {
    const store = this.#store;
    const last = store.elementFirstComponent[this.#element + 1] as number;
    const components: Component[] = [];
    // The components of the first repetition come first.
    for (let c = store.elementFirstComponent[this.#element] as number; c < last; c++) {
      if (store.componentRepetition[c] !== 0) {
        break;
      }
      components.push(new ComponentView(this.#ctx, store, this.#segment, this.#element, c));
    }
    return components;
  }

  get repetitions(): Component[][] {
    const store = this.#store;
    const repetitions: Component[][] = Array.from(
      { length: store.elementRepetitions[this.#element] as number },
      () => [],
    );
    const first = store.elementFirstComponent[this.#element] as number;
    const last = store.elementFirstComponent[this.#element + 1] as number;
    for (let c = first; c < last; c++) {
      const view = new ComponentView(this.#ctx, store, this.#segment, this.#element, c);
      (repetitions[store.componentRepetition[c] as number] as Component[]).push(view);
    }
    return repetitions;
  }
}

export class SegmentView implements Segment {
  readonly kind = "segment";
  readonly #ctx: InterchangeNode;
  readonly #store: Store;
  readonly #segment: number;

  constructor(ctx: InterchangeNode, store: Store, segment: number) {
    this.#ctx = ctx;
    this.#store = store;
    this.#segment = segment;
  }

  get start(): number {
    return this.#store.segmentStart[this.#segment] as number;
  }

  get end(): number {
    return this.#store.segmentEnd[this.#segment] as number;
  }

  get number(): number {
    return this.#store.segmentNumber[this.#segment] as number;
  }

  get tag(): string {
    return tagOf(this.#ctx.source, this.start);
  }

  get position(): Position {
    return { segment: this.number, tag: this.tag, element: null, component: null };
  }

  get elements(): Element[] {
    const store = this.#store;
    const first = store.segmentFirstElement[this.#segment] as number;
    const last = store.segmentFirstElement[this.#segment + 1] as number;
    const elements: Element[] = [];
    for (let e = first; e < last; e++) {
      elements.push(new ElementView(this.#ctx, store, this.#segment, e));
    }
    return elements;
  }

  element(n: number): Element | undefined {
    const store = this.#store;
    const first = store.segmentFirstElement[this.#segment] as number;
    const last = store.segmentFirstElement[this.#segment + 1] as number;
    return Number.isInteger(n) && n >= 1 && first + n - 1 < last
      ? new ElementView(this.#ctx, store, this.#segment, first + n - 1)
      : undefined;
  }

  component(e: number, c: number): Component | undefined {
    const store = this.#store;
    const element = (store.segmentFirstElement[this.#segment] as number) + e - 1;
    if (e < 1 || element >= (store.segmentFirstElement[this.#segment + 1] as number) || c < 1) {
      return undefined;
    }
    const component = (store.elementFirstComponent[element] as number) + c - 1;
    // The first repetition's components come first in the element.
    return component < (store.elementFirstComponent[element + 1] as number) &&
      store.componentRepetition[component] === 0
      ? new ComponentView(this.#ctx, store, this.#segment, element, component)
      : undefined;
  }

  text(e: number, c = 1): string | undefined {
    return this.component(e, c)?.text();
  }
}

export class MessageNode implements Message {
  readonly kind = "message";
  readonly interchange: MessageInterchange;
  readonly ung: Segment | null;
  readonly segmentCount: number;
  readonly closed: boolean;
  readonly unt: Segment | null;
  readonly #ctx: InterchangeNode;
  readonly #store: Store;
  #segments: readonly Segment[] | null = null;
  #unh: Segment | null = null;

  constructor(ctx: InterchangeNode, store: Store, ung: Segment | null, closed: boolean) {
    this.interchange = ctx;
    this.#ctx = ctx;
    this.#store = store;
    this.ung = ung;
    this.segmentCount = store.segmentCount;
    this.closed = closed;
    this.unt = closed ? new SegmentView(ctx, store, store.segmentCount - 1) : null;
  }

  get start(): number {
    return this.#store.segmentStart[0] as number;
  }

  get end(): number {
    return this.#store.segmentEnd[this.segmentCount - 1] as number;
  }

  /** Bytes of the arrays that describe the message. */
  get memory(): number {
    return this.#store.segmentStart.buffer.byteLength;
  }

  get unh(): Segment {
    this.#unh ??= new SegmentView(this.#ctx, this.#store, 0);
    return this.#unh;
  }

  get segments(): readonly Segment[] {
    this.#segments ??= Object.freeze(
      Array.from(
        { length: this.segmentCount },
        (_unused, s) => new SegmentView(this.#ctx, this.#store, s),
      ),
    );
    return this.#segments;
  }
}
