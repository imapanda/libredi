import { describe, expect, it } from "vitest";
import example from "../../../contracts/overrides/examples/fictitious-retailer.overrides.json" with {
  type: "json",
};
import schema from "../../../contracts/overrides/overrides.schema.json" with { type: "json" };
import { checkOverrides, type Overrides, validateOverrides } from "./index.ts";
import { loadJson } from "./load.ts";
import type { Registry } from "./types.ts";

/** A document of any shape, which a test breaks on purpose. */
// biome-ignore lint/suspicious/noExplicitAny: the tests reach into a document to damage it
type Document = Record<string, any>;

const registry = loadJson("examples/fictitious-registry.json") as Registry;
const document = example as unknown as Overrides;

/** A copy of the example with one change. */
function edit(change: (overrides: Document) => void): unknown {
  const copy = structuredClone(example) as Document;
  change(copy);
  return copy;
}

const messages = (document: unknown): string[] =>
  validateOverrides(document).map((p) => `${p.path || "/"} ${p.message}`);

describe("contracts/overrides/overrides.schema.json", () => {
  it("is a JSON Schema 2020-12 document with a stable URN identifier", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("urn:libredi:schema:edifact-overrides");
  });

  it("accepts the fictitious example, and a document that only names its directory", () => {
    expect(validateOverrides(example)).toEqual([]);
    expect(validateOverrides({ schemaVersion: 1, directory: document.directory })).toEqual([]);
  });

  it("does not borrow from a real directory: it names no real message, directory or segment", () => {
    expect(JSON.stringify(example)).not.toMatch(/D\.96A|D\.01B|ORDERS|UNH/);
  });

  it.each(["schemaVersion", "directory"])("rejects a document without %s", (field) => {
    expect(messages(edit((o) => delete o[field]))).toEqual([`/ missing property "${field}"`]);
  });

  it("refuses a version it does not know, and a directory that is not one", () => {
    expect(messages(edit((o) => (o["schemaVersion"] = 2)))).toEqual(["/schemaVersion must be 1"]);
    expect(messages(edit((o) => (o["directory"].release = "lowercase")))).toEqual([
      '/directory/release must match pattern "^[A-Z0-9]{1,3}$"',
    ]);
    expect(messages(edit((o) => delete o["directory"].agency))).toEqual([
      '/directory missing property "agency"',
    ]);
  });

  it("is closed: a property it does not know is an error, at every level", () => {
    const where: [string, (o: Document) => void, string][] = [
      ["the document", (o) => (o["severty"] = {}), ""],
      ["the directory", (o) => (o["directory"].extra = 1), "/directory"],
      ["a data element", (o) => (o["dataElements"]["9002"].maxLen = 1), "/dataElements/9002"],
      ["a composite", (o) => (o["composites"]["C901"].extra = 1), "/composites/C901"],
      [
        "a component",
        (o) => (o["composites"]["C901"]["components"]["2"].maxOccurs = 1),
        "/composites/C901/components/2",
      ],
      ["a segment", (o) => (o["segments"]["XPT"].extra = 1), "/segments/XPT"],
      [
        "an element",
        (o) => (o["segments"]["XPT"]["elements"]["3"].required = true),
        "/segments/XPT/elements/3",
      ],
      ["a code list", (o) => (o["codeLists"]["9005"].codes = {}), "/codeLists/9005"],
      [
        "an added code",
        (o) => (o["codeLists"]["9005"]["add"]["AG"].label = "x"),
        "/codeLists/9005/add/AG",
      ],
      ["a message", (o) => (o["messages"]["SAMPLE"].extra = 1), "/messages/SAMPLE"],
      [
        "a node",
        (o) => (o["messages"]["SAMPLE"]["nodes"]["XDT"].min = 1),
        "/messages/SAMPLE/nodes/XDT",
      ],
    ];
    for (const [name, change, path] of where) {
      const found = validateOverrides(edit(change));
      expect(found, name).toHaveLength(1);
      expect(found[0]?.path, name).toBe(path);
      expect(found[0]?.message, name).toMatch(/^unknown property "/);
    }
  });

  it("names the key that does not fit, in the section it is in", () => {
    const keys: [string, (o: Document) => void, string][] = [
      [
        "a data element tag",
        (o) => (o["dataElements"]["90"] = { maxLength: 1 }),
        '/dataElements "90" must match pattern "^[0-9]{4}$"',
      ],
      [
        "a composite tag",
        (o) => (o["composites"]["X901"] = { components: {} }),
        '/composites "X901" must match pattern "^[CS][0-9]{3}$"',
      ],
      [
        "a segment tag",
        (o) => (o["segments"]["xpt"] = { elements: {} }),
        '/segments "xpt" must match pattern "^[A-Z]{3}$"',
      ],
      [
        "a position",
        (o) => (o["segments"]["XPT"]["elements"]["0"] = { status: "M" }),
        '/segments/XPT/elements "0" must match pattern "^[1-9][0-9]{0,2}$"',
      ],
      [
        "a message type",
        (o) => (o["messages"]["Sample"] = { nodes: {} }),
        '/messages "Sample" must match pattern "^[A-Z]{6}$"',
      ],
      [
        "a selector",
        (o) => (o["messages"]["SAMPLE"]["nodes"]["SG1/SG2/XPT"] = { status: "M" }),
        '/messages/SAMPLE/nodes "SG1/SG2/XPT" must match pattern "^(SG[0-9]+/[A-Z]{3}|SG[0-9]+|[A-Z]{3})$"',
      ],
      [
        "a code list id",
        (o) => (o["codeLists"]["-"] = { closed: true }),
        '/codeLists "-" must match pattern "^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$"',
      ],
      [
        "a severity code",
        (o) => (o["severity"]["UNKNOWN_CODES"] = "off"),
        '/severity "UNKNOWN_CODES" is not an issue code whose severity can be changed (see docs/partner-overrides.md)',
      ],
    ];
    for (const [name, change, expected] of keys) {
      const found = messages(edit(change));
      expect(found, name).toHaveLength(1);
      expect(found[0], name).toContain(expected);
    }
  });

  it("lets an editor name the schema, and says which values repeat", () => {
    expect(validateOverrides(edit((o) => (o["$schema"] = "../overrides.schema.json")))).toEqual([]);
    expect(messages(edit((o) => (o["$schema"] = 1)))).toEqual(["/$schema must be string"]);
    expect(messages(edit((o) => (o["codeLists"]["9005"].remove = ["SL", "SL"])))).toEqual([
      "/codeLists/9005/remove has the same value twice (items 0 and 1)",
    ]);
  });

  it("refuses a rule that says nothing or says it wrongly", () => {
    const wrong: [string, (o: Document) => void][] = [
      ["an empty data element rule", (o) => (o["dataElements"]["9002"] = {})],
      ["a length of 0", (o) => (o["dataElements"]["9002"].maxLength = 0)],
      ["a length that is text", (o) => (o["dataElements"]["9002"].maxLength = "12")],
      ["a type that does not exist", (o) => (o["dataElements"]["9002"].type = "x")],
      [
        "a status that does not exist",
        (o) => (o["composites"]["C901"]["components"]["2"].status = "X"),
      ],
      ["a component with no status", (o) => (o["composites"]["C901"]["components"]["2"] = {})],
      ["maxOccurs of 0", (o) => (o["segments"]["XPT"]["elements"]["3"].maxOccurs = 0)],
      [
        "maxOccurs that is not whole",
        (o) => (o["messages"]["SAMPLE"]["nodes"]["XDT"].maxOccurs = 1.5),
      ],
      ["a composite with no components", (o) => (o["composites"]["C901"] = {})],
      ["closed that is text", (o) => (o["codeLists"]["9010"].closed = "yes")],
      ["an empty code list rule", (o) => (o["codeLists"]["9010"] = {})],
      ["no code to remove", (o) => (o["codeLists"]["9005"].remove = [])],
      ["a code removed twice", (o) => (o["codeLists"]["9005"].remove = ["SL", "SL"])],
      ["an empty code", (o) => (o["codeLists"]["9005"]["add"][""] = {})],
      ["a severity that does not exist", (o) => (o["severity"]["UNKNOWN_CODE"] = "ignore")],
      ["a section that is not an object", (o) => (o["segments"] = [])],
      ["a name that is empty", (o) => (o["name"] = "")],
    ];
    for (const [name, change] of wrong) {
      expect(validateOverrides(edit(change)).length, name).toBeGreaterThan(0);
    }
  });

  it("says in words what is wrong", () => {
    expect(messages(edit((o) => (o["severity"]["UNKNOWN_CODE"] = "ignore")))).toEqual([
      "/severity/UNKNOWN_CODE must be one of error, warning, off",
    ]);
    expect(messages(edit((o) => (o["dataElements"]["9002"].maxLength = 0)))).toEqual([
      "/dataElements/9002/maxLength must be >= 1",
    ]);
    expect(messages(edit((o) => (o["segments"]["XPT"]["elements"]["3"].status = "X")))).toEqual([
      "/segments/XPT/elements/3/status must be one of M, C",
    ]);
  });

  it("does not let the severity of a file that cannot be read be changed", () => {
    for (const code of [
      "INVALID_UNA",
      "UNEXPECTED_END_OF_FILE",
      "INVALID_SEGMENT_TAG",
      "INVALID_CHARACTER",
      "UNSUPPORTED_CHARSET",
      "MESSAGE_TOO_LARGE",
      "TOO_MANY_ELEMENT_REPETITIONS",
    ]) {
      expect(messages(edit((o) => (o["severity"][code] = "off"))).join(), code).toContain(
        `"${code}"`,
      );
    }
    for (const code of [
      "UNKNOWN_CODE",
      "UNT_COUNT_MISMATCH",
      "MESSAGE_NOT_CHECKED",
      "VALUE_TOO_SHORT",
    ]) {
      expect(validateOverrides(edit((o) => (o["severity"][code] = "warning"))), code).toEqual([]);
    }
  });
});

