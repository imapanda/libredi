import { parentPort, workerData } from "node:worker_threads";
import { type MappingErrorData, toMappingError } from "./errors.ts";
import { type CompiledMapping, compileMapping, type Limits, type Mapping } from "./evaluate.ts";

/** A document to map, as the pool sends it. */
export interface Job {
  readonly id: number;
  /** Names the mapping: the same key is always the same `source`. */
  readonly key: number;
  /** The mapping as JSON, parsed and compiled once per worker. */
  readonly source: string;
  readonly input: unknown;
}

export type Reply =
  | { readonly id: number; readonly ok: true; readonly output: Record<string, unknown> }
  | { readonly id: number; readonly ok: false; readonly error: MappingErrorData };

/** Compiled mappings kept by a worker, the least recently used dropped first. */
const CACHE_SIZE = 256;

const limits = workerData as Limits;
const cache = new Map<number, CompiledMapping>();

function compiled(job: Job): CompiledMapping {
  let mapping = cache.get(job.key);
  if (mapping === undefined) {
    mapping = compileMapping(JSON.parse(job.source) as Mapping, limits);
    if (cache.size >= CACHE_SIZE) {
      cache.delete(cache.keys().next().value as number);
    }
  } else {
    cache.delete(job.key);
  }
  cache.set(job.key, mapping);
  return mapping;
}

parentPort?.on("message", async (job: Job) => {
  let reply: Reply;
  try {
    reply = { id: job.id, ok: true, output: await compiled(job).run(job.input) };
  } catch (thrown) {
    reply = { id: job.id, ok: false, error: toMappingError(thrown, null).toData() };
  }
  parentPort?.postMessage(reply);
});

// Sent once the code is loaded: the pool starts counting the time of a document from here.
parentPort?.postMessage("ready");
