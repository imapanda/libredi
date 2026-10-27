import { CharacterChecker, type CharacterSet, encodeText, findUnencodable } from "./charset.ts";
import { ParseError, TokenizeError } from "./errors.ts";
import type { IssueCode } from "./issues.ts";
import { type ParseOptions, parseMessages } from "./parser.ts";
import {
  type ElementData,
  type InterchangeData,
  type SegmentData,
  serializeData,
} from "./serialize.ts";
import type { ErrorNote, InterchangeSummary, MessageSummary } from "./summary.ts";
import type { Message, Segment } from "./tree.ts";
import { type ValidateOptions, type ValidationReport, validate } from "./validate.ts";

/*
 * CONTRL, the acknowledgement of ISO 9735, in both directions.
 *
 * Writing: what a validation found, interchange by interchange and message by message, becomes a
 * CONTRL interchange that accepts, rejects or partly rejects what was received. The layout is the
 * one of the sample corpus (samples/edifact, the CONTRL samples):
 *
 *     UNB   sender and recipient swapped, its own reference, date and time
 *     UNH   CONTRL:D:3:UN (syntax 3) or CONTRL:4:2:UN (syntax 4)
 *     UCI   reference, sender and recipient of the interchange answered, action [error, tag, position]
 *     UCM   one per message: reference, identifier, action [error, tag, position]
 *     UNT, UNZ
 *
 * An error in a service segment (UNB, UNH, UNT, UNZ...) is said in the UCI or UCM itself, as in the
 * samples: error code, tag, position. An error in the body of a message cannot name a service
 * segment, and is said the way ISO 9735 has it: the UCM is rejected, a UCS gives the position of
 * the segment in the message (and the error, when it concerns the whole segment) and a UCD the
 * error and the position of the data element. The corpus has no sample of that, so it is written
 * from memory of the standard, like the error codes. Messages inside a group (UNG/UNE) are
 * answered under the UCI like any other: there is no UCF.
 *
 * Reading: a CONTRL that came in is turned into the status of the interchange and the messages it
 * names, and matched with the interchanges that were sent.
 *
 * The action codes are 7 (acknowledged, accepted) and 4 (rejected), those of the corpus.
 */

/** UCI/UCM action codes (0083). */
export const ACTION = { accepted: "7", rejected: "4", received: "8" } as const;

/**
 * The syntax error code (0085) that says why, for each issue code that can reject. 28 and 29 are
 * the codes of the sample corpus, written from memory of ISO 9735 and unconfirmed. The other values
 * are this table's own, also from memory, and less likely to be right: nobody has checked any of
 * them against the standard or against the guideline of a partner. Check them here before relying
 * on a CONTRL in production, and change the table and the corpus together.
 */
export const CONTRL_ERROR_CODES: Readonly<Partial<Record<IssueCode, string>>> = {
  UNT_REFERENCE_MISMATCH: "28",
  UNE_REFERENCE_MISMATCH: "28",
  UNZ_REFERENCE_MISMATCH: "28",
  UNT_COUNT_MISMATCH: "29",
  UNE_COUNT_MISMATCH: "29",
  UNZ_COUNT_MISMATCH: "29",
  UNSUPPORTED_SYNTAX_VERSION: "2",
  UNSUPPORTED_CHARSET: "2",
  MISSING_MANDATORY_ELEMENT: "13",
  MISSING_MANDATORY_SEGMENT: "13",
  MISSING_ENVELOPE_SEGMENT: "13",
  INVALID_DATA_TYPE: "12",
  VALUE_TOO_LONG: "12",
  VALUE_TOO_SHORT: "12",
  INVALID_CHARACTER: "21",
  UNKNOWN_CODE: "14",
  SEGMENT_OUT_OF_ORDER: "15",
  UNKNOWN_SEGMENT: "15",
  UNEXPECTED_SEGMENT: "15",
  UNEXPECTED_ELEMENT: "16",
  UNEXPECTED_COMPONENT: "16",
  TOO_MANY_REPETITIONS: "16",
  ELEMENT_REPEATED_TOO_OFTEN: "16",
  REPETITION_NOT_ALLOWED: "15",
};

/** What is said for an issue that has no code in the table (a file that could not be read...): invalid value. */
export const DEFAULT_CONTRL_ERROR_CODE = "12";

export type AcknowledgementOutcome = "accepted" | "partially_rejected" | "rejected";

