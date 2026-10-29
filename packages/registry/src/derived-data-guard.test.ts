import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(repoRoot, "scripts/check-derived-data.sh");

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A Git repository in a temporary folder with the guard and the given tracked files. */
function repository(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "libredi-guard-"));
  created.push(dir);
  mkdirSync(join(dir, "scripts"));
  copyFileSync(script, join(dir, "scripts/check-derived-data.sh"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  return dir;
}

function guard(cwd: string): { status: number | null; output: string } {
  const result = spawnSync("sh", ["scripts/check-derived-data.sh"], { cwd, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const REGISTRY = (kind: string) =>
  JSON.stringify({ schemaVersion: 1, source: { kind }, dataElements: {} }, null, 2);

describe("scripts/check-derived-data.sh", () => {
  it("passes on this repository", () => {
    const result = spawnSync("sh", [script], { cwd: repoRoot, encoding: "utf8" });
    expect(`${result.stdout}${result.stderr}`).toContain("No UN/EDIFACT directory file");
    expect(result.status).toBe(0);
  });

  it("passes when the tracked files are ordinary, fictitious or hand-written", () => {
    const dir = repository({
      "README.md": "# Hello\n",
      "contracts/registry/registry.schema.json":
        '{ "properties": { "dataElements": {} }, "enum": ["unece-directory"] }',
      "contracts/registry/examples/fictitious-registry.json": REGISTRY("handwritten"),
      "packages/registry/src/test-support/fixtures/d01b-layout/elements.txt": "invented\n",
      "contracts/overrides/overrides.schema.json": '{ "properties": { "dataElements": {} } }',
      "contracts/overrides/examples/fictitious-retailer.overrides.json":
        '{ "schemaVersion": 1, "dataElements": { "9002": { "maxLength": 12 } } }',
      "docs/notes.md": "The licence agreement of the directories forbids redistribution.\n",
    });
    expect(guard(dir)).toMatchObject({ status: 0 });
  });

  it.each([
    ["the archive of a directory", "vendor/d01b.zip"],
    ["the archive of another directory", "D96A.ZIP"],
    ["an inner archive", "data/EDED.ZIP"],
    ["a data element file", "data/EDED.01B"],
    ["a D.96A segment file", "data/TRSD.96A"],
    ["an interactive file", "data/EDMDI1.01B"],
    ["a code list file", "data/UNCL-1.96A"],
    ["a service code list", "data/UNSL.96A"],
    ["a message file", "data/ORDERS_D.01B"],
    ["the licence text", "data/LICENAGR.TXT"],
    ["a registry file by its name", "out/d01b.registry.json"],
  ])("refuses %s", (_label, path) => {
    const dir = repository({ [path]: "x" });
    const result = guard(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain(path);
    expect(result.output).toContain("ADR 7");
  });

  it("refuses a generated registry, whatever its name", () => {
    const dir = repository({ "build/anything.json": REGISTRY("unece-directory") });
    const result = guard(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain("build/anything.json");
  });

  it("refuses a generated registry in the folder of the contract, too", () => {
    const dir = repository({
      "contracts/registry/examples/real.json": REGISTRY("unece-directory"),
    });
    expect(guard(dir).status).toBe(1);
  });

  it("refuses a registry-shaped file outside the folder of the contract", () => {
    const dir = repository({ "data/registry.json": REGISTRY("handwritten") });
    expect(guard(dir).status).toBe(1);
  });

  it.each([
    ["the licence of the directories", "Licence Agreement for the use of UN/EDIFACT Directory\n"],
    ["a title page of a message", "   UNITED NATIONS STANDARD MESSAGE (UNSM)\n"],
    ["a title of the code lists", "UNITED NATIONS DIRECTORIES FOR ELECTRONIC DATA INTERCHANGE\n"],
  ])("refuses a file that carries %s, whatever its name", (_label, text) => {
    const dir = repository({ "docs/copied.txt": text });
    const result = guard(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain("docs/copied.txt");
  });

  it("still refuses a registry that hides next to the overrides, or anywhere else", () => {
    const dir = repository({
      "contracts/overrides/examples/ok.overrides.json": '{ "dataElements": {} }',
      "contracts/overrides-copy/registry.json": REGISTRY("handwritten"),
      "packages/x/overrides.json": '{ "dataElements": {} }',
    });
    const result = guard(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain("contracts/overrides-copy/registry.json");
    expect(result.output).toContain("packages/x/overrides.json");
    expect(result.output).not.toContain("contracts/overrides/examples/ok.overrides.json");
    // A registry built from the directories is refused in the overrides folder as well.
    const built = repository({ "contracts/overrides/built.json": REGISTRY("unece-directory") });
    expect(guard(built).status).toBe(1);
  });

  it("lists every offender once", () => {
    const dir = repository({ "a/d01b.zip": "x", "b/ORDERS_D.01B": "x", "c/d96a.zip": "x" });
    const lines = guard(dir)
      .output.split("\n")
      .filter((line) => line.startsWith("  "));
    expect(lines.sort()).toEqual(["  a/d01b.zip", "  b/ORDERS_D.01B", "  c/d96a.zip"]);
  });

  it("looks at what Git tracks, not at what is on disk", () => {
    const dir = repository({ "README.md": "# Hello\n" });
    writeFileSync(join(dir, "d01b.zip"), "x"); // present, but never added
    expect(guard(dir).status).toBe(0);
  });
});

describe(".gitignore", () => {
  it("keeps the usual places of the output and of the downloads out of Git", () => {
    const ignored = spawnSync(
      "git",
      [
        "check-ignore",
        "--no-index",
        "d01b.zip",
        "out/d01b.registry.json",
        "registry/d01b.json",
        ".libredi/x",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(ignored.stdout.split("\n").filter(Boolean).sort()).toEqual(
      ["d01b.zip", "out/d01b.registry.json", "registry/d01b.json", ".libredi/x"].sort(),
    );
  });
});
