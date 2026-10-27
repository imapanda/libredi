/*
 * Benchmark of the tokenizer: throughput and memory on a generated multi-megabyte interchange.
 *
 *   pnpm --filter @libredi/edifact bench                  # defaults: about 10 MB, 15 runs
 *   pnpm --filter @libredi/edifact bench -- --sweep       # also compare batch sizes
 *   pnpm --filter @libredi/edifact bench -- --size-mb=100 --runs=5 --no-baseline
 *   pnpm --filter @libredi/edifact bench -- --json                 # numbers for a script
 *
 * It runs on Node.js with `--expose-gc` (the script sets it) and prints Markdown tables to paste
 * in a pull request. Nothing here fails a build: a regression threshold is issue #54.
 * MB means 10^6 bytes. Timings are the median of the runs after a warm-up.
 */
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import {
  acknowledge,
  type InterchangeData,
  interchangeData,
  parseInterchanges,
  parseMessages,
  serialize,
  serializeData,
  splitMessages,
  Tokenizer,
  TokenKind,
  validate,
} from "../src/index.ts";
import { corpusRegistries } from "../src/testing/corpus-registry.ts";
import { generateOrders } from "./generate.ts";
import { parseToObjectTree } from "./object-tree.ts";

const options = parseOptions(process.argv.slice(2));
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) {
  console.error("Run with `node --expose-gc bench/run.ts` (the package script does).");
  process.exit(1);
}

/** Keeps the work observable so that the engine cannot drop it. */
let sink = 0;

// --- Inputs ------------------------------------------------------------------------------

// One order of 80 lines is about 9 KB (the "9 KB message" of docs/research/languages.md); a
// one-line order is about 0.6 KB. The big file holds enough 9 KB orders to reach the size asked.
const BIG_LINES = 80;
const bigMessages = Math.max(1, Math.round((options.sizeMb * 1e6) / 9_200));
const big = generateOrders({
  messages: bigMessages,
  linesPerMessage: BIG_LINES,
  seed: options.seed,
});
const small = generateOrders({
  messages: Math.max(1, Math.round((options.sizeMb * 1e6) / 560)),
  linesPerMessage: 3,
  seed: options.seed,
});

// --- Things to measure ---------------------------------------------------------------------

/** What any scanner pays just to look at every byte: one table lookup per byte, nothing else. */
const SPECIAL = new Uint8Array(256);
for (const byte of [0x27, 0x2b, 0x3a, 0x3f]) {
  SPECIAL[byte] = 1;
}

function rawLoop(bytes: Uint8Array): number {
  const length = bytes.length;
  let special = 0;
  for (let i = 0; i < length; i++) {
    special += SPECIAL[bytes[i] as number] as number;
  }
  return special;
}

/** The tokenizer with the lightest consumer: it only counts the tokens. */
function countTokens(bytes: Uint8Array, batchSize?: number): number {
  let tokens = 0;
  for (const batch of new Tokenizer(bytes, batchSize === undefined ? undefined : { batchSize })) {
    tokens += batch.length;
  }
  return tokens;
}

/** The tokenizer with a consumer that reads every token, as a parser would. */
function readTokens(bytes: Uint8Array, batchSize?: number): number {
  let segments = 0;
  let checksum = 0;
  for (const batch of new Tokenizer(bytes, batchSize === undefined ? undefined : { batchSize })) {
    const { kinds, starts, ends, length } = batch;
    for (let i = 0; i < length; i++) {
      if (kinds[i] === TokenKind.SegmentTag) {
        segments++;
      }
      checksum = (checksum + (ends[i] as number) - (starts[i] as number)) | 0;
    }
  }
  return segments + checksum;
}

/**
 * The tokenizer with a consumer that also turns every tag and value into a string, as the object
 * tree does. Strings are only measured, not kept: this is the like-for-like speed, not the memory.
 */
function decodeValues(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  let total = 0;
  for (const batch of new Tokenizer(bytes)) {
    const { kinds, starts, ends, length } = batch;
    for (let i = 0; i < length; i++) {
      const kind = kinds[i];
      if (
        kind === TokenKind.Text ||
        kind === TokenKind.EscapedText ||
        kind === TokenKind.SegmentTag
      ) {
        total += text.slice(starts[i] as number, ends[i] as number).length;
      }
    }
  }
  return total;
}

