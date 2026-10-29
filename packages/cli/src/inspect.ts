import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type CodeListCheck,
  type InterchangeAcknowledgement,
  readContrl,
  type ValidationReport,
  validate,
} from "@libredi/edifact";
import { type CliContext, EXIT } from "./context.ts";
import { jsonReport } from "./json.ts";
import { plain, reason } from "./plain.ts";
import { InputError, loadOverrides, loadRegistries } from "./registries.ts";
import { type Head, textReport } from "./text.ts";
import { walk } from "./walk.ts";

const INSPECT_USAGE = `Usage: libredi inspect <file> [options]

Shows what is in an EDIFACT file, the interchanges, the messages and their segments, and what is
wrong with it. The file is checked as a whole: its characters, its envelopes (UNB, UNG, UNH, UNT,
UNE, UNZ and their counts and references) and, with a registry, the structure and the data of
each message. Nothing is written or sent.

Arguments:
  <file>                The EDIFACT file, or - to read standard input.

Options:
  --json                Write one JSON document instead of text (the README of the package
                        describes it).
  --registry <path>     A registry (contracts/registry) to check the messages against: a JSON
                        file, or a folder of them such as the one \`libredi registry build\`
                        writes. Repeat for several. Without one, only the file and its
                        envelopes are checked.
  --overrides <path>    A document of partner overrides (contracts/overrides): the rules a
                        partner changes, applied on top of the registry of its directory, which
                        --registry must give. Repeat for several; the last one wins.
  --no-tree             Leave out the segments: list the interchanges and messages only.
  --max-issues <n>      Most issues to list; all are counted. Default 1000.
  --code-lists <mode>   Which code lists are enforced: closed (the default: the lists that hold
                        every valid value), all (open lists too, as warnings) or off.
  --memory-budget <n>   Most memory, in bytes, for the arrays of one message. Default 64 MiB; a
                        message that needs more is reported and the check stops there.
  -h, --help            Show this help.

Exit status:
  0  the file has no error (warnings do not count)
  1  the file has errors, or holds no interchange
  2  the command line is wrong
  3  the file or a registry cannot be read
  4  something else went wrong: the output cannot be written, or a bug
`;

class UsageError extends Error {}

interface Arguments {
  readonly file: string;
  readonly json: boolean;
  readonly registries: readonly string[];
  readonly overrides: readonly string[];
  readonly tree: boolean;
  readonly maxIssues: number | undefined;
  readonly codeLists: CodeListCheck | undefined;
  readonly memoryBudget: number | undefined;
}

/** A whole number from the command line: digits only, and small enough to be exact. */
function wholeNumber(option: string, text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const value = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value)) {
    throw new UsageError(`--${option} expects a whole number, not "${text}"`);
  }
  return value;
}

function parseArguments(argv: readonly string[]): Arguments | "help" {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      registry: { type: "string", multiple: true },
      overrides: { type: "string", multiple: true },
      "no-tree": { type: "boolean" },
      "max-issues": { type: "string" },
      "code-lists": { type: "string" },
      "memory-budget": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    return "help";
  }
  const [file, ...extra] = positionals;
  if (file === undefined) {
    throw new UsageError("inspect needs the file to look at (or - for standard input)");
  }
  if (extra.length > 0) {
    throw new UsageError(`inspect takes one file, not ${positionals.length}`);
  }
  const registries = values.registry ?? [];
  if (registries.includes("")) {
    throw new UsageError("--registry expects the path of a registry file or folder");
  }
  const overrides = values.overrides ?? [];
  if (overrides.includes("")) {
    throw new UsageError("--overrides expects the path of a document of overrides");
  }
  const mode = values["code-lists"];
  if (mode !== undefined && mode !== "closed" && mode !== "all" && mode !== "off") {
    throw new UsageError(`--code-lists expects closed, all or off, not "${mode}"`);
  }
  return {
    file,
    json: values.json === true,
    registries,
    overrides,
    tree: values["no-tree"] !== true,
    maxIssues: wholeNumber("max-issues", values["max-issues"]),
    codeLists: mode,
    memoryBudget: wholeNumber("memory-budget", values["memory-budget"]),
  };
}

