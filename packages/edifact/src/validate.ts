import { type CodeListCheck, checkSegment } from "./elements.ts";
import { EnvelopeChecker, type IssueSink } from "./envelope.ts";
import { ParseError, TokenizeError } from "./errors.ts";
import {
  ISSUE_CATALOGUE,
  type IssueDraft,
  isIssueCode,
  makeIssue,
  shown,
  type ValidationIssue,
} from "./issues.ts";
import type { LineColumn } from "./line-index.ts";
import { type ParseOptions, parseMessages } from "./parser.ts";
import { findRegistry, type RegistryView } from "./registry.ts";
import { StructureChecker } from "./structure.ts";
import { type InterchangeSummary, Summaries } from "./summary.ts";
import type { Message, Segment } from "./tree.ts";
import type { ParseIssue } from "./types.ts";

export interface ValidateOptions {
  /** Most issues to keep (all are counted). Default 1000. */
  readonly maxIssues?: number;
  /** Most memory, in bytes, for the arrays of one message; see {@link ParseOptions}. */
  readonly memoryBudget?: number;
  /**
   * Registries (contracts/registry) to check the structure and the data of the messages against.
   * The one that matches the message identifier of UNH (agency, version, release) is used; a
   * message that none matches is not checked and gets a warning. Without registries, only the
   * file and its envelopes are checked.
   */
  readonly registries?: readonly RegistryView[];
  /**
   * Which code lists are enforced: `closed` (default) the lists that hold every valid value,
   * `all` also the open lists, which are only what the directory knows, as warnings, `off` none.
   */
  readonly codeLists?: CodeListCheck;
  /**
   * Keep, for each interchange and each message, whether it had errors and the first one, in
   * `report.interchanges`: what a CONTRL needs. Costs a record per message. Default false.
   */
  readonly summary?: boolean;
}

export interface ValidationReport {
  /** The first issues found, in file order, at most `maxIssues` of them. */
  readonly issues: readonly ValidationIssue[];
  /** How many issues were found, including the ones that were not kept. */
  readonly issueCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  /** No error was found. Warnings do not count. */
  readonly valid: boolean;
  /**
   * The whole file was read. False when the check stopped on a problem that makes the rest of the
   * file unreadable (a cut-off file, a bad UNA string, a message too large for the memory budget):
   * the issue says which, and what comes after it has not been checked.
   */
  readonly complete: boolean;
  /** Messages and interchanges that were read before the check ended. */
  readonly messageCount: number;
  readonly interchangeCount: number;
  /** With `summary: true`, one record per interchange with its messages; empty otherwise. */
  readonly interchanges: readonly InterchangeSummary[];
}

const DEFAULT_MAX_ISSUES = 1000;

/**
 * Keeps the first issues of the file, counts all of them. The checkers find their issues message by
 * message, and the ones of a message in the order of the checks and not of the file, so the kept
 * ones are a list sorted by offset and cut at the limit: an issue that would come after the last
 * one kept, when the list is full, is only counted.
 */
class Collector implements IssueSink {
  readonly #max: number;
  readonly #kept: ValidationIssue[] = [];
  readonly #summaries: Summaries | null;
  count = 0;
  errors = 0;
  warnings = 0;

  constructor(max: number, summaries: Summaries | null = null) {
    this.#max = max;
    this.#summaries = summaries;
  }

  /** `summarised` is false for an issue that the summary has already counted (see `Summaries.pending`). */
  add(draft: IssueDraft, locate: (offset: number) => LineColumn, summarised = true): void {
    this.count++;
    if ((draft.severity ?? ISSUE_CATALOGUE[draft.code].severity) === "error") {
      this.errors++;
      if (summarised) {
        this.#summaries?.note(draft);
      }
    } else {
      this.warnings++;
    }
    const kept = this.#kept;
    if (kept.length >= this.#max && draft.offset >= (kept[kept.length - 1]?.offset ?? 0)) {
      return;
    }
    const issue = makeIssue(draft, locate);
    let at = kept.length;
    while (at > 0 && (kept[at - 1] as ValidationIssue).offset > issue.offset) {
      at--;
    }
    kept.splice(at, 0, issue);
    if (kept.length > this.#max) {
      kept.pop();
    }
  }

  /** An issue the splitter found in a value (INVALID_CHARACTER, UNSUPPORTED_CHARSET). */
  addParseIssue(issue: ParseIssue): void {
    this.add(
      {
        code: issue.code,
        segment: issue.position.segment,
        tag: issue.position.tag,
        element: issue.position.element,
        component: issue.position.component,
        repetition: issue.repetition,
        expected: issue.expected,
        found: issue.found,
        message: issue.message,
        offset: issue.offset,
      },
      () => ({ line: issue.line, column: issue.column }),
      false,
    );
  }

  /** The error that stopped the tokenizer or the parser. */
  addStop(error: TokenizeError | ParseError): void {
    if (!isIssueCode(error.code)) {
      throw error;
    }
    const draft: IssueDraft = {
      code: error.code,
      segment: error.segment,
      tag: error.tag,
      message: error.detail,
      offset: error.offset,
    };
    this.add(draft, () => ({ line: error.line, column: error.column }), false);
    this.#summaries?.stop(draft);
  }

