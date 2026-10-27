import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RegistryView } from "@libredi/edifact";
import { checkRegistry, type Problem, type Registry, validateRegistry } from "@libredi/registry";
import { reason } from "./plain.ts";

/** A registry that cannot be used: the message says which file and why. */
export class RegistryError extends Error {}

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
    throw new RegistryError(`cannot read registry ${path}: ${reason(error)}`);
  }
  try {
    const shape = validateRegistry(document);
    if (shape.length > 0) {
      throw new RegistryError(`${path} is not a registry (contracts/registry): ${list(shape)}`);
    }
    const references = checkRegistry(document as Registry);
    if (references.length > 0) {
      throw new RegistryError(`${path} is not a coherent registry: ${list(references)}`);
    }
  } catch (error) {
    if (error instanceof RangeError) {
      // The schema and the rules walk the document recursively: a registry nested thousands deep.
      throw new RegistryError(`${path} is nested too deeply to be a registry`);
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
    throw new RegistryError(`cannot read registry ${path}: ${reason(error)}`);
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
    throw new RegistryError(`no .json registry in the folder ${path}`);
  }
  return names.map((name) => join(path, name));
}

/**
 * Reads the registries that `--registry` names, files or folders (relative to `cwd`), and checks
 * each against the schema and the rules of contracts/registry. A file named twice is read once; two
 * registries for one directory are refused, since the validator would use the first and the
 * second would never be known to be ignored.
 */
export async function loadRegistries(
  paths: readonly string[],
  cwd: string,
): Promise<RegistryView[]> {
  const loaded: RegistryView[] = [];
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
          throw new RegistryError(
            `${path} and ${first} are both the registry of ${version}.${release} (${agency}): keep one`,
          );
        }
        directories.set(`${agency} ${version} ${release}`, path);
        loaded.push(registry);
      }
    }
  } catch (error) {
    if (error instanceof RegistryError) {
      throw error;
    }
    throw new RegistryError(`cannot read registry: ${reason(error)}`);
  }
  return loaded;
}
