import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyOverrides,
  ISSUE_CATALOGUE,
  type OverridesView,
  type RegistryView,
  severityRules,
  validate,
} from "./index.ts";
import { type ExpectedInvalid, expectedOf, readSample, samples } from "./testing/corpus.ts";
import { corpusRegistries } from "./testing/corpus-registry.ts";
import { bytesOf, textOf } from "./testing/helpers.ts";

const D96A = { agency: "UN", version: "D", release: "96A" } as const;
const D01B = { agency: "UN", version: "D", release: "01B" } as const;
const registry96 = corpusRegistries[0] as RegistryView;
const MINIMAL = textOf(readSample("valid", "orders-d96a-s3-unoa-minimal"));

/** The sample with one segment replaced or removed (the count in UNT is left alone). */
const edit = (from: string, to: string): string => {
  expect(MINIMAL).toContain(from);
  return MINIMAL.replace(from, to);
};

type Row = [
  code: string,
  severity: string,
  segment: number,
  tag: string | null,
  element: number | null,
  component: number | null,
];

const rows = (text: string, ...overrides: OverridesView[]): Row[] => {
  const report = validate(bytesOf(text), {
    registries: [registry96],
    overrides,
    codeLists: "all",
  });
  return report.issues
    .filter((issue) => issue.code !== "UNT_COUNT_MISMATCH")
    .map((i) => [
      i.code,
      i.severity,
      i.position.segment,
      i.position.tag,
      i.position.element,
      i.position.component,
    ]);
};

