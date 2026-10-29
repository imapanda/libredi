import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../../../contracts/overrides/overrides.schema.json" with { type: "json" };
import type { Problem } from "./check.ts";
import type { MessageNode, Registry, Status } from "./types.ts";

/**
 * TypeScript view of contracts/overrides/overrides.schema.json, written by hand like the registry
 * types (issue #182). The schema is the source of truth: keep both in step.
 */
export interface Overrides {
  schemaVersion: 1;
  name?: string;
  description?: string;
  directory: { agency: string; version: string; release: string };
  dataElements?: Record<
    string,
    { type?: "a" | "an" | "n"; minLength?: number; maxLength?: number }
  >;
  composites?: Record<string, { components: Record<string, { status: Status }> }>;
  segments?: Record<string, { elements: Record<string, { status?: Status; maxOccurs?: number }> }>;
  codeLists?: Record<
    string,
    {
      closed?: boolean;
      add?: Record<string, { name?: string; description?: string }>;
      remove?: string[];
    }
  >;
  messages?: Record<string, { nodes: Record<string, { status?: Status; maxOccurs?: number }> }>;
  severity?: Record<string, "error" | "warning" | "off">;
}

let validator: ReturnType<Ajv2020["compile"]> | undefined;

/** What an error of the schema says, in words for someone who is writing the document. */
function describe(error: ErrorObject): string {
  const { keyword, params } = error;
  if (keyword === "additionalProperties") {
    return `unknown property "${String(params["additionalProperty"])}"`;
  }
  if (keyword === "required") {
    return `missing property "${String(params["missingProperty"])}"`;
  }
  if (keyword === "enum") {
    const allowed = (params["allowedValues"] as unknown[]).map(String);
    // The list of the issue codes is long: the page of overrides has it.
    return allowed.length > 8
      ? "is not an issue code whose severity can be changed (see docs/partner-overrides.md)"
      : `must be one of ${allowed.join(", ")}`;
  }
  if (keyword === "uniqueItems") {
    const [first, second] = [Number(params["i"]), Number(params["j"])].sort((a, b) => a - b);
    return `has the same value twice (items ${first} and ${second})`;
  }
  if (keyword === "const") {
    return `must be ${JSON.stringify(params["allowedValue"])}`;
  }
  return error.message ?? "is invalid";
}

/**
 * Validates a document against contracts/overrides/overrides.schema.json. The schema is imported,
 * not read from disk, so that a bundled service carries it. Returns every violation with the JSON
 * Pointer of the offending value and a sentence that names it; an empty list means the document
 * has the right shape (call `checkOverrides` for the registry it is for). Objects are closed: a
 * misspelt property is reported, not ignored.
 */
export function validateOverrides(document: unknown): Problem[] {
  if (!validator) {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    validator = ajv.compile(schema);
  }
  if (validator(document)) return [];
  return (
    (validator.errors ?? [])
      // A key that does not match is reported once with its name, not again as "propertyNames".
      .filter((error) => error.keyword !== "propertyNames")
      .map((error) => ({
        path: error.instancePath,
        message:
          error.propertyName === undefined
            ? describe(error)
            : `"${error.propertyName}" ${describe(error)}`,
      }))
  );
}

/** A JSON Pointer to a key, which may hold a "/" (a selector such as SG2/QTY). */
const key = (text: string): string => text.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * Checks a document of overrides against the registry it is for: the shape (`validateOverrides`,
 * whose problems are returned alone when there are any, since the rest needs a document of the
 * right shape), then what the schema cannot say: that the document is for this registry, that
 * everything it names is there, so that a rule that would silently do nothing is an error, and that
 * the lengths it gives for a data element agree. The registry must be valid (`checkRegistry`).
 * Returns every problem found; an empty list means each rule of the document applies to something.
 *
 * To check a document that is applied after others, give the registry the others were applied to
 * (`applyOverrides` of `@libredi/edifact`): it then sees the codes they added and the lengths they
 * set, and the lengths of the two documents together are checked.
 */
