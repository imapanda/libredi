import { describe, expect, it } from "vitest";
import { plain, reason } from "./plain.ts";

describe("plain", () => {
  it("leaves text a person can read as it is", () => {
    for (const text of ["", "ORDERS D.96A", "Café à la crème", "日本語", "\u{1f4e6}", " ~ "]) {
      expect(plain(text)).toBe(text);
    }
  });

  it.each([
    ["a C0 control", "\u0000\u0007\u0008\u0009\u000a\u000d\u001b\u001f", "????????"],
    ["delete and the C1 controls", "\u007f\u0080\u009b\u009f", "????"],
    ["the line and paragraph separators", "  ", "??"],
    ["the bidirectional overrides and isolates", "‪‫‬‭‮⁦⁧⁨⁩", "?????????"],
  ])("replaces %s with ?", (_name, text, shown) => {
    expect(plain(text)).toBe(shown);
  });

  it("stops at the edges of the ranges", () => {
    expect(plain(" ~ ‧ ⁥⁪")).toBe(" ~ ‧ ⁥⁪");
  });

  it("does not let a value forge a line", () => {
    expect(plain("R1\nerror FORGED at line 1")).toBe("R1?error FORGED at line 1");
  });
});

describe("reason", () => {
  it("puts the code of a system error in front when its message lacks it", () => {
    expect(reason(Object.assign(new Error("no such file"), { code: "ENOENT" }))).toBe(
      "ENOENT: no such file",
    );
    expect(reason(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }))).toBe(
      "ENOENT: no such file",
    );
    expect(reason(new Error("plain"))).toBe("plain");
    expect(reason("text")).toBe("text");
  });
});
