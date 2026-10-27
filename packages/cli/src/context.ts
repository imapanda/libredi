/** Everything the commands touch outside their arguments, so that a test can run them. */
export interface CliContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Writes text as it is: the pieces carry their own line breaks. It may return a promise, which
   * the command waits for before it writes more, so that a slow reader slows the command down
   * instead of making it keep the whole output.
   */
  readonly stdout: (text: string) => void | Promise<void>;
  readonly stderr: (text: string) => void;
  /** Reads standard input to its end, for `inspect -`. */
  readonly stdin?: () => Promise<Uint8Array>;
  /** The folder relative paths are relative to. Default: the working directory. */
  readonly cwd?: string;
}

/** The exit status of the program; the README of the package documents them. */
export const EXIT = {
  /** Done, and for `inspect` the file has no error (warnings do not count). */
  ok: 0,
  /** `inspect`: the file has errors, or holds no interchange. */
  invalid: 1,
  /** The command line is wrong. */
  usage: 2,
  /** A file or a registry cannot be read. */
  unreadable: 3,
  /** Something else went wrong: the output cannot be written, or a bug. */
  failed: 4,
} as const;
