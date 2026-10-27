import type { CharacterSet } from "./charset.ts";
import type { IssueCode, IssueDraft } from "./issues.ts";
import { DEFAULT_SEPARATORS, type Separators } from "./separators.ts";
import type { Envelope, Message, MessageInterchange, Segment } from "./tree.ts";
import type { Position } from "./types.ts";

/*
 * What a validation found, interchange by interchange and message by message: for the caller that
 * answers a file (a CONTRL says, for each interchange and each message, whether it was accepted).
 * It is kept only when asked for (`summary: true`), since it costs a record for every message.
 */

/** The first error of an interchange or a message, where it was. */
export interface ErrorNote {
  readonly code: IssueCode;
  /** The segment number in the interchange (UNB is 1); 0 when there is none. */
  readonly segment: number;
  readonly tag: string | null;
  readonly element: number | null;
  readonly component: number | null;
  /** Offset in the file of the byte at fault. */
  readonly offset: number;
}

export interface MessageSummary {
  /** The message reference number (UNH, first element). */
  readonly reference: string;
  /** The message identifier as written: type, version, release, agency, association code. */
  readonly identifier: readonly string[];
  /** The number in the interchange of its UNH segment. */
  readonly firstSegment: number;
  /** Offsets of the first byte of the message, and of the one after its UNT (end excluded). */
  readonly start: number;
  readonly end: number;
  /** Errors found in the message, all of them, and the first. */
  readonly errorCount: number;
  readonly firstError: ErrorNote | null;
}

export interface InterchangeSummary {
  /** Which interchange of the file, from 0. */
  readonly index: number;
  /** The interchange control reference (UNB, fifth element); null without a UNB. */
  readonly reference: string | null;
  /** The sender and the recipient of UNB, as the components written. */
  readonly sender: readonly string[] | null;
  readonly recipient: readonly string[] | null;
  readonly syntaxIdentifier: string | null;
  readonly syntaxVersion: string | null;
  readonly characterSet: CharacterSet | null;
  readonly separators: Separators;
  /** The interchange had a UNA string. */
  readonly una: boolean;
  /** UNB asks for an acknowledgement: its element 0031 is 1. */
  readonly acknowledgementRequest: boolean;
  readonly start: number;
  readonly end: number;
  /** The interchange was read to its UNZ. False for one that is cut off or has no UNZ. */
  readonly closed: boolean;
  readonly messages: readonly MessageSummary[];
  /** Errors in the interchange as a whole (its envelope, the file), all of them, and the first. */
  readonly errorCount: number;
  readonly firstError: ErrorNote | null;
}

interface Counting {
  errorCount: number;
  firstError: ErrorNote | null;
}
type MessageRecord = { -readonly [K in keyof MessageSummary]: MessageSummary[K] } & Counting;
type InterchangeRecord = { -readonly [K in keyof InterchangeSummary]: InterchangeSummary[K] } & {
  messages: MessageRecord[];
};

const components = (segment: Segment, element: number): string[] | null => {
  const view = segment.element(element);
  if (view === undefined) {
    return null;
  }
  const out = view.components.map((component) => component.text());
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }
  return out.length === 0 ? null : out;
};

/** Collects the summary while the file is read. */
export class Summaries {
  readonly list: InterchangeRecord[] = [];
  #interchange: InterchangeRecord | null = null;
  #target: Counting | null = null;
  /** Issues found in values since the last item was handed out: they belong to that item. */
  #pending: { count: number; first: ErrorNote | null } = { count: 0, first: null };