export interface ContrlOptions {
  /** The interchange control reference of the CONTRL: one to 14 characters of its character set. */
  readonly reference: string;
  /** Date and time of preparation, in UTC. Default: now. */
  readonly now?: Date;
  /** Character set of the CONTRL. Default: that of the interchange answered, UNOA if unknown. */
  readonly characterSet?: CharacterSet;
  /** Syntax version of the CONTRL. Default: that of the interchange answered, 3 if unknown. */
  readonly syntaxVersion?: "3" | "4";
  /** Answer an interchange whose UNB does not ask for an acknowledgement. Default false. */
  readonly always?: boolean;
  /** CR and LF after the UNA string and every segment. Default one LF, as in the corpus. */
  readonly lineBreak?: string;
}

/** How the interchange was received: accepted whole, in part, or rejected. */
export function outcomeOf(summary: InterchangeSummary): AcknowledgementOutcome {
  if (summary.errorCount > 0) {
    return "rejected";
  }
  return summary.messages.some((message) => message.errorCount > 0)
    ? "partially_rejected"
    : "accepted";
}

/** Why an interchange gets no CONTRL: nobody to send it to, or it did not ask for one. */
export type NotAnswered = "no_address" | "not_requested";

/** A party that is named: UNB gives the identification (its first component) of it. */
const named = (party: readonly string[] | null): boolean => (party?.[0] ?? "") !== "";

function notAnswered(summary: InterchangeSummary, always: boolean | undefined): NotAnswered | null {
  if (summary.reference === null || !named(summary.sender) || !named(summary.recipient)) {
    return "no_address";
  }
  return !summary.acknowledgementRequest && always !== true ? "not_requested" : null;
}

// --- Writing ------------------------------------------------------------------------------

const SERVICE_TAGS: ReadonlySet<string> = new Set([
  "UNA",
  "UNB",
  "UNZ",
  "UNG",
  "UNE",
  "UNH",
  "UNT",
]);

/** The simple data elements of the service segments: an error there has no component. */
const SIMPLE_ELEMENTS: Readonly<Record<string, readonly number[]>> = {
  UNB: [5],
  UNZ: [1, 2],
  UNG: [1, 5, 6],
  UNE: [1, 2],
  UNH: [1],
  UNT: [1, 2],
};

/** A value taken from the interchange answered, as it can be written in the set: what cannot is "?". */
function echo(value: string, set: CharacterSet): string {
  if (findUnencodable(value, set) === -1) {
    return value;
  }
  let out = "";
  for (const char of value) {
    out += findUnencodable(char, set) === -1 ? char : "?";
  }
  return out;
}

function position(note: ErrorNote): ElementData | null {
  if (note.element === null) {
    return null;
  }
  const simple = note.tag !== null && SIMPLE_ELEMENTS[note.tag]?.includes(note.element) === true;
  return note.component === null || simple
    ? [String(note.element)]
    : [String(note.element), String(note.component)];
}

/** The error code, the tag and the position that a UCI or a UCM says about an error. */
function why(note: ErrorNote): ElementData[] {
  const code = CONTRL_ERROR_CODES[note.code] ?? DEFAULT_CONTRL_ERROR_CODE;
  // The tag of a UCI or a UCM is a service segment tag (0013): a segment of the body is not one.
  if (note.tag === null || !SERVICE_TAGS.has(note.tag)) {
    return [code];
  }
  const at = position(note);
  return at === null ? [code, note.tag] : [code, note.tag, at];
}

function codeOf(note: ErrorNote): string {
  return CONTRL_ERROR_CODES[note.code] ?? DEFAULT_CONTRL_ERROR_CODE;
}

/** The UCM of a message, and the UCS and UCD after it when the error is in its body. */
function messageSegments(summary: MessageSummary, set: CharacterSet): SegmentData[] {
  const head: ElementData[] = [
    echo(summary.reference, set),
    summary.identifier.slice(0, 4).map((part) => echo(part, set)),
  ];
  const bad = summary.errorCount > 0 ? summary.firstError : null;
  if (bad === null) {
    return [{ tag: "UCM", elements: [...head, ACTION.accepted] }];
  }
  const inBody = bad.tag !== null && !SERVICE_TAGS.has(bad.tag);
  if (!inBody) {
    return [{ tag: "UCM", elements: [...head, ACTION.rejected, ...why(bad)] }];
  }
  const place = String(bad.segment - summary.firstSegment + 1);
  const at = position(bad);
  return [
    { tag: "UCM", elements: [...head, ACTION.rejected] },
    // An error in a segment as a whole is told by the UCS; one in a data element by a UCD.
    { tag: "UCS", elements: at === null ? [place, codeOf(bad)] : [place] },
    ...(at === null ? [] : [{ tag: "UCD", elements: [codeOf(bad), at] }]),
  ];
}