describe("a rule of a document changes what is valid", () => {
  it("is valid without any document", () => {
    expect(rows(MINIMAL)).toEqual([]);
  });

  it("makes a data element shorter, or of another type", () => {
    const shorter: OverridesView = { directory: D96A, dataElements: { "1004": { maxLength: 5 } } };
    expect(rows(MINIMAL, shorter)).toEqual([["VALUE_TOO_LONG", "error", 3, "BGM", 2, 1]]);
    const numeric: OverridesView = { directory: D96A, dataElements: { "1004": { type: "n" } } };
    expect(rows(MINIMAL, numeric)).toEqual([["INVALID_DATA_TYPE", "error", 3, "BGM", 2, 1]]);
    const longer: OverridesView = { directory: D96A, dataElements: { "1004": { minLength: 8 } } };
    expect(rows(MINIMAL, longer)).toEqual([["VALUE_TOO_SHORT", "error", 3, "BGM", 2, 1]]);
  });

  it("makes a data element longer: what the directory refuses, the partner may send", () => {
    const text = textOf(readSample("invalid", "value-too-long"));
    const report = (overrides: OverridesView[]) =>
      validate(bytesOf(text), { registries: [registry96], overrides }).issues.map((i) => i.code);
    expect(report([])).toEqual(["VALUE_TOO_LONG"]);
    expect(report([{ directory: D96A, dataElements: { "1004": { maxLength: 40 } } }])).toEqual([]);
  });

  it("makes a component mandatory, wherever its composite is used", () => {
    const text = edit("DTM+137:20301015:102", "DTM+137");
    expect(rows(text)).toEqual([]);
    const overrides: OverridesView = {
      directory: D96A,
      composites: { C507: { components: { "2": { status: "M" } } } },
    };
    expect(rows(text, overrides)).toEqual([["MISSING_MANDATORY_ELEMENT", "error", 4, "DTM", 1, 2]]);
  });

  it("makes an element of a segment mandatory, or allows it to be repeated", () => {
    const mandatory: OverridesView = {
      directory: D96A,
      segments: { LIN: { elements: { "2": { status: "M" } } } },
    };
    expect(rows(MINIMAL, mandatory)).toEqual([
      ["MISSING_MANDATORY_ELEMENT", "error", 7, "LIN", 2, null],
    ]);
    // It also makes a conditional element optional again.
    const optional: OverridesView = {
      directory: D96A,
      segments: { QTY: { elements: { "1": { status: "C" } } } },
    };
    expect(rows(edit("QTY+21:10:PCE", "QTY+"), optional)).toEqual([]);
    expect(rows(edit("QTY+21:10:PCE", "QTY+"))).toEqual([
      ["MISSING_MANDATORY_ELEMENT", "error", 8, "QTY", 1, null],
    ]);
  });

  it("adds a code to a list, removes one, or opens the list", () => {
    const partner = edit("NAD+BY+9520000000011::9", "NAD+ZZ+9520000000011::9");
    expect(rows(partner)).toEqual([["UNKNOWN_CODE", "error", 5, "NAD", 1, null]]);
    const added: OverridesView = {
      directory: D96A,
      codeLists: { "3035": { add: { ZZ: { name: "Agent" } } } },
    };
    expect(rows(partner, added)).toEqual([]);

    const removed: OverridesView = { directory: D96A, codeLists: { "3035": { remove: ["SU"] } } };
    expect(rows(MINIMAL, removed)).toEqual([["UNKNOWN_CODE", "error", 6, "NAD", 1, null]]);

    // An open list is not enforced as it is: with the lists "all", a warning.
    const open: OverridesView = { directory: D96A, codeLists: { "3035": { closed: false } } };
    expect(rows(partner, open)).toEqual([["UNKNOWN_CODE", "warning", 5, "NAD", 1, null]]);
    const report = validate(bytesOf(partner), { registries: [registry96], overrides: [open] });
    expect(report.issues).toEqual([]);
  });

  it("makes a segment or a group mandatory, or limits how often it may be", () => {
    const withoutDtm = edit("DTM+137:20301015:102'\n", "");
    expect(rows(withoutDtm)).toEqual([]);
    const needed: OverridesView = {
      directory: D96A,
      messages: { ORDERS: { nodes: { DTM: { status: "M" } } } },
    };
    expect(rows(withoutDtm, needed)).toEqual([
      ["MISSING_MANDATORY_SEGMENT", "error", 4, "NAD", null, null],
    ]);

    const twice = edit("QTY+21:10:PCE", "QTY+21:10:PCE'\nQTY+21:5:PCE");
    expect(rows(twice)).toEqual([]);
    const once: OverridesView = {
      directory: D96A,
      messages: { ORDERS: { nodes: { "SG28/QTY": { maxOccurs: 1 } } } },
    };
    expect(rows(twice, once)).toEqual([["TOO_MANY_REPETITIONS", "error", 9, "QTY", null, null]]);
    // Only the QTY directly in that group: the same tag elsewhere is another node.
    const elsewhere: OverridesView = {
      directory: D96A,
      messages: { ORDERS: { nodes: { "SG1/QTY": { maxOccurs: 1 } } } },
    };
    expect(rows(twice, elsewhere)).toEqual([]);

    const noParties = edit("NAD+BY+9520000000011::9'\nNAD+SU+9520000000035::9'\n", "");
    expect(rows(noParties)).toEqual([]);
    const group: OverridesView = {
      directory: D96A,
      messages: { ORDERS: { nodes: { SG2: { status: "M" } } } },
    };
    expect(rows(noParties, group)).toEqual([
      ["MISSING_MANDATORY_SEGMENT", "error", 5, "LIN", null, null],
    ]);
  });

  it("changes the severity of a code to a warning, or drops it", () => {
    const text = textOf(readSample("invalid", "unknown-code"));
    const run = (...overrides: OverridesView[]) =>
      validate(bytesOf(text), { registries: [registry96], overrides, summary: true });
    expect(run().valid).toBe(false);

    const warning = run({ directory: D96A, severity: { UNKNOWN_CODE: "warning" } });
    expect(warning).toMatchObject({ valid: true, errorCount: 0, warningCount: 1, issueCount: 1 });
    expect(warning.issues.map((i) => [i.code, i.severity])).toEqual([["UNKNOWN_CODE", "warning"]]);
    // The summary a CONTRL is written from sees no error either.
    expect(warning.interchanges[0]).toMatchObject({ errorCount: 0 });
    expect(warning.interchanges[0]?.messages[0]).toMatchObject({ errorCount: 0 });

    const off = run({ directory: D96A, severity: { UNKNOWN_CODE: "off" } });
    expect(off).toMatchObject({
      valid: true,
      errorCount: 0,
      warningCount: 0,
      issueCount: 0,
      issues: [],
    });

    const unchanged = run({ directory: D96A, severity: { UNKNOWN_CODE: "error" } });
    expect(unchanged.errorCount).toBe(1);
  });

  it("can turn a warning into an error", () => {
    // A registry of another directory: the message is not checked, and the validator says so.
    const report = validate(bytesOf(MINIMAL), {
      registries: [corpusRegistries[1] as RegistryView],
      overrides: [{ directory: D96A, severity: { MESSAGE_NOT_CHECKED: "error" } }],
    });
    expect(report.issues.map((i) => [i.code, i.severity])).toEqual([
      ["MESSAGE_NOT_CHECKED", "error"],
    ]);
    expect(report.valid).toBe(false);
  });
});

