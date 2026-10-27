import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { USAGE } from "./run.ts";
import { cli, samplePath } from "./testing.ts";

const MINIMAL = samplePath("valid", "orders-d96a-s3-unoa-minimal");

describe("the program", () => {
  it("prints its usage, with the commands and the exit codes, for --help, -h and help", async () => {
    for (const word of ["--help", "-h", "help"]) {
      const { status, out, err } = await cli([word]);
      expect([status, err]).toEqual([0, ""]);
      expect(out).toBe(USAGE);
    }
    expect(USAGE).toContain("inspect <file>");
    expect(USAGE).toContain("registry build");
    expect(USAGE).toContain("Exit status: 0 on success, 1 when inspect finds errors");
  });

  it("is a usage error (2) without a command, or with one it does not know", async () => {
    const none = await cli([]);
    expect([none.status, none.out, none.err]).toEqual([2, "", USAGE]);
    const unknown = await cli(["frobnicate"]);
    expect(unknown.status).toBe(2);
    expect(unknown.out).toBe("");
    expect(unknown.err).toBe(`libredi: unknown command "frobnicate"\n\n${USAGE}`);
  });

  it("hands `registry build` to the registry generator, with its own help and exit status", async () => {
    const help = await cli(["registry", "build", "--help"]);
    expect([help.status, help.err]).toEqual([0, ""]);
    expect(help.out).toContain("Usage: libredi registry build [options]");
    // One line break at the end, not the generator's and another.
    expect(help.out.endsWith("\n")).toBe(true);
    expect(help.out.endsWith("\n\n")).toBe(false);

    const bad = await cli(["registry", "build", "--nope"]);
    expect(bad.status).toBe(2);
    expect(bad.err).toContain("Usage: libredi registry build");

    const unknown = await cli(["registry", "frobnicate"]);
    expect(unknown.status).toBe(2);
  });
});

describe("the program as a process", () => {
  const main = fileURLToPath(new URL("./main.ts", import.meta.url));
  const node = (args: string[], options: { input?: string } = {}) =>
    spawnSync(process.execPath, [main, ...args], { encoding: "utf8", ...options });

  // Each starts a Node.js process, which a shared CI runner can take a while over.
  const SLOW = 15_000;

  it(
    "exits 0 for a file with no error",
    () => {
      const valid = node([
        "inspect",
        samplePath("valid", "orders-d96a-s3-unoa-minimal"),
        "--no-tree",
      ]);
      expect([valid.status, valid.stderr]).toEqual([0, ""]);
      expect(valid.stdout).toContain("Result: valid");
    },
    SLOW,
  );

  it(
    "exits 1 for a file with errors",
    () => {
      const invalid = node(["inspect", samplePath("invalid", "unz-count-mismatch"), "--json"]);
      expect([invalid.status, invalid.stderr]).toEqual([1, ""]);
      expect(JSON.parse(invalid.stdout).valid).toBe(false);
    },
    SLOW,
  );

  it(
    "exits 2 for a wrong command line, and 3 for a file it cannot read",
    () => {
      const usage = node(["inspect"]);
      expect(usage.status).toBe(2);
      expect(usage.stderr).toContain("inspect needs the file");

      const unreadable = node(["inspect", "/nonexistent/file.edi"]);
      expect([unreadable.status, unreadable.stdout]).toEqual([3, ""]);
      expect(unreadable.stderr).toContain("ENOENT");
    },
    SLOW,
  );

  it(
    "reads standard input for -",
    () => {
      const { status, stdout } = node(["inspect", "-", "--json", "--no-tree"], {
        input: "UNB+UNOA:3+A:1+B:1+301015:0830+R1'UNH+1+ORDERS:D:96A:UN'BGM+220'UNT+3+1'UNZ+1+R1'",
      });
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ file: "<stdin>", valid: true });
    },
    SLOW,
  );

  it.skipIf(!existsSync("/dev/full"))(
    "exits 4 and says so when the output cannot be written",
    () => {
      const full = spawnSync(
        "sh",
        ["-c", '"$0" "$1" inspect "$2" > /dev/full', process.execPath, main, MINIMAL],
        { encoding: "utf8" },
      );
      expect(full.status).toBe(4);
      expect(full.stderr).toMatch(/^libredi: .*ENOSPC/);
      expect(full.stderr).not.toContain("    at ");
    },
    SLOW,
  );

  it(
    "starts from the folder pnpm was run in (INIT_CWD) for relative paths",
    () => {
      const relative = ["inspect", "orders-d96a-s3-unoa-minimal.edi", "--no-tree"];
      // Not in the folder of the test, where there is no such file...
      expect(node(relative).status).toBe(3);
      // ...but where pnpm says it was run.
      const there = spawnSync(process.execPath, [main, ...relative], {
        encoding: "utf8",
        env: { ...process.env, INIT_CWD: dirname(MINIMAL) },
      });
      expect([there.status, there.stderr]).toEqual([0, ""]);
    },
    SLOW,
  );

  it.skipIf(process.platform === "win32")(
    "stops quietly when whoever reads its output stops reading",
    async () => {
      const folder = await mkdtemp(join(tmpdir(), "libredi-cli-pipe-"));
      try {
        const file = join(folder, "big.edi");
        const messages = Array.from(
          { length: 4000 },
          (_unused, i) => `UNH+${i + 1}+ORDERS:D:96A:UN'BGM+220'UNT+3+${i + 1}'`,
        );
        await writeFile(file, `UNB+UNOA:3+A:1+B:1+301015:0830+R1'${messages.join("")}UNZ+4000+R1'`);
        const piped = spawnSync(
          "sh",
          ["-c", `"$0" "$1" inspect "$2" | head -n 1`, process.execPath, main, file],
          {
            encoding: "utf8",
          },
        );
        expect(piped.stdout).toContain("big.edi: ");
        expect(piped.stderr).toBe("");
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
    SLOW,
  );
});