const two = (n: number): string => String(n).padStart(2, "0");

function dateAndTime(now: Date, version: "3" | "4"): [string, string] {
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const date = `${version === "4" ? year : year.slice(2)}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}`;
  return [date, `${two(now.getUTCHours())}${two(now.getUTCMinutes())}`];
}

const MAX_REFERENCE = 14;

/** The options are the caller's: a reference that cannot be written, or a date that is not one, is refused. */
function checkOptions(
  options: ContrlOptions,
  set: CharacterSet,
  summary: InterchangeSummary,
): void {
  const { reference } = options;
  const bad =
    reference.length === 0 ||
    reference.length > MAX_REFERENCE ||
    findUnencodable(reference, set) !== -1 ||
    new CharacterChecker(set, summary.separators).find(
      encodeText(reference, set),
      0,
      encodeText(reference, set).length,
    ) !== -1;
  if (bad) {
    throw new RangeError(
      `reference must be 1 to ${MAX_REFERENCE} characters that ${set} allows, not ${JSON.stringify(reference)}`,
    );
  }
  if (options.now !== undefined && Number.isNaN(options.now.getTime())) {
    throw new RangeError("now must be a valid date");
  }
}

/**
 * The CONTRL for an interchange, as data to write with `serializeData`, or null when the interchange
 * gets none (see {@link NotAnswered}): no UNB says who sent it, or its UNB does not ask for an
 * acknowledgement (its element 0031 is not 1) and `always` is not set. What is taken from the
 * interchange answered (references, parties, identifiers) is copied as it was received, with "?" for
 * a character the set of the CONTRL cannot hold.
 */
export function contrlData(
  summary: InterchangeSummary,
  options: ContrlOptions,
): InterchangeData | null {
  if (notAnswered(summary, options.always) !== null) {
    return null;
  }
  const sender = summary.sender as readonly string[];
  const recipient = summary.recipient as readonly string[];
  const version = options.syntaxVersion ?? (summary.syntaxVersion === "4" ? "4" : "3");
  const set = options.characterSet ?? summary.characterSet ?? "UNOA";
  checkOptions(options, set, summary);
  const [date, time] = dateAndTime(options.now ?? new Date(), version);
  const outcome = outcomeOf(summary);
  const party = (parts: readonly string[]): string[] => parts.map((part) => echo(part, set));

  // The interchange: accepted, or rejected with the first thing that was wrong with it.
  const uci: SegmentData = {
    tag: "UCI",
    elements: [
      echo(summary.reference as string, set),
      party(sender),
      party(recipient),
      ...(outcome === "rejected" && summary.firstError !== null
        ? [ACTION.rejected, ...why(summary.firstError)]
        : [ACTION.accepted]),
    ],
  };
  const messages =
    outcome === "rejected" ? [] : summary.messages.flatMap((m) => messageSegments(m, set));
  const body: SegmentData[] = [
    {
      tag: "UNH",
      elements: ["1", version === "4" ? ["CONTRL", "4", "2", "UN"] : ["CONTRL", "D", "3", "UN"]],
    },
    uci,
    ...messages,
  ];
  return {
    segments: [
      {
        tag: "UNB",
        elements: [
          [set, version],
          party(recipient),
          party(sender),
          [date, time],
          options.reference,
        ],
      },
      ...body,
      { tag: "UNT", elements: [String(body.length + 1), "1"] },
      { tag: "UNZ", elements: ["1", options.reference] },
    ],
    separators: summary.separators,
    characterSet: set,
    una: true,
    lineBreak: options.lineBreak ?? "\n",
  };
}

/** The CONTRL for an interchange as bytes, or null (see {@link contrlData}). */
export function contrl(summary: InterchangeSummary, options: ContrlOptions): Uint8Array | null {
  const data = contrlData(summary, options);
  // The values echoed were checked by the validation that read them, against another set maybe.
  return data === null ? null : serializeData(data, { checkCharacters: false });
}

export interface Acknowledged {
  readonly summary: InterchangeSummary;
  readonly outcome: AcknowledgementOutcome;
  /** The CONTRL; null when the interchange gets none, and `notAnswered` says why. */
  readonly contrl: Uint8Array | null;
  readonly notAnswered: NotAnswered | null;
}