describe("several documents and other directories", () => {
  it("are applied in order, the last one winning", () => {
    const text = textOf(readSample("invalid", "unknown-code"));
    const severity = (...rules: ("error" | "warning" | "off")[]) =>
      validate(bytesOf(text), {
        registries: [registry96],
        overrides: rules.map((rule) => ({ directory: D96A, severity: { UNKNOWN_CODE: rule } })),
      }).issues.map((i) => i.severity);
    expect(severity("warning", "error")).toEqual(["error"]);
    expect(severity("error", "warning")).toEqual(["warning"]);
    expect(severity("warning", "off")).toEqual([]);
    expect(severity("off", "warning")).toEqual(["warning"]);

    const first: OverridesView = { directory: D96A, dataElements: { "1004": { maxLength: 5 } } };
    const second: OverridesView = { directory: D96A, dataElements: { "1004": { maxLength: 10 } } };
    expect(rows(MINIMAL, first, second)).toEqual([]);
    expect(rows(MINIMAL, second, first)).toEqual([["VALUE_TOO_LONG", "error", 3, "BGM", 2, 1]]);
  });

  it("are for one directory: the agency, the version and the release all count", () => {
    const rule = { dataElements: { "1004": { maxLength: 5 } } };
    for (const directory of [
      D01B,
      { ...D96A, agency: "EN" },
      { ...D96A, version: "S" },
      { ...D96A, release: "97A" },
    ]) {
      expect(applyOverrides(registry96, { directory, ...rule })).toBe(registry96);
      expect(rows(MINIMAL, { directory, ...rule })).toEqual([]);
    }
    expect(applyOverrides(registry96, { directory: D96A, ...rule })).not.toBe(registry96);
  });

  it("change the registry of their directory and no other, but the severities are the call's", () => {
    const other: OverridesView = {
      directory: D01B,
      dataElements: { "1004": { maxLength: 5 } },
      severity: { MESSAGE_NOT_CHECKED: "off" },
    };
    // The rules are for D.01B: a message of D.96A is checked as the directory says.
    expect(rows(MINIMAL, other)).toEqual([]);
    expect(applyOverrides(registry96, other)).toBe(registry96);
    // The severity belongs to the flow, whatever the directory of the message.
    const noRegistry = validate(bytesOf(MINIMAL), { registries: [], overrides: [other] });
    expect(noRegistry.issues).toEqual([]);
  });

  it("refuse a single document where a list is wanted, and change nothing in a registry for severities only", () => {
    const one = { directory: D96A, severity: { UNKNOWN_CODE: "off" as const } };
    expect(() =>
      validate(bytesOf(MINIMAL), { overrides: one as unknown as OverridesView[] }),
    ).toThrow(new RangeError("overrides must be an array of documents, even for one document"));
    // Nothing of the registry changes, so there is nothing to copy and compile again.
    expect(applyOverrides(registry96, one)).toBe(registry96);
    expect(applyOverrides(registry96, { directory: D96A })).toBe(registry96);
  });

  it("do not change the registry they were applied to, and give the same registry twice", () => {
    const before = JSON.stringify(registry96);
    const overrides: OverridesView = {
      directory: D96A,
      dataElements: { "1004": { maxLength: 5 } },
      composites: { C507: { components: { "2": { status: "M" } } } },
      segments: { LIN: { elements: { "2": { status: "M" } } } },
      codeLists: { "3035": { add: { ZZ: {} }, remove: ["BY"], closed: false } },
      messages: { ORDERS: { nodes: { DTM: { status: "M" }, SG2: { maxOccurs: 1 } } } },
    };
    const applied = applyOverrides(registry96, overrides);
    expect(applied).not.toBe(registry96);
    expect(JSON.stringify(registry96)).toBe(before);
    expect(applyOverrides(registry96, overrides)).toBe(applied);
    // What the document does not touch is shared, not copied.
    expect(applied.segments["BGM"]).toBe(registry96.segments["BGM"]);
    expect(applied.messages["ORDRSP"]).toBe(registry96.messages["ORDRSP"]);
    expect(applied.dataElements["1004"]).toEqual({
      ...registry96.dataElements["1004"],
      maxLength: 5,
    });
  });

  it("leave alone a position just past the last one, and a property that is not given", () => {
    const past: OverridesView = {
      directory: D96A,
      composites: { C507: { components: { "4": { status: "M" } } } },
      segments: { BGM: { elements: { "5": { status: "M" } } } },
    };
    const applied = applyOverrides(registry96, past);
    expect(applied.composites["C507"]?.components).toHaveLength(3);
    expect(applied.segments["BGM"]?.elements).toHaveLength(4);
    // Nor a position before the first: "0" is not a position, whatever the schema says.
    const zero = applyOverrides(registry96, {
      directory: D96A,
      composites: { C507: { components: { "0": { status: "M" } } } },
    });
    expect(Object.keys(zero.composites["C507"]?.components ?? [])).toEqual(["0", "1", "2"]);
    expect(JSON.stringify(applied.composites["C507"])).toBe(
      JSON.stringify(registry96.composites["C507"]),
    );

    // `undefined` is not a value: it does not erase the registry's.
    const holes = {
      directory: D96A,
      dataElements: { "1004": { maxLength: undefined, type: undefined } },
      segments: { LIN: { elements: { "1": { status: undefined } } } },
    } as unknown as OverridesView;
    const same = applyOverrides(registry96, holes);
    expect(same.dataElements["1004"]).toEqual(registry96.dataElements["1004"]);
    expect(same.segments["LIN"]?.elements[0]).toEqual(registry96.segments["LIN"]?.elements[0]);
  });

  it("let the rule for a group's own segment win over the one for the tag everywhere", () => {
    const twice = edit("QTY+21:10:PCE", "QTY+21:10:PCE'\nQTY+21:5:PCE'\nQTY+21:2:PCE");
    const rules = (specific: number): OverridesView => ({
      directory: D96A,
      messages: {
        ORDERS: { nodes: { QTY: { maxOccurs: 5 }, "SG28/QTY": { maxOccurs: specific } } },
      },
    });
    expect(rows(twice, rules(2)).map((r) => r[0])).toEqual(["TOO_MANY_REPETITIONS"]);
    expect(rows(twice, rules(3))).toEqual([]);
  });

  it("take SGn/TAG for the segments in that group and not for the same tag at the top", () => {
    const twiceAtTheTop = edit(
      "DTM+137:20301015:102",
      "DTM+137:20301015:102'\nDTM+137:20301016:102",
    );
    expect(rows(twiceAtTheTop)).toEqual([]);
    const inGroupOnly: OverridesView = {
      directory: D96A,
      messages: { ORDERS: { nodes: { "SG1/DTM": { maxOccurs: 1 } } } },
    };
    expect(rows(twiceAtTheTop, inGroupOnly)).toEqual([]);
    const everywhere: OverridesView = {
      directory: D96A,
      messages: { ORDERS: { nodes: { DTM: { maxOccurs: 1 } } } },
    };
    expect(rows(twiceAtTheTop, everywhere).map((r) => r[0])).toEqual(["TOO_MANY_REPETITIONS"]);
  });

  it("keep a code called __proto__ a code, and do not touch the prototype", () => {
    const document = JSON.parse(
      '{"directory":{"agency":"UN","version":"D","release":"96A"},"dataElements":{"3035":{"maxLength":12}},"codeLists":{"3035":{"add":{"__proto__":{},"constructor":{}}}}}',
    ) as OverridesView;
    const list = applyOverrides(registry96, document).codeLists["3035"];
    expect(Object.hasOwn(list?.codes ?? {}, "__proto__")).toBe(true);
    expect(Object.hasOwn(list?.codes ?? {}, "constructor")).toBe(true);
    expect(Object.getPrototypeOf(list?.codes)).toBe(Object.prototype);
    expect(Object.hasOwn({}, "polluted")).toBe(false);
    // Lower case is not in UNOA: the same message in UNOC (ISO 8859-1).
    const unoc = edit("NAD+BY+", "NAD+constructor+").replace("UNOA:3", "UNOC:3");
    expect(rows(unoc)).toEqual([["VALUE_TOO_LONG", "error", 5, "NAD", 1, null]]);
    expect(rows(unoc, document)).toEqual([]);
  });
});

