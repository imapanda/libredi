import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  compileMapping,
  DEFAULT_LIMITS,
  type Difference,
  diffJson,
  type FieldNode,
  type Mapping,
  MappingError,
} from "@libredi/mapping";
import { createMappingPool } from "@libredi/mapping/pool";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { type CliContext, EXIT } from "./context.ts";
import { plain, reason } from "./plain.ts";

const TEST_USAGE = `Usage: libredi test <mapping> [options]

Runs the fixtures of a mapping (contracts/mapping) and compares what it gives with what each
fixture expects. The mapping runs in the sandbox of the translator: in a worker thread, with a
time and a memory limit, and without the functions a mapping may not call ($eval, $now...).
Nothing is written or sent.

Arguments:
  <mapping>             The mapping file, in YAML.

Options:
  --timeout <ms>        Most time for one fixture, in milliseconds. Default ${DEFAULT_LIMITS.timeoutMs}.
  -h, --help            Show this help.

Exit status:
  0  every fixture gives what it expects
  1  a fixture gives something else, or fails
  2  the command line is wrong
  3  the file cannot be read, or is not a valid mapping
  4  something else went wrong: the output cannot be written, or a bug
`;

/** Differences shown for one fixture; the others are counted. */
const MAX_DIFFERENCES = 20;
/** Characters of a value shown in a difference. */
const MAX_VALUE = 120;

class UsageError extends Error {}
class InvalidMapping extends Error {}

interface Fixture {
  readonly name: string;
  readonly input: unknown;
  readonly expected: unknown;
}

interface MappingDocument extends Mapping {
  readonly name: string;
  readonly version: number;
  readonly fixtures: readonly Fixture[];
}

const schemaUrl = new URL("../../../contracts/mapping/mapping.schema.json", import.meta.url);

let validateMapping: ValidateFunction | undefined;

async function loadValidator(): Promise<ValidateFunction> {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(await readFile(schemaUrl, "utf8")) as object);
}

/**
 * The error to show: the deepest, and there an unknown property before a missing one. A field
 * is one of two shapes (`oneOf`), so a typo in `expression` also fails both shapes, which says
 * less.
 */
function mostUseful(errors: readonly ErrorObject[]): ErrorObject {
  const rank = (error: ErrorObject): number =>
    error.keyword === "additionalProperties" ? 0 : error.keyword === "required" ? 2 : 1;
  const depth = (error: ErrorObject): number => error.instancePath.split("/").length;
  const candidates = errors.filter((error) => error.keyword !== "oneOf");
  const sorted = [...(candidates.length > 0 ? candidates : errors)].sort(
    (a, b) => depth(b) - depth(a) || rank(a) - rank(b),
  );
  return sorted[0] as ErrorObject;
}

/** The YAML text as a mapping, checked against contracts/mapping/mapping.schema.json. */
async function readMapping(text: string): Promise<MappingDocument> {
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    throw new InvalidMapping(`not valid YAML: ${reason(error)}`);
  }
  validateMapping ??= await loadValidator();
  if (!validateMapping(document)) {
    const error = mostUseful(validateMapping.errors ?? []);
    const where =
      error.instancePath
        .split("/")
        .slice(1)
        .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
        .join(".") || "the document";
    const detail = error.params["additionalProperty"] ?? error.params["missingProperty"];
    throw new InvalidMapping(
      `not a valid mapping: ${where} ${error.message ?? "is not valid"}${detail === undefined ? "" : ` (${String(detail)})`}`,
    );
  }
  return document as MappingDocument;
}

/** The fields of low confidence, which block promotion to production. */
function lowConfidence(fields: Readonly<Record<string, FieldNode>>, path = ""): string[] {
  return Object.entries(fields).flatMap(([name, node]) => {
    const at = path === "" ? name : `${path}.${name}`;
    return [
      ...(node.confidence === "low" ? [at] : []),
      ...(node.fields === undefined ? [] : lowConfidence(node.fields, at)),
    ];
  });
}

