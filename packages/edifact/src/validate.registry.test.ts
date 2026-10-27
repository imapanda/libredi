import { describe, expect, it } from "vitest";
import { type ValidationIssue, validate } from "./index.ts";
import { type ExpectedInvalid, expectedOf, readSample, samples } from "./testing/corpus.ts";
import { corpusRegistries } from "./testing/corpus-registry.ts";

const where = (issue: ValidationIssue) => ({
  segment: issue.position.segment,
  tag: issue.position.tag,
  element: issue.position.element,
  component: issue.position.component,
});

describe("valid samples, with the registries of the corpus", () => {
  it.each(samples("valid"))("%s has no error", (name) => {
    const report = validate(readSample("valid", name), { registries: corpusRegistries });
    expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    // CONTRL is out of scope: it has no registry, and says so.
    const warnings = report.issues.map((issue) => issue.code);
    expect(warnings).toEqual(name.startsWith("contrl") ? ["MESSAGE_NOT_CHECKED"] : []);
  });
});

describe("invalid samples, with the registries of the corpus", () => {
  it.each(samples("invalid"))(
    "%s gives its expected error, with its position, and nothing else",
    (name) => {
      const { expectedErrors } = expectedOf<ExpectedInvalid>("invalid", name);
      const report = validate(readSample("invalid", name), { registries: corpusRegistries });
      expect(report.issues.map((issue) => issue.code)).toEqual(expectedErrors.map((e) => e.code));
      expect(report.issues.map(where)).toEqual(expectedErrors.map((e) => e.position));
    },
  );
});

describe("what the file puts into a message about it", () => {
  const unsafe = (text: string | null): boolean =>
    text !== null &&
    [...text].some((char) => {
      const code = char.codePointAt(0) as number;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    });

  it("never holds a control character, wherever one is put in a sample", () => {
    const controls = [[0x1b], [0x07], [0x0d], [0xc2, 0x9b]];
    let checked = 0;
    for (const directory of ["valid", "invalid"] as const) {
      for (const name of samples(directory)) {
        const original = readSample(directory, name);
        for (let at = 0; at < original.length; at += 7) {
          for (const control of controls) {
            const bytes = new Uint8Array(original.length + control.length);
            bytes.set(original.subarray(0, at));
            bytes.set(control, at);
            bytes.set(original.subarray(at), at + control.length);
            const report = validate(bytes, { registries: corpusRegistries, codeLists: "all" });
            for (const issue of report.issues) {
              checked++;
              expect(
                [issue.message, issue.hint, issue.found, issue.expected].some(unsafe),
                `${name} +${control.join(",")} at ${at}: ${issue.code}`,
              ).toBe(false);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
