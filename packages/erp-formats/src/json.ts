import { encode } from "./encoding.ts";
import { FormatError } from "./errors.ts";
import { throwIfAny, validateSchema } from "./layout.ts";

/** A JSON format, checked and with its defaults filled in: see contracts/erp-formats. */
export interface JsonFormat {
  format: "json";
  name?: string;
  layout: "document" | "array" | "lines";
  indent: number;
  bom: boolean;
  lineEnding: "crlf" | "lf";
}

/** Checks a JSON format configuration and fills in the defaults. Throws a LayoutError. */
export function loadJsonFormat(config: unknown): JsonFormat {
  throwIfAny(validateSchema("json", config));
  const raw = config as Partial<JsonFormat>;
  return {
    format: "json",
    ...(raw.name === undefined ? {} : { name: raw.name }),
    layout: raw.layout ?? "document",
    indent: raw.indent ?? 2,
    bom: raw.bom ?? false,
    lineEnding: raw.lineEnding ?? "lf",
  };
}

/**
 * Refuses what JSON.stringify would drop or change without a word: undefined, functions,
 * symbols, big integers, NaN, the infinities and -0, holes in arrays, cycles, and objects that
 * are not plain data.
 */
export function checkJsonValue(
  value: unknown,
  path: string,
  document: number,
  ancestors = new Set<object>(),
): void {
  const fail = (reason: string) => {
    throw new FormatError(reason, { document, path: path || "the document" });
  };
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail(`${value} cannot be written in JSON`);
    return;
  }
  if (typeof value !== "object") fail(`is ${typeof value}, which JSON cannot hold`);
  const object = value as object;
  if (ancestors.has(object)) fail("contains itself");
  ancestors.add(object);
  if (Array.isArray(object)) {
    for (let index = 0; index < object.length; index++) {
      if (!(index in object)) fail(`has no item ${index}`);
      checkJsonValue(object[index], `${path}[${index}]`, document, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) fail("is not a plain object");
    for (const [key, item] of Object.entries(object)) {
      checkJsonValue(item, path ? `${path}.${key}` : key, document, ancestors);
    }
  }
  ancestors.delete(object);
}

/** Writes documents as one JSON file, in UTF-8, with the properties in their order. */
export function renderJson(format: JsonFormat, documents: readonly unknown[]): Uint8Array {
  documents.forEach((document, index) => {
    checkJsonValue(document, "", index + 1);
  });
  const eol = format.lineEnding === "crlf" ? "\r\n" : "\n";
  // JSON.stringify escapes line breaks inside strings, so every \n it writes is a line end.
  const write = (value: unknown, indent: number) =>
    JSON.stringify(value, null, indent).replaceAll("\n", eol);
  let text: string;
  if (format.layout === "lines") {
    text = documents.map((document) => write(document, 0) + eol).join("");
  } else if (format.layout === "array") {
    text = write(documents, format.indent) + eol;
  } else {
    if (documents.length !== 1) {
      throw new FormatError(
        `the document layout writes one document per file, not ${documents.length}: use the array or lines layout`,
      );
    }
    text = write(documents[0], format.indent) + eol;
  }
  return encode(text, "utf-8", format.bom);
}
