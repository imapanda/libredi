import { runCli as registry } from "@libredi/registry/cli";
import { type CliContext, EXIT } from "./context.ts";
import { inspect } from "./inspect.ts";

export { type CliContext, EXIT } from "./context.ts";

export const USAGE = `Usage: libredi <command> [options]

Commands:
  inspect <file>
    Show the interchanges, messages and segments of an EDIFACT file, and what is wrong with it
    (text, or JSON with --json).
  registry build
    Build the EDIFACT definition registry from the UN/ECE directories.

Run \`libredi <command> --help\` for the options of a command.

Exit status: 0 on success, 1 when inspect finds errors in the file or a registry build fails,
2 on a usage error, 3 when a file or a registry cannot be read, 4 on another failure. Each
command's help says more.
`;

/**
 * `libredi registry build` is the generator's own command: it writes lines through callbacks that
 * do not wait, and its status is its own (0, 1 or 2). What the context's `stdout` returns is
 * awaited at the end, and a failed write is thrown then.
 */
async function registryCommand(argv: readonly string[], context: CliContext): Promise<number> {
  const pending: Promise<void>[] = [];
  let failure: unknown;
  const line = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);
  const status = await registry([...argv], {
    env: { ...context.env },
    stdout: (text) => {
      const done = context.stdout(line(text));
      if (done !== undefined) {
        pending.push(
          done.catch((error: unknown) => {
            failure ??= error;
          }),
        );
      }
    },
    stderr: (text) => context.stderr(line(text)),
  });
  await Promise.all(pending);
  if (failure !== undefined) {
    throw failure;
  }
  return status;
}

/**
 * The `libredi` program. The arguments are those after the program name. Returns the exit status
 * instead of exiting, so that a test can run it.
 */
export async function run(argv: readonly string[], context: CliContext): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "inspect":
      return inspect(rest, context);
    case "registry":
      return registryCommand(argv, context);
    case "-h":
    case "--help":
    case "help":
      await context.stdout(USAGE);
      return EXIT.ok;
    case undefined:
      context.stderr(USAGE);
      return EXIT.usage;
    default:
      context.stderr(`libredi: unknown command "${command}"\n\n${USAGE}`);
      return EXIT.usage;
  }
}