export interface AcknowledgeOptions extends Omit<ContrlOptions, "reference"> {
  /**
   * The reference of the CONTRL for an interchange: a string for one, a function for several. The
   * function is called only for an interchange that will be answered, once.
   */
  readonly reference: string | ((summary: InterchangeSummary) => string);
  /** How to validate: registries, code lists, memory budget. */
  readonly validate?: Omit<ValidateOptions, "summary">;
}

export interface AcknowledgeResult {
  /** One for each interchange the file could be read into. */
  readonly interchanges: readonly Acknowledged[];
  /**
   * The validation. An empty `interchanges` and a report that is not valid and not complete mean
   * a file that could not be read at all (no CONTRL can be written: nobody is known to answer to).
   */
  readonly report: ValidationReport;
}

/** Validates a file and answers each interchange in it. The file is read once, a message at a time. */
export function acknowledge(bytes: Uint8Array, options: AcknowledgeOptions): AcknowledgeResult {
  const report = validate(bytes, { ...options.validate, summary: true });
  const { reference, validate: _validate, ...rest } = options;
  const interchanges = report.interchanges.map((summary): Acknowledged => {
    const outcome = outcomeOf(summary);
    const why = notAnswered(summary, options.always);
    if (why !== null) {
      return { summary, outcome, contrl: null, notAnswered: why };
    }
    const own = typeof reference === "function" ? reference(summary) : reference;
    return {
      summary,
      outcome,
      contrl: contrl(summary, { ...rest, reference: own }),
      notAnswered: null,
    };
  });
  return { interchanges, report };
}

// --- Reading ------------------------------------------------------------------------------

export type AcknowledgementStatus = "accepted" | "rejected" | "received" | "unknown";

/** What a UCI or a UCM says about what it names. */
export interface ErrorReport {
  /** The syntax error code (0085); null for none. */
  readonly code: string | null;
  /** The tag of the service segment at fault. */
  readonly segment: string | null;
  /** The position of the data element (and component) at fault. */
  readonly element: number | null;
  readonly component: number | null;
}

/** What a UCS and the UCDs after it say: a segment of the message, and the data elements at fault in it. */
export interface SegmentError {
  /** The position of the segment in the message, UNH being 1. */
  readonly position: number | null;
  /** The error that concerns the segment as a whole. */
  readonly code: string | null;
  readonly elements: readonly {
    readonly code: string | null;
    readonly element: number | null;
    readonly component: number | null;
  }[];
}

export interface MessageAcknowledgement extends ErrorReport {
  readonly reference: string;
  readonly identifier: readonly string[];
  readonly action: string;
  readonly status: AcknowledgementStatus;
  /** The segments of the body that the CONTRL says are wrong (UCS and UCD). */
  readonly segmentErrors: readonly SegmentError[];
}

/** The answer to one interchange: what a UCI and the UCMs after it say. */
export interface InterchangeAcknowledgement extends ErrorReport {
  readonly reference: string;
  readonly sender: readonly string[];
  readonly recipient: readonly string[];
  readonly action: string;
  readonly status: AcknowledgementStatus;
  readonly messages: readonly MessageAcknowledgement[];
  /** Accepted whole, in part, or rejected: from the action of the UCI and of its UCMs. */
  readonly outcome: AcknowledgementOutcome | "received" | "unknown";
}

const STATUS: Readonly<Record<string, AcknowledgementStatus>> = {
  "7": "accepted",
  "4": "rejected",
  "8": "received",
};

function statusOf(action: string): AcknowledgementStatus {
  return STATUS[action] ?? "unknown";
}

function parts(segment: Segment, element: number): string[] {
  return segment.element(element)?.components.map((component) => component.text()) ?? [];
}

function whole(text: string | undefined): number | null {
  const n = Number(text);
  return text !== undefined && text !== "" && Number.isInteger(n) && n > 0 ? n : null;
}

function errorOf(segment: Segment, first: number): ErrorReport {
  const code = segment.text(first) ?? "";
  const tag = segment.text(first + 1) ?? "";
  return {
    code: code === "" ? null : code,
    segment: tag === "" ? null : tag,
    element: whole(segment.text(first + 2, 1)),
    component: whole(segment.text(first + 2, 2)),
  };
}

export interface ContrlReading {
  /** The acknowledgements found, in file order. */
  readonly acknowledgements: readonly InterchangeAcknowledgement[];
  /** The whole file was read. False when it is damaged: what comes before the damage is here. */
  readonly complete: boolean;
}

