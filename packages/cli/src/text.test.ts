import type { ValidationIssue, ValidationReport } from "@libredi/edifact";
import { describe, expect, it } from "vitest";
import { textReport } from "./text.ts";

describe("the text of an issue", () => {
  it("is shown without what would act on a terminal, whoever built it", () => {
    // The engine takes care of the values it quotes; the report is not taken on trust all the same.
    const issue: ValidationIssue = {
      code: "UNKNOWN_CODE",
      severity: "error",
      layer: "code",
      position: { segment: 3, tag: "NAD", element: 1, component: null, repetition: null },
      expected: null,
      found: "Q\u001b[31mQ",
      message: "NAD has \u001b[31mQQQ‮ and\nerror FORGED at line 1",
      hint: "Hint with \u0007 bell",
      offset: 10,
      line: 3,
      column: 5,
    };
    const report: ValidationReport = {
      issues: [issue],
      issueCount: 1,
      errorCount: 1,
      warningCount: 0,
      valid: false,
      complete: true,
      messageCount: 0,
      interchangeCount: 0,
      interchanges: [],
    };
    const out = [
      ...textReport({ file: "f.edi", bytes: 0, directories: [], overrides: [] }, report, [], []),
    ].join("");
    expect(out).toContain("\n  NAD has ?[31mQQQ? and?error FORGED at line 1\n");
    expect(out).toContain("Hint: Hint with ? bell");
    expect([...out].filter((char) => char < " " && char !== "\n")).toEqual([]);
    expect(out).not.toContain("‮");
    // The lines of the issue are still lines.
    expect(out).toContain("error UNKNOWN_CODE at line 3, column 5 (segment 3 NAD, element 1)\n");
  });
});