  /** An issue found in a value, as it is read. */
  pending(code: IssueCode, position: Position, offset: number): void {
    this.#pending.count++;
    const first = this.#pending.first;
    if (first === null || offset < first.offset) {
      this.#pending.first = {
        code,
        segment: position.segment,
        tag: position.tag,
        element: position.element,
        component: position.component,
        offset,
      };
    }
  }

  /** The next item of the file: a message or the segments between messages. */
  begin(item: Message | Envelope): void {
    const interchange = this.#enter(item.interchange, item);
    if (item.kind === "message") {
      const unh = item.unh;
      const record: MessageRecord = {
        reference: unh.text(1) ?? "",
        identifier: components(unh, 2) ?? [],
        firstSegment: unh.number,
        start: item.start,
        end: item.end,
        errorCount: 0,
        firstError: null,
      };
      interchange.messages.push(record);
      this.#target = record;
    } else {
      this.#target = interchange;
      if (item.segments.some((segment) => segment.tag === "UNZ")) {
        interchange.closed = true;
      }
    }
    interchange.end = Math.max(interchange.end, item.end);
    this.#drain();
  }

  /** An issue of the checkers: it belongs to what is being checked, or to what it says. */
  note(draft: IssueDraft): void {
    const note = this.#noteOf(draft);
    // A missing UNT is found when the segment after the message arrives, and a missing UNE, UNZ
    // or UNB when the interchange is over: they say whom they are about.
    const about = this.#about(draft);
    this.#count(about ?? this.#target, note);
  }

  /**
   * The error that stopped the reading of the file. It belongs to the interchange being read, which
   * the file does not finish; if the last interchange was complete, it is a new one that could not
   * be read, and has no record of what it was.
   */
  stop(draft: IssueDraft): void {
    let owner = this.#interchange;
    if (owner === null || owner.closed) {
      owner = this.#unreadable(draft.offset);
    }
    this.#count(owner, this.#noteOf(draft));
  }

  /** The end of the file: what is left over belongs to the last interchange. */
  finish(): void {
    this.#target = this.#interchange;
    this.#drain();
  }

  // --- Inside -----------------------------------------------------------------------------

  #noteOf(draft: IssueDraft): ErrorNote {
    // A segment that is missing is the one at fault: its tag is what the answer should say.
    const missing =
      draft.code === "MISSING_ENVELOPE_SEGMENT" || draft.code === "MISSING_MANDATORY_SEGMENT";
    return {
      code: draft.code,
      segment: draft.segment,
      tag: missing ? (draft.expected ?? draft.tag) : draft.tag,
      element: draft.element ?? null,
      component: draft.component ?? null,
      offset: draft.offset,
    };
  }

  /** An interchange that could not be read at all: it is only known to have been there. */
  #unreadable(offset: number): InterchangeRecord {
    const record: InterchangeRecord = {
      index: (this.#interchange?.index ?? -1) + 1,
      reference: null,
      sender: null,
      recipient: null,
      syntaxIdentifier: null,
      syntaxVersion: null,
      characterSet: null,
      separators: DEFAULT_SEPARATORS,
      una: false,
      acknowledgementRequest: false,
      start: offset,
      end: offset,
      closed: false,
      messages: [],
      errorCount: 0,
      firstError: null,
    };
    this.list.push(record);
    this.#interchange = record;
    this.#target = record;
    return record;
  }

  #enter(interchange: MessageInterchange, item: Message | Envelope): InterchangeRecord {
    const current = this.#interchange;
    if (current !== null && current.index === interchange.index) {
      return current;
    }
    const unb = interchange.unb;
    const record: InterchangeRecord = {
      index: interchange.index,
      reference: unb?.text(5) ?? null,
      sender: unb === null ? null : components(unb, 2),
      recipient: unb === null ? null : components(unb, 3),
      syntaxIdentifier: interchange.syntaxIdentifier,
      syntaxVersion: interchange.syntaxVersion,
      characterSet: interchange.characterSet,
      separators: interchange.separators,
      una: interchange.una !== null,
      acknowledgementRequest: unb?.text(9) === "1",
      start: interchange.una?.start ?? item.start,
      end: item.end,
      closed: false,
      messages: [],
      errorCount: 0,
      firstError: null,
    };
    this.list.push(record);
    this.#interchange = record;
    return record;
  }

  #about(draft: IssueDraft): Counting | null {
    if (draft.code !== "MISSING_ENVELOPE_SEGMENT") {
      return null;
    }
    // A missing UNB is found at the first message of the interchange, which is where it starts; the
    // others at the end of the interchange they close, which may be where the next one starts.
    const header = draft.expected === "UNB";
    // It is about the last interchange that started before it, or in front of it: the end of the
    // list is where to look, and only a few records are ever passed over.
    let owner: InterchangeRecord | null = null;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const record = this.list[i] as InterchangeRecord;
      if (header ? record.start <= draft.offset : record.start < draft.offset) {
        owner = record;
        break;
      }
    }
    if (owner === null || draft.expected !== "UNT") {
      return owner;
    }
    // The message that has no UNT is the last one that started before the segment that follows it.
    for (let i = owner.messages.length - 1; i >= 0; i--) {
      const message = owner.messages[i] as MessageRecord;
      if (message.start < draft.offset) {
        return message;
      }
    }
    return owner;
  }

  #drain(): void {
    const { count, first } = this.#pending;
    if (count > 0 && this.#target !== null) {
      this.#target.errorCount += count;
      this.#first(this.#target, first);
    }
    this.#pending = { count: 0, first: null };
  }

  #count(target: Counting | null, note: ErrorNote): void {
    if (target !== null) {
      target.errorCount++;
      this.#first(target, note);
    }
  }

  /** The first error is the one nearest the start of the file, whoever found it first. */
  #first(target: Counting, note: ErrorNote | null): void {
    if (note !== null && (target.firstError === null || note.offset < target.firstError.offset)) {
      target.firstError = note;
    }
  }
}