/** Every message of the file located, with the character set of each value checked. */
function splitAll(bytes: Uint8Array, checkCharacters = true): number {
  let segments = 0;
  for (const slice of splitMessages(bytes, { checkCharacters })) {
    segments += slice.segmentCount;
  }
  return segments;
}

/** The parser at its cheapest: every message is built, nothing is read from it. */
function parseOnly(bytes: Uint8Array): number {
  let segments = 0;
  for (const message of parseMessages(bytes)) {
    segments += message.segmentCount;
  }
  return segments;
}

/** What a validator does first: visit every segment, element and component of every message. */
function parseAndWalk(bytes: Uint8Array): number {
  let components = 0;
  for (const message of parseMessages(bytes)) {
    for (const segment of message.segments) {
      for (const element of segment.elements) {
        components += element.components.length;
      }
    }
  }
  return components;
}

/** ... and what a mapping does: turn every value into text. */
function parseAndRead(bytes: Uint8Array): number {
  let characters = 0;
  for (const message of parseMessages(bytes)) {
    for (const segment of message.segments) {
      for (const element of segment.elements) {
        for (const component of element.components) {
          characters += component.text().length;
        }
      }
    }
  }
  return characters;
}

/** The validator: the file and its envelopes, and nothing built beyond what the parser builds. */
function validateAll(bytes: Uint8Array): number {
  return validate(bytes).issueCount + 1;
}

/** The validator with the summary of each interchange and message that a CONTRL is written from. */
function validateWithSummary(bytes: Uint8Array): number {
  return validate(bytes, { summary: true }).issueCount + 1;
}

/** The CONTRL for each interchange of a file: the validation with a summary, and the writing. */
function acknowledgeAll(bytes: Uint8Array): number {
  const { interchanges } = acknowledge(bytes, { reference: "C1", always: true });
  let written = 0;
  for (const one of interchanges) {
    written += one.contrl?.length ?? 0;
  }
  return written + 1;
}

/** The validator with a registry: structure, and the type, length and codes of every value. */
function validateWithRegistry(bytes: Uint8Array): number {
  return validate(bytes, { registries: corpusRegistries }).issueCount + 1;
}

/** The whole file as one tree, kept in memory. */
function parseWhole(bytes: Uint8Array): number {
  const { interchanges } = parseInterchanges(bytes, { maxTreeBytes: 2 ** 31 });
  return interchanges.length + (interchanges[0]?.items.length ?? 0);
}

/** How many distinct orders the writing scenarios cycle through: enough not to measure one object's cache. */
const DISTINCT_ORDERS = 256;

/** Some orders of the file, each as data: the input of the build path. */
function ordersAsData(
  bytes: Uint8Array,
  messages: readonly { start: number; end: number }[],
  values: "text" | "bytes",
): InterchangeData[] {
  return messages.slice(0, DISTINCT_ORDERS).map(({ start, end }) => {
    const [interchange] = parseInterchanges(bytes.subarray(start, end)).interchanges;
    if (interchange === undefined) {
      throw new Error("no interchange in an order");
    }
    return interchangeData(interchange, { values });
  });
}

/** Writes `count` orders from data, cycling through the data. */
function writeOrders(data: readonly InterchangeData[], count: number): number {
  let bytes = 0;
  for (let i = 0; i < count; i++) {
    bytes += serializeData(data[i % data.length] as InterchangeData).length;
  }
  return bytes;
}

/** The whole path of an edit: parse an order, turn it into data, write it again. */
function parseEditWrite(
  bytes: Uint8Array,
  messages: readonly { start: number; end: number }[],
): number {
  let total = 0;
  for (const { start, end } of messages) {
    const [interchange] = parseInterchanges(bytes.subarray(start, end)).interchanges;
    total += serializeData(interchangeData(interchange as NonNullable<typeof interchange>)).length;
  }
  return total;
}

/** One tokenizer per message, as a worker will see them when the file has been split (see `splitMessages`). */
function perMessage(
  bytes: Uint8Array,
  messages: readonly { start: number; end: number }[],
): number {
  let total = 0;
  for (const { start, end } of messages) {
    total += readTokens(bytes.subarray(start, end));
  }
  return total;
}

