import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli } from "./testing.ts";

const examples = fileURLToPath(new URL("../../../contracts/mapping/examples/", import.meta.url));
const OUTBOUND = `${examples}order-to-csv.mapping.yaml`;
const INBOUND = `${examples}csv-to-order-response.mapping.yaml`;

/** A small mapping in YAML, with its fixtures. */
const mapping = (fields: string, fixtures: string): string => `formatVersion: 1
name: Test mapping
version: 2
flow:
  direction: inbound
  message: { syntax: csv, type: test, version: "1" }
  canonical: { documentType: order, schemaVersion: 1 }
fields:
${fields}
fixtures:
${fixtures}
`;

describe("libredi test", () => {
  let folder: string;
  const write = async (name: string, text: string): Promise<string> => {
    const path = join(folder, name);
    await writeFile(path, text);
    return path;
  };

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "libredi-test-"));
  });
  afterAll(() => rm(folder, { recursive: true, force: true }));

  it("passes the examples of contracts/mapping, and names the fields to review", async () => {
    const outbound = await cli(["test", OUTBOUND]);
    expect([outbound.status, outbound.err]).toEqual([0, ""]);
    expect(outbound.out).toBe(
      [
        "order-to-csv.mapping.yaml: Order to ERP order lines (CSV), version 3",
        "pass two lines delivered to a depot",
        "Result: the fixture passes.",
        "",
      ].join("\n"),
    );
    const inbound = await cli(["test", INBOUND]);
    expect(inbound.status).toBe(0);
    expect(inbound.out).toContain("Low confidence, to review before promotion: lines.unitPrice\n");
  });

  it("shows how the output differs from what a fixture expects, and exits 1", async () => {
    const text = (await readFile(OUTBOUND, "utf8")).replace(
      'order_date: "2030-10-15"',
      'order_date: "2030-10-16"',
    );
    const path = await write("wrong.mapping.yaml", text);
    const { status, out, err } = await cli(["test", path]);
    expect([status, err]).toEqual([1, ""]);
    expect(out).toContain(
      'FAIL two lines delivered to a depot\n  rows[0].order_date: expected "2030-10-16", got "2030-10-15"\n',
    );
    expect(out).toContain("Result: 1 of 1 fixture fails.\n");
  });

  it("reports missing and unexpected values, and an expression that fails", async () => {
    const path = await write(
      "small.mapping.yaml",
      mapping(
        `  documentNumber: { expression: number }
  lines:
    forEach: rows
    fields:
      lineNumber: { expression: $number(n) }`,
        `  - name: missing and unexpected
    input: { number: "1", rows: [{ n: "1" }] }
    expected: { lines: [{ lineNumber: 1 }, { lineNumber: 2 }] }
  - name: a bad number
    input: { rows: [{ n: "1" }, { n: "x" }] }
    expected: {}`,
      ),
    );
    const { status, out } = await cli(["test", path]);
    expect(status).toBe(1);
    const lines = out.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "small.mapping.yaml: Test mapping, version 2",
      "FAIL missing and unexpected",
      '  lines[1]: missing, expected {"lineNumber":2}',
      '  documentNumber: not expected, got "1"',
      "FAIL a bad number",
    ]);
    expect(lines[5]).toMatch(/^ {2}EXPRESSION_FAILED in lines\[1\]\.lineNumber: .*\(D3030\)$/);
    expect(lines.slice(6)).toEqual(["Result: 2 of 2 fixtures fail.", ""]);
  });

  it("stops a runaway fixture at the time limit", async () => {
    const path = await write(
      "loop.mapping.yaml",
      mapping(
        `  documentNumber: { expression: "($f := function($n){ $f($n) }; $f(1))" }`,
        `  - name: loops
    input: {}
    expected: {}`,
      ),
    );
    const { status, out } = await cli(["test", path, "--timeout", "200"]);
    expect(status).toBe(1);
    expect(out).toContain("FAIL loops\n  TIMEOUT in documentNumber: ");
    expect(out).toContain("Result: 1 of 1 fixture fails.\n");
  });

  it("refuses a mapping that calls $eval before running anything (3)", async () => {
    const path = await write(
      "eval.mapping.yaml",
      mapping(
        `  documentNumber: { expression: '$eval("1")' }`,
        `  - name: any
    input: {}
    expected: {}`,
      ),
    );
    const { status, out, err } = await cli(["test", path]);
    expect([status, out]).toEqual([3, ""]);
    expect(err).toBe(
      "libredi: eval.mapping.yaml: documentNumber: $eval() is not available in a mapping\n",
    );
  });

  it.each([
    ["not YAML", "a: [", /^libredi: bad\.yaml: not valid YAML: /],
    [
      "not a mapping",
      mapping("  documentNumber: { formula: number }", "  - { name: x, input: {}, expected: {} }"),
      /^libredi: bad\.yaml: not a valid mapping: fields\.documentNumber must NOT have additional properties \(formula\)\n$/,
    ],
    [
      "an expression that does not parse",
      mapping('  documentNumber: { expression: "(" }', "  - { name: x, input: {}, expected: {} }"),
      /^libredi: bad\.yaml: documentNumber: .*\(S0203\)\n$/,
    ],
  ])("refuses a file that is %s (3)", async (_label, text, message) => {
    const path = await write("bad.yaml", text);
    const { status, out, err } = await cli(["test", path]);
    expect([status, out]).toEqual([3, ""]);
    expect(err).toMatch(message);
  });

  it("reads a path relative to the folder it is given, and says when a file is missing", async () => {
    const relative = await cli(["test", "order-to-csv.mapping.yaml"], { cwd: examples });
    expect(relative.status).toBe(0);
    const missing = await cli(["test", join(folder, "none.yaml")]);
    expect(missing.status).toBe(3);
    expect(missing.err).toMatch(/^libredi: none\.yaml: ENOENT: /);
  });

  it.each([
    [[], "test needs the mapping file to run"],
    [["a.yaml", "b.yaml"], "test takes one mapping, not 2"],
    [
      ["a.yaml", "--timeout", "soon"],
      '--timeout expects a whole number of milliseconds, not "soon"',
    ],
    [["a.yaml", "--timeout", "0"], '--timeout expects a whole number of milliseconds, not "0"'],
    [["a.yaml", "--frobnicate"], "Unknown option '--frobnicate'"],
  ])("is a usage error (2) for %j", async (args, message) => {
    const { status, out, err } = await cli(["test", ...args]);
    expect([status, out]).toEqual([2, ""]);
    expect(err).toContain(message);
    expect(err).toContain("Usage: libredi test <mapping> [options]");
  });

  // Starts a Node.js process and a worker thread, which a shared CI runner can take a while over.
  it("runs as a process, with the worker of the sandbox", { timeout: 15_000 }, () => {
    const main = fileURLToPath(new URL("./main.ts", import.meta.url));
    const ran = spawnSync(process.execPath, [main, "test", OUTBOUND], { encoding: "utf8" });
    expect([ran.status, ran.stderr]).toEqual([0, ""]);
    expect(ran.stdout).toContain("pass two lines delivered to a depot\n");
  });

  it("prints its help", async () => {
    const { status, out } = await cli(["test", "--help"]);
    expect(status).toBe(0);
    expect(out).toContain("Usage: libredi test <mapping> [options]");
    expect(out).toContain("3  the file cannot be read, or is not a valid mapping");
  });
});
