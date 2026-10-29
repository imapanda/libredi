import { FormatError, type Position } from "./errors.ts";

export type DecimalMark = "." | ",";
export type ColumnType = "string" | "decimal" | "integer";

/** A value of a document: what JSON can hold. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** The property names of a path such as product.gtin. */
export function segments(path: string): string[] {
  const names = path.split(".");
  for (const name of names) {
    if (name === "" || FORBIDDEN.has(name)) throw new Error(`invalid path ${path}`);
  }
  return names;
}

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The value at `path` in `root`, or undefined when a property on the way is missing. A path that
 * runs into an array or a scalar is an error: a record source, not a path, iterates.
 */
export function getPath(root: unknown, path: string, where: Position): unknown {
  let value = root;
  let walked = "";
  for (const name of segments(path)) {
    if (value === undefined || value === null) return undefined;
    if (!isObject(value)) {
      const kind = Array.isArray(value) ? "an array" : `a ${typeof value}`;
      throw new FormatError(`${walked || "the item"} is ${kind}, not an object`, where);
    }
    value = Object.hasOwn(value, name) ? value[name] : undefined;
    walked = walked ? `${walked}.${name}` : name;
  }
  return value;
}

/** Sets `path` in `root`, creating the objects on the way. */
export function setPath(root: JsonObject, path: string, value: JsonValue): void {
  const names = segments(path);
  let target = root;
  for (const name of names.slice(0, -1)) {
    const next = Object.hasOwn(target, name) ? target[name] : undefined;
    if (isObject(next)) {
      target = next;
    } else {
      const created: JsonObject = {};
      Object.defineProperty(target, name, {
        value: created,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      target = created;
    }
  }
  const last = names[names.length - 1] as string;
  Object.defineProperty(target, last, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const INTEGER = /^-?(0|[1-9][0-9]*)$/;

/**
 * Writes a decimal string of a document with the decimal mark of the file. With a scale, adds the
 * missing zeros, drops extra zeros and refuses to drop any other digit: nothing is rounded.
 */
export function formatDecimal(
  value: string,
  mark: DecimalMark,
  scale: number | undefined,
  where: Position,
): string {
  if (!DECIMAL.test(value)) {
    throw new FormatError(`"${value}" is not a decimal number such as 12 or -2.50`, where);
  }
  const [whole, rest = ""] = value.split(".") as [string, string?];
  let decimals = rest;
  if (scale !== undefined) {
    const kept = decimals.slice(0, scale);
    if (/[1-9]/.test(decimals.slice(scale))) {
      throw new FormatError(
        `"${value}" has ${decimals.length} decimals, the format writes ${scale}: it would be rounded`,
        where,
      );
    }
    decimals = kept.padEnd(scale, "0");
  }
  return decimals === "" ? whole : `${whole}${mark}${decimals}`;
}

/** Reads a decimal number written with `mark`, as a decimal string of a document. */
export function parseDecimal(text: string, mark: DecimalMark, where: Position): string {
  const match = (
    mark === "." ? /^(-?)([0-9]+)(?:\.([0-9]+))?$/ : /^(-?)([0-9]+)(?:,([0-9]+))?$/
  ).exec(text);
  if (!match) {
    throw new FormatError(
      `"${text}" is not a decimal number with "${mark}" as decimal mark`,
      where,
    );
  }
  const [, sign = "", digits = "", decimals] = match;
  const whole = digits.replace(/^0+(?=.)/, "");
  return decimals === undefined ? `${sign}${whole}` : `${sign}${whole}.${decimals}`;
}

/** Checks a whole number of a document: a safe JSON integer, or a string of digits. */
export function formatInteger(value: unknown, where: Position): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && INTEGER.test(value) && Number.isSafeInteger(Number(value))) {
    return value;
  }
  throw new FormatError(`${JSON.stringify(value)} is not a whole number`, where);
}

/** Reads a whole number as a JSON number, refusing one that a double cannot hold exactly. */
export function parseInteger(text: string, where: Position): number {
  const value = /^-?[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value)) {
    throw new FormatError(
      `"${text}" is not a whole number between -${Number.MAX_SAFE_INTEGER} and ${Number.MAX_SAFE_INTEGER}`,
      where,
    );
  }
  return value === 0 ? 0 : value;
}
