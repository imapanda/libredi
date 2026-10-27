import {
  type ExpectedInvalid,
  type ExpectedValid,
  expectedOf,
  readSample,
  samples,
} from "@libredi/edifact/testing/corpus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli, corpusRegistryFolder, type JsonReport, must, samplePath } from "./testing.ts";

let registries: { folder: string; remove: () => Promise<void> };
beforeAll(async () => {
  registries = await corpusRegistryFolder();
});
afterAll(async () => {
  await registries.remove();
});

const inspectJson = async (
  directory: "valid" | "invalid",
  name: string,
  ...options: string[]
): Promise<{ status: number; report: JsonReport }> => {
  const { status, out, err } = await cli([
    "inspect",
    samplePath(directory, name),
    "--json",
    ...options,
  ]);
  expect(err).toBe("");
  return { status, report: JSON.parse(out) as JsonReport };
};

/** An element as the expected-result files write it: its components, or its repetitions. */
type ExpectedElement = string[] | { repetitions: string[][] };

/** Repetitions of components, without the empty components at the end of each. */
const normal = (repetitions: readonly (readonly string[])[]): string[][] =>
  repetitions.map((components) => {
    const kept = [...components];
    while (kept[kept.length - 1] === "") {
      kept.pop();
    }
    return kept;
  });

const expectedRepetitions = (element: ExpectedElement): string[][] =>
  normal(Array.isArray(element) ? [element] : element.repetitions);

describe("every valid sample", () => {
  it.each(samples("valid"))("%s: exit 0, and the JSON is what the sample says", async (name) => {
    const expected = expectedOf<ExpectedValid>("valid", name);
    const { status, report } = await inspectJson("valid", name);
    expect(status).toBe(0);
    expect(report).toMatchObject({ schemaVersion: 1, valid: true, complete: true });
    expect(report.counts).toMatchObject({ interchanges: 1, errors: 0 });
    const [interchange] = report.interchanges;
    expect(interchange).toMatchObject({
      reference: expected.interchange.interchangeReference,
      syntaxIdentifier: expected.interchange.syntaxIdentifier,
      syntaxVersion: String(expected.interchange.syntaxVersion),
      una: expected.interchange.una !== null,
    });
    expect(
      interchange?.messages.map((m) => ({
        reference: m.reference,
        type: m.type,
        version: m.version,
        release: m.release,
        agency: m.agency,
      })),
    ).toEqual(expected.interchange.messages);

    // The segments of the messages, UNH to UNT, with the values they have.
    const inMessages: { tag: string; elements: string[][][] }[] = [];
    let inside = false;
    for (const segment of expected.segments) {
      inside ||= segment.tag === "UNH";
      if (inside) {
        inMessages.push({
          tag: segment.tag,
          elements: (segment.elements as ExpectedElement[]).map(expectedRepetitions),
        });
      }
      inside &&= segment.tag !== "UNT";
    }
    const shown = (interchange?.messages ?? []).flatMap((m) =>
      m.segments.map((s) => ({ tag: s.tag, elements: s.elements.map(normal) })),
    );
    expect(shown).toEqual(inMessages);

    // The offsets are where the segments and messages are in the file.
    const file = Buffer.from(readSample("valid", name));
    const terminator = expected.interchange.una === null ? "'" : expected.interchange.una.slice(5);
    const at = (start: number, end: number): string => file.subarray(start, end).toString("latin1");
    for (const message of interchange?.messages ?? []) {
      expect(at(message.start, message.start + 3)).toBe("UNH");
      expect(message.end).toBe(must(message.segments.at(-1)).end);
      expect(message.segmentCount).toBe(message.segments.length);
      for (const segment of message.segments) {
        expect(at(segment.start, segment.start + 3)).toBe(segment.tag);
        expect(at(segment.end - 1, segment.end)).toBe(terminator);
      }
    }

    // What the CONTRL messages of the file say is what their UCI and UCM segments say.
    const uci = expected.segments.filter((segment) => segment.tag === "UCI");
    expect(report.acknowledgements.map((one) => one.reference)).toEqual(
      uci.map((segment) => (segment.elements[0] as string[])[0]),
    );
    const ucm = expected.segments.filter((segment) => segment.tag === "UCM");
    expect(report.acknowledgements.flatMap((one) => one.messages).length).toBe(ucm.length);
  });

  it.each(samples("valid"))(
    "%s: the text says it is valid, with and without registries",
    async (name) => {
      const plain = await cli(["inspect", samplePath("valid", name)]);
      expect(plain.status).toBe(0);
      expect(plain.err).toBe("");
      expect(plain.out).toContain("Result: valid\n");
      expect(plain.out).toContain("No registry");
      expect(plain.out).toContain("Interchange 1:");
      for (const [i, message] of expectedOf<ExpectedValid>(
        "valid",
        name,
      ).interchange.messages.entries()) {
        expect(plain.out).toContain(
          `Message ${i + 1}: ${message.type} ${message.version}.${message.release} (${message.agency}), reference ${message.reference}, `,
        );
      }

      const checked = await cli([
        "inspect",
        samplePath("valid", name),
        "--registry",
        registries.folder,
      ]);
      expect(checked.status).toBe(0);
      expect(checked.out).toContain("Checked against the registry of D.01B (UN), D.96A (UN).");
    },
  );
});

describe("every invalid sample", () => {
  const where = (position: JsonReport["issues"][number]["position"]) => ({
    segment: position.segment,
    tag: position.tag,
    element: position.element,
    component: position.component,
  });

  it.each(samples("invalid"))(
    "%s: exit 1 and its expected errors, with the registries",
    async (name) => {
      const { expectedErrors } = expectedOf<ExpectedInvalid>("invalid", name);
      const { status, report } = await inspectJson(
        "invalid",
        name,
        "--registry",
        registries.folder,
      );
      expect(status).toBe(1);
      expect(report.valid).toBe(false);
      expect(report.issues.map((issue) => issue.code)).toEqual(expectedErrors.map((e) => e.code));
      expect(report.issues.map((issue) => where(issue.position))).toEqual(
        expectedErrors.map((e) => e.position),
      );
      expect(report.counts.errors).toBe(expectedErrors.length);
    },
  );

  it.each(samples("invalid"))(
    "%s: without a registry, only the file and its envelopes are checked",
    async (name) => {
      const { layer, expectedErrors } = expectedOf<ExpectedInvalid>("invalid", name);
      const { status, report } = await inspectJson("invalid", name);
      if (layer === "tokenizer" || layer === "envelope") {
        expect(status).toBe(1);
        expect(report.issues.map((issue) => issue.code)).toEqual(expectedErrors.map((e) => e.code));
      } else {
        // Structure, data and codes are the registry's to check: without it the file is valid.
        expect([status, report.valid, report.issues]).toEqual([0, true, []]);
      }
    },
  );

  it.each(samples("invalid"))("%s: the text lists the errors before the contents", async (name) => {
    const { expectedErrors } = expectedOf<ExpectedInvalid>("invalid", name);
    const { status, out, err } = await cli([
      "inspect",
      samplePath("invalid", name),
      "--registry",
      registries.folder,
    ]);
    expect(status).toBe(1);
    expect(err).toBe("");
    expect(out).toContain("Result: not valid (");
    for (const error of expectedErrors) {
      expect(out).toContain(`error ${error.code} at line`);
    }
    const issues = out.indexOf("\nIssues");
    expect(issues).toBeGreaterThan(-1);
    // A file that stops being readable may have nothing to show of its contents.
    const contents = out.indexOf("\nContents");
    expect(contents === -1 || contents > issues).toBe(true);
  });
});
