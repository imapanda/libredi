import { evaluateMapping } from "@libredi/contracts/reference-evaluator";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MappingError } from "./errors.ts";
import { compileMapping, DEFAULT_LIMITS, type Mapping, UNAVAILABLE_FUNCTIONS } from "./evaluate.ts";
import { example, exampleNames } from "./testing.ts";

/** The runner's result, or the code of its error. */
async function outcome(mapping: Mapping, input: unknown): Promise<unknown> {
  try {
    return await compileMapping(mapping).run(input);
  } catch (error) {
    return { error: (error as MappingError).code };
  }
}

/** The reference evaluator's result, or the fact that it threw. */
async function reference(mapping: Mapping, input: unknown): Promise<unknown> {
  try {
    return await evaluateMapping(mapping as Parameters<typeof evaluateMapping>[0], input);
  } catch {
    return { error: true };
  }
}

const lookups = { t: { x: "X" } };

/** Small mappings, one rule of contracts/mapping/README.md each, with an input. */
const RULES: [string, Mapping, unknown][] = [
  ["leaves out a property that gives nothing", { fields: { a: { expression: "missing" } } }, {}],
  ["leaves out null", { fields: { a: { expression: "null" } } }, {}],
  [
    "leaves out an empty group",
    { fields: { g: { fields: { a: { expression: "missing" } } }, b: { expression: "1" } } },
    {},
  ],
  [
    "takes one value as a list of one",
    { fields: { l: { forEach: "row", fields: { v: { expression: "v" } } } } },
    { row: { v: "a" } },
  ],
  [
    "leaves out a forEach with no item and empty items",
    {
      fields: {
        l: { forEach: "rows", fields: { v: { expression: "v" } } },
        m: { forEach: "none", fields: { v: { expression: "v" } } },
      },
    },
    { rows: [{}, { v: "b" }, {}] },
  ],
  [
    "numbers the items from 0 and reads $root",
    {
      fields: {
        l: {
          forEach: "rows",
          fields: { i: { expression: "$index" }, t: { expression: "$root.top" } },
        },
      },
    },
    { top: "T", rows: [{}, {}] },
  ],
  [
    "nests forEach, with $index of the innermost",
    {
      fields: {
        l: {
          forEach: "rows",
          fields: { m: { forEach: "items", fields: { i: { expression: "$index" } } } },
        },
      },
    },
    { rows: [{ items: [1, 2] }, { items: 3 }] },
  ],
  [
    "always gives an array with []",
    { fields: { n: { expression: "rows.note[]" } } },
    { rows: { note: "a" } },
  ],
  [
    "reads a lookup",
    { lookups, fields: { u: { expression: "$lookup($lookups.t, k)" } } },
    { k: "x" },
  ],
  [
    "misses a lookup",
    { lookups, fields: { u: { expression: "$lookup($lookups.t, k)" } } },
    { k: "y" },
  ],
  ["drops a function", { fields: { f: { expression: "function($x){ $x }" } } }, {}],
  ["reads an array input", { fields: { n: { expression: "$count($)" } } }, [1, 2, 3]],
  [
    "pads as JSONata does",
    {
      fields: {
        right: { expression: '$pad(s, 6, "-+")' },
        left: { expression: "$pad(s, -6)" },
        short: { expression: "$pad(s, 2)" },
        unicode: { expression: '$pad("é😀", 4, "😀a")' },
        context: { expression: 's.$pad(5, "#")' },
        missing: { expression: "$pad(none, 5)" },
      },
    },
    { s: "ab" },
  ],
  [
    "joins as JSONata does",
    {
      fields: {
        a: { expression: '$join(rows.v, ", ")' },
        b: { expression: "$join(rows.v)" },
        c: { expression: "$join(none)" },
      },
    },
    { rows: [{ v: "x" }, { v: "y" }] },
  ],
  [
    "lets a parameter be named $now",
    { fields: { v: { expression: "function($now){ $now + 1 }(1)" } } },
    {},
  ],
  [
    "lets a variable be named $shuffle",
    { fields: { v: { expression: "($shuffle := 1; $shuffle)" } } },
    {},
  ],
  [
    "lets a path bind $random",
    { fields: { v: { expression: "rows@$random.v" } } },
    { rows: [{ v: 1 }] },
  ],
  ["fails on $error", { fields: { a: { expression: '$error("no")' } } }, {}],
  ["fails on a bad number", { fields: { a: { expression: '$number("x")' } } }, {}],
];