// --- Measuring -----------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

interface Timing {
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}

function time(work: () => number, runs = options.runs, warmup = options.warmup): Timing {
  for (let i = 0; i < warmup; i++) {
    sink ^= work();
  }
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    gc?.();
    const start = performance.now();
    sink ^= work();
    samples.push(performance.now() - start);
  }
  return { medianMs: median(samples), minMs: Math.min(...samples), maxMs: Math.max(...samples) };
}

const mbPerSecond = (bytes: number, ms: number): number => bytes / 1e6 / (ms / 1000);
const fixed = (value: number, digits = 0): string => value.toFixed(digits);
const heapNow = (): number => {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
};

/**
 * What the tokenizer holds while it runs and after it is done. `workingSet` is the ArrayBuffer
 * memory it adds (its batch: a few tens of KiB, sampled during the scan); `retained` is what
 * is still in use after a full collection (nothing, if it keeps no state).
 */
function tokenizerMemory(bytes: Uint8Array): { workingSet: number; retained: number } {
  gc?.();
  gc?.();
  const baseBuffers = process.memoryUsage().arrayBuffers;
  const baseTotal = heapNow();
  let workingSet = 0;
  let batches = 0;
  const tokenizer = new Tokenizer(bytes);
  for (const batch of tokenizer) {
    sink ^= batch.length;
    if (++batches % 16 === 1) {
      workingSet = Math.max(workingSet, process.memoryUsage().arrayBuffers - baseBuffers);
    }
  }
  gc?.();
  gc?.();
  const retained = Math.max(0, heapNow() - baseTotal);
  sink ^= tokenizer.locate(0).line;
  return { workingSet, retained };
}

/** Heap and buffers while the file is split (sampled): the slices are small and dropped. */
function splitMemory(bytes: Uint8Array): number {
  gc?.();
  gc?.();
  const base = heapNow();
  let peak = 0;
  let count = 0;
  for (const slice of splitMessages(bytes)) {
    sink ^= slice.segmentCount;
    if (++count % 64 === 0) {
      peak = Math.max(peak, heapNow() - base);
    }
  }
  return peak;
}

/**
 * Memory of the parser: the arrays it needs for one message, which is what bounds it (exact),
 * and the growth of the heap and of the buffers while it runs (sampled, so it also counts the
 * garbage of messages not yet collected), then what the whole tree keeps.
 */
function parserMemory(bytes: Uint8Array): {
  workingBytes: number;
  freeRunning: number;
  live: number;
  messages: number;
  wholeTree: number | null;
} {
  const loop = (
    collectEvery: number,
  ): { peak: number; stream: ReturnType<typeof parseMessages> } => {
    gc?.();
    gc?.();
    const base = heapNow();
    const stream = parseMessages(bytes);
    let peak = 0;
    let count = 0;
    for (const message of stream) {
      sink ^= message.segmentCount;
      if (++count % 64 === 0) {
        if (collectEvery > 0 && count % collectEvery === 0) {
          gc?.();
        }
        peak = Math.max(peak, heapNow() - base);
      }
    }
    return { peak, stream };
  };
  // Left to itself the engine collects when the buffers it has been handed pile up; with a
  // collection every 64 messages, what is left is what the parser really holds.
  const free = loop(0);
  const live = loop(64);
  gc?.();
  gc?.();
  let wholeTree: number | null = null;
  if (options.wholeTree) {
    const baseTree = heapNow();
    const result = parseInterchanges(bytes, { maxTreeBytes: 2 ** 31 });
    gc?.();
    gc?.();
    wholeTree = heapNow() - baseTree;
    sink ^= result.interchanges.length;
  }
  return {
    workingBytes: live.stream.peakWorkingBytes,
    freeRunning: free.peak,
    live: live.peak,
    messages: live.stream.messageCount,
    wholeTree,
  };
}

/**
 * What the whole tree keeps for a file of tiny messages (16 bytes each): the fixed cost of a
 * message, which the ratio of 3.8 for ordinary orders hides.
 */
