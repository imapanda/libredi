import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { diffJson } from "./diff.ts";

describe("diffJson", () => {
  it("finds nothing between equal values, whatever the order of the properties", () => {
    expect(diffJson({ a: 1, b: [1, { c: "x" }] }, { b: [1, { c: "x" }], a: 1 })).toEqual([]);
    fc.assert(
      fc.property(fc.jsonValue(), (value) => diffJson(value, structuredClone(value)).length === 0),
    );
  });

  it("says where a value changed, went missing or was not expected", () => {
    const expected = { rows: [{ unit: "ST", gtin: "1" }, { unit: "KG" }], total: "2" };
    const actual = { rows: [{ unit: "KG", note: "x" }], total: 2, "odd key": true };
    expect(diffJson(expected, actual)).toEqual([
      { path: "rows[0].unit", kind: "changed", expected: "ST", actual: "KG" },
      { path: "rows[0].gtin", kind: "missing", expected: "1" },
      { path: "rows[0].note", kind: "unexpected", actual: "x" },
      { path: "rows[1]", kind: "missing", expected: { unit: "KG" } },
      { path: "total", kind: "changed", expected: "2", actual: 2 },
      { path: '["odd key"]', kind: "unexpected", actual: true },
    ]);
  });

  it("compares an array with an object, and the whole document", () => {
    expect(diffJson({ a: [1] }, { a: { 0: 1 } })).toEqual([
      { path: "a", kind: "changed", expected: [1], actual: { 0: 1 } },
    ]);
    expect(diffJson(1, "1")).toEqual([{ path: "", kind: "changed", expected: 1, actual: "1" }]);
  });

  it("finds a difference between any two different values", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        const equal = JSON.stringify(a) === JSON.stringify(b);
        // JSON.stringify is sensitive to the order of the properties; diffJson is not.
        if (equal) expect(diffJson(a, b)).toEqual([]);
        else if (diffJson(a, b).length === 0) expect(a).toEqual(b);
      }),
    );
  });
});
