import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Mapping } from "./evaluate.ts";

/** Helpers of the tests and the benchmark: the example mappings of contracts/mapping. */

export interface Example extends Mapping {
  readonly fixtures: readonly { name: string; input: unknown; expected: unknown }[];
}

const examplesDir = fileURLToPath(new URL("../../../contracts/mapping/examples/", import.meta.url));

export const exampleNames: readonly string[] = readdirSync(examplesDir).filter((name) =>
  name.endsWith(".mapping.yaml"),
);

export const examplePath = (name: string): string => `${examplesDir}${name}`;

export const example = (name: string): Example =>
  parse(readFileSync(examplePath(name), "utf8")) as Example;
