#!/usr/bin/env node
import { EXIT } from "./context.ts";
import { plain, reason } from "./plain.ts";
import { run } from "./run.ts";

async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const all = Buffer.concat(chunks);
  return new Uint8Array(all.buffer, all.byteOffset, all.byteLength);
}

/** Writes to standard output, and resolves when the reader has taken what is queued. */
function write(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdout = process.stdout;
    const failed = (error: Error): void => reject(error);
    stdout.once("error", failed);
    const done = (): void => {
      stdout.off("error", failed);
      resolve();
    };
    if (stdout.write(text)) {
      done();
    } else {
      stdout.once("drain", done);
    }
  });
}

// An error on a closed pipe can come between two writes; write() is where it is reported.
process.stdout.on("error", () => {});

try {
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    stdout: write,
    stderr: (text) => process.stderr.write(text),
    stdin: readStdin,
    // pnpm runs a script in the folder of its package; the paths are the ones typed where pnpm was run.
    cwd: process.env["INIT_CWD"] ?? process.cwd(),
  });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EPIPE") {
    // `libredi inspect big.edi | head`: the reader going away is not an error to report.
    process.exitCode = EXIT.ok;
  } else {
    process.stderr.write(`libredi: ${plain(reason(error))}\n`);
    process.exitCode = EXIT.failed;
  }
}