describe("compileMapping", () => {
  describe("gives what the reference evaluator gives", () => {
    describe.each(exampleNames)("%s", (name) => {
      const mapping = example(name);
      it.each(mapping.fixtures.map((fixture) => [fixture.name, fixture] as const))(
        "fixture %s",
        async (_name, fixture) => {
          const output = await compileMapping(mapping).run(fixture.input);
          expect(output).toEqual(fixture.expected);
          expect(output).toEqual(await evaluateMapping(mapping, fixture.input));
          // Same JSON, property order included.
          expect(JSON.stringify(output)).toBe(
            JSON.stringify(await evaluateMapping(mapping, fixture.input)),
          );
        },
      );
    });

    it.each(RULES)("%s", async (_label, mapping, input) => {
      const ours = await outcome(mapping, input);
      const theirs = await reference(mapping, input);
      expect("error" in (ours as object)).toBe("error" in (theirs as object));
      if (!("error" in (theirs as object))) expect(ours).toEqual(theirs);
    });

    it("on random inputs to the examples", async () => {
      const value = fc.oneof(fc.string({ maxLength: 4 }), fc.integer(), fc.constant(null));
      const row = fc.dictionary(
        fc.constantFrom(
          "confirmation_number",
          "status_code",
          "line",
          "gtin",
          "unit",
          "ordered_qty",
          "unit_price",
        ),
        fc.oneof(value, fc.constantFrom("A", "C", "R", "ST", "KG", "1")),
      );
      const csv = fc.record({ rows: fc.array(row, { maxLength: 4 }) });
      const order = fc.record({
        documentNumber: value,
        issueDate: fc.string({ maxLength: 12 }),
        lines: fc.array(
          fc.record({
            lineNumber: fc.integer(),
            quantity: fc.record({ value, unit: fc.constantFrom("PCE", "KGM", "X") }),
          }),
          { maxLength: 4 },
        ),
      });
      const mappings = exampleNames.map(example);
      await fc.assert(
        fc.asyncProperty(fc.oneof(csv, order), async (input) => {
          for (const mapping of mappings) {
            const ours = await outcome(mapping, input);
            const theirs = await reference(mapping, input);
            expect("error" in (ours as object)).toBe("error" in (theirs as object));
            if (!("error" in (theirs as object))) expect(ours).toEqual(theirs);
          }
        }),
        { numRuns: 200 },
      );
    });
  });

  it("keeps a field named __proto__ as a field", async () => {
    const output = await compileMapping({ fields: { ["__proto__"]: { expression: '"x"' } } }).run(
      {},
    );
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.keys(output)).toEqual(["__proto__"]);
  });

  describe("refuses the unavailable functions", () => {
    it.each(UNAVAILABLE_FUNCTIONS)("$%s, when the mapping is compiled", (name) => {
      const compile = () =>
        compileMapping({
          fields: { g: { fields: { a: { expression: `false ? $${name}() : 1` } } } },
        });
      expect(compile).toThrow(MappingError);
      expect(compile).toThrow(`$${name}() is not available in a mapping`);
      try {
        compile();
      } catch (error) {
        expect((error as MappingError).toData()).toMatchObject({
          code: "UNAVAILABLE_FUNCTION",
          field: "g.a",
        });
      }
    });

    it("$now bound in one place and called in another, when it is reached", async () => {
      const mapping = { fields: { a: { expression: "(function($now){ $now }(1); $now())" } } };
      await expect(compileMapping(mapping).run({})).rejects.toMatchObject({
        code: "UNAVAILABLE_FUNCTION",
        field: "a",
      });
    });

    it("$eval given another name, and in a forEach", () => {
      expect(() =>
        compileMapping({ fields: { a: { expression: '($e := $eval; $e("1"))' } } }),
      ).toThrow("$eval() is not available");
      expect(() =>
        compileMapping({
          fields: { l: { forEach: '$eval("rows")', fields: { a: { expression: "1" } } } },
        }),
      ).toThrow("$eval() is not available");
    });
  });

  it("says which field of which item failed, and keeps nothing", async () => {
    const mapping: Mapping = {
      fields: {
        a: { expression: "1" },
        lines: { forEach: "rows", fields: { n: { expression: "$number(v)" } } },
      },
    };
    const run = compileMapping(mapping).run({ rows: [{ v: "1" }, { v: "x" }, { v: "y" }] });
    await expect(run).rejects.toMatchObject({ code: "EXPRESSION_FAILED", field: "lines[1].n" });
  });

  it("reports an expression that does not parse, with its field", () => {
    expect(() => compileMapping({ fields: { a: { expression: "(" } } })).toThrow(
      expect.objectContaining({ code: "INVALID_EXPRESSION", field: "a" }),
    );
  });

  describe("limits", () => {
    const recursion = (depth: number): Mapping => ({
      fields: {
        a: { expression: `($f := function($n){ $n = 0 ? 0 : 1 + $f($n - 1) }; $f(${depth}))` },
      },
    });

    it("lets a recursion of 50 levels run, and stops one of 100,000 as too deep", async () => {
      expect(await compileMapping(recursion(50)).run({})).toEqual({ a: 50 });
      await expect(compileMapping(recursion(100_000)).run({})).rejects.toMatchObject({
        code: "TOO_DEEP",
        field: "a",
      });
    });

    it("stops a runaway expression after the time limit", async () => {
      const mapping = { fields: { a: { expression: "($f := function($n){ $f($n) }; $f(1))" } } };
      const started = Date.now();
      await expect(
        compileMapping(mapping, { ...DEFAULT_LIMITS, timeoutMs: 100 }).run({}),
      ).rejects.toMatchObject({ code: "TIMEOUT", field: "a" });
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("counts the time limit for the whole document, not each field", async () => {
      const slow = "$count([1..20000].$string())";
      const fields = Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`f${i}`, { expression: slow }]),
      );
      await expect(
        compileMapping({ fields }, { ...DEFAULT_LIMITS, timeoutMs: 50 }).run({}),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
    });

    it("refuses a padding longer than the limit, which would be allocated in one step", async () => {
      await expect(
        compileMapping({ fields: { a: { expression: '$pad("", 500000000)' } } }).run({}),
      ).rejects.toMatchObject({ code: "TOO_LONG", field: "a" });
    });

    it("stops a string that doubles, before it is hundreds of megabytes", async () => {
      const doubling =
        '($f := function($s, $n){ $n = 0 ? $s : $f($s & $s, $n - 1) }; $length($f("aaaa", 26)))';
      await expect(
        compileMapping({ fields: { a: { expression: doubling } } }).run({}),
      ).rejects.toMatchObject({
        code: "TOO_LONG",
        field: "a",
      });
    });

    it("refuses to join a string longer than the limit, before building it", async () => {
      const join = '($s := $join([1..1000].("x")); $length($join([1..2000].($s))))';
      await expect(
        compileMapping({ fields: { a: { expression: join } } }).run({}),
      ).rejects.toMatchObject({
        code: "TOO_LONG",
      });
    });

    it("stops a sequence longer than the limit", async () => {
      await expect(
        compileMapping(
          { fields: { a: { expression: "$count([1..1000].$string())" } } },
          { ...DEFAULT_LIMITS, maxSequence: 100 },
        ).run({}),
      ).rejects.toMatchObject({ code: "TOO_LONG" });
    });
  });
});