interface Open {
  head: InterchangeAcknowledgement;
  messages: MessageAcknowledgement[];
  segmentErrors: SegmentError[];
}

/**
 * The acknowledgements in the CONTRL messages of a file, in file order: one for each UCI, with the
 * UCM segments that follow it and the UCS and UCD segments under those. Other messages are left
 * alone, and so is the group a message may be in. A file that is damaged does not throw: what was
 * read before the damage is returned, and `complete` is false.
 */
export function readContrl(bytes: Uint8Array, options: ParseOptions = {}): ContrlReading {
  const found: InterchangeAcknowledgement[] = [];
  let complete = true;
  try {
    for (const message of parseMessages(bytes, options)) {
      if (message.unh.text(2, 1) === "CONTRL") {
        readMessage(message, found);
      }
    }
  } catch (error) {
    if (!(error instanceof TokenizeError || error instanceof ParseError)) {
      throw error;
    }
    complete = false;
  }
  return { acknowledgements: found, complete };
}

function readMessage(message: Message, found: InterchangeAcknowledgement[]): void {
  let current: Open | null = null;
  const closeMessage = (): void => {
    const last = current?.messages.at(-1);
    if (current !== null && last !== undefined && current.segmentErrors.length > 0) {
      current.messages[current.messages.length - 1] = {
        ...last,
        segmentErrors: current.segmentErrors,
      };
    }
    if (current !== null) {
      current.segmentErrors = [];
    }
  };
  const closeInterchange = (): void => {
    closeMessage();
    if (current !== null) {
      found.push(withOutcome(current.head, current.messages));
    }
    current = null;
  };
  for (let i = 1; i < message.segmentCount; i++) {
    const segment = message.segment(i) as Segment;
    switch (segment.tag) {
      case "UCI": {
        closeInterchange();
        const action = segment.text(4) ?? "";
        current = {
          head: {
            reference: segment.text(1) ?? "",
            sender: parts(segment, 2),
            recipient: parts(segment, 3),
            action,
            status: statusOf(action),
            messages: [],
            outcome: "unknown",
            ...errorOf(segment, 5),
          },
          messages: [],
          segmentErrors: [],
        };
        break;
      }
      case "UCM": {
        if (current !== null) {
          closeMessage();
          const action = segment.text(3) ?? "";
          current.messages.push({
            reference: segment.text(1) ?? "",
            identifier: parts(segment, 2),
            action,
            status: statusOf(action),
            segmentErrors: [],
            ...errorOf(segment, 4),
          });
        }
        break;
      }
      case "UCS": {
        const code = segment.text(2) ?? "";
        current?.segmentErrors.push({
          position: whole(segment.text(1)),
          code: code === "" ? null : code,
          elements: [],
        });
        break;
      }
      case "UCD": {
        const last = current?.segmentErrors.at(-1);
        const code = segment.text(1) ?? "";
        if (current !== null && last !== undefined) {
          current.segmentErrors[current.segmentErrors.length - 1] = {
            ...last,
            elements: [
              ...last.elements,
              {
                code: code === "" ? null : code,
                element: whole(segment.text(2, 1)),
                component: whole(segment.text(2, 2)),
              },
            ],
          };
        }
        break;
      }
    }
  }
  closeInterchange();
}

function withOutcome(
  head: InterchangeAcknowledgement,
  messages: MessageAcknowledgement[],
): InterchangeAcknowledgement {
  let outcome: InterchangeAcknowledgement["outcome"];
  if (head.status === "rejected") {
    outcome = "rejected";
  } else if (head.status === "accepted") {
    outcome = messages.some((message) => message.status === "rejected")
      ? "partially_rejected"
      : "accepted";
  } else {
    outcome = head.status;
  }
  return { ...head, messages, outcome };
}

// --- Correlation --------------------------------------------------------------------------

/** What is kept of an interchange that was sent, to recognise its acknowledgement. */
export interface SentInterchange {
  /** The interchange control reference of its UNB. */
  readonly reference: string;
  /** Identification of its sender and of its recipient (the first component of S002 and S003). */
  readonly sender: string;
  readonly recipient: string;
  /** Their qualifiers (the second component), compared when both the CONTRL and this give one. */
  readonly senderQualifier?: string;
  readonly recipientQualifier?: string;
  /** The message reference numbers of its messages, if they are known. */
  readonly messages?: readonly string[];
}

