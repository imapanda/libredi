/*
 * Throughput of the mapping runner: documents mapped per second, by the pure evaluator on the main
 * thread, and by the worker pool (one worker per core).
 *
 *   pnpm --filter @libredi/mapping bench
 *   pnpm --filter @libredi/mapping bench -- --seconds=5 --workers=4
 *
 * The documents are the fixtures of the two examples of contracts/mapping, made longer: an order
 * of n lines for the outbound mapping, a confirmation of n rows for the inbound one. Nothing here
 * fails a build; it prints a Markdown table to paste in a pull request.
 */
import { availableParallelism, cpus } from "node:os";
import { parseArgs } from "node:util";
import { compileMapping, type Mapping } from "../src/index.ts";
import { createMappingPool } from "../src/pool.ts";
import { type Example, example } from "../src/testing.ts";

const { values } = parseArgs({
  options: { seconds: { type: "string", default: "3" }, workers: { type: "string" } },
});
const seconds = Number(values.seconds);
const workers = Number(values.workers ?? Math.min(4, availableParallelism()));

/** The input of the first fixture, with its list of lines repeated up to `lines` items. */
function longer(mapping: Example, key: "lines" | "rows", lines: number): unknown {
  const input = structuredClone(mapping.fixtures[0]?.input) as Record<string, unknown[]>;
  const items = input[key] ?? [];
  input[key] = Array.from({ length: lines }, (_, i) => ({
    ...(items[i % items.length] as object),
    lineNumber: i + 1,
    line: String(i + 1),
  }));
  return input;
}

async function onMainThread(mapping: Mapping, input: unknown): Promise<number> {
  const compiled = compileMapping(mapping);
  for (let i = 0; i < 200; i++) await compiled.run(input);
  let done = 0;
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    for (let i = 0; i < 50; i++) await compiled.run(input);
    done += 50;
  }
  return done / seconds;
}

async function inPool(mapping: Mapping, input: unknown, size: number): Promise<number> {
  const pool = createMappingPool({ size });
  try {
    await Promise.all(Array.from({ length: 200 * size }, () => pool.run(mapping, input)));
    let done = 0;
    const end = performance.now() + seconds * 1000;
    // Keeps 4 documents in flight per worker, so that none waits for the main thread.
    const lane = async (): Promise<void> => {
      while (performance.now() < end) {
        await pool.run(mapping, input);
        done++;
      }
    };
    await Promise.all(Array.from({ length: size * 4 }, lane));
    return done / seconds;
  } finally {
    await pool.close();
  }
}

const outbound = example("order-to-csv.mapping.yaml");
const inbound = example("csv-to-order-response.mapping.yaml");
const rows: string[] = [];
for (const lines of [3, 20, 80]) {
  for (const [name, mapping, input] of [
    ["order to CSV rows", outbound, longer(outbound, "lines", lines)],
    ["CSV rows to order response", inbound, longer(inbound, "rows", lines)],
  ] as const) {
    const main = await onMainThread(mapping, input);
    const one = await inPool(mapping, input, 1);
    const many = await inPool(mapping, input, workers);
    const bytes = JSON.stringify(input).length;
    rows.push(
      `| ${name} | ${lines} | ${(bytes / 1000).toFixed(1)} KB | ${Math.round(main)} | ${Math.round(one)} | ${Math.round(many)} (${Math.round(many / workers)} per worker) |`,
    );
  }
}

console.info(
  `Node.js ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, ${seconds} s per figure\n`,
);
console.info(
  `| Mapping | Lines | Input | Main thread (doc/s) | Pool of 1 worker (doc/s) | Pool of ${workers} workers (doc/s) |`,
);
console.info("| --- | --- | --- | --- | --- | --- |");
for (const row of rows) console.info(row);
