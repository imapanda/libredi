import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSample } from "@libredi/edifact/testing/corpus";
import { corpusRegistries } from "@libredi/edifact/testing/corpus-registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "./context.ts";
import {
  cli,
  corpusRegistryFolder,
  type JsonReport,
  must,
  registryDocument,
  samplePath,
} from "./testing.ts";

const text = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "latin1"));
const MINIMAL = samplePath("valid", "orders-d96a-s3-unoa-minimal");
const MSG = "UNH+1+ORDERS:D:96A:UN'BGM+220'UNT+3+1'";
const UNB = "UNB+UNOA:3+A:1+B:1+301015:0830+R1++++1'";

let scratch: string;
let registries: Awaited<ReturnType<typeof corpusRegistryFolder>>;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "libredi-cli-test-"));
  registries = await corpusRegistryFolder();
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  await registries.remove();
});

const inStdin = async (file: string, ...options: string[]) =>
  cli(["inspect", "-", ...options], { stdin: text(file) });

describe("the command line", () => {
  it("prints its help, on standard output, with the exit codes", async () => {
    for (const flag of ["--help", "-h"]) {
      const { status, out, err } = await cli(["inspect", flag]);
      expect([status, err]).toEqual([EXIT.ok, ""]);
      expect(out).toContain("Usage: libredi inspect <file> [options]");
      expect(out).toMatch(/Exit status:\n {2}0 .*\n {2}1 .*\n {2}2 .*\n {2}3 /);
    }
  });

  it.each([
    [[], "needs the file"],
    [["a.edi", "b.edi"], "takes one file, not 2"],
    [["a.edi", "--nope"], "nope"],
    [["a.edi", "--max-issues"], "max-issues"],
    [["a.edi", "--max-issues", "many"], '--max-issues expects a whole number, not "many"'],
    [["a.edi", "--max-issues", "-1"], "--max-issues"],
    [["a.edi", "--max-issues", "1.5"], "--max-issues"],
    [["a.edi", "--code-lists", "some"], '--code-lists expects closed, all or off, not "some"'],
    [["a.edi", "--registry"], "registry"],
    [["a.edi", "--registry="], "--registry expects the path of a registry file or folder"],
    [["a.edi", "--no-json"], "no-json"],
    [["a.edi", "--memory-budget", "lots"], '--memory-budget expects a whole number, not "lots"'],
    [[MINIMAL, "--memory-budget", "1"], "memoryBudget must be an integer from"],
  ])("%j is a usage error (2) that says why and shows the usage", async (args, why) => {
    const { status, out, err } = await cli(["inspect", ...args]);
    expect(status).toBe(EXIT.usage);
    expect(out).toBe("");
    expect(err).toContain(why);
    expect(err).toContain("Usage: libredi inspect");
  });

  it("reads the file it is given, or standard input with -", async () => {
    const file = await cli(["inspect", MINIMAL, "--no-tree"]);
    expect(file.status).toBe(0);
    expect(file.out).toContain(`${MINIMAL}: 280 bytes, 1 interchange, 1 message`);
    const stdin = await inStdin(`${UNB}${MSG}UNZ+1+R1'`, "--no-tree");
    expect(stdin.status).toBe(0);
    expect(stdin.out).toContain("<stdin>: ");
  });

  it("cannot read standard input when the program has none", async () => {
    const { run } = await import("./run.ts");
    let err = "";
    const status = await run(["inspect", "-"], {
      env: {},
      stdout: () => {},
      stderr: (t) => (err += t),
    });
    expect([status, err]).toEqual([
      EXIT.unreadable,
      "libredi: cannot read standard input: standard input is not available\n",
    ]);
  });
});

describe("a file that cannot be read is 3, and says which", () => {
  it("does not exist", async () => {
    const { status, out, err } = await cli(["inspect", join(scratch, "nothing.edi")]);
    expect([status, out]).toEqual([EXIT.unreadable, ""]);
    expect(err).toMatch(/^libredi: cannot read .*nothing\.edi: ENOENT/);
  });

  it("is a folder", async () => {
    const { status, err } = await cli(["inspect", scratch]);
    expect(status).toBe(EXIT.unreadable);
    expect(err).toContain("EISDIR");
  });
});

