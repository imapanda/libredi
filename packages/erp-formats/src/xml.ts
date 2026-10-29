import { encode, firstUnencodable, type TextEncoding } from "./encoding.ts";
import { FormatError, type Position } from "./errors.ts";
import { checkJsonValue } from "./json.ts";
import { throwIfAny, validateSchema } from "./layout.ts";
import { isObject } from "./values.ts";

/** An XML format, checked and with its defaults filled in: see contracts/erp-formats. */
export interface XmlFormat {
  format: "xml";
  name?: string;
  root: string;
  wrapper?: string;
  namespace?: string;
  encoding: TextEncoding;
  bom: boolean;
  declaration: boolean;
  indent: number;
  lineEnding: "crlf" | "lf";
  names: ReadonlyMap<string, string>;
  items: ReadonlyMap<string, string>;
  attributes: ReadonlySet<string>;
}

interface XmlConfig extends Partial<Omit<XmlFormat, "names" | "items" | "attributes">> {
  root: string;
  names?: Record<string, string>;
  items?: Record<string, string>;
  attributes?: string[];
}

const DECLARED = { "utf-8": "UTF-8", "windows-1252": "windows-1252", "iso-8859-1": "ISO-8859-1" };
const NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;
// Characters XML 1.0 allows; any other one, even escaped, makes the file unreadable.
const NOT_XML = /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/u;

/** Checks an XML format configuration and fills in the defaults. Throws a LayoutError. */
export function loadXmlFormat(config: unknown): XmlFormat {
  throwIfAny(validateSchema("xml", config));
  const raw = config as XmlConfig;
  const format: XmlFormat = {
    format: "xml",
    ...(raw.name === undefined ? {} : { name: raw.name }),
    root: raw.root,
    ...(raw.wrapper === undefined ? {} : { wrapper: raw.wrapper }),
    ...(raw.namespace === undefined ? {} : { namespace: raw.namespace }),
    encoding: raw.encoding ?? "utf-8",
    bom: raw.bom ?? false,
    declaration: raw.declaration ?? true,
    indent: raw.indent ?? 2,
    lineEnding: raw.lineEnding ?? "lf",
    names: new Map(Object.entries(raw.names ?? {})),
    items: new Map(Object.entries(raw.items ?? {})),
    attributes: new Set(raw.attributes ?? []),
  };
  const problems = [];
  if (format.bom && format.encoding !== "utf-8") {
    problems.push({ path: "/bom", message: "a byte order mark exists in UTF-8 only" });
  }
  if (!format.declaration && format.encoding !== "utf-8") {
    problems.push({
      path: "/declaration",
      message:
        "an XML file without a declaration is read as UTF-8: keep it to write another encoding",
    });
  }
  throwIfAny(problems);
  return format;
}

