/** Why a mapping could not be run on a document. */
export type MappingErrorCode =
  /** An expression is not valid JSONata. */
  | "INVALID_EXPRESSION"
  /** An expression uses a function a mapping may not call, such as `$eval()` or `$now()`. */
  | "UNAVAILABLE_FUNCTION"
  /** An expression failed: `$error()`, a wrong type, a function given a bad value. */
  | "EXPRESSION_FAILED"
  /** Recursion went deeper than the limit. */
  | "TOO_DEEP"
  /** A sequence grew longer than the limit. */
  | "TOO_LONG"
  /** The document took longer than the time limit. */
  | "TIMEOUT"
  /** The worker running the document went over its memory limit. */
  | "OUT_OF_MEMORY"
  /** The worker running the document stopped for another reason, or the pool was closed. */
  | "WORKER_FAILED";

/** What a {@link MappingError} carries, as plain data that can cross a worker boundary. */
export interface MappingErrorData {
  readonly code: MappingErrorCode;
  readonly message: string;
  /** The output field being computed, such as `lines[2].unit`, or null for the whole document. */
  readonly field: string | null;
  /** Where in the expression, in characters from its start, when JSONata says. */
  readonly position: number | null;
}

/** The one error the runner throws: nothing partial is kept when it does. */
export class MappingError extends Error implements MappingErrorData {
  readonly code: MappingErrorCode;
  readonly field: string | null;
  readonly position: number | null;

  constructor(data: MappingErrorData) {
    super(data.message);
    this.name = "MappingError";
    this.code = data.code;
    this.field = data.field;
    this.position = data.position;
  }

  toData(): MappingErrorData {
    return { code: this.code, message: this.message, field: this.field, position: this.position };
  }
}

/** JSONata throws plain objects with a code (`D1011`) and a message, not `Error`s. */
interface JsonataError {
  code?: unknown;
  message?: unknown;
  position?: unknown;
}

const LIMIT_CODES: Readonly<Record<string, MappingErrorCode>> = {
  D1011: "TOO_DEEP",
  D1012: "TIMEOUT",
  D2014: "TOO_LONG",
  D2015: "TOO_LONG",
};

/** Turns whatever an evaluation threw into a {@link MappingError} for that field. */
export function toMappingError(thrown: unknown, field: string | null): MappingError {
  if (thrown instanceof MappingError) {
    return thrown.field === null && field !== null
      ? new MappingError({ ...thrown.toData(), field })
      : thrown;
  }
  if (thrown instanceof RangeError && /call stack/i.test(thrown.message)) {
    return new MappingError({
      code: "TOO_DEEP",
      message: "The expression recursed too deeply.",
      field,
      position: null,
    });
  }
  const error = (typeof thrown === "object" && thrown !== null ? thrown : {}) as JsonataError;
  const code = typeof error.code === "string" ? error.code : "";
  const message =
    typeof error.message === "string" && error.message !== "" ? error.message : String(thrown);
  return new MappingError({
    code: LIMIT_CODES[code] ?? (code.startsWith("S") ? "INVALID_EXPRESSION" : "EXPRESSION_FAILED"),
    message: code === "" ? message : `${message} (${code})`,
    field,
    position: typeof error.position === "number" ? error.position : null,
  });
}
