/**
 * Text for a terminal or a log: a control character, or a character that moves or reorders the
 * text that follows it (line and paragraph separators, bidirectional overrides), becomes "?", so
 * that a value taken from a file cannot act on whatever shows it or forge a line.
 */
export function plain(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    const acts =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    out += acts ? "?" : char;
  }
  return out;
}

/** What went wrong, for a message: the code of a system error first. */
export function reason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const text = error instanceof Error ? error.message : String(error);
  return code === undefined || text.includes(code) ? text : `${code}: ${text}`;
}