function tinyMessagesRetained(): { inputBytes: number; retained: number } {
  const bytes = new TextEncoder().encode("UNH+1+X'UNT+1+1'".repeat(50_000));
  gc?.();
  gc?.();
  const base = heapNow();
  const result = parseInterchanges(bytes, { maxTreeBytes: 1 << 30 });
  gc?.();
  gc?.();
  const retained = heapNow() - base;
  sink ^= result.interchanges.length;
  return { inputBytes: bytes.length, retained };
}

/** Memory still held by the tree once it is built, after a full collection. */
function objectTreeRetained(bytes: Uint8Array): number {
  gc?.();
  gc?.();
  const base = heapNow();
  const tree = parseToObjectTree(bytes);
  gc?.();
  gc?.();
  const retained = heapNow() - base;
  sink ^= tree.length;
  return retained;
}

// --- Report --------------------------------------------------------------------------------

const bigBytes = big.bytes.length;
const smallBytes = small.bytes.length;
const smallAverage = smallBytes / small.messages.length;
const bigAverage = bigBytes / big.messages.length;

const tokens = countTokens(big.bytes);
const rows: {
  scenario: string;
  input: string;
  throughput: string;
  detail: string;
  range: string;
}[] = [];

function addThroughput(scenario: string, bytes: number, timing: Timing, detail: string): number {
  const rate = mbPerSecond(bytes, timing.medianMs);
  rows.push({
    scenario,
    input: `${fixed(bytes / 1e6, 1)} MB`,
    throughput: `${fixed(rate)} MB/s`,
    detail,
    range: `${fixed(mbPerSecond(bytes, timing.maxMs))}–${fixed(mbPerSecond(bytes, timing.minMs))}`,
  });
  return rate;
}

const rawTiming = time(() => rawLoop(big.bytes));
addThroughput("raw byte loop (the floor: read every byte once)", bigBytes, rawTiming, "");

const countTiming = time(() => countTokens(big.bytes));
addThroughput(
  "tokenizer, counting tokens",
  bigBytes,
  countTiming,
  `${fixed(tokens / 1e6, 2)} M tokens, ${fixed(tokens / (countTiming.medianMs / 1000) / 1e6, 1)} M tokens/s`,
);

const readTiming = time(() => readTokens(big.bytes));
const readRate = addThroughput(
  "tokenizer, reading every token",
  bigBytes,
  readTiming,
  `${big.segments.toLocaleString("en-US")} segments, ${fixed(big.segments / (readTiming.medianMs / 1000) / 1e3)} k segments/s`,
);

const decodeTiming = time(() => decodeValues(big.bytes));
const decodeRate = addThroughput(
  "tokenizer, turning every tag and value into a string",
  bigBytes,
  decodeTiming,
  "the work the object tree does too, without keeping the strings",
);

const splitTiming = time(() => splitAll(big.bytes));
const splitOrdersPerSecond = big.messages.length / (splitTiming.medianMs / 1000);
const splitRate = addThroughput(
  "splitMessages, locating every message and checking every character",
  bigBytes,
  splitTiming,
  `${fixed(splitOrdersPerSecond)} orders/s, ${fixed(1e6 / splitOrdersPerSecond, 1)} µs per order`,
);

const unCheckedTiming = time(() => splitAll(big.bytes, false));
addThroughput(
  "splitMessages without the character check",
  bigBytes,
  unCheckedTiming,
  `the check adds ${fixed((splitTiming.medianMs / unCheckedTiming.medianMs - 1) * 100)} % to the time`,
);

const parseTiming = time(() => parseOnly(big.bytes));
const parseOrdersPerSecond = big.messages.length / (parseTiming.medianMs / 1000);
const parseRate = addThroughput(
  "parseMessages, building every message",
  bigBytes,
  parseTiming,
  `${fixed(parseOrdersPerSecond)} orders/s, ${fixed(1e6 / parseOrdersPerSecond, 1)} µs per order`,
);

const validateTiming = time(() => validateAll(big.bytes));
const validateOrdersPerSecond = big.messages.length / (validateTiming.medianMs / 1000);
const validateRate = addThroughput(
  "validate, the file and its envelopes",
  bigBytes,
  validateTiming,
  `${fixed(validateOrdersPerSecond)} orders/s, ${fixed(1e6 / validateOrdersPerSecond, 1)} µs per order`,
);