/** Escapes text or an attribute value, with a character reference for what the encoding lacks. */
function escapeXml(
  text: string,
  encoding: TextEncoding,
  attribute: boolean,
  where: Position,
): string {
  const invalid = NOT_XML.exec(text);
  if (invalid) {
    const code = (invalid[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    throw new FormatError(`holds U+${code}, which XML 1.0 does not allow`, where);
  }
  let escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  escaped = escaped.replaceAll("\r", "&#xD;");
  if (attribute) {
    escaped = escaped.replaceAll('"', "&quot;").replaceAll("\t", "&#x9;").replaceAll("\n", "&#xA;");
  }
  if (encoding === "utf-8") return escaped;
  return escaped.replace(/[\u{80}-\u{10FFFF}]/gu, (char) =>
    firstUnencodable(char, encoding) < 0
      ? char
      : `&#x${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()};`,
  );
}

/** The text of a scalar; a number JavaScript would write with an exponent is refused. */
function text(value: string | number | boolean, where: Position): string {
  const written = String(value);
  if (typeof value === "number" && (/e/i.test(written) || Object.is(value, -0))) {
    throw new FormatError(
      `${written} would not be written as a plain decimal number: give it as a decimal string`,
      where,
    );
  }
  return written;
}

const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/**
 * Writes documents as one XML file. An object becomes an element with a child per property, in
 * order; a string, a number or a boolean becomes text, or an attribute when the format says so.
 */
export function renderXml(format: XmlFormat, documents: readonly unknown[]): Uint8Array {
  if (format.wrapper === undefined && documents.length !== 1) {
    throw new FormatError(
      `without a wrapper element, an XML file holds one document, not ${documents.length}`,
    );
  }
  const eol = format.lineEnding === "crlf" ? "\r\n" : "\n";
  const out: string[] = [];
  const line = (depth: number, text: string) => {
    out.push(format.indent > 0 ? `${" ".repeat(depth * format.indent)}${text}${eol}` : text);
  };

  const nameOf = (key: string, where: Position) => {
    const name = format.names.get(key) ?? key;
    if (!NAME.test(name)) {
      throw new FormatError(
        `${JSON.stringify(name)} is not an XML name: give it one in names`,
        where,
      );
    }
    return name;
  };

  const element = (
    name: string,
    value: unknown,
    depth: number,
    where: Position,
    extra = "",
  ): void => {
    const path = where.path ?? "";
    if (scalar(value)) {
      line(
        depth,
        `<${name}${extra}>${escapeXml(text(value, where), format.encoding, false, where)}</${name}>`,
      );
      return;
    }
    if (!isObject(value)) {
      throw new FormatError(
        value === null
          ? "is null, which XML cannot tell from an empty value"
          : "is an array inside an array",
        where,
      );
    }
    let attributes = extra;
    const attributeNames = new Set(extra ? ["xmlns"] : []);
    const children: [string, unknown][] = [];
    for (const [key, child] of Object.entries(value)) {
      const at: Position = { ...where, path: path ? `${path}.${key}` : key };
      if (format.attributes.has(key)) {
        if (!scalar(child))
          throw new FormatError(
            "is an attribute, so it must be a string, a number or a boolean",
            at,
          );
        const attribute = nameOf(key, at);
        if (attribute === "xmlns" || attributeNames.has(attribute)) {
          throw new FormatError(`would be a second attribute named ${attribute}`, at);
        }
        attributeNames.add(attribute);
        attributes += ` ${attribute}="${escapeXml(text(child, at), format.encoding, true, at)}"`;
      } else {
        children.push([key, child]);
      }
    }
    if (children.length === 0) {
      line(depth, `<${name}${attributes}/>`);
      return;
    }
    line(depth, `<${name}${attributes}>`);
    for (const [key, child] of children) {
      const at: Position = { ...where, path: path ? `${path}.${key}` : key };
      const childName = nameOf(key, at);
      if (!Array.isArray(child)) {
        element(childName, child, depth + 1, at);
        continue;
      }
      const itemName = format.items.get(key);
      if (itemName === undefined) {
        child.forEach((item, index) => {
          element(childName, item, depth + 1, { ...at, path: `${at.path}[${index}]` });
        });
      } else if (child.length === 0) {
        line(depth + 1, `<${childName}/>`);
      } else {
        line(depth + 1, `<${childName}>`);
        child.forEach((item, index) => {
          element(itemName, item, depth + 2, { ...at, path: `${at.path}[${index}]` });
        });
        line(depth + 1, `</${childName}>`);
      }
    }
    line(depth, `</${name}>`);
  };

  const xmlns =
    format.namespace === undefined
      ? ""
      : ` xmlns="${escapeXml(format.namespace, format.encoding, true, {})}"`;
  documents.forEach((document, index) => {
    checkJsonValue(document, "", index + 1);
    if (!isObject(document)) throw new FormatError("is not an object", { document: index + 1 });
  });
  if (format.declaration) {
    out.push(`<?xml version="1.0" encoding="${DECLARED[format.encoding]}"?>${eol}`);
  }
  if (format.wrapper === undefined) {
    element(format.root, documents[0], 0, { document: 1 }, xmlns);
  } else {
    if (documents.length === 0) {
      line(0, `<${format.wrapper}${xmlns}/>`);
    } else {
      line(0, `<${format.wrapper}${xmlns}>`);
      documents.forEach((document, index) => {
        element(format.root, document, 1, { document: index + 1 });
      });
      line(0, `</${format.wrapper}>`);
    }
  }
  if (format.indent === 0) out.push(eol);
  return encode(out.join(""), format.encoding, format.bom);
}
