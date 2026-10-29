import type { IssueCode, Severity } from "./issues.ts";
import { ISSUE_CATALOGUE, isIssueCode } from "./issues.ts";
import type {
  CodeListView,
  DataElementView,
  NodeView,
  PositionView,
  RegistryView,
  Status,
} from "./registry.ts";

/*
 * Partner overrides (contracts/overrides/overrides.schema.json): the rules one trading partner, or
 * one flow with a partner, changes in the standard definitions, without editing the registry.
 *
 * `OverridesView` is the part of the document that validation uses, written as an interface for the
 * reason `RegistryView` is: a document that follows the schema, an `Overrides` of
 * `@libredi/registry` or a hand-written object for a test is one. A document is trusted after the
 * schema and `checkOverrides()` of the registry package have been through it; here, what does not
 * match the registry (a position that is not there, a message the registry lacks) is left alone and
 * never throws.
 *
 * `applyOverrides` turns a registry and a document into the registry the flow is validated against:
 * a copy that shares everything the document does not touch. The validator does the rest unchanged,
 * which is why a rule of a document is judged by the same code, with the same messages, as one of
 * the directory.
 */

export type SeverityRule = Severity | "off";

export interface OverridesView {
  readonly directory: RegistryView["directory"];
  readonly dataElements?: Readonly<
    Record<
      string,
      {
        readonly type?: DataElementView["type"];
        readonly minLength?: number;
        readonly maxLength?: number;
      }
    >
  >;
  readonly composites?: Readonly<
    Record<string, { readonly components: Readonly<Record<string, { readonly status: Status }>> }>
  >;
  readonly segments?: Readonly<
    Record<
      string,
      {
        readonly elements: Readonly<
          Record<string, { readonly status?: Status; readonly maxOccurs?: number }>
        >;
      }
    >
  >;
  readonly codeLists?: Readonly<
    Record<
      string,
      {
        readonly closed?: boolean;
        readonly add?: Readonly<Record<string, unknown>>;
        readonly remove?: readonly string[];
      }
    >
  >;
  readonly messages?: Readonly<
    Record<
      string,
      {
        readonly nodes: Readonly<
          Record<string, { readonly status?: Status; readonly maxOccurs?: number }>
        >;
      }
    >
  >;
  readonly severity?: Readonly<Record<string, SeverityRule>>;
}

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/** `position` is a key of the document, "1" and up: the index in a list, or undefined. */
function indexOf(position: string, length: number): number | undefined {
  const index = Number(position) - 1;
  return Number.isInteger(index) && index >= 0 && index < length ? index : undefined;
}

function replaceAt<T>(list: readonly T[], index: number, value: T): T[] {
  const copy = [...list];
  copy[index] = value;
  return copy;
}