const summaryTiming = time(() => validateWithSummary(big.bytes));
const summaryOrdersPerSecond = big.messages.length / (summaryTiming.medianMs / 1000);
const summaryRate = addThroughput(
  "validate, with the summary of each interchange and message",
  bigBytes,
  summaryTiming,
  `${fixed(summaryOrdersPerSecond)} orders/s, ${fixed(1e6 / summaryOrdersPerSecond, 1)} µs per order`,
);

const acknowledgeTiming = time(() => acknowledgeAll(big.bytes));
const acknowledgeOrdersPerSecond = big.messages.length / (acknowledgeTiming.medianMs / 1000);
const acknowledgeRate = addThroughput(
  "acknowledge, the validation and the CONTRL (one UCM per order)",
  bigBytes,
  acknowledgeTiming,
  `${fixed(acknowledgeOrdersPerSecond)} orders/s, ${fixed(1e6 / acknowledgeOrdersPerSecond, 1)} µs per order`,
);

const registryTiming = time(() => validateWithRegistry(big.bytes));
const registryOrdersPerSecond = big.messages.length / (registryTiming.medianMs / 1000);
const registryRate = addThroughput(
  "validate, with a registry (structure and every value)",
  bigBytes,
  registryTiming,
  `${fixed(registryOrdersPerSecond)} orders/s, ${fixed(1e6 / registryOrdersPerSecond, 1)} µs per order`,
);

const walkTiming = time(() => parseAndWalk(big.bytes));
const walkRate = addThroughput(
  "parseMessages, then visiting every segment, element and component",
  bigBytes,
  walkTiming,
  `${fixed(big.messages.length / (walkTiming.medianMs / 1000))} orders/s`,
);

const textTiming = time(() => parseAndRead(big.bytes));
const textOrdersPerSecond = big.messages.length / (textTiming.medianMs / 1000);
const textRate = addThroughput(
  "parseMessages, then reading every value as text",
  bigBytes,
  textTiming,
  `${fixed(textOrdersPerSecond)} orders/s, ${fixed(1e6 / textOrdersPerSecond, 1)} µs per order`,
);

if (options.wholeTree) {
  addThroughput(
    "parseInterchanges, the whole file as one tree",
    bigBytes,
    time(() => parseWhole(big.bytes), Math.max(3, options.runs >> 3), 2),
    "everything stays in memory",
  );
}

// Writing. `serialize` copies what was parsed; `serializeData` builds the bytes from data.
const wholeTree = parseInterchanges(big.bytes, { maxTreeBytes: 2 ** 31 });
const replayTiming = time(() => serialize(wholeTree).length);
addThroughput(
  "serialize, a parsed tree (a copy of its bytes)",
  bigBytes,
  replayTiming,
  "the whole file, line breaks included",
);

const textData = ordersAsData(big.bytes, big.messages, "text");
const bytesData = ordersAsData(big.bytes, big.messages, "bytes");
const orderBytes = writeOrders(textData, textData.length) / textData.length;
const buildTiming = time(() => writeOrders(textData, big.messages.length));
const buildOrdersPerSecond = big.messages.length / (buildTiming.medianMs / 1000);
const buildRate = addThroughput(
  `serializeData, one ${fixed(orderBytes / 1000, 1)} KB order from text values`,
  orderBytes * big.messages.length,
  buildTiming,
  `${fixed(buildOrdersPerSecond)} orders/s, ${fixed(1e6 / buildOrdersPerSecond, 1)} µs per order`,
);

const buildBytesTiming = time(() => writeOrders(bytesData, big.messages.length));
addThroughput(
  `serializeData, one ${fixed(orderBytes / 1000, 1)} KB order from byte values`,
  orderBytes * big.messages.length,
  buildBytesTiming,
  `${fixed(big.messages.length / (buildBytesTiming.medianMs / 1000))} orders/s`,
);

const editTiming = time(() => parseEditWrite(big.bytes, big.messages));
const editOrdersPerSecond = big.messages.length / (editTiming.medianMs / 1000);
addThroughput(
  "parse an order, interchangeData, serializeData (the edit path)",
  bigBytes,
  editTiming,
  `${fixed(editOrdersPerSecond)} orders/s, ${fixed(1e6 / editOrdersPerSecond, 1)} µs per order`,
);

