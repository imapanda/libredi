import { afterAll, describe, expect, it } from "vitest";
import type { Mapping } from "./evaluate.ts";
import { createMappingPool } from "./pool.ts";
import { example, exampleNames } from "./testing.ts";

const one = (expression: string): Mapping => ({ fields: { a: { expression } } });

describe("createMappingPool", () => {
  const pool = createMappingPool({ size: 2, limits: { timeoutMs: 300 }, memoryMb: 32 });
  afterAll(() => pool.close());

  it("runs the fixtures of the examples", async () => {
    for (const name of exampleNames) {
      const mapping = example(name);
      for (const fixture of mapping.fixtures) {
        expect(await pool.run(mapping, fixture.input), fixture.name).toEqual(fixture.expected);
      }
    }
  });

  it("runs documents side by side, each with its own result", async () => {
    const mapping = one("n * 2");
    const outputs = await Promise.all(
      Array.from({ length: 20 }, (_, n) => pool.run(mapping, { n })),
    );
    expect(outputs).toEqual(Array.from({ length: 20 }, (_, n) => ({ a: n * 2 })));
  });

  it("rejects $eval", async () => {
    await expect(pool.run(one('$eval("1 + 1")'), {})).rejects.toMatchObject({
      name: "MappingError",
      code: "UNAVAILABLE_FUNCTION",
      field: "a",
    });
  });

  it("stops a runaway expression after the time limit", async () => {
    await expect(pool.run(one("($f := function($n){ $f($n) }; $f(1))"), {})).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("terminates a worker stuck in one step, and goes on with a new one", async () => {
    // A regular expression that backtracks: JSONata never gets to check the time.
    const stuck = one('$match("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", /(a+)+$/)');
    const started = Date.now();
    const [result, other] = await Promise.allSettled([pool.run(stuck, {}), pool.run(one("1"), {})]);
    expect(result).toMatchObject({ status: "rejected", reason: { code: "TIMEOUT" } });
    expect(other).toEqual({ status: "fulfilled", value: { a: 1 } });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await pool.run(one("2"), {})).toEqual({ a: 2 });
  });

  it("stops a recursion that is too deep", async () => {
    const deep = one("($f := function($n){ $n = 0 ? 0 : 1 + $f($n - 1) }; $f(100000))");
    await expect(pool.run(deep, {})).rejects.toMatchObject({ code: "TOO_DEEP" });
  });

  it("refuses to build a huge string in one step, which would abort the process", async () => {
    await expect(pool.run(one('$pad("", 500000000)'), {})).rejects.toMatchObject({
      code: "TOO_LONG",
    });
    const doubling =
      '($f := function($s, $n){ $n = 0 ? $s : $f($s & $s, $n - 1) }; $length($f("aaaa", 26)))';
    await expect(pool.run(one(doubling), {})).rejects.toMatchObject({ code: "TOO_LONG" });
  });

  // Fills 16 MiB, which a slow runner can take a few seconds over.
  it("stops a document that needs more memory than the limit", { timeout: 15_000 }, async () => {
    const big = createMappingPool({ size: 1, memoryMb: 16 });
    try {
      await expect(
        big.run(one("$count($keys($merge([1..999999].{$string($): 1})))"), {}),
      ).rejects.toMatchObject({ code: "OUT_OF_MEMORY" });
      expect(await big.run(one("1"), {})).toEqual({ a: 1 });
    } finally {
      await big.close();
    }
  });

  it("reads a mapping when first given", async () => {
    const mapping = { fields: { a: { expression: "1" } } };
    expect(await pool.run(mapping, {})).toEqual({ a: 1 });
    mapping.fields.a.expression = "2";
    expect(await pool.run(mapping, {})).toEqual({ a: 1 });
  });

  it("fails an input that cannot be copied, and the documents after it run", async () => {
    await expect(pool.run(one("1"), { f: () => 1 })).rejects.toMatchObject({
      code: "WORKER_FAILED",
    });
    expect(await pool.run(one("1"), {})).toEqual({ a: 1 });
  });

  it("refuses work once closed", async () => {
    const closing = createMappingPool({ size: 1 });
    const queued = expect(closing.run(one("1"), {})).rejects.toMatchObject({
      code: "WORKER_FAILED",
    });
    await closing.close();
    await queued;
    await expect(closing.run(one("1"), {})).rejects.toMatchObject({ code: "WORKER_FAILED" });
  });
});