export function checkOverrides(document: unknown, registry: Registry): Problem[] {
  const shape = validateOverrides(document);
  if (shape.length > 0) {
    return shape;
  }
  const overrides = document as Overrides;
  const problems: Problem[] = [];
  const report = (path: string, message: string): void => {
    problems.push({ path, message });
  };
  const has = (record: object, name: string): boolean => Object.hasOwn(record, name);

  const { directory } = overrides;
  const wanted = registry.directory;
  if (
    directory.agency !== wanted.agency ||
    directory.version !== wanted.version ||
    directory.release !== wanted.release
  ) {
    report(
      "/directory",
      `the document is for ${directory.version}.${directory.release} (${directory.agency}), the registry is of ${wanted.version}.${wanted.release} (${wanted.agency})`,
    );
  }

  for (const [tag, rule] of Object.entries(overrides.dataElements ?? {})) {
    const element = has(registry.dataElements, tag) ? registry.dataElements[tag] : undefined;
    if (element === undefined) {
      report(`/dataElements/${tag}`, `data element "${tag}" does not exist in the registry`);
      continue;
    }
    const min = rule.minLength ?? element.minLength;
    const max = rule.maxLength ?? element.maxLength;
    if (min > max) {
      report(
        `/dataElements/${tag}`,
        `minLength (${min}) would be greater than maxLength (${max}) for data element "${tag}"`,
      );
    }
  }

  for (const [tag, rule] of Object.entries(overrides.composites ?? {})) {
    const composite = has(registry.composites, tag) ? registry.composites[tag] : undefined;
    if (composite === undefined) {
      report(`/composites/${tag}`, `composite "${tag}" does not exist in the registry`);
      continue;
    }
    for (const position of Object.keys(rule.components)) {
      if (Number(position) > composite.components.length) {
        report(
          `/composites/${tag}/components/${position}`,
          `composite "${tag}" has ${composite.components.length} components: there is no position ${position}`,
        );
      }
    }
  }

  for (const [tag, rule] of Object.entries(overrides.segments ?? {})) {
    const segment = has(registry.segments, tag) ? registry.segments[tag] : undefined;
    if (segment === undefined) {
      report(`/segments/${tag}`, `segment "${tag}" does not exist in the registry`);
      continue;
    }
    for (const position of Object.keys(rule.elements)) {
      if (Number(position) > segment.elements.length) {
        report(
          `/segments/${tag}/elements/${position}`,
          `segment "${tag}" has ${segment.elements.length} elements: there is no position ${position}`,
        );
      }
    }
  }

  for (const [id, rule] of Object.entries(overrides.codeLists ?? {})) {
    const list = has(registry.codeLists, id) ? registry.codeLists[id] : undefined;
    if (list === undefined) {
      report(`/codeLists/${id}`, `code list "${id}" does not exist in the registry`);
      continue;
    }
    const removed = new Set(rule.remove ?? []);
    for (const code of Object.keys(rule.add ?? {})) {
      if (has(list.codes, code)) {
        report(
          `/codeLists/${id}/add/${key(code)}`,
          `code "${code}" is already in code list "${id}": there is nothing to add`,
        );
      }
      if (removed.has(code)) {
        report(
          `/codeLists/${id}/add/${key(code)}`,
          `code "${code}" is both added and removed in code list "${id}"`,
        );
      }
    }
    (rule.remove ?? []).forEach((code, index) => {
      if (!has(list.codes, code)) {
        report(
          `/codeLists/${id}/remove/${index}`,
          `code "${code}" is not in code list "${id}": there is nothing to remove`,
        );
      }
    });
  }

  for (const [type, rule] of Object.entries(overrides.messages ?? {})) {
    const message = has(registry.messages, type) ? registry.messages[type] : undefined;
    if (message === undefined) {
      report(`/messages/${type}`, `message "${type}" does not exist in the registry`);
      continue;
    }
    const groups = new Map<string, MessageNode[]>();
    const tags = new Set<string>();
    const collect = (nodes: MessageNode[]): void => {
      for (const node of nodes) {
        if (node.kind === "segment") {
          tags.add(node.tag);
        } else {
          groups.set(node.id, node.nodes ?? []);
          collect(node.nodes ?? []);
        }
      }
    };
    collect(message.nodes);
    for (const selector of Object.keys(rule.nodes)) {
      const path = `/messages/${type}/nodes/${key(selector)}`;
      const [group, tag] = selector.includes("/") ? selector.split("/") : [undefined, selector];
      if (tag === undefined) {
        continue;
      }
      if (group === undefined && /^SG[0-9]+$/.test(tag)) {
        if (!groups.has(tag)) {
          report(path, `message ${type} has no group "${tag}"`);
        }
      } else if (group === undefined) {
        if (!tags.has(tag)) {
          report(path, `message ${type} has no segment "${tag}"`);
        }
      } else if (!groups.has(group as string)) {
        report(path, `message ${type} has no group "${group}"`);
      } else if (
        !(groups.get(group as string) ?? []).some((n) => n.kind === "segment" && n.tag === tag)
      ) {
        report(
          path,
          `group ${group} of message ${type} has no segment "${tag}" directly inside it`,
        );
      }
    }
  }

  return problems;
}