const bigMessageTiming = time(() => perMessage(big.bytes, big.messages));
const bigMessageRate = big.messages.length / (bigMessageTiming.medianMs / 1000);
addThroughput(
  `one tokenizer per ${fixed(bigAverage / 1000, 1)} KB order`,
  bigBytes,
  bigMessageTiming,
  `${fixed(bigMessageRate)} orders/s, ${fixed(1e6 / bigMessageRate, 1)} µs per order`,
);

const smallMessageTiming = time(() => perMessage(small.bytes, small.messages));
const smallMessageRate = small.messages.length / (smallMessageTiming.medianMs / 1000);
addThroughput(
  `one tokenizer per ${fixed(smallAverage / 1000, 1)} KB order`,
  smallBytes,
  smallMessageTiming,
  `${fixed(smallMessageRate)} orders/s, ${fixed(1e6 / smallMessageRate, 1)} µs per order`,
);

let treeRate: number | null = null;
if (options.baseline) {
  const treeTiming = time(
    () => parseToObjectTree(big.bytes).length,
    Math.max(3, options.runs >> 2),
    2,
  );
  treeRate = addThroughput(
    "baseline: object tree (what we avoid)",
    bigBytes,
    treeTiming,
    "an object per segment, an array per element, a string per component",
  );
}

const memory = tokenizerMemory(big.bytes);
const splitting = splitMemory(big.bytes);
const parsing = parserMemory(big.bytes);
const tiny = options.wholeTree ? tinyMessagesRetained() : null;
const retained = options.baseline ? objectTreeRetained(big.bytes) : null;

const lines: string[] = [];
lines.push(
  `Node.js ${process.version} on ${process.platform}/${process.arch}, ${cpus()[0]?.model ?? "unknown CPU"}`,
  `Input: ${fixed(bigBytes / 1e6, 2)} MB, ${big.messages.length.toLocaleString("en-US")} orders of ${BIG_LINES} lines, ${big.segments.toLocaleString("en-US")} segments, seed ${options.seed}; median of ${options.runs} runs after ${options.warmup} warm-up runs.`,
  "",
  "| Scenario | Input | Throughput (median) | Range (MB/s) | Detail |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.scenario} | ${r.input} | ${r.throughput} | ${r.range} | ${r.detail} |`),
  "",
  "| Memory | Extra heap and buffers | Relative to the input |",
  "| --- | --- | --- |",
  `| tokenizer, while scanning (its batch, sampled) | ${fixed(memory.workingSet / 1024, 1)} KiB | ${fixed(memory.workingSet / bigBytes, 4)}× |`,
  `| tokenizer, after the scan and a collection | ${fixed(memory.retained / 1024, 1)} KiB | ${fixed(memory.retained / bigBytes, 4)}× |`,
  `| splitMessages, heap and buffers while it runs (sampled) | ${fixed(splitting / 1024, 1)} KiB | ${fixed(splitting / bigBytes, 4)}× |`,
  `| parseMessages, arrays for one message (exact, the bound) | ${fixed(parsing.workingBytes / 1024, 1)} KiB | ${fixed(parsing.workingBytes / bigBytes, 4)}× |`,
  `| parseMessages, live heap and buffers (collected every 64 messages, sampled) | ${fixed(parsing.live / 1024)} KiB | ${fixed(parsing.live / bigBytes, 4)}× |`,
  `| parseMessages, left to collect itself (sampled, includes garbage) | ${fixed(parsing.freeRunning / 1024)} KiB | ${fixed(parsing.freeRunning / bigBytes, 4)}× |`,
  ...(tiny === null
    ? []
    : [
        `| parseInterchanges, 16-byte messages (retained, the fixed cost of a message) | ${fixed(tiny.retained / 1e6, 1)} MB | ${fixed(tiny.retained / tiny.inputBytes, 0)}× |`,
      ]),
  ...(parsing.wholeTree === null
    ? []
    : [
        `| parseInterchanges, the whole tree (retained) | ${fixed(parsing.wholeTree / 1e6, 1)} MB | ${fixed(parsing.wholeTree / bigBytes, 2)}× |`,
      ]),
  ...(retained === null || treeRate === null
    ? []
    : [
        `| object tree, once built (retained) | ${fixed(retained / 1e6, 1)} MB | ${fixed(retained / bigBytes, 1)}× |`,
        "",
        `Tokenizer vs object tree: ${fixed(readRate / treeRate, 1)}× faster as is, ${fixed(decodeRate / treeRate, 1)}× faster when it also builds every string; ${fixed(retained / Math.max(memory.workingSet, 1))}× less memory.`,
      ]),
  `ADR 10 asks for 500 typical orders per second per core, a budget of 2,000 µs per order for the whole translator; tokenizing one ${fixed(bigAverage / 1000, 1)} KB order takes ${fixed(1e6 / bigMessageRate, 1)} µs (${fixed((1e6 / bigMessageRate / 2000) * 100, 1)} % of it).`,
);

