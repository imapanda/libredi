/**
 * Codes of the errors that stop the tokenizer. They are the working names of the sample corpus
 * (`samples/edifact/README.md`); the plain-language error model of issue #46 may rename them.
 */
export const TokenizeErrorCode = {
  /** The UNA string is malformed, cut off, or reuses a service character. */
  InvalidUna: "INVALID_UNA",
  /** The file ends inside a segment, or right after a release character. */
  UnexpectedEndOfFile: "UNEXPECTED_END_OF_FILE",
  /** A segment does not start with a three-character tag. */
  InvalidSegmentTag: "INVALID_SEGMENT_TAG",
} as const;

export type TokenizeErrorCode = (typeof TokenizeErrorCode)[keyof typeof TokenizeErrorCode];

export interface TokenizeErrorPosition {
  /** Byte offset in the input, 0-based. For a file that ends too early, the length of the input. */
  readonly offset: number;
  /** Line, 1-based. CR LF, LF and a lone CR each end a line. */
  readonly line: number;
  /** Column, 1-based, counted in bytes: a multi-byte UNOW character takes several columns. */
  readonly column: number;
  /** Number of the segment in the interchange, 1-based (UNB is 1); 0 for the UNA string. */
  readonly segment: number;
  /** Tag of that segment, or null when the problem is that there is no valid tag. */
  readonly tag: string | null;
}

/** Why the tokenizer stopped. Everything it had found before this point has been delivered. */
export class TokenizeError extends Error implements TokenizeErrorPosition {
  readonly code: TokenizeErrorCode;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly segment: number;
  readonly tag: string | null;

  constructor(code: TokenizeErrorCode, detail: string, position: TokenizeErrorPosition) {
    super(`${detail} (line ${position.line}, column ${position.column}, byte ${position.offset})`);
    this.name = "TokenizeError";
    this.code = code;
    this.offset = position.offset;
    this.line = position.line;
    this.column = position.column;
    this.segment = position.segment;
    this.tag = position.tag;
  }
}

/**
 * A byte as it can be shown in an error message: printable ASCII quoted, anything else by its
 * value, so that a message never carries a raw control character or a lone half of a character.
 */
export function describeByte(byte: number): string {
  if (byte >= 0x20 && byte <= 0x7e) {
    return `"${String.fromCharCode(byte)}"`;
  }
  return `byte 0x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

/** Codes of the errors that stop the parser. */
export const ParseErrorCode = {
  /** A message needs more memory than the budget allows. */
  MessageTooLarge: "MESSAGE_TOO_LARGE",
  /** The whole tree of a file needs more memory than `maxTreeBytes` allows. */
  TreeTooLarge: "TREE_TOO_LARGE",
  /** An element has more repetitions than the parser counts (65,535). */
  TooManyRepetitions: "TOO_MANY_REPETITIONS",
} as const;

export type ParseErrorCode = (typeof ParseErrorCode)[keyof typeof ParseErrorCode];

/**
 * Why the parser stopped, other than a {@link TokenizeError}. The messages and interchanges that
 * were complete before it have been delivered.
 */
export class ParseError extends Error implements TokenizeErrorPosition {
  readonly code: ParseErrorCode;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly segment: number;
  readonly tag: string | null;

  constructor(code: ParseErrorCode, detail: string, position: TokenizeErrorPosition) {
    super(`${detail} (line ${position.line}, column ${position.column}, byte ${position.offset})`);
    this.name = "ParseError";
    this.code = code;
    this.offset = position.offset;
    this.line = position.line;
    this.column = position.column;
    this.segment = position.segment;
    this.tag = position.tag;
  }
}

/** Codes of the errors of the serializer. */
export const SerializeErrorCode = {
  /** A segment tag is not three capital letters or digits, or is `UNA`, which has its own option. */
  InvalidTag: "INVALID_TAG",
  /** The service characters could not be read back by a tokenizer, or cannot be left out of a UNA string. */
  InvalidSeparators: "INVALID_SEPARATORS",
  /** The line break is made of something other than CR and LF. */
  InvalidLineBreak: "INVALID_LINE_BREAK",
  /** An element is repeated and the service characters have no repetition separator (syntax version 3). */
  RepetitionNotAllowed: "REPETITION_NOT_ALLOWED",
  /** A value has a character that the character set cannot hold or does not allow. */
  InvalidCharacter: "INVALID_CHARACTER",
  /** The output would be larger than `maxBytes`. */
  OutputTooLarge: "OUTPUT_TOO_LARGE",
} as const;

export type SerializeErrorCode = (typeof SerializeErrorCode)[keyof typeof SerializeErrorCode];

/**
 * Why the serializer stopped. The position is that of the data it was given, in the terms of the
 * tree: the number of the segment in the interchange (the first segment is 1, as UNB is in a
 * parsed tree), its tag, and its element and component counted from 1; `element` and `component`
 * are null when the problem is not at that level.
 */
export class SerializeError extends Error {
  readonly code: SerializeErrorCode;
  readonly position: {
    readonly segment: number;
    readonly tag: string | null;
    readonly element: number | null;
    readonly component: number | null;
  };

  constructor(code: SerializeErrorCode, detail: string, position: SerializeError["position"]) {
    super(detail);
    this.name = "SerializeError";
    this.code = code;
    this.position = position;
  }
}
