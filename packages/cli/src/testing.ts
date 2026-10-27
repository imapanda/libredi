import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RegistryView } from "@libredi/edifact";
import { corpusRegistries } from "@libredi/edifact/testing/corpus-registry";
import { type CliContext, run } from "./run.ts";

/** Helpers of the tests: run the program in memory, and the corpus on disk. */

const corpus = fileURLToPath(new URL("../../../samples/edifact/", import.meta.url));

export const samplePath = (directory: "valid" | "invalid", name: string): string =>
  `${corpus}${directory}/${name}.edi`;

export interface Ran {
  readonly status: number;
  readonly out: string;
  readonly err: string;
}

export async function cli(
  args: readonly string[],
  options: { stdin?: Uint8Array; env?: CliContext["env"]; cwd?: string } = {},
): Promise<Ran> {
  let out = "";
  let err = "";
  const status = await run(args, {
    env: options.env ?? {},
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    stdin: async () => options.stdin ?? new Uint8Array(),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  return { status, out, err };
}

/** A registry of the corpus as the document of contracts/registry (the names the schema asks for added). */
export function registryDocument(view: RegistryView): Record<string, unknown> {
  const named = (entries: Record<string, object>, what: string) =>
    Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [
        key,
        { name: `Test ${what} ${key}`, ...value },
      ]),
    );
  return {
    schemaVersion: 1,
    syntaxVersions: [3, 4],
    source: { kind: "handwritten" },
    ...view,
    codeLists: named(view.codeLists, "code list"),
    messages: named(view.messages, "message"),
  };
}

/** A folder with the two registries of the corpus, as `libredi registry build` would write them. */
export async function corpusRegistryFolder(): Promise<{
  folder: string;
  remove: () => Promise<void>;
}> {
  const folder = await mkdtemp(join(tmpdir(), "libredi-cli-"));
  for (const view of corpusRegistries) {
    const { agency, version, release } = view.directory;
    await writeFile(
      join(folder, `${version}${release}-${agency}.json`.toLowerCase()),
      JSON.stringify(registryDocument(view)),
    );
  }
  // What the build leaves next to its registries: the folder of archives, which is no registry.
  await mkdir(join(folder, ".downloads"));
  await writeFile(join(folder, "notes.txt"), "not a registry");
  return { folder, remove: () => rm(folder, { recursive: true, force: true }) };
}

/** What `--json` gives, as far as the tests read it. */
export interface JsonSegment {
  number: number;
  tag: string;
  start: number;
  end: number;
  elements: string[][][];
}

export interface JsonMessage {
  number: number;
  reference: string;
  type: string;
  version: string;
  release: string;
  agency: string;
  start: number;
  end: number;
  errorCount: number;
  firstError: { code: string; tag: string | null } | null;
  segmentCount: number;
  segments: JsonSegment[];
}

export interface JsonInterchange {
  index: number;
  reference: string | null;
  sender: { id: string; qualifier: string | null; address: string | null } | null;
  recipient: { id: string; qualifier: string | null; address: string | null } | null;
  syntaxIdentifier: string | null;
  syntaxVersion: string | null;
  characterSet: string | null;
  una: boolean;
  acknowledgementRequest: boolean;
  closed: boolean;
  errorCount: number;
  firstError: { code: string; tag: string | null } | null;
  messages: JsonMessage[];
}

export interface JsonIssue {
  code: string;
  severity: string;
  position: {
    segment: number;
    tag: string | null;
    element: number | null;
    component: number | null;
  };
}

export interface JsonReport {
  schemaVersion: number;
  file: string;
  bytes: number;
  valid: boolean;
  complete: boolean;
  counts: {
    interchanges: number;
    messages: number;
    issues: number;
    errors: number;
    warnings: number;
  };
  registries: string[];
  issues: JsonIssue[];
  interchanges: JsonInterchange[];
  acknowledgements: {
    reference: string;
    outcome: string;
    messages: { status: string; code: string | null; segment: string | null }[];
  }[];
}

/** An item the test knows is there, for the compiler that does not. */
export function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a value, got undefined");
  }
  return value;
}