/** Only the properties that are given: `{ status: undefined }` must not erase the registry's. */
function given<T extends object>(rule: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(rule).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function dataElements(
  registry: RegistryView,
  rules: NonNullable<OverridesView["dataElements"]>,
): RegistryView["dataElements"] {
  const changed: Record<string, DataElementView> = {};
  for (const [tag, rule] of Object.entries(rules)) {
    const element = own(registry.dataElements, tag);
    if (element !== undefined) {
      changed[tag] = { ...element, ...given(rule) };
    }
  }
  return { ...registry.dataElements, ...changed };
}

function composites(
  registry: RegistryView,
  rules: NonNullable<OverridesView["composites"]>,
): RegistryView["composites"] {
  const changed: Record<string, RegistryView["composites"][string]> = {};
  for (const [tag, rule] of Object.entries(rules)) {
    const composite = own(registry.composites, tag);
    if (composite === undefined) {
      continue;
    }
    let components = composite.components;
    for (const [position, change] of Object.entries(rule.components)) {
      const index = indexOf(position, components.length);
      if (index !== undefined) {
        components = replaceAt(components, index, {
          ...(components[index] as PositionView),
          status: change.status,
        });
      }
    }
    changed[tag] = { ...composite, components };
  }
  return { ...registry.composites, ...changed };
}

function segments(
  registry: RegistryView,
  rules: NonNullable<OverridesView["segments"]>,
): RegistryView["segments"] {
  const changed: Record<string, RegistryView["segments"][string]> = {};
  for (const [tag, rule] of Object.entries(rules)) {
    const segment = own(registry.segments, tag);
    if (segment === undefined) {
      continue;
    }
    let elements = segment.elements;
    for (const [position, change] of Object.entries(rule.elements)) {
      const index = indexOf(position, elements.length);
      if (index !== undefined) {
        elements = replaceAt(elements, index, {
          ...(elements[index] as PositionView),
          ...given(change),
        });
      }
    }
    changed[tag] = { ...segment, elements };
  }
  return { ...registry.segments, ...changed };
}

function codeLists(
  registry: RegistryView,
  rules: NonNullable<OverridesView["codeLists"]>,
): RegistryView["codeLists"] {
  const changed: Record<string, CodeListView> = {};
  for (const [id, rule] of Object.entries(rules)) {
    const list = own(registry.codeLists, id);
    if (list === undefined) {
      continue;
    }
    const removed = new Set(rule.remove ?? []);
    // Code values are arbitrary text, "__proto__" and "constructor" included: fromEntries defines
    // properties and never reaches the prototype.
    const codes = Object.fromEntries([
      ...Object.entries(list.codes).filter(([code]) => !removed.has(code)),
      ...Object.entries(rule.add ?? {}).filter(([code]) => !Object.hasOwn(list.codes, code)),
    ]);
    changed[id] = { ...list, closed: rule.closed ?? list.closed, codes };
  }
  return { ...registry.codeLists, ...changed };
}

type NodeRule = { readonly status?: Status; readonly maxOccurs?: number };

/** The nodes with the rules applied: `tag` and `group/tag` select segments, `SGn` a group. */
function nodes(
  source: readonly NodeView[],
  rules: Readonly<Record<string, NodeRule>>,
  parent: string | null,
): NodeView[] {
  return source.map((node): NodeView => {
    if (node.kind === "segment") {
      const generic = own(rules, node.tag);
      const specific = parent === null ? undefined : own(rules, `${parent}/${node.tag}`);
      return generic === undefined && specific === undefined
        ? node
        : { ...node, ...given(generic ?? {}), ...given(specific ?? {}) };
    }
    const rule = own(rules, node.id);
    const below = nodes(node.nodes ?? [], rules, node.id);
    return { ...node, ...given(rule ?? {}), nodes: below };
  });
}

function messages(
  registry: RegistryView,
  rules: NonNullable<OverridesView["messages"]>,
): RegistryView["messages"] {
  const changed: Record<string, RegistryView["messages"][string]> = {};
  for (const [type, rule] of Object.entries(rules)) {
    const message = own(registry.messages, type);
    if (message !== undefined) {
      changed[type] = { ...message, nodes: nodes(message.nodes, rule.nodes, null) };
    }
  }
  return { ...registry.messages, ...changed };
}

const APPLIED = new WeakMap<RegistryView, WeakMap<OverridesView, RegistryView>>();

/**
 * The registry with the rules of a partner's document applied, or the registry itself when the
 * document is for another directory or has no rule about the registry (only severities). The result
 * is new where the document touches the registry and shares the rest; applying the same document to
 * the same registry gives the same object, so that what the validator compiled for it is kept. That
 * is why a registry and a document must not be changed once they have been used: the result would
 * keep the old rules, and a severity, which is read at every call, would not.
 */
export function applyOverrides(registry: RegistryView, overrides: OverridesView): RegistryView {
  const { directory } = overrides;
  if (
    directory.agency !== registry.directory.agency ||
    directory.version !== registry.directory.version ||
    directory.release !== registry.directory.release
  ) {
    return registry;
  }
  if (
    overrides.dataElements === undefined &&
    overrides.composites === undefined &&
    overrides.segments === undefined &&
    overrides.codeLists === undefined &&
    overrides.messages === undefined
  ) {
    // Only severities (and a name): nothing in the registry to change.
    return registry;
  }
  let byDocument = APPLIED.get(registry);
  const cached = byDocument?.get(overrides);
  if (cached !== undefined) {
    return cached;
  }
  const applied: RegistryView = {
    ...registry,
    ...(overrides.dataElements === undefined
      ? {}
      : { dataElements: dataElements(registry, overrides.dataElements) }),
    ...(overrides.composites === undefined
      ? {}
      : { composites: composites(registry, overrides.composites) }),
    ...(overrides.segments === undefined
      ? {}
      : { segments: segments(registry, overrides.segments) }),
    ...(overrides.codeLists === undefined
      ? {}
      : { codeLists: codeLists(registry, overrides.codeLists) }),
    ...(overrides.messages === undefined
      ? {}
      : { messages: messages(registry, overrides.messages) }),
  };
  if (byDocument === undefined) {
    byDocument = new WeakMap();
    APPLIED.set(registry, byDocument);
  }
  byDocument.set(overrides, applied);
  return applied;
}

/**
 * The severities of the documents, in order, the last winning. A code the catalogue does not know,
 * and one of a file that cannot be read (layer `tokenizer`), is left out: a partner's rule cannot
 * make a broken file acceptable.
 */
export function severityRules(
  overrides: readonly OverridesView[],
): ReadonlyMap<IssueCode, SeverityRule> {
  const rules = new Map<IssueCode, SeverityRule>();
  for (const document of overrides) {
    for (const [code, rule] of Object.entries(document.severity ?? {})) {
      if (isIssueCode(code) && ISSUE_CATALOGUE[code].layer !== "tokenizer") {
        rules.set(code, rule);
      }
    }
  }
  return rules;
}
