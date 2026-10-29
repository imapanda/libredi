import {
  formatIssue,
  type InterchangeAcknowledgement,
  type InterchangeSummary,
  type MessageSummary,
  type Segment,
  type ValidationIssue,
  type ValidationReport,
} from "@libredi/edifact";
import { plain } from "./plain.ts";
import { describeElements } from "./segments.ts";
import type { Event } from "./walk.ts";

export interface Head {
  readonly file: string;
  readonly bytes: number;
  /** The directories of the registries the file was checked against, as written for a person. */
  readonly directories: readonly string[];
  /** The documents of partner overrides applied, with the name each gives itself. */
  readonly overrides: readonly { readonly file: string; readonly name: string | null }[];
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

const party = (parts: readonly string[] | null): string =>
  parts === null ? "?" : plain(parts.join(":"));

/** An issue as `formatIssue` prints it, with texts fit for a terminal: some are the file's own. */
const safe = (issue: ValidationIssue): ValidationIssue => ({
  ...issue,
  position: {
    ...issue.position,
    tag: issue.position.tag === null ? null : plain(issue.position.tag),
  },
  message: plain(issue.message),
  hint: plain(issue.hint),
});

function problems(errors: number): string {
  return errors === 0 ? "" : `  [${count(errors, "error")}]`;
}

function interchangeLine(interchange: InterchangeSummary): string {
  const number = interchange.index + 1;
  if (interchange.reference === null && interchange.sender === null) {
    return `Interchange ${number}: no UNB could be read${problems(interchange.errorCount)}`;
  }
  const facts = [
    interchange.syntaxIdentifier === null
      ? null
      : `syntax ${interchange.syntaxIdentifier}:${interchange.syntaxVersion ?? "?"}`,
    interchange.una ? "UNA string" : "no UNA string",
    interchange.acknowledgementRequest ? "acknowledgement requested" : null,
    interchange.closed ? null : "no UNZ",
  ].filter((fact) => fact !== null);
  return [
    `Interchange ${number}: ${plain(interchange.reference ?? "?")},`,
    `${party(interchange.sender)} -> ${party(interchange.recipient)}`,
    `(${facts.join(", ")})${problems(interchange.errorCount)}`,
  ].join(" ");
}

function messageLine(number: number, message: MessageSummary, segments: number | null): string {
  const [type = "?", version = "", release = "", agency = ""] = message.identifier;
  const kind = [
    type,
    `${version}.${release}`.replace(/^\.$/, ""),
    agency === "" ? "" : `(${agency})`,
  ]
    .filter((part) => part !== "")
    .join(" ");
  const size = segments === null ? "" : `, ${count(segments, "segment")}`;
  return `  Message ${number}: ${plain(kind)}, reference ${plain(message.reference)}${size}${problems(message.errorCount)}`;
}

/** The number of the segment in a column, then its tag (indented under its message) and values. */
function segmentLine(segment: Segment, indent: string): string {
  const line = `${String(segment.number).padStart(5)}  ${indent}${segment.tag}  ${describeElements(segment)}`;
  return `${line.trimEnd()}\n`;
}

function* acknowledgements(found: readonly InterchangeAcknowledgement[]): Generator<string> {
  yield "\nAcknowledgements (CONTRL)\n";
  for (const one of found) {
    const error =
      one.code === null
        ? ""
        : `, error ${plain(one.code)}${one.segment === null ? "" : ` in ${plain(one.segment)}`}`;
    yield `  Interchange ${plain(one.reference)} (${party(one.sender)} -> ${party(one.recipient)}): ${one.outcome.replace("_", " ")}${error}\n`;
    for (const message of one.messages) {
      const why =
        message.code === null
          ? ""
          : `, error ${plain(message.code)}${message.segment === null ? "" : ` in ${plain(message.segment)}`}`;
      yield `    Message ${plain(message.reference)}: ${message.status}${why}\n`;
    }
  }
}

/** The report for a person: the verdict, the issues, then the contents of the file. */
export function* textReport(
  head: Head,
  report: ValidationReport,
  events: Iterable<Event>,
  found: readonly InterchangeAcknowledgement[],
): Generator<string> {
  yield `${plain(head.file)}: ${count(head.bytes, "byte")}, ${count(report.interchanges.length, "interchange")}, ${count(report.messageCount, "message")}\n`;
  const tail = [
    report.errorCount > 0 ? count(report.errorCount, "error") : null,
    report.warningCount > 0 ? count(report.warningCount, "warning") : null,
  ].filter((part) => part !== null);
  if (report.interchanges.length === 0 && report.valid) {
    yield "Result: no interchange found in the file\n";
  } else {
    yield `Result: ${report.valid ? "valid" : "not valid"}${tail.length > 0 ? ` (${tail.join(", ")})` : ""}\n`;
  }
  if (!report.complete) {
    yield "The check stopped before the end of the file: what follows has not been checked.\n";
  }
  yield head.directories.length === 0
    ? "No registry: only the file and its envelopes were checked (see --registry).\n"
    : `Checked against the registry of ${head.directories.join(", ")}.\n`;
  if (head.overrides.length > 0) {
    const named = head.overrides.map(({ file, name }) =>
      plain(name === null ? file : `${name} (${file})`),
    );
    yield `With the overrides of ${named.join(", ")}.\n`;
  }

  if (report.issueCount > 0) {
    const more = report.issueCount - report.issues.length;
    yield `\nIssues${more > 0 ? ` (the first ${report.issues.length} of ${report.issueCount}; see --max-issues)` : ""}\n`;
    for (const issue of report.issues) {
      yield `${formatIssue(safe(issue))}\n`;
    }
  }

  let contents = false;
  for (const event of events) {
    if (!contents) {
      yield "\nContents\n";
      contents = true;
    }
    switch (event.kind) {
      case "interchange":
        yield `${interchangeLine(event.interchange)}\n`;
        break;
      case "message":
        yield `${messageLine(event.number, event.message, event.segments?.length ?? null)}\n`;
        for (const segment of event.segments ?? []) {
          yield segmentLine(segment, "  ");
        }
        break;
      case "segments":
        for (const segment of event.segments) {
          yield segmentLine(segment, "");
        }
        break;
    }
  }
  if (found.length > 0) {
    yield* acknowledgements(found);
  }
}
