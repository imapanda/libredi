/** Where a problem is, as precisely as the format allows. Every property is optional. */
export interface Position {
  /** Name of the file, as the format names it. */
  file?: string;
  /** Line of the file, from 1. */
  line?: number;
  /** Character of the line, from 1. */
  character?: number;
  /** Byte of the file, from 0, byte order mark included. */
  offset?: number;
  /** Record type, as the format names it. */
  record?: string;
  /** Column, as the format names it. */
  column?: string;
  /** Document given to a renderer, from 1. */
  document?: number;
  /** Path of the value in that document, such as lines[1].unitPrice.amount. */
  path?: string;
}

function describe(position: Position): string {
  const parts: string[] = [];
  if (position.file !== undefined) parts.push(`file ${position.file}`);
  if (position.document !== undefined) parts.push(`document ${position.document}`);
  if (position.line !== undefined) parts.push(`line ${position.line}`);
  if (position.character !== undefined) parts.push(`character ${position.character}`);
  if (position.offset !== undefined) parts.push(`byte ${position.offset}`);
  if (position.record !== undefined) parts.push(`record ${position.record}`);
  if (position.column !== undefined) parts.push(`column ${position.column}`);
  if (position.path !== undefined) parts.push(position.path);
  return parts.length === 0 ? "" : `${parts.join(", ")}: `;
}

/**
 * A file that cannot be read, or a document that cannot be written, with where it went wrong.
 * `message` starts with the position in words; `reason` is the same message without it.
 */
export class FormatError extends Error {
  override readonly name = "FormatError";
  readonly reason: string;
  readonly position: Position;

  constructor(reason: string, position: Position = {}) {
    super(`${describe(position)}${reason}`);
    this.reason = reason;
    this.position = position;
  }
}

/** One problem of a format configuration: the JSON Pointer of the offending value and why. */
export interface LayoutProblem {
  path: string;
  message: string;
}

/** A format configuration that is not valid, with every problem found. */
export class LayoutError extends Error {
  override readonly name = "LayoutError";
  readonly problems: readonly LayoutProblem[];

  constructor(problems: readonly LayoutProblem[]) {
    super(
      `The format configuration is not valid: ${problems
        .map((problem) => `${problem.path || "/"} ${problem.message}`)
        .join("; ")}`,
    );
    this.problems = problems;
  }
}
