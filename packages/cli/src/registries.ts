import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyOverrides, type OverridesView } from "@libredi/edifact";
import {
  checkOverrides,
  checkRegistry,
  type Overrides,
  type Problem,
  type Registry,
  validateOverrides,
  validateRegistry,
} from "@libredi/registry";
import { reason } from "./plain.ts";

/** A registry or a document of overrides that cannot be used: the message says which and why. */
export class InputError extends Error {}

const SHOWN_PROBLEMS = 3;

const list = (problems: readonly Problem[]): string => {
  const shown = problems
    .slice(0, SHOWN_PROBLEMS)
    .map((problem) => `${problem.path === "" ? "/" : problem.path} ${problem.message}`);
  const more = problems.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
};

async function loadFile(path: string, file: string): Promise<Registry> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new InputError(`cannot read registry ${path}: ${reason(error)}`);
  }
  try {
    const shape = validateRegistry(document);
    if (shape.length > 0) {
      throw new InputError(`${path} is not a registry (contracts/registry): ${list(shape)}`);
    }
    const references = checkRegistry(document as Registry);
    if (references.length > 0) {
      throw new InputError(`${path} is not a coherent registry: ${list(references)}`);
    }
  } catch (error) {
    if (error instanceof RangeError) {
      // The schema and the rules walk the document recursively: a registry nested thousands deep.
      throw new InputError(`${path} is nested too deeply to be a registry`);
    }
    throw error;
  }
  return document as Registry;
}

/** The registry files a path stands for: the file itself, or the `.json` files of a folder. */
async function filesOf(path: string, file: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    if (!(await stat(file)).isDirectory()) {
      return [path];
    }
    entries = await readdir(file, { withFileTypes: true });
  } catch (error) {
    throw new InputError(`cannot read registry ${path}: ${reason(error)}`);
  }
  const names = entries
    // A link to a file is a file here; one that leads nowhere is reported when it is read.
    .filter(
      (entry) =>
        !entry.isDirectory() && entry.name.endsWith(".json") && !entry.name.startsWith("."),
    )
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new InputError(`no .json registry in the folder ${path}`);
  }
  return names.map((name) => join(path, name));
}

/**
 * Reads the registries that `--registry` names, files or folders (relative to `cwd`), and checks
 * each against the schema and the rules of contracts/registry. A file named twice is read once; two
 * registries for one directory are refused, since the validator would use the first and the
 * second would never be known to be ignored.
 */
export async function loadRegistries(paths: readonly string[], cwd: string): Promise<Registry[]> {
  const loaded: Registry[] = [];
  const read = new Set<string>();
  const directories = new Map<string, string>();
  try {
    for (const given of paths) {
      for (const path of await filesOf(given, resolve(cwd, given))) {
        const file = resolve(cwd, path);
        if (read.has(file)) {
          continue;
        }
        read.add(file);
        const registry = await loadFile(path, file);
        const { agency, version, release } = registry.directory;
        const first = directories.get(`${agency} ${version} ${release}`);
        if (first !== undefined) {
          throw new InputError(
            `${path} and ${first} are both the registry of ${version}.${release} (${agency}): keep one`,
          );
        }
        directories.set(`${agency} ${version} ${release}`, path);
        loaded.push(registry);
      }
    }
  } catch (error) {
    if (error instanceof InputError) {
      throw error;
    }
    throw new InputError(`cannot read registry: ${reason(error)}`);
  }
  return loaded;
}

export interface LoadedOverrides {
  readonly path: string;
  /** The name the document gives itself, or null. */
  readonly name: string | null;
  readonly overrides: OverridesView;
}

/** The sections of a document that change a registry: the others (severity) need none. */
const REGISTRY_SECTIONS = [
  "dataElements",
  "composites",
  "segments",
  "codeLists",
  "messages",
] as const;

/**
 * Reads the documents of overrides that `--overrides` names (files, relative to `cwd`), in the
 * order given, and checks each against the schema of contracts/overrides and against the registry
 * of its directory, which must be one of the registries given: a rule that would silently apply to
 * nothing is refused. A document is checked against the registry the documents before it were
 * applied to, as the validator will see it, so that one can build on another. A document of
 * severities alone needs no registry. A file named twice is read once and applied twice.
 */
export async function loadOverrides(
  paths: readonly string[],
  cwd: string,
  registries: readonly Registry[],
): Promise<LoadedOverrides[]> {
  const loaded: LoadedOverrides[] = [];
  const read = new Map<string, Overrides>();
  // The registry of each directory as the documents so far leave it.
  const current = new Map<string, Registry>(
    registries.map((registry) => [key(registry), registry]),
  );
  for (const path of paths) {
    const file = resolve(cwd, path);
    let overrides = read.get(file);
    if (overrides === undefined) {
      overrides = await readOverrides(path, file);
      read.set(file, overrides);
    }
    try {
      const { agency, version, release } = overrides.directory;
      const registry = current.get(key(overrides));
      if (registry === undefined) {
        if (REGISTRY_SECTIONS.some((section) => overrides[section] !== undefined)) {
          throw new InputError(
            `${path} is for ${version}.${release} (${agency}) and no --registry is of that directory`,
          );
        }
      } else {
        const references = checkOverrides(overrides, registry);
        if (references.length > 0) {
          throw new InputError(
            `${path} does not fit the registry of ${version}.${release} (${agency}): ${list(references)}`,
          );
        }
        current.set(key(overrides), applyOverrides(registry, overrides) as Registry);
      }
    } catch (error) {
      if (error instanceof RangeError) {
        throw new InputError(`${path} is nested too deeply to be a document of overrides`);
      }
      throw error;
    }
    loaded.push({ path, name: overrides.name ?? null, overrides });
  }
  return loaded;
}

const key = ({ directory }: { directory: { agency: string; version: string; release: string } }) =>
  `${directory.agency} ${directory.version} ${directory.release}`;

async function readOverrides(path: string, file: string): Promise<Overrides> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new InputError(`cannot read overrides ${path}: ${reason(error)}`);
  }
  try {
    const shape = validateOverrides(document);
    if (shape.length > 0) {
      throw new InputError(
        `${path} is not a valid document of overrides (contracts/overrides): ${list(shape)}`,
      );
    }
  } catch (error) {
    if (error instanceof RangeError) {
      throw new InputError(`${path} is nested too deeply to be a document of overrides`);
    }
    throw error;
  }
  return document as Overrides;
}