describe("a file with nothing in it", () => {
  it.each([[""], ["\n\n"]])("%j holds no interchange: exit 1", async (file) => {
    const { status, out } = await inStdin(file);
    expect(status).toBe(EXIT.invalid);
    expect(out).toContain("0 interchanges, 0 messages");
    expect(out).toContain("Result: no interchange found in the file");
    const json = JSON.parse((await inStdin(file, "--json")).out);
    expect(json).toMatchObject({ valid: false, complete: true, interchanges: [] });
  });
});

describe("the registries", () => {
  const write = async (name: string, content: string): Promise<string> => {
    const path = join(scratch, name);
    await writeFile(path, content);
    return path;
  };

  it("take a file, a folder, or several", async () => {
    const d96a = await write(
      "d96a.json",
      JSON.stringify(registryDocument(corpusRegistries[0] as never)),
    );
    const one = await cli(["inspect", MINIMAL, "--registry", d96a, "--no-tree"]);
    expect([one.status, one.out]).toEqual([0, expect.stringContaining("registry of D.96A (UN).")]);
    const folder = await cli(["inspect", MINIMAL, "--registry", registries.folder, "--no-tree"]);
    expect(folder.out).toContain("registry of D.01B (UN), D.96A (UN).");
    const d01b = await write(
      "d01b.json",
      JSON.stringify(registryDocument(corpusRegistries[1] as never)),
    );
    const two = await cli([
      "inspect",
      MINIMAL,
      "--registry",
      d96a,
      "--registry",
      d01b,
      "--no-tree",
    ]);
    expect(two.out).toContain("registry of D.96A (UN), D.01B (UN).");
  });

  it("make the structure and the data of a message checked", async () => {
    const without = await cli(["inspect", samplePath("invalid", "unknown-code"), "--no-tree"]);
    expect([without.status, without.out]).toEqual([0, expect.stringContaining("Result: valid")]);
    const checked = await cli([
      "inspect",
      samplePath("invalid", "unknown-code"),
      "--registry",
      registries.folder,
      "--no-tree",
    ]);
    expect(checked.status).toBe(1);
    expect(checked.out).toContain("error UNKNOWN_CODE at line");
  });

  it("enforce a code list as --code-lists says: closed lists, all lists as warnings, or none", async () => {
    const unknown = samplePath("invalid", "unknown-code");
    const base = ["inspect", unknown, "--registry", registries.folder, "--no-tree"];
    // The corpus list is closed: an unknown code is an error, unless the lists are off.
    expect((await cli([...base, "--code-lists", "closed"])).status).toBe(1);
    expect((await cli([...base, "--code-lists", "all"])).status).toBe(1);
    const off = await cli([...base, "--code-lists", "off"]);
    expect([off.status, off.out]).toEqual([0, expect.stringContaining("Result: valid\n")]);

    // The same registry with that list open: closed leaves it, all warns, off leaves it.
    const open = registryDocument(corpusRegistries[0] as never) as {
      codeLists: Record<string, { closed: boolean }>;
    };
    must(open.codeLists["3035"]).closed = false;
    const path = join(scratch, "open-list.json");
    await writeFile(path, JSON.stringify(open));
    const args = ["inspect", unknown, "--registry", path, "--no-tree"];
    const closed = await cli([...args, "--code-lists", "closed"]);
    expect([closed.status, closed.out]).toEqual([0, expect.stringContaining("Result: valid\n")]);
    const all = await cli([...args, "--code-lists", "all"]);
    expect([all.status, all.out]).toEqual([
      0,
      expect.stringContaining("Result: valid (1 warning)\n"),
    ]);
    expect(all.out).toContain("warning UNKNOWN_CODE at line");
    expect((await cli([...args, "--code-lists", "off"])).out).toContain("Result: valid\n");
    // Without the option, it is closed.
    expect((await cli(args)).out).toContain("Result: valid\n");
  });

  it("are refused, with exit 3, when they are not usable", async () => {
    // A registry nested thousands deep is valid in shape and overflows the recursion of the checks.
    const nested = `{"schemaVersion":1,"syntaxVersions":[3],"source":{"kind":"handwritten"},"directory":{"agency":"UN","version":"D","release":"96A"},"dataElements":{},"composites":{},"segments":{},"codeLists":{},"messages":{"X":{"name":"x","nodes":[${'{"kind":"group","id":"SG1","status":"C","maxOccurs":1,"trigger":"BGM","nodes":['.repeat(20000)}${"]}".repeat(20000)}]}}}`;
    const failures: [string, string][] = [
      [join(scratch, "missing.json"), "cannot read registry"],
      [await write("broken.json", "{ not json"), "cannot read registry"],
      [await write("shape.json", '{"schemaVersion":1}'), "is not a registry (contracts/registry)"],
      [await write("deep.json", nested), "is nested too deeply to be a registry"],
    ];
    for (const [path, why] of failures) {
      const { status, out, err } = await cli(["inspect", MINIMAL, "--registry", path]);
      expect([status, out], path).toEqual([EXIT.unreadable, ""]);
      expect(err, path).toContain(why);
      expect(err, path).toContain(path);
    }
  });

  it("are refused, with exit 3, when the folder cannot be read", async () => {
    const locked = join(scratch, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      // A user who can read anything (root) is not locked out: there is nothing to check then.
      if (process.getuid?.() === 0) {
        return;
      }
      const { status, out, err } = await cli(["inspect", MINIMAL, "--registry", locked]);
      expect([status, out]).toEqual([EXIT.unreadable, ""]);
      expect(err).toMatch(/^libredi: cannot read registry .*locked: EACCES/);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("follow a link to a registry, and read a file given twice once", async () => {
    const folder = join(scratch, "linked");
    await mkdir(folder);
    const real = await write(
      "linked-target.json",
      JSON.stringify(registryDocument(corpusRegistries[0] as never)),
    );
    await symlink(real, join(folder, "d96a.json"));
    const linked = await cli(["inspect", MINIMAL, "--registry", folder, "--no-tree"]);
    expect([linked.status, linked.out]).toEqual([
      0,
      expect.stringContaining("registry of D.96A (UN)."),
    ]);
    const twice = await cli([
      "inspect",
      MINIMAL,
      "--registry",
      real,
      "--registry",
      real,
      "--no-tree",
    ]);
    expect(twice.status).toBe(0);
    // A link that leads nowhere is a registry that cannot be read, not a file that is skipped.
    await symlink(join(scratch, "nowhere.json"), join(folder, "gone.json"));
    const broken = await cli(["inspect", MINIMAL, "--registry", folder]);
    expect(broken.status).toBe(EXIT.unreadable);
    expect(broken.err).toContain("gone.json");
  });

  it("are looked for from the folder the program was run in, for a relative path", async () => {
    const folder = join(scratch, "cwd");
    await mkdir(folder);
    await copyFile(MINIMAL, join(folder, "orders.edi"));
    await writeFile(
      join(folder, "d96a.json"),
      JSON.stringify(registryDocument(corpusRegistries[0] as never)),
    );
    const relative = await cli(["inspect", "orders.edi", "--registry", "d96a.json", "--no-tree"], {
      cwd: folder,
    });
    expect([relative.status, relative.err]).toEqual([0, ""]);
    expect(relative.out).toContain("orders.edi: 280 bytes");
    expect(relative.out).toContain("registry of D.96A (UN).");
    const folderToo = await cli(["inspect", "orders.edi", "--registry", ".", "--no-tree"], {
      cwd: folder,
    });
    expect(folderToo.out).toContain("registry of D.96A (UN).");
    const missing = await cli(["inspect", "nothing.edi"], { cwd: folder });
    expect(missing.err).toMatch(/^libredi: cannot read nothing\.edi: ENOENT/);
  });

  it("are refused when a folder holds none, or two for one directory", async () => {
    const empty = join(scratch, "empty");
    await mkdir(empty);
    await writeFile(join(empty, ".hidden.json"), "{}");
    const none = await cli(["inspect", MINIMAL, "--registry", empty]);
    expect([none.status, none.err]).toEqual([
      EXIT.unreadable,
      `libredi: no .json registry in the folder ${empty}\n`,
    ]);

    const twice = join(scratch, "twice");
    await mkdir(twice);
    const document = JSON.stringify(registryDocument(corpusRegistries[0] as never));
    await writeFile(join(twice, "a.json"), document);
    await writeFile(join(twice, "b.json"), document);
    const both = await cli(["inspect", MINIMAL, "--registry", twice]);
    expect(both.status).toBe(EXIT.unreadable);
    expect(both.err).toContain("are both the registry of D.96A (UN): keep one");
  });

  it("are refused when their references do not hold together", async () => {
    const document = registryDocument(corpusRegistries[0] as never) as {
      segments: Record<string, { elements: { ref: string }[] }>;
    };
    document.segments["BGM"]?.elements.push({ ref: "9999", status: "C" } as never);
    const path = join(scratch, "dangling.json");
    await writeFile(path, JSON.stringify(document));
    const { status, err } = await cli(["inspect", MINIMAL, "--registry", path]);
    expect(status).toBe(EXIT.unreadable);
    expect(err).toContain("is not a coherent registry");
  });
});

describe("the text", () => {
  it("lists the segments with their numbers and the values of each element", async () => {
    const { out } = await cli(["inspect", MINIMAL]);
    expect(out).toContain(
      "Interchange 1: IC000001, 9520000000011:14 -> 9520000000035:14 (syntax UNOA:3, UNA string)",
    );
    expect(out).toContain("  Message 1: ORDERS D.96A (UN), reference 1, 10 segments");
    expect(out).toContain("    1  UNB  1=UNOA:3  2=9520000000011:14");
    expect(out).toContain("    3    BGM  1=220  2=PO-0001  3=9");
    // An empty element is left out and the positions stay.
    expect(out).toContain("    7    LIN  1=1  3=9520000010010:EN");
    expect(out).toContain("   12  UNZ  1=1  2=IC000001");
  });

  it("leaves out the empty components at the end of an element, and keeps those inside", async () => {
    const { out } = await inStdin(
      `${UNB}UNH+1+ORDERS:D:96A:UN'BGM+220+PO::+:A:B::'UNT+3+1'UNZ+1+R1'`,
    );
    expect(out).toContain("BGM  1=220  2=PO  3=:A:B");
  });

  it("leaves the segments out with --no-tree, and the messages stay", async () => {
    const { out } = await cli(["inspect", MINIMAL, "--no-tree"]);
    expect(out).toContain("  Message 1: ORDERS D.96A (UN), reference 1\n");
    expect(out).not.toContain("BGM");
    expect(out).not.toContain("UNB  1=");
  });

  it("says what a message with errors is, and how many", async () => {
    const { out } = await cli([
      "inspect",
      samplePath("invalid", "unt-count-mismatch"),
      "--no-tree",
    ]);
    expect(out).toMatch(/ {2}Message 2: ORDERS D\.96A \(UN\), reference 2 {2}\[1 error\]\n/);
  });

  it("says that the check stopped, and which interchange could not be read", async () => {
    const { out } = await inStdin("UNA:::.? 'UNB+A");
    expect(out).toContain("The check stopped before the end of the file");
    expect(out).toContain("Interchange 1: no UNB could be read  [1 error]");
  });

  it("tells a file cut off, with what was read", async () => {
    const { status, out } = await inStdin(`${UNB}${MSG}UNH+2+ORDERS:D:96A:UN'BGM+22`);
    expect(status).toBe(EXIT.invalid);
    expect(out).toContain(
      "Interchange 1: R1, A:1 -> B:1 (syntax UNOA:3, no UNA string, acknowledgement requested, no UNZ)",
    );
    expect(out).toContain("The check stopped before the end of the file");
  });

  /** What would act on a terminal if it were printed as it is: all but the line feed. */
  const acting = (text: string): string[] =>
    [...text].filter((char) => {
      const code = char.codePointAt(0) as number;
      return (
        (code < 0x20 && code !== 0x0a) ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x2028 ||
        code === 0x2029 ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    });

  it("does not let a value of the file act on the terminal, wherever it is shown", async () => {
    const plain = await inStdin(`UNB+UNOA:3+A:1+B:1+301015:0830+R\u001b[31m1++++1'${MSG}UNZ+1+R1'`);
    expect(acting(plain.out)).toEqual([]);
    expect(plain.out).toContain("R?[31m1");

    // In the text of an issue, which the engine builds from the value that is wrong.
    const unknown = Buffer.from(readSample("invalid", "unknown-code")).toString("latin1");
    for (const control of ["\u001b", "\u0007", "\r"]) {
      const edited = unknown.replace("QQQ", `Q${control}Q`);
      const { out } = await cli(["inspect", "-", "--registry", registries.folder], {
        stdin: text(edited),
      });
      expect(acting(out), JSON.stringify(control)).toEqual([]);
      expect(out).toContain("UNKNOWN_CODE");
      expect(out).toContain("Q?Q");
    }

    // A character that reorders the text, and one that ends a line, in a file of UTF-8 text.
    const bidi = `UNB+UNOW:3+A:1+B:1+301015:0830+R1'UNH+1+ORDERS:D:96A:UN'BGM+220+A\u202eB\u2028C'UNT+3+1'UNZ+1+R1'`;
    const reordering = await cli(["inspect", "-"], { stdin: new TextEncoder().encode(bidi) });
    expect(acting(reordering.out)).toEqual([]);
    expect(reordering.out).toContain("2=A?B?C");
  });

  it("does not let a file name or a message about a registry act on the terminal either", async () => {
    const named = join(scratch, "a\u001b[2Jb.edi");
    await copyFile(MINIMAL, named);
    const shown = await cli(["inspect", named, "--no-tree"]);
    expect(acting(shown.out)).toEqual([]);
    expect(shown.out).toContain("a?[2Jb.edi");

    const missing = await cli(["inspect", join(scratch, "x\u001b[31m.edi")]);
    expect(acting(missing.err)).toEqual([]);

    const registry = join(scratch, "escape.json");
    await writeFile(registry, "\u001b]0;title\u0007 not json");
    const broken = await cli(["inspect", MINIMAL, "--registry", registry]);
    expect(broken.status).toBe(EXIT.unreadable);
    expect(acting(broken.err)).toEqual([]);
  });

  it("shows what a CONTRL says", async () => {
    const { out } = await cli(["inspect", samplePath("valid", "contrl-s3-unoa-rejected")]);
    expect(out).toMatch(
      /\nAcknowledgements \(CONTRL\)\n {2}Interchange IC000001 \(.* -> .*\): rejected, error 28 in UNZ/,
    );
    const ordinary = await cli(["inspect", MINIMAL]);
    expect(ordinary.out).not.toContain("Acknowledgements");
  });

  it("says how many issues there were when it shows fewer", async () => {
    const file = `${UNB}${"UNH+1+ORDERS:D:96A:UN'BGM+220'UNT+9+2'".repeat(5)}UNZ+9+R2'`;
    const all = await inStdin(file, "--no-tree");
    expect(all.out).not.toContain("see --max-issues");
    const some = await inStdin(file, "--no-tree", "--max-issues", "2");
    expect(some.status).toBe(EXIT.invalid);
    expect(some.out).toContain("Issues (the first 2 of 12; see --max-issues)");
    expect(some.out.match(/^error /gm)).toHaveLength(2);
    const none = await inStdin(file, "--no-tree", "--max-issues", "0");
    expect(none.status).toBe(EXIT.invalid);
    expect(none.out).toContain("Issues (the first 0 of 12; see --max-issues)");
  });
});

describe("the JSON", () => {
  const json = async (file: string, ...options: string[]) =>
    JSON.parse((await inStdin(file, "--json", ...options)).out) as JsonReport;

  it("is one document that ends with a line break, whatever the file", async () => {
    for (const file of [
      "",
      "garbage",
      `${UNB}${MSG}`,
      `${UNB}${MSG}UNZ+1+R1'${UNB}${MSG}UNZ+1+R1'`,
      `${UNB}UNH+1`,
    ]) {
      const { out, err } = await inStdin(file, "--json");
      expect(err).toBe("");
      expect(out.endsWith("}\n"), JSON.stringify(file)).toBe(true);
      expect(() => JSON.parse(out), JSON.stringify(file)).not.toThrow();
    }
  });

  it("gives the facts of each interchange and message, with the segments of the messages", async () => {
    const report = await json(`${UNB}${MSG}UNH+2+ORDERS:D:96A:UN'BGM+220'UNT+3+2'UNZ+2+R1'`);
    expect(report).toMatchObject({
      schemaVersion: 1,
      file: "<stdin>",
      valid: true,
      complete: true,
    });
    expect(report.counts).toEqual({
      interchanges: 1,
      messages: 2,
      issues: 0,
      errors: 0,
      warnings: 0,
    });
    const interchange = must(report.interchanges[0]);
    expect(interchange).toMatchObject({
      index: 0,
      reference: "R1",
      sender: { id: "A", qualifier: "1", address: null },
      recipient: { id: "B", qualifier: "1", address: null },
      syntaxIdentifier: "UNOA",
      syntaxVersion: "3",
      characterSet: "UNOA",
      una: false,
      acknowledgementRequest: true,
      closed: true,
      errorCount: 0,
      firstError: null,
    });
    expect(
      interchange.messages.map((m) => [m.number, m.reference, m.type, m.segmentCount]),
    ).toEqual([
      [1, "1", "ORDERS", 3],
      [2, "2", "ORDERS", 3],
    ]);
    const bgm = must(must(interchange.messages[1]).segments[1]);
    expect(bgm).toMatchObject({ number: 6, tag: "BGM", elements: [[["220"]]] });
  });

  it("gives the offsets so that bytes.slice(start, end) is the segment, and the message", async () => {
    const file = `${UNB}${MSG}UNZ+1+R1'`;
    const report = await json(file);
    const message = must(must(report.interchanges[0]).messages[0]);
    expect(file.slice(message.start, message.end)).toBe(MSG);
    const [unh, bgm] = [must(message.segments[0]), must(message.segments[1])];
    expect(file.slice(unh.start, unh.end)).toBe("UNH+1+ORDERS:D:96A:UN'");
    expect(file.slice(bgm.start, bgm.end)).toBe("BGM+220'");
  });

  it("leaves the segments out with --no-tree", async () => {
    const report = await json(`${UNB}${MSG}UNZ+1+R1'`, "--no-tree");
    const message = must(must(report.interchanges[0]).messages[0]);
    expect(message).not.toHaveProperty("segments");
    expect(message).not.toHaveProperty("segmentCount");
    expect(message).toMatchObject({ reference: "1", type: "ORDERS" });
  });

  it("gives repetitions and the components of each", async () => {
    const report = await json(
      "UNA:+.?*'UNB+UNOA:4+A:1+B:1+20301015:0830+R1'UNH+1+ORDERS:D:96A:UN'FTX+AAI+++A:B*C'UNT+3+1'UNZ+1+R1'",
    );
    const ftx = must(must(must(report.interchanges[0]).messages[0]).segments[1]);
    expect(ftx.elements).toEqual([[["AAI"]], [[]], [[]], [["A", "B"], ["C"]]]);
  });

  it("counts the issues, and keeps the first ones with their positions", async () => {
    const report = await json(
      `${UNB}UNH+1+ORDERS:D:96A:UN'BGM+220'UNT+9+2'UNZ+1+R1'`,
      "--max-issues",
      "1",
    );
    expect(report).toMatchObject({ valid: false, complete: true });
    expect(report.counts).toMatchObject({ issues: 2, errors: 2 });
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      code: "UNT_COUNT_MISMATCH",
      severity: "error",
      position: { segment: 4, tag: "UNT", element: 1 },
    });
    expect(report.interchanges[0]).toMatchObject({ errorCount: 0 });
    expect(must(report.interchanges[0]).messages[0]).toMatchObject({
      errorCount: 2,
      firstError: { code: "UNT_COUNT_MISMATCH", tag: "UNT" },
    });
  });

  it("describes an interchange that could not be read, without inventing its facts", async () => {
    const report = await json("garbage");
    expect(report).toMatchObject({ valid: false, complete: false });
    expect(report.interchanges).toHaveLength(1);
    expect(report.interchanges[0]).toMatchObject({
      reference: null,
      sender: null,
      recipient: null,
      closed: false,
      messages: [],
      errorCount: 1,
    });
  });

  it("gives what each CONTRL says, and an empty list when the file has none", async () => {
    const contrl = JSON.parse(
      (await cli(["inspect", samplePath("valid", "contrl-s3-unoa-partially-rejected"), "--json"]))
        .out,
    );
    expect(contrl.acknowledgements).toHaveLength(1);
    expect(contrl.acknowledgements[0]).toMatchObject({
      reference: "IC000005",
      outcome: "partially_rejected",
      messages: [{ status: "accepted" }, { status: "rejected", code: "29", segment: "UNT" }],
    });
    expect((await json(`${UNB}${MSG}UNZ+1+R1'`)).acknowledgements).toEqual([]);
  });

  it("names the registries it used", async () => {
    const { out } = await cli([
      "inspect",
      MINIMAL,
      "--registry",
      registries.folder,
      "--json",
      "--no-tree",
    ]);
    expect(JSON.parse(out).registries).toEqual(["D.01B (UN)", "D.96A (UN)"]);
  });
});

describe("a large file", () => {
  it("is shown message by message, in pieces, and quickly", async () => {
    const file = `${UNB}${Array.from({ length: 3000 }, (_unused, i) => `UNH+${i + 1}+ORDERS:D:96A:UN'BGM+220'UNT+3+${i + 1}'`).join("")}UNZ+3000+R1'`;
    const started = performance.now();
    let pieces = 0;
    const { run } = await import("./run.ts");
    let out = "";
    const status = await run(["inspect", "-"], {
      env: {},
      stdout: (piece) => {
        pieces++;
        out += piece;
      },
      stderr: () => {},
      stdin: async () => text(file),
    });
    expect(status).toBe(EXIT.ok);
    expect(out).toContain("  Message 3000: ORDERS D.96A (UN), reference 3000, 3 segments");
    // Written in blocks, not line by line.
    expect(pieces).toBeLessThan(out.split("\n").length / 100);
    expect(performance.now() - started).toBeLessThan(3000);
    const json = JSON.parse((await inStdin(file, "--json", "--no-tree")).out);
    expect(json.interchanges[0].messages).toHaveLength(3000);
  });
});

describe("the memory budget", () => {
  it("makes a message that needs more a reported error, and the check stops there", async () => {
    const message = `UNH+1+ORDERS:D:96A:UN'${"BGM+220'".repeat(2000)}UNT+2002+1'`;
    const file = `${UNB}${message}UNZ+1+R1'`;
    const enough = await inStdin(file, "--no-tree");
    expect(enough.status).toBe(EXIT.ok);
    const small = await inStdin(file, "--no-tree", "--memory-budget", "4096");
    expect(small.status).toBe(EXIT.invalid);
    expect(small.out).toContain("error MESSAGE_TOO_LARGE");
    expect(small.out).toContain("The check stopped before the end of the file");
    const json = JSON.parse((await inStdin(file, "--json", "--memory-budget", "4096")).out);
    expect(json).toMatchObject({ valid: false, complete: false });
    expect(json.issues[0].code).toBe("MESSAGE_TOO_LARGE");
  });
});

describe("the output", () => {
  const file = `${UNB}${Array.from({ length: 3000 }, (_unused, i) => `UNH+${i + 1}+ORDERS:D:96A:UN'BGM+220'UNT+3+${i + 1}'`).join("")}UNZ+3000+R1'`;

  it("waits for the reader between two writes, so that a slow one is not outrun", async () => {
    for (const json of [false, true]) {
      let active = 0;
      let overlaps = 0;
      let writes = 0;
      const { run } = await import("./run.ts");
      const status = await run(["inspect", "-", ...(json ? ["--json"] : [])], {
        env: {},
        stdout: async () => {
          writes++;
          active++;
          overlaps += active > 1 ? 1 : 0;
          await new Promise((resolve) => setTimeout(resolve, 1));
          active--;
        },
        stderr: () => {},
        stdin: async () => text(file),
      });
      expect(status).toBe(EXIT.ok);
      expect(writes, `json ${json}`).toBeGreaterThan(3);
      expect(overlaps, `json ${json}`).toBe(0);
    }
  });

  it("is given up when the reader fails, and the failure reaches the caller", async () => {
    const { run } = await import("./run.ts");
    let writes = 0;
    await expect(
      run(["inspect", "-"], {
        env: {},
        stdout: async () => {
          writes++;
          throw new Error("write failed");
        },
        stderr: () => {},
        stdin: async () => text(file),
      }),
    ).rejects.toThrow("write failed");
    // Nothing more is produced once a write has failed.
    expect(writes).toBe(1);
  });
});
