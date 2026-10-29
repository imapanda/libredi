/** One place where an output differs from what a fixture expects. */
export interface Difference {
  /** Where, such as `lines[1].unit`; empty for the whole document. */
  readonly path: string;
  /** `changed`: both have a value; `missing`: only the fixture; `unexpected`: only the output. */
  readonly kind: "changed" | "missing" | "unexpected";
  readonly expected?: unknown;
  readonly actual?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const member = (path: string, key: string): string =>
  IDENTIFIER.test(key) ? (path === "" ? key : `${path}.${key}`) : `${path}[${JSON.stringify(key)}]`;

/**
 * Where two JSON values differ, as fixtures compare them: the order of the properties of an object
 * does not count, the order of the items of an array does. Empty when they are equal.
 */
export function diffJson(expected: unknown, actual: unknown, path = ""): Difference[] {
  if (isObject(expected) && isObject(actual)) {
    const differences: Difference[] = [];
    for (const key of Object.keys(expected)) {
      const at = member(path, key);
      if (!Object.hasOwn(actual, key)) {
        differences.push({ path: at, kind: "missing", expected: expected[key] });
      } else {
        differences.push(...diffJson(expected[key], actual[key], at));
      }
    }
    for (const key of Object.keys(actual)) {
      if (!Object.hasOwn(expected, key)) {
        differences.push({ path: member(path, key), kind: "unexpected", actual: actual[key] });
      }
    }
    return differences;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const differences: Difference[] = [];
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      const at = `${path}[${i}]`;
      if (i >= actual.length)
        differences.push({ path: at, kind: "missing", expected: expected[i] });
      else if (i >= expected.length)
        differences.push({ path: at, kind: "unexpected", actual: actual[i] });
      else differences.push(...diffJson(expected[i], actual[i], at));
    }
    return differences;
  }
  // === and not Object.is: 0 and -0 are the same JSON number.
  return expected === actual ? [] : [{ path, kind: "changed", expected, actual }];
}
