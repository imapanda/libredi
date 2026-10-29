import jsonata from "jsonata";

export interface FieldNode {
  expression?: string;
  forEach?: string;
  fields?: Record<string, FieldNode>;
  confidence?: "high" | "medium" | "low";
}

export interface MappingFile {
  lookups?: Record<string, Record<string, string>>;
  fields: Record<string, FieldNode>;
}

/** Functions whose result is not a function of the input, or that run text as code. */
const UNAVAILABLE = ["eval", "now", "millis", "random", "shuffle"];

/**
 * Executable statement of the evaluation rules in contracts/mapping/README.md, so that the
 * fixtures of the examples run in CI. It is not the runner: no sandbox, no limits.
 */
export async function evaluateMapping(mapping: MappingFile, input: unknown): Promise<unknown> {
  const evaluate = (expression: string, context: unknown, index: number): Promise<unknown> => {
    const compiled = jsonata(expression);
    for (const name of UNAVAILABLE) {
      compiled.registerFunction(name, () => {
        throw new Error(`$${name}() is not available in a mapping`);
      });
    }
    compiled.assign("root", input);
    compiled.assign("lookups", mapping.lookups ?? {});
    compiled.assign("index", index);
    return compiled.evaluate(context);
  };

  const build = async (
    fields: Record<string, FieldNode>,
    context: unknown,
    index: number,
  ): Promise<Record<string, unknown> | undefined> => {
    const output: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(fields)) {
      const value = await evaluateNode(node, context, index);
      if (value !== undefined) output[name] = value;
    }
    return Object.keys(output).length > 0 ? output : undefined;
  };

  const evaluateNode = async (
    node: FieldNode,
    context: unknown,
    index: number,
  ): Promise<unknown> => {
    if (node.expression !== undefined) {
      return (await evaluate(node.expression, context, index)) ?? undefined;
    }
    const fields = node.fields ?? {};
    if (node.forEach === undefined) return build(fields, context, index);
    const selected = await evaluate(node.forEach, context, index);
    const items = selected == null ? [] : Array.isArray(selected) ? selected : [selected];
    const built = await Promise.all(items.map((item, position) => build(fields, item, position)));
    const objects = built.filter((object) => object !== undefined);
    return objects.length > 0 ? objects : undefined;
  };

  const output = (await build(mapping.fields, input, 0)) ?? {};
  return JSON.parse(JSON.stringify(output));
}