if (options.sweep) {
  lines.push("", "| Batch size | Throughput, reading every token |", "| --- | --- |");
  for (const batchSize of [64, 256, 1024, 4096, 16384, 65536]) {
    const timing = time(() => readTokens(big.bytes, batchSize));
    lines.push(`| ${batchSize} | ${fixed(mbPerSecond(bigBytes, timing.medianMs))} MB/s |`);
  }
}

if (options.json) {
  console.info(
    JSON.stringify({
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpu: cpus()[0]?.model,
      inputBytes: bigBytes,
      segments: big.segments,
      tokens,
      mbPerSecond: {
        raw: mbPerSecond(bigBytes, rawTiming.medianMs),
        tokenizer: readRate,
        split: splitRate,
        parse: parseRate,
        parseAndWalk: walkRate,
        parseAndRead: textRate,
        validate: validateRate,
        validateWithSummary: summaryRate,
        acknowledge: acknowledgeRate,
        validateWithRegistry: registryRate,
        serializeData: buildRate,
        objectTree: treeRate,
      },
      ordersPerSecond: {
        tokenizeLarge: bigMessageRate,
        tokenizeSmall: smallMessageRate,
        split: splitOrdersPerSecond,
        parse: parseOrdersPerSecond,
        parseAndRead: textOrdersPerSecond,
        validate: validateOrdersPerSecond,
        validateWithSummary: summaryOrdersPerSecond,
        acknowledge: acknowledgeOrdersPerSecond,
        validateWithRegistry: registryOrdersPerSecond,
        serializeData: buildOrdersPerSecond,
        parseEditWrite: editOrdersPerSecond,
      },
      memoryBytes: {
        parserWorkingBytes: parsing.workingBytes,
        parserLive: parsing.live,
        parserFreeRunning: parsing.freeRunning,
        wholeTree: parsing.wholeTree,
        tokenizerWorkingSet: memory.workingSet,
        tokenizerRetained: memory.retained,
        objectTreeRetained: retained,
      },
      sink,
    }),
  );
} else {
  console.info(lines.join("\n"));
}

// --- Options -------------------------------------------------------------------------------

function parseOptions(argv: string[]): {
  sizeMb: number;
  runs: number;
  warmup: number;
  seed: number;
  sweep: boolean;
  json: boolean;
  baseline: boolean;
  wholeTree: boolean;
} {
  const result = {
    sizeMb: 10,
    runs: 15,
    warmup: 8,
    seed: 1,
    sweep: false,
    json: false,
    baseline: true,
    wholeTree: true,
  };
  for (const arg of argv) {
    const [name, value] = arg.split("=");
    const number = Number(value);
    switch (name) {
      case "--size-mb":
        result.sizeMb = number;
        break;
      case "--runs":
        result.runs = number;
        break;
      case "--warmup":
        result.warmup = number;
        break;
      case "--seed":
        result.seed = number;
        break;
      case "--sweep":
        result.sweep = true;
        break;
      case "--json":
        result.json = true;
        break;
      case "--no-baseline":
        result.baseline = false;
        break;
      case "--no-whole-tree":
        result.wholeTree = false;
        break;
      case "--":
        break;
      default:
        console.error(
          `Unknown option ${arg}. Known: --size-mb --runs --warmup --seed --sweep --json --no-baseline --no-whole-tree`,
        );
        process.exit(1);
    }
  }
  for (const [name, value] of Object.entries(result)) {
    if (typeof value === "number" && !(value > 0)) {
      console.error(`${name} must be a positive number`);
      process.exit(1);
    }
  }
  return result;
}
