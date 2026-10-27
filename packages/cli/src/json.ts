import type {
  ErrorNote,
  InterchangeAcknowledgement,
  InterchangeSummary,
  MessageSummary,
  ValidationReport,
} from "@libredi/edifact";
import { valuesOf } from "./segments.ts";
import type { Head } from "./text.ts";
import type { Event } from "./walk.ts";

/** The version of the document below. A change that breaks a reader increases it. */
const JSON_SCHEMA_VERSION = 1;

const J = JSON.stringify;

const party = (parts: readonly string[] | null) =>
  parts === null
    ? null
    : { id: parts[0] ?? "", qualifier: parts[1] ?? null, address: parts[2] ?? null };

const note = (error: ErrorNote | null) =>
  error === null
    ? null
    : {
        code: error.code,
        segment: error.segment,
        tag: error.tag,
        element: error.element,
        component: error.component,
        offset: error.offset,
      };

function interchangeOf(one: InterchangeSummary) {
  return {
    index: one.index,
    reference: one.reference,
    sender: party(one.sender),
    recipient: party(one.recipient),
    syntaxIdentifier: one.syntaxIdentifier,
    syntaxVersion: one.syntaxVersion,
    characterSet: one.characterSet,
    una: one.una,
    acknowledgementRequest: one.acknowledgementRequest,
    closed: one.closed,
    errorCount: one.errorCount,
    firstError: note(one.firstError),
  };
}

/** The JSON of a message, in pieces: its facts, then its segments one at a time. */
function* messageJson(event: Extract<Event, { kind: "message" }>): Generator<string> {
  const message: MessageSummary = event.message;
  const [type, version, release, agency, associationCode] = message.identifier;
  const facts = J({
    number: event.number,
    reference: message.reference,
    type: type ?? null,
    version: version ?? null,
    release: release ?? null,
    agency: agency ?? null,
    associationCode: associationCode ?? null,
    firstSegment: message.firstSegment,
    start: message.start,
    end: message.end,
    errorCount: message.errorCount,
    firstError: note(message.firstError),
  });
  if (event.segments === null) {
    yield facts;
    return;
  }
  yield `${facts.slice(0, -1)},"segmentCount":${event.segments.length},"segments":[`;
  let first = true;
  for (const segment of event.segments) {
    yield `${first ? "" : ","}${J({
      number: segment.number,
      tag: segment.tag,
      start: segment.start,
      end: segment.end,
      elements: valuesOf(segment),
    })}`;
    first = false;
  }
  yield "]}";
}

/**
 * The JSON document of `libredi inspect --json`, in pieces that make one document when joined.
 * The messages are written as they are read; the interchanges carry the facts of their UNB and
 * their counts, and each message its UNH identifier and, unless `--no-tree`, its segments. The
 * layout is described in the README of the package.
 */
export function* jsonReport(
  head: Head,
  report: ValidationReport,
  events: Iterable<Event>,
  found: readonly InterchangeAcknowledgement[],
): Generator<string> {
  yield `{"schemaVersion":${JSON_SCHEMA_VERSION},"file":${J(head.file)},"bytes":${head.bytes},`;
  yield `"valid":${report.valid && report.interchanges.length > 0},"complete":${report.complete},`;
  yield `"counts":${J({
    interchanges: report.interchanges.length,
    messages: report.messageCount,
    issues: report.issueCount,
    errors: report.errorCount,
    warnings: report.warningCount,
  })},`;
  yield `"registries":${J(head.directories)},`;
  yield `"issues":${J(report.issues)},"interchanges":[`;
  let first = true;
  let open = false;
  let firstMessage = true;
  for (const event of events) {
    if (event.kind === "interchange") {
      if (open) {
        yield "]}";
      }
      const body = J(interchangeOf(event.interchange));
      yield `${first ? "" : ","}${body.slice(0, -1)},"messages":[`;
      first = false;
      open = true;
      firstMessage = true;
    } else if (event.kind === "message") {
      yield firstMessage ? "" : ",";
      yield* messageJson(event);
      firstMessage = false;
    }
  }
  if (open) {
    yield "]}";
  }
  yield `],"acknowledgements":${J(found)}}\n`;
}