describe("checkOverrides", () => {
  it("finds nothing wrong in the example for the registry it was written for", () => {
    expect(checkOverrides(document, registry)).toEqual([]);
  });

  const problems = (change: (o: Document) => void) =>
    checkOverrides(edit(change) as Overrides, registry).map((p) => `${p.path} ${p.message}`);

  it("says when the document is for another directory, whichever part differs", () => {
    expect(problems((o) => (o["directory"].release = "01B"))).toEqual([
      "/directory the document is for Z.01B (ZZ), the registry is of Z.00A (ZZ)",
    ]);
    expect(problems((o) => (o["directory"].version = "D"))).toEqual([
      "/directory the document is for D.00A (ZZ), the registry is of Z.00A (ZZ)",
    ]);
    expect(problems((o) => (o["directory"].agency = "UN"))).toEqual([
      "/directory the document is for Z.00A (UN), the registry is of Z.00A (ZZ)",
    ]);
  });

  it("finds a rule about something the registry does not have", () => {
    expect(problems((o) => (o["dataElements"]["9999"] = { maxLength: 3 }))).toEqual([
      '/dataElements/9999 data element "9999" does not exist in the registry',
    ]);
    expect(
      problems((o) => (o["composites"]["C999"] = { components: { "1": { status: "M" } } })),
    ).toEqual(['/composites/C999 composite "C999" does not exist in the registry']);
    expect(
      problems((o) => (o["segments"]["ZZZ"] = { elements: { "1": { status: "M" } } })),
    ).toEqual(['/segments/ZZZ segment "ZZZ" does not exist in the registry']);
    expect(problems((o) => (o["codeLists"]["nothing"] = { closed: true }))).toEqual([
      '/codeLists/nothing code list "nothing" does not exist in the registry',
    ]);
    expect(
      problems((o) => (o["messages"]["ABSENT"] = { nodes: { XHD: { status: "C" } } })),
    ).toEqual(['/messages/ABSENT message "ABSENT" does not exist in the registry']);
  });

  it("finds a position that is not there", () => {
    expect(problems((o) => (o["composites"]["C901"]["components"]["3"] = { status: "M" }))).toEqual(
      ['/composites/C901/components/3 composite "C901" has 2 components: there is no position 3'],
    );
    expect(problems((o) => (o["segments"]["XPT"]["elements"]["4"] = { status: "M" }))).toEqual([
      '/segments/XPT/elements/4 segment "XPT" has 3 elements: there is no position 4',
    ]);
  });

  it("finds lengths that would contradict each other, with what the registry has", () => {
    // 9002 is 1 to 35 in the registry.
    expect(problems((o) => (o["dataElements"]["9002"] = { minLength: 20, maxLength: 12 }))).toEqual(
      [
        '/dataElements/9002 minLength (20) would be greater than maxLength (12) for data element "9002"',
      ],
    );
    expect(problems((o) => (o["dataElements"]["9002"] = { minLength: 40 }))).toEqual([
      '/dataElements/9002 minLength (40) would be greater than maxLength (35) for data element "9002"',
    ]);
    expect(problems((o) => (o["dataElements"]["9002"] = { minLength: 5 }))).toEqual([]);
    // Equal is fine: a value of exactly 12 characters.
    expect(problems((o) => (o["dataElements"]["9002"] = { minLength: 12, maxLength: 12 }))).toEqual(
      [],
    );
  });

  it("finds codes to add that are there, codes to remove that are not, and both at once", () => {
    expect(problems((o) => (o["codeLists"]["9005"]["add"]["BU"] = {}))).toEqual([
      '/codeLists/9005/add/BU code "BU" is already in code list "9005": there is nothing to add',
    ]);
    expect(problems((o) => (o["codeLists"]["9005"]["remove"] = ["SL", "XX"]))).toEqual([
      '/codeLists/9005/remove/1 code "XX" is not in code list "9005": there is nothing to remove',
    ]);
    expect(problems((o) => (o["codeLists"]["9005"] = { add: { AG: {} }, remove: ["AG"] }))).toEqual(
      [
        '/codeLists/9005/add/AG code "AG" is both added and removed in code list "9005"',
        '/codeLists/9005/remove/0 code "AG" is not in code list "9005": there is nothing to remove',
      ],
    );
  });

  it("finds a node that the structure does not have, with a pointer that escapes the slash", () => {
    expect(problems((o) => (o["messages"]["SAMPLE"]["nodes"]["XPP"] = { status: "M" }))).toEqual([
      '/messages/SAMPLE/nodes/XPP message SAMPLE has no segment "XPP"',
    ]);
    expect(problems((o) => (o["messages"]["SAMPLE"]["nodes"]["SG9"] = { status: "M" }))).toEqual([
      '/messages/SAMPLE/nodes/SG9 message SAMPLE has no group "SG9"',
    ]);
    expect(
      problems((o) => (o["messages"]["SAMPLE"]["nodes"]["SG9/XQT"] = { status: "M" })),
    ).toEqual(['/messages/SAMPLE/nodes/SG9~1XQT message SAMPLE has no group "SG9"']);
    expect(
      problems((o) => (o["messages"]["SAMPLE"]["nodes"]["SG2/XTT"] = { status: "M" })),
    ).toEqual([
      '/messages/SAMPLE/nodes/SG2~1XTT group SG2 of message SAMPLE has no segment "XTT" directly inside it',
    ]);
    // A segment in a nested group is found by its tag, and a group by its id, at any depth.
    expect(
      problems(
        (o) =>
          (o["messages"]["SAMPLE"]["nodes"] = {
            SG3: { maxOccurs: 1 },
            XQT: { status: "C" },
            "SG2/XQT": { status: "C" },
          }),
      ),
    ).toEqual([]);
    // The trigger of a group is not a node of its own: SG1 is the group, XPT its trigger.
    expect(problems((o) => (o["messages"]["SAMPLE"]["nodes"] = { XPT: { status: "M" } }))).toEqual([
      '/messages/SAMPLE/nodes/XPT message SAMPLE has no segment "XPT"',
    ]);
  });

  it("gives the problems of the shape and does not throw when the document is not of the right shape", () => {
    const broken: [string, unknown][] = [
      ["a composite without components", edit((o) => (o["composites"]["C901"] = {}))],
      ["a segment without elements", edit((o) => (o["segments"]["XPT"] = {}))],
      ["a message without nodes", edit((o) => (o["messages"]["SAMPLE"] = {}))],
      ["no directory", edit((o) => delete o["directory"])],
      ["a rule that is null", edit((o) => (o["dataElements"]["9002"] = null))],
      ["remove that is text", edit((o) => (o["codeLists"]["9005"] = { remove: "SL" }))],
      ["a document that is null", null],
      ["a document that is a list", []],
      ["a document that is text", "overrides"],
    ];
    for (const [name, document] of broken) {
      const found = checkOverrides(document, registry);
      expect(found.length, name).toBeGreaterThan(0);
      expect(found, name).toEqual(validateOverrides(document));
    }
  });

  it("checks a long list of codes in a time that does not grow with the square of it", () => {
    const many = Object.fromEntries(Array.from({ length: 40000 }, (_unused, i) => [`C${i}`, {}]));
    const started = performance.now();
    const found = checkOverrides(
      edit((o) => (o["codeLists"]["9005"] = { add: many, remove: Object.keys(many) })),
      registry,
    );
    expect(performance.now() - started).toBeLessThan(2000);
    // Each code is added and removed, and the removal finds nothing to remove.
    expect(found).toHaveLength(80000);
  });

  it("reports every problem, not the first", () => {
    const found = problems((o) => {
      o["dataElements"]["9999"] = { maxLength: 3 };
      o["segments"]["ZZZ"] = { elements: { "1": { status: "M" } } };
      o["messages"]["SAMPLE"]["nodes"]["XPP"] = { status: "M" };
    });
    expect(found).toHaveLength(3);
  });
});