describe("a document that does not fit the registry", () => {
  it("is left alone where it does not fit: no throw, no change", () => {
    const stray: OverridesView = {
      directory: D96A,
      dataElements: { "0000": { maxLength: 1 } },
      composites: {
        C999: { components: { "1": { status: "M" } } },
        C507: { components: { "9": { status: "M" }, "0": { status: "M" }, x: { status: "M" } } },
      },
      segments: {
        ZZZ: { elements: { "1": { status: "M" } } },
        BGM: { elements: { "99": { status: "M" } } },
      },
      codeLists: { nothing: { closed: false, add: { A: {} }, remove: ["B"] } },
      messages: {
        NOMSGS: { nodes: { DTM: { status: "M" } } },
        ORDERS: {
          nodes: { ZZZ: { status: "M" }, SG99: { status: "M" }, "SG2/ZZZ": { status: "M" } },
        },
      },
    };
    expect(rows(MINIMAL, stray)).toEqual([]);
  });

  it("never makes the validator throw, whatever the keys it names", () => {
    const status = fc.constantFrom("M", "C");
    const maybe = <T extends object>(record: fc.Arbitrary<T>) => record;
    const positions = fc.constantFrom("1", "2", "3", "99", "0", "x");
    const tag = (...names: string[]) => fc.constantFrom(...names, "NOPE", "__proto__");
    const section = <T>(keys: fc.Arbitrary<string>, rule: fc.Arbitrary<T>) =>
      fc.dictionary(keys, rule, { maxKeys: 4 });
    const ofNode = fc.record(
      { status, maxOccurs: fc.integer({ min: 1, max: 5 }) },
      { requiredKeys: [] },
    );
    const document = fc.record(
      {
        directory: fc.constantFrom(D96A, D01B),
        dataElements: section(
          tag("1004", "3035", "6060"),
          fc.record(
            {
              type: fc.constantFrom("a", "an", "n"),
              minLength: fc.integer({ min: 1, max: 40 }),
              maxLength: fc.integer({ min: 1, max: 40 }),
            },
            { requiredKeys: [] },
          ),
        ),
        composites: section(
          tag("C507", "C186"),
          fc.record({ components: section(positions, fc.record({ status })) }),
        ),
        segments: section(
          tag("BGM", "NAD", "LIN", "QTY"),
          fc.record({ elements: section(positions, maybe(ofNode)) }),
        ),
        codeLists: section(
          tag("3035"),
          fc.record(
            {
              closed: fc.boolean(),
              add: section(fc.constantFrom("ZZ", "BY", "__proto__"), fc.constant({})),
              remove: fc.array(fc.constantFrom("BY", "SU", "ZZ")),
            },
            { requiredKeys: [] },
          ),
        ),
        messages: section(
          tag("ORDERS", "ORDRSP"),
          fc.record({
            nodes: section(
              fc.constantFrom("DTM", "SG2", "SG28", "SG28/QTY", "SG1/NAD", "NOPE"),
              ofNode,
            ),
          }),
        ),
        severity: section(
          fc.constantFrom("UNKNOWN_CODE", "VALUE_TOO_LONG", "NOPE", "INVALID_CHARACTER"),
          fc.constantFrom("error", "warning", "off"),
        ),
      },
      { requiredKeys: ["directory"] },
    );
    const bytes = [
      "orders-d96a-s3-unoa-minimal",
      "orders-d96a-s3-unoa-multi-message",
      "ordrsp-d96a-s3-unoa-accepted",
    ].map((name) => readSample("valid", name));
    fc.assert(
      fc.property(
        fc.array(document, { maxLength: 3 }),
        fc.constantFrom(...bytes),
        (documents, file) => {
          const report = validate(file, {
            registries: [registry96],
            overrides: documents as unknown as OverridesView[],
            summary: true,
          });
          expect(report.errorCount + report.warningCount).toBe(report.issueCount);
          expect(report.valid).toBe(report.errorCount === 0);
          const counted = report.interchanges.reduce((n, one) => n + one.errorCount, 0);
          expect(report.errorCount).toBeGreaterThanOrEqual(counted);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("severity rules", () => {
  it("leave out a code that is not known and the codes of a file that cannot be read", () => {
    const rules = severityRules([
      {
        directory: D96A,
        severity: {
          UNKNOWN_CODE: "warning",
          NOPE: "off",
          INVALID_CHARACTER: "off",
          UNEXPECTED_END_OF_FILE: "off",
          MESSAGE_TOO_LARGE: "off",
        },
      },
      { directory: D01B, severity: { UNKNOWN_CODE: "off" } },
    ]);
    expect([...rules]).toEqual([["UNKNOWN_CODE", "off"]]);
  });

  it("do not make a file that is broken acceptable", () => {
    const text = textOf(readSample("invalid", "invalid-character-unoa"));
    const report = validate(bytesOf(text), {
      registries: [registry96],
      overrides: [
        { directory: D96A, severity: { INVALID_CHARACTER: "off", UNEXPECTED_END_OF_FILE: "off" } },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain("INVALID_CHARACTER");
    const cut = validate(bytesOf(MINIMAL.slice(0, 120)), {
      overrides: [{ directory: D96A, severity: { UNEXPECTED_END_OF_FILE: "off" } }],
    });
    expect(cut.valid).toBe(false);
  });
});

describe("every sample of the corpus, with all the severities lowered or dropped", () => {
  const INVALID = samples("invalid");

  it.each(INVALID)("%s: its errors are warnings at the same positions, or gone", (name) => {
    const { layer, expectedErrors } = expectedOf<ExpectedInvalid>("invalid", name);
    const bytes = readSample("invalid", name);
    const every = (rule: "warning" | "off") => ({
      directory: D96A,
      severity: Object.fromEntries(expectedErrors.map((e) => [e.code, rule])),
    });
    const plain = validate(bytes, { registries: corpusRegistries });
    const lowered = validate(bytes, {
      registries: corpusRegistries,
      overrides: [every("warning")],
    });
    const dropped = validate(bytes, { registries: corpusRegistries, overrides: [every("off")] });
    if (layer === "tokenizer") {
      // A file that cannot be read stays invalid, whatever the document says.
      expect([lowered.valid, dropped.valid]).toEqual([false, false]);
      return;
    }
    expect(lowered.valid).toBe(true);
    expect(lowered.issues.map((i) => [i.code, i.severity, i.position.segment])).toEqual(
      plain.issues.map((i) => [i.code, "warning", i.position.segment]),
    );
    expect(dropped).toMatchObject({ valid: true, issueCount: 0 });
  });
});

describe("the files of contracts/overrides", () => {
  const read = (path: string): unknown =>
    JSON.parse(
      readFileSync(fileURLToPath(new URL(`../../../contracts/${path}`, import.meta.url)), "utf8"),
    );
  const example = read("overrides/examples/fictitious-retailer.overrides.json") as OverridesView;
  const fictitious = read("registry/examples/fictitious-registry.json") as RegistryView;

  it("let a partner change the severity of every code of the catalogue but those of a file that cannot be read", () => {
    const schema = read("overrides/overrides.schema.json") as {
      properties: { severity: { propertyNames: { enum: string[] } } };
    };
    const allowed = Object.entries(ISSUE_CATALOGUE)
      .filter(([, info]) => info.layer !== "tokenizer")
      .map(([code]) => code)
      .sort();
    expect(schema.properties.severity.propertyNames.enum).toEqual(allowed);
    // The engine agrees with the schema about which ones count.
    const all = Object.fromEntries(
      Object.keys(ISSUE_CATALOGUE).map((code) => [code, "off" as const]),
    );
    expect([...severityRules([{ directory: D96A, severity: all }]).keys()].sort()).toEqual(allowed);
  });

  it("make the example change the result of a message of the invented directory", () => {
    const sound = [
      "XHD+DOC1:1",
      "XDT+10:20301015",
      "XPT+BU+ID1+NAME",
      "UNS+D",
      "XLN+1+TEXT+X1",
      "XQT+Q1:10",
      "UNS+S",
      "XTT+1",
    ];
    const message = (segments: string[]): string =>
      [
        "UNA:+.?*'",
        "UNB+UNOA:4+A:1+B:1+20301015:0830+R1'",
        "UNH+1+SAMPLE:Z:00A:ZZ'",
        ...segments.map((s) => `${s}'`),
        `UNT+${segments.length + 2}+1'`,
        "UNZ+1+R1'",
      ].join("\n");
    const result = (segments: string[], withExample: boolean) =>
      validate(bytesOf(message(segments)), {
        registries: [fictitious],
        overrides: withExample ? [example] : [],
      }).issues.map((i) => [i.code, i.severity, i.position.tag]);
    const change = (index: number, segment: string) =>
      sound.map((s, i) => (i === index ? segment : s));

    expect(result(sound, false)).toEqual([]);
    expect(result(sound, true)).toEqual([]);
    // A shorter document number, a mandatory function code, a code of its own, a code removed.
    expect(result(change(0, "XHD+DOC1234567890123:1"), false)).toEqual([]);
    expect(result(change(0, "XHD+DOC1234567890123:1"), true)).toEqual([
      ["VALUE_TOO_LONG", "error", "XHD"],
    ]);
    expect(result(change(0, "XHD+DOC1"), false)).toEqual([]);
    expect(result(change(0, "XHD+DOC1"), true)).toEqual([
      ["MISSING_MANDATORY_ELEMENT", "error", "XHD"],
    ]);
    expect(result(change(2, "XPT+AG+ID1+NAME"), false)).toEqual([["UNKNOWN_CODE", "error", "XPT"]]);
    expect(result(change(2, "XPT+AG+ID1+NAME"), true)).toEqual([]);
    // The code SL is removed from the list; AG, which the retailer uses, is not in it otherwise.
    expect(result(change(2, "XPT+SL+ID1+NAME"), false)).toEqual([]);
    expect(result(change(2, "XPT+SL+ID1+NAME"), true)).toEqual([["UNKNOWN_CODE", "error", "XPT"]]);
    // The severities of the example: a segment it does not know is a warning, a short date no issue.
    const stray = [...sound.slice(0, 3), "XZZ+1", ...sound.slice(3)];
    expect(result(stray, false)).toEqual([["UNKNOWN_SEGMENT", "error", "XZZ"]]);
    expect(result(stray, true)).toEqual([["UNKNOWN_SEGMENT", "warning", "XZZ"]]);
    expect(result(change(1, "XDT+10:2030101"), false)).toEqual([
      ["VALUE_TOO_SHORT", "error", "XDT"],
    ]);
    expect(result(change(1, "XDT+10:2030101"), true)).toEqual([]);
    // The date and the total become mandatory, and the quantities of a line are limited to two.
    expect(
      result(
        sound.filter((_s, i) => i !== 1 && i !== 7),
        true,
      ).map((r) => r[0]),
    ).toEqual(["MISSING_MANDATORY_SEGMENT", "MISSING_MANDATORY_SEGMENT"]);
    expect(
      result(
        sound.flatMap((s) => (s === "XQT+Q1:10" ? [s, s, s] : [s])),
        true,
      ),
    ).toEqual([["TOO_MANY_REPETITIONS", "error", "XQT"]]);
  });
});