/** Writes the pieces in blocks, waiting for the reader: a million segments are not a million writes. */
async function emit(
  pieces: Iterable<string>,
  write: (text: string) => void | Promise<void>,
): Promise<void> {
  const BLOCK = 1 << 16;
  let block = "";
  for (const piece of pieces) {
    block += piece;
    if (block.length >= BLOCK) {
      await write(block);
      block = "";
    }
  }
  if (block !== "") {
    await write(block);
  }
}

/** `libredi inspect`. The arguments are those after the command. Returns the exit status. */
export async function inspect(argv: readonly string[], context: CliContext): Promise<number> {
  const { stdout, stderr } = context;
  const fail = (status: number, message: string): number => {
    stderr(`libredi: ${plain(message)}\n`);
    return status;
  };
  let args: Arguments | "help";
  try {
    args = parseArguments(argv);
  } catch (error) {
    if (
      error instanceof UsageError ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      stderr(`libredi: ${plain((error as Error).message)}\n\n${INSPECT_USAGE}`);
      return EXIT.usage;
    }
    throw error;
  }
  if (args === "help") {
    await stdout(INSPECT_USAGE);
    return EXIT.ok;
  }

  const cwd = context.cwd ?? process.cwd();
  let bytes: Uint8Array;
  try {
    if (args.file === "-") {
      if (context.stdin === undefined) {
        throw new Error("standard input is not available");
      }
      bytes = await context.stdin();
    } else {
      // The file as it was read, not a copy of it: a Buffer is a view on memory that is not reused.
      const buffer = await readFile(resolve(cwd, args.file));
      bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
  } catch (error) {
    return fail(
      EXIT.unreadable,
      `cannot read ${args.file === "-" ? "standard input" : args.file}: ${reason(error)}`,
    );
  }

  let registries: Awaited<ReturnType<typeof loadRegistries>>;
  let overrides: Awaited<ReturnType<typeof loadOverrides>>;
  try {
    registries = await loadRegistries(args.registries, cwd);
    overrides = await loadOverrides(args.overrides, cwd, registries);
  } catch (error) {
    if (error instanceof InputError) {
      return fail(EXIT.unreadable, error.message);
    }
    throw error;
  }

  let report: ValidationReport;
  try {
    report = validate(bytes, {
      summary: true,
      registries,
      overrides: overrides.map((loaded) => loaded.overrides),
      ...(args.maxIssues === undefined ? {} : { maxIssues: args.maxIssues }),
      ...(args.codeLists === undefined ? {} : { codeLists: args.codeLists }),
      ...(args.memoryBudget === undefined ? {} : { memoryBudget: args.memoryBudget }),
    });
  } catch (error) {
    // The engine refuses a number it cannot use, such as a memory budget that is too small.
    if (error instanceof RangeError) {
      stderr(`libredi: ${plain(error.message)}\n\n${INSPECT_USAGE}`);
      return EXIT.usage;
    }
    throw error;
  }
  const head: Head = {
    file: args.file === "-" ? "<stdin>" : args.file,
    bytes: bytes.length,
    directories: registries.map(
      ({ directory }) => `${directory.version}.${directory.release} (${directory.agency})`,
    ),
    overrides: overrides.map(({ path, name }) => ({ file: path, name })),
  };
  // What a CONTRL in the file says is worth showing; reading the file again is only done for one.
  const found: readonly InterchangeAcknowledgement[] = report.interchanges.some((one) =>
    one.messages.some((message) => message.identifier[0] === "CONTRL"),
  )
    ? readContrl(bytes, args.memoryBudget === undefined ? {} : { memoryBudget: args.memoryBudget })
        .acknowledgements
    : [];
  const events = walk(bytes, report.interchanges, args.tree, args.memoryBudget);
  await emit(
    args.json ? jsonReport(head, report, events, found) : textReport(head, report, events, found),
    stdout,
  );
  return report.valid && report.interchanges.length > 0 ? EXIT.ok : EXIT.invalid;
}