  /** Issues the splitter counted but did not keep: they are all errors. */
  addDropped(count: number): void {
    this.count += count;
    this.errors += count;
  }

  /** The kept issues, in file order. */
  issues(): ValidationIssue[] {
    return this.#kept;
  }
}

/** The structure and the data of one message, against the registry that describes it. */
function checkMessage(
  message: Message,
  registries: readonly RegistryView[],
  sink: IssueSink,
  codeLists: CodeListCheck,
): void {
  const { unh, unt } = message;
  const type = unh.text(2, 1);
  const version = unh.text(2, 2);
  const release = unh.text(2, 3);
  const agency = unh.text(2, 4);
  if (
    type === undefined ||
    version === undefined ||
    release === undefined ||
    agency === undefined
  ) {
    return; // the identifier is incomplete: the envelope check has said so
  }
  const locate = (offset: number): LineColumn => message.interchange.locate(offset);
  const registry = findRegistry(registries, agency, version, release);
  const def = registry?.message(type);
  if (registry === undefined || def === undefined) {
    sink.add(
      {
        code: "MESSAGE_NOT_CHECKED",
        segment: unh.number,
        tag: "UNH",
        element: 2,
        found: shown(`${type} ${version} ${release} ${agency}`),
        offset: unh.element(2)?.start ?? unh.start,
      },
      locate,
    );
    return;
  }
  const structure = new StructureChecker(def, sink, locate);
  const context = { interchange: message.interchange, sink, locate, codeLists };
  // Segments are made one at a time and dropped: the list of a message is not built.
  const count = message.segmentCount;
  const last = unt === null ? count : count - 1;
  for (let i = 1; i < last; i++) {
    const segment = message.segment(i) as Segment;
    const tag = segment.tag;
    structure.feed(tag, segment.number, segment.start);
    const definition = registry.segment(tag);
    if (definition !== undefined) {
      checkSegment(segment, definition, context);
    }
  }
  if (unt === null) {
    structure.end(null, unh.number + count, message.end);
  } else {
    structure.end(unt.tag, unt.number, unt.start);
  }
}

/**
 * Checks a file and reports what is wrong with it, in plain language. A file is read once, a
 * message at a time, so the memory used is that of the largest message, not that of the file.
 *
 * What it checks: the file itself (the UNA string, segment tags, character sets, a file that is
 * cut off) and the envelopes (UNB and UNZ, UNG and UNE, UNH and UNT: mandatory data, references
 * and counts). It needs no registry for these.
 *
 * It never throws for a problem in the file: a file that stops the tokenizer ends the check with
 * an issue (`complete` is then false), and everything delivered before it has been checked.
 */
export function validate(bytes: Uint8Array, options: ValidateOptions = {}): ValidationReport {
  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  if (!Number.isInteger(maxIssues) || maxIssues < 0) {
    throw new RangeError(`maxIssues must be a non-negative integer, not ${maxIssues}`);
  }
  const summaries = options.summary === true ? new Summaries() : null;
  const collector = new Collector(maxIssues, summaries);
  const envelope = new EnvelopeChecker(collector);
  const parseOptions: ParseOptions = {
    maxIssues,
    ...(summaries === null
      ? {}
      : { onIssue: (code, position, offset) => summaries.pending(code, position, offset) }),
    ...(options.memoryBudget === undefined ? {} : { memoryBudget: options.memoryBudget }),
  };
  const registries = options.registries ?? [];
  const codeLists = options.codeLists ?? "closed";
  if (codeLists !== "closed" && codeLists !== "all" && codeLists !== "off") {
    throw new RangeError(`codeLists must be "closed", "all" or "off", not ${String(codeLists)}`);
  }
  const stream = parseMessages(bytes, parseOptions);
  let complete = true;
  let messageCount = 0;
  const interchanges = new Set<number>();
  try {
    for (const item of stream.items()) {
      interchanges.add(item.interchange.index);
      summaries?.begin(item);
      if (item.kind === "message") {
        messageCount++;
        envelope.message(item);
        if (registries.length > 0) {
          checkMessage(item, registries, collector, codeLists);
        }
      } else {
        envelope.envelope(item);
      }
    }
  } catch (error) {
    if (!(error instanceof TokenizeError || error instanceof ParseError)) {
      throw error;
    }
    complete = false;
    collector.addStop(error);
  }
  envelope.finish(complete);
  summaries?.finish();

  for (const issue of stream.issues) {
    collector.addParseIssue(issue);
  }
  collector.addDropped(stream.issueCount - stream.issues.length);

  return {
    issues: collector.issues(),
    issueCount: collector.count,
    errorCount: collector.errors,
    warningCount: collector.warnings,
    valid: collector.errors === 0,
    complete,
    messageCount,
    interchangeCount: interchanges.size,
    interchanges: summaries?.list ?? [],
  };
}
