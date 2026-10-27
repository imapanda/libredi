import { runCli } from "./cli.ts";

// Run with `node src/main.ts registry build [options]`. The `libredi` program of @libredi/cli hands
// the arguments that follow its name to `runCli` in the same way, and has other commands too.
process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (line) => console.info(line),
  stderr: (line) => console.error(line),
});
