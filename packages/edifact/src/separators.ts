import { describeByte } from "./errors.ts";

/**
 * The service characters of an interchange, as byte values. All of them are single ASCII
 * bytes, so the tokenizer can scan UNOA, UNOB, UNOC and UNOW (UTF-8) text byte by byte: no byte
 * of a multi-byte UTF-8 character can be mistaken for a separator.
 */
export interface Separators {
  readonly component: number;
  readonly element: number;
  readonly decimalMark: number;
  readonly release: number;
  /** Syntax 4 only; null when the interchange has none (syntax 3 reserves a space for it). */
  readonly repetition: number | null;
  readonly terminator: number;
  /** True when a UNA string declared these characters, false for the defaults. */
  readonly declared: boolean;
}

/** `UNA:+.? '`: what applies when an interchange has no UNA string. */
export const DEFAULT_SEPARATORS: Separators = Object.freeze({
  component: 0x3a,
  element: 0x2b,
  decimalMark: 0x2e,
  release: 0x3f,
  repetition: null,
  terminator: 0x27,
  declared: false,
});

/**
 * `UNA:+.?*'`: what syntax version 4 assumes when an interchange has no UNA string. It is the
 * default characters with the asterisk as repetition separator (ISO 9735-1:2002, which
 * introduced the repetition separator).
 */
export const SYNTAX_4_SEPARATORS: Separators = Object.freeze({
  ...DEFAULT_SEPARATORS,
  repetition: 0x2a,
});

const MAX_IDENTIFIER = 32;

/**
 * Whether the UNB segment whose tag starts at `tag` announces syntax version 4, for an
 * interchange that has no UNA string: `UNB+` an identifier, the component separator, then `4` as
 * a whole component. Read with the default service characters, since nothing else applies yet.
 * The tokenizer asks once per interchange, at its first segment, so that the asterisk is the
 * repetition separator from the very first token.
 */
export function announcesSyntax4(bytes: Uint8Array, tag: number): boolean {
  const { element, component, release, terminator } = DEFAULT_SEPARATORS;
  let i = tag + 3;
  if (bytes[i++] !== element) {
    return false;
  }
  const limit = Math.min(bytes.length, i + MAX_IDENTIFIER);
  while (i < limit && bytes[i] !== component) {
    const byte = bytes[i] as number;
    if (byte === element || byte === release || byte === terminator) {
      return false;
    }
    i++;
  }
  if (bytes[i] !== component || bytes[i + 1] !== 0x34) {
    return false;
  }
  const after = bytes[i + 2];
  return after === element || after === component || after === terminator;
}

/** The default characters, when a UNA string says so: the one set that is shared, not rebuilt. */
export const DECLARED_DEFAULT_SEPARATORS: Separators = Object.freeze({
  ...DEFAULT_SEPARATORS,
  declared: true,
});

export type ServiceStringAdviceResult =
  | { readonly ok: true; readonly separators: Separators }
  | {
      readonly ok: false;
      /** Offset of the byte at fault, or of the end of the input when it is cut off. */
      readonly offset: number;
      readonly reason: string;
      /** True when the input ends before the nine bytes are complete. */
      readonly truncated: boolean;
    };

/** "UNA" and the six service characters. */
export const SERVICE_STRING_LENGTH = 9;

const ROLES = [
  "component separator",
  "element separator",
  "decimal mark",
  "release character",
  "repetition separator",
  "segment terminator",
] as const;

const SPACE = 0x20;
const REPETITION = 4;
const DECIMAL_MARK = 2;

function isPunctuation(byte: number): boolean {
  return (
    (byte >= 0x21 && byte <= 0x2f) ||
    (byte >= 0x3a && byte <= 0x40) ||
    (byte >= 0x5b && byte <= 0x60) ||
    (byte >= 0x7b && byte <= 0x7e)
  );
}

/**
 * Reads the UNA string that starts at `start` (where "UNA" has been found). The six characters
 * must be distinct ASCII punctuation marks, apart from the repetition position, which may be the
 * reserved space of syntax 3, and the decimal mark, which must be a point or a comma. Letters and
 * digits are refused so that a separator can never be mistaken for part of a segment tag.
 */
export function readServiceStringAdvice(
  bytes: Uint8Array,
  start: number,
): ServiceStringAdviceResult {
  if (start + SERVICE_STRING_LENGTH > bytes.length) {
    return {
      ok: false,
      offset: bytes.length,
      reason: `only ${bytes.length - start} of the ${SERVICE_STRING_LENGTH} bytes it needs are left`,
      truncated: true,
    };
  }
  const chars: number[] = [];
  for (let role = 0; role < ROLES.length; role++) {
    const byte = bytes[start + 3 + role] as number;
    const offset = start + 3 + role;
    const name = ROLES[role] as string;
    if (role === DECIMAL_MARK) {
      if (byte !== 0x2e && byte !== 0x2c) {
        return {
          ok: false,
          offset,
          reason: `the decimal mark must be "." or ",", not ${describeByte(byte)}`,
          truncated: false,
        };
      }
    } else if (!isPunctuation(byte) && !(role === REPETITION && byte === SPACE)) {
      return {
        ok: false,
        offset,
        reason: `the ${name} (${describeByte(byte)}) must be an ASCII punctuation mark, not a letter, a digit, a space, a control character or a byte above 0x7E`,
        truncated: false,
      };
    }
    const unused = role === REPETITION && byte === SPACE;
    const clash = unused ? -1 : chars.indexOf(byte);
    if (clash !== -1) {
      return {
        ok: false,
        offset,
        reason: `the ${ROLES[clash]} and the ${name} are both ${describeByte(byte)}`,
        truncated: false,
      };
    }
    chars.push(unused ? -2 : byte);
  }
  const [component, element, decimalMark, release, repetition, terminator] = chars as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const same =
    component === DEFAULT_SEPARATORS.component &&
    element === DEFAULT_SEPARATORS.element &&
    decimalMark === DEFAULT_SEPARATORS.decimalMark &&
    release === DEFAULT_SEPARATORS.release &&
    repetition === -2 &&
    terminator === DEFAULT_SEPARATORS.terminator;
  return {
    ok: true,
    separators: same
      ? DECLARED_DEFAULT_SEPARATORS
      : Object.freeze({
          component,
          element,
          decimalMark,
          release,
          repetition: repetition === -2 ? null : repetition,
          terminator,
          declared: true,
        }),
  };
}

/**
 * Whether the UNA string at `start` spells exactly the service characters already in force.
 * Used to skip the work of reading a UNA string again when a file repeats it.
 */
export function matchesServiceString(
  bytes: Uint8Array,
  start: number,
  separators: Separators,
): boolean {
  return (
    bytes[start + 3] === separators.component &&
    bytes[start + 4] === separators.element &&
    bytes[start + 5] === separators.decimalMark &&
    bytes[start + 6] === separators.release &&
    bytes[start + 7] === (separators.repetition ?? SPACE) &&
    bytes[start + 8] === separators.terminator
  );
}