/** A JSON value on one line, cut if long. */
function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 3)}...` : text;
}

function describe(difference: Difference): string {
  const where = difference.path === "" ? "the document" : difference.path;
  switch (difference.kind) {
    case "changed":
      return `${where}: expected ${shown(difference.expected)}, got ${shown(difference.actual)}`;
    case "missing":
      return `${where}: missing, expected ${shown(difference.expected)}`;
    case "unexpected":
      return `${where}: not expected, got ${shown(difference.actual)}`;
  }
}

function parseArguments(argv: readonly string[]): { file: string; timeoutMs: number } | "help" {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: { timeout: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) return "help";
  const [file, ...extra] = positionals;
  if (file === undefined) throw new UsageError("test needs the mapping file to run");
  if (extra.length > 0) throw new UsageError(`test takes one mapping, not ${positionals.length}`);
  const timeout = values.timeout ?? String(DEFAULT_LIMITS.timeoutMs);
  const timeoutMs = /^[0-9]+$/.test(timeout) ? Number(timeout) : Number.NaN;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new UsageError(`--timeout expects a whole number of milliseconds, not "${timeout}"`);
  }
  return { file, timeoutMs };
}

/** `libredi test`. The arguments are those after the command. Returns the exit status. */
export async function testMapping(argv: readonly string[], context: CliContext): Promise<number> {
  const { stdout, stderr } = context;
  let options: ReturnType<typeof parseArguments>;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr(`libredi: ${plain(reason(error))}\n\n${TEST_USAGE}`);
    return EXIT.usage;
  }
  if (options === "help") {
    await stdout(TEST_USAGE);
    return EXIT.ok;
  }

  const file = basename(options.file);
  let mapping: MappingDocument;
  try {
    const text = await readFile(resolve(context.cwd ?? process.cwd(), options.file), "utf8");
    mapping = await readMapping(text);
    // Refuses a bad expression or $eval before any fixture runs.
    compileMapping(mapping);
  } catch (error) {
    const detail =
      error instanceof MappingError && error.field !== null
        ? `${error.field}: ${error.message}`
        : reason(error);
    stderr(`libredi: ${plain(file)}: ${plain(detail)}\n`);
    return EXIT.unreadable;
  }

  const pool = createMappingPool({
    size: Math.min(4, mapping.fixtures.length),
    limits: { timeoutMs: options.timeoutMs },
  });
  const outcomes = await Promise.all(
    mapping.fixtures.map((fixture) =>
      pool.run(mapping, fixture.input).then(
        (output) => ({ fixture, differences: diffJson(fixture.expected, output) }),
        (error: unknown) => ({ fixture, error: error as MappingError }),
      ),
    ),
  ).finally(() => pool.close());

  const lines = [`${file}: ${mapping.name}, version ${mapping.version}`];
  let passed = 0;
  for (const outcome of outcomes) {
    if ("error" in outcome) {
      const { code, field, message } = outcome.error;
      lines.push(`FAIL ${outcome.fixture.name}`);
      lines.push(`  ${code}${field === null ? "" : ` in ${field}`}: ${message}`);
    } else if (outcome.differences.length > 0) {
      lines.push(`FAIL ${outcome.fixture.name}`);
      for (const difference of outcome.differences.slice(0, MAX_DIFFERENCES)) {
        lines.push(`  ${describe(difference)}`);
      }
      const more = outcome.differences.length - MAX_DIFFERENCES;
      if (more > 0) lines.push(`  ... and ${more} more`);
    } else {
      passed++;
      lines.push(`pass ${outcome.fixture.name}`);
    }
  }
  const total = outcomes.length;
  lines.push(
    passed === total
      ? `Result: ${total === 1 ? "the fixture passes" : `all ${total} fixtures pass`}.`
      : `Result: ${total - passed} of ${total} ${total === 1 ? "fixture fails" : "fixtures fail"}.`,
  );
  const low = lowConfidence(mapping.fields);
  if (low.length > 0) {
    lines.push(`Low confidence, to review before promotion: ${low.join(", ")}`);
  }
  await stdout(`${lines.map(plain).join("\n")}\n`);
  return passed === total ? EXIT.ok : EXIT.invalid;
}
