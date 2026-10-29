// Loads the examples of contracts/ for the tests. Not exported by the package.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { JsonObject } from "./values.ts";

const contracts = fileURLToPath(new URL("../../../contracts/", import.meta.url));

export const formatExamples = readdirSync(`${contracts}erp-formats/v1/examples`).sort();

export const formatExample = (name: string): unknown =>
  parse(readFileSync(`${contracts}erp-formats/v1/examples/${name}`, "utf8"));

export const CANONICAL_EXAMPLES = [
  "order",
  "order-response",
  "despatch-advice",
  "invoice",
] as const;

export const canonicalExample = (name: (typeof CANONICAL_EXAMPLES)[number]): JsonObject =>
  JSON.parse(readFileSync(`${contracts}canonical/v1/examples/${name}.json`, "utf8"));

export const text = (bytes: Uint8Array, encoding = "utf-8"): string =>
  new TextDecoder(encoding).decode(bytes);

export const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
