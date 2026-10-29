import jsonata from "jsonata";
import { MappingError, toMappingError } from "./errors.ts";

/** A field of a mapping (contracts/mapping): a leaf with an expression, or a group of fields. */
export interface FieldNode {
  readonly expression?: string;
  readonly forEach?: string;
  readonly fields?: Readonly<Record<string, FieldNode>>;
  readonly confidence?: "high" | "medium" | "low";
}

/** What the runner reads of a mapping document: its lookup tables and its fields. */
export interface Mapping {
  readonly lookups?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly fields: Readonly<Record<string, FieldNode>>;
}

/** The limits of one document. Every one applies inside a worker and in the browser alike. */
export interface Limits {
  /** Most time for one document, in milliseconds. */
  readonly timeoutMs: number;
  /** Deepest nesting of JSONata evaluations, which recursion makes grow. */
  readonly maxDepth: number;
  /** Longest sequence an expression may build, the range operator `[1..n]` included. */
  readonly maxSequence: number;
  /** Most characters `$pad()` may add: it builds its padding in one allocation. */
  readonly maxPadLength: number;
  /** Longest string an expression, or a step of it, may give. */
  readonly maxStringLength: number;
}

export const DEFAULT_LIMITS: Limits = {
  timeoutMs: 1000,
  maxDepth: 500,
  maxSequence: 1_000_000,
  maxPadLength: 100_000,
  maxStringLength: 1_000_000,
};

/**
 * Functions a mapping may not call: their result is not a function of the input, or they run
 * text as code. contracts/mapping/README.md lists them.
 */
export const UNAVAILABLE_FUNCTIONS: readonly string[] = [
  "eval",
  "now",
  "millis",
  "random",
  "shuffle",
];

type Expression = ReturnType<typeof jsonata>;

interface CompiledNode {
  readonly name: string;
  readonly expression?: Expression;
  readonly forEach?: Expression;
  readonly fields?: readonly CompiledNode[];
}

/** A mapping whose expressions are parsed once, to run on any number of documents. */
export interface CompiledMapping {
  /** The output for one input document, as JSON data. Throws a {@link MappingError}. */
  run(input: unknown): Promise<Record<string, unknown>>;
}

/**
 * The variables an expression reads but never binds itself (with `:=`, as a parameter of a
 * function, or with `@$` and `#$` in a path), from its syntax tree: those come from outside.
 */
function freeVariables(ast: unknown): Set<string> {
  const read = new Set<string>();
  const bound = new Set<string>();
  const seen = new Set<object>();
  const nameOf = (variable: unknown): unknown => (variable as { value?: unknown } | null)?.value;
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    const {
      type,
      value,
      lhs,
      arguments: parameters,
      focus,
      index,
    } = node as Record<string, unknown>;
    if (type === "variable") read.add(String(value));
    const binds = [
      type === "bind" ? nameOf(lhs) : undefined,
      ...(type === "lambda" && Array.isArray(parameters) ? parameters.map(nameOf) : []),
      focus,
      index,
    ];
    for (const name of binds) if (typeof name === "string") bound.add(name);
    for (const child of Object.values(node)) visit(child);
  };
  visit(ast);
  return new Set([...read].filter((name) => !bound.has(name)));
}

/**
 * `$join()` as JSONata writes it, but refusing a result longer than the limit before building it:
 * joining the same long string many times would allocate it in one step.
 */
function boundedJoin(maxStringLength: number) {
  return (strings: string[] | undefined, separator = ""): string | undefined => {
    if (strings === undefined) return undefined;
    let length = Math.max(0, strings.length - 1) * separator.length;
    for (const text of strings) length += text.length;
    if (length > maxStringLength) throw tooLong(maxStringLength);
    return strings.join(separator);
  };
}

const tooLong = (maxStringLength: number): MappingError =>
  new MappingError({
    code: "TOO_LONG",
    message: `A string may have at most ${maxStringLength} characters.`,
    field: null,
    position: null,
  });

/**
 * `$pad()` as JSONata writes it, counting in code points, but refusing a padding longer than the
 * limit: `$pad("", 500000000)` would allocate it in one step, which the memory limit of a worker
 * cannot stop (V8 then aborts the whole process).
 */
function boundedPad(maxPadLength: number) {
  return (text: string | undefined, width: number, char?: string): string | undefined => {
    if (text === undefined) return undefined;
    const fill = char === undefined || char.length === 0 ? [" "] : [...char];
    const target = Math.trunc(width);
    const padLength = Math.abs(target) - [...text].length;
    if (padLength <= 0) return text;
    if (padLength > maxPadLength) {
      throw new MappingError({
        code: "TOO_LONG",
        message: `$pad() may add at most ${maxPadLength} characters, not ${padLength}.`,
        field: null,
        position: null,
      });
    }
    const padding = Array.from({ length: padLength }, (_, i) => fill[i % fill.length]).join("");
    return target > 0 ? text + padding : padding + text;
  };
}