/** The part of a summary to keep about an interchange that was sent. */
export function sentFrom(summary: InterchangeSummary): SentInterchange | null {
  const { reference, sender, recipient } = summary;
  if (reference === null || sender?.[0] === undefined || recipient?.[0] === undefined) {
    return null;
  }
  return {
    reference,
    sender: sender[0],
    recipient: recipient[0],
    ...(sender[1] === undefined ? {} : { senderQualifier: sender[1] }),
    ...(recipient[1] === undefined ? {} : { recipientQualifier: recipient[1] }),
    messages: summary.messages.map((message) => message.reference),
  };
}

export type CorrelationProblem =
  /** No interchange that was sent has this reference. */
  | "UNKNOWN_INTERCHANGE"
  /** The reference is that of an interchange sent, but its sender or recipient is not. */
  | "PARTIES_DIFFER"
  /** The interchange sent was already acknowledged by an earlier acknowledgement. */
  | "DUPLICATE_ACKNOWLEDGEMENT"
  /** The CONTRL names a message that the interchange did not have. */
  | "UNKNOWN_MESSAGE"
  /** The interchange had a message that the CONTRL does not name, though it accepts or partly rejects. */
  | "MESSAGE_NOT_ACKNOWLEDGED";

export interface Correlation {
  readonly acknowledgement: InterchangeAcknowledgement;
  /** The interchange that was sent, if the reference and the parties match one. */
  readonly sent: SentInterchange | null;
  readonly problems: readonly CorrelationProblem[];
}

export interface CorrelationResult {
  readonly correlations: readonly Correlation[];
  /** The interchanges that were sent and that no acknowledgement named. */
  readonly pending: readonly SentInterchange[];
}

function sameParty(id: string, qualifier: string | undefined, written: readonly string[]): boolean {
  const [writtenId, writtenQualifier] = written;
  return (
    writtenId !== undefined &&
    writtenId !== "" &&
    writtenId === id &&
    (qualifier === undefined || writtenQualifier === undefined || writtenQualifier === qualifier)
  );
}

/**
 * Matches acknowledgements with the interchanges that were sent, by reference and parties. Each
 * sent interchange is matched once; a second acknowledgement of it is a problem, and what no
 * acknowledgement names is `pending`.
 */
export function correlate(
  acknowledgements: readonly InterchangeAcknowledgement[],
  sent: readonly SentInterchange[],
): CorrelationResult {
  const byReference = new Map<string, SentInterchange[]>();
  for (const candidate of sent) {
    const list = byReference.get(candidate.reference);
    if (list === undefined) {
      byReference.set(candidate.reference, [candidate]);
    } else {
      list.push(candidate);
    }
  }
  const matched = new Set<SentInterchange>();
  const correlations = acknowledgements.map((acknowledgement): Correlation => {
    const named = byReference.get(acknowledgement.reference) ?? [];
    const same = named.filter(
      (candidate) =>
        sameParty(candidate.sender, candidate.senderQualifier, acknowledgement.sender) &&
        sameParty(candidate.recipient, candidate.recipientQualifier, acknowledgement.recipient),
    );
    const open = same.find((candidate) => !matched.has(candidate));
    if (open !== undefined) {
      matched.add(open);
      return { acknowledgement, sent: open, problems: messageProblems(acknowledgement, open) };
    }
    const problem =
      same.length > 0
        ? "DUPLICATE_ACKNOWLEDGEMENT"
        : named.length === 0
          ? "UNKNOWN_INTERCHANGE"
          : "PARTIES_DIFFER";
    return { acknowledgement, sent: null, problems: [problem] };
  });
  return { correlations, pending: sent.filter((candidate) => !matched.has(candidate)) };
}

function messageProblems(
  acknowledgement: InterchangeAcknowledgement,
  sent: SentInterchange,
): CorrelationProblem[] {
  const problems: CorrelationProblem[] = [];
  const known = sent.messages;
  if (known === undefined) {
    return problems;
  }
  const named = new Set(acknowledgement.messages.map((message) => message.reference));
  const knownSet = new Set(known);
  if (acknowledgement.messages.some((message) => !knownSet.has(message.reference))) {
    problems.push("UNKNOWN_MESSAGE");
  }
  if (
    acknowledgement.status === "accepted" &&
    acknowledgement.messages.length > 0 &&
    known.some((reference) => !named.has(reference))
  ) {
    problems.push("MESSAGE_NOT_ACKNOWLEDGED");
  }
  return problems;
}