function compileExpression(source: string, field: string, limits: Limits): Expression {
  let expression: Expression;
  let used: Set<string>;
  try {
    expression = jsonata(source, {
      timeout: limits.timeoutMs,
      stack: limits.maxDepth,
      sequence: limits.maxSequence,
    });
    used = freeVariables(expression.ast());
  } catch (thrown) {
    throw toMappingError(thrown, field);
  }
  // Refused when written, not only when reached: a branch the fixtures do not take is checked too.
  for (const name of UNAVAILABLE_FUNCTIONS) {
    if (used.has(name)) {
      throw new MappingError({
        code: "UNAVAILABLE_FUNCTION",
        message: `$${name}() is not available in a mapping`,
        field,
        position: null,
      });
    }
    // Shadows the built-in in case a name reaches it another way.
    expression.registerFunction(name, () => {
      throw new MappingError({
        code: "UNAVAILABLE_FUNCTION",
        message: `$${name}() is not available in a mapping`,
        field: null,
        position: null,
      });
    });
  }
  expression.registerFunction("pad", boundedPad(limits.maxPadLength), "<s-ns?:s>");
  expression.registerFunction("join", boundedJoin(limits.maxStringLength), "<a<s>s?:s>");
  // Every step: doubling a string with & would otherwise reach hundreds of megabytes in a few
  // steps, and the first use of it would allocate them at once. Reading the length is free.
  const checkLength = (_node: unknown, _input: unknown, _env: unknown, result: unknown): void => {
    if (typeof result === "string" && result.length > limits.maxStringLength) {
      throw tooLong(limits.maxStringLength);
    }
  };
  (expression.assign as unknown as (name: symbol, value: unknown) => void)(
    Symbol.for("jsonata.__evaluate_exit"),
    checkLength,
  );
  return expression;
}

function compileFields(
  fields: Readonly<Record<string, FieldNode>>,
  path: string,
  limits: Limits,
): CompiledNode[] {
  return Object.entries(fields).map(([name, node]) => {
    const field = path === "" ? name : `${path}.${name}`;
    if (node.expression !== undefined) {
      return { name, expression: compileExpression(node.expression, field, limits) };
    }
    const compiled = compileFields(node.fields ?? {}, field, limits);
    return node.forEach === undefined
      ? { name, fields: compiled }
      : { name, forEach: compileExpression(node.forEach, field, limits), fields: compiled };
  });
}

/**
 * Parses the expressions of a mapping and checks that they call no unavailable function. Pure:
 * no Node.js API, so that the browser preview runs exactly what the translator runs. It applies
 * the evaluation rules of contracts/mapping/README.md, as the reference evaluator of
 * `@libredi/contracts` states them. The limits are checked by JSONata between two steps of an
 * evaluation: a single slow step, such as a regular expression that backtracks, is stopped only
 * by the worker pool of `@libredi/mapping/pool`.
 */
export function compileMapping(mapping: Mapping, limits: Limits = DEFAULT_LIMITS): CompiledMapping {
  const root = compileFields(mapping.fields, "", limits);
  const lookups = mapping.lookups ?? {};

  return {
    async run(input) {
      const deadline = Date.now() + limits.timeoutMs;

      const evaluate = async (
        expression: Expression,
        field: string,
        context: unknown,
        index: number,
      ): Promise<unknown> => {
        if (Date.now() > deadline) {
          throw new MappingError({
            code: "TIMEOUT",
            message: `The document took longer than ${limits.timeoutMs} ms.`,
            field,
            position: null,
          });
        }
        try {
          return (await expression.evaluate(context, { root: input, lookups, index })) ?? undefined;
        } catch (thrown) {
          throw toMappingError(thrown, field);
        }
      };

      const build = async (
        nodes: readonly CompiledNode[],
        path: string,
        context: unknown,
        index: number,
      ): Promise<Record<string, unknown> | undefined> => {
        const entries: [string, unknown][] = [];
        for (const node of nodes) {
          const value = await evaluateNode(
            node,
            path === "" ? node.name : `${path}.${node.name}`,
            context,
            index,
          );
          if (value !== undefined) entries.push([node.name, value]);
        }
        // fromEntries defines the properties: a field named __proto__ is a field like another.
        return entries.length > 0 ? Object.fromEntries(entries) : undefined;
      };

      const evaluateNode = async (
        node: CompiledNode,
        field: string,
        context: unknown,
        index: number,
      ): Promise<unknown> => {
        if (node.expression !== undefined) return evaluate(node.expression, field, context, index);
        const fields = node.fields ?? [];
        if (node.forEach === undefined) return build(fields, field, context, index);
        const selected = await evaluate(node.forEach, field, context, index);
        const items = selected == null ? [] : Array.isArray(selected) ? selected : [selected];
        // One item after the other, so that the error reported is always that of the first item.
        const objects: Record<string, unknown>[] = [];
        for (const [position, item] of items.entries()) {
          const built = await build(fields, `${field}[${position}]`, item, position);
          if (built !== undefined) objects.push(built);
        }
        return objects.length > 0 ? objects : undefined;
      };

      const output = (await build(root, "", input, 0)) ?? {};
      // As JSON: no undefined, no function, no reference into the input.
      return JSON.parse(JSON.stringify(output)) as Record<string, unknown>;
    },
  };
}
