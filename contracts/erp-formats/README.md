# ERP file formats

How Libredi writes the files an ERP imports, and reads the files it exports. A format is a
configuration, written in YAML or JSON and checked by a JSON Schema (2020-12), not code: an AI
assistant can draft one from the import guide of an ERP, and a person can review it. The code
that runs them is [`packages/erp-formats`](../../packages/erp-formats/README.md).

| Format | Schema | Writes | Reads |
| --- | --- | --- | --- |
| CSV | [`csv.schema.json`](v1/csv.schema.json) | yes | yes |
| Fixed width | [`fixed-width.schema.json`](v1/fixed-width.schema.json) | yes | yes |
| JSON | [`json.schema.json`](v1/json.schema.json) | yes | not yet |
| XML | [`xml.schema.json`](v1/xml.schema.json) | yes | not yet |

[`common.schema.json`](v1/common.schema.json) holds what the formats share: encodings, line
endings, paths, columns and record types.

A format works on JSON documents: a [canonical document](../canonical/README.md), written
directly, or what a [mapping](../mapping/README.md) gives, such as `{ "rows": [...] }`. The
format does not compute anything: it says where each value goes. Renaming, lookups and
conditions belong in the mapping.

## Common rules

- **`formatVersion: 1`** and **`format`** (`csv`, `fixed-width`, `json`, `xml`) start every
  configuration. The schemas of version 1 live in `v1/`; a change that breaks a configuration
  needs a version 2, as for the [canonical documents](../canonical/README.md#versioning).
- **Closed objects.** An unknown property is an error, so a misspelled option fails at once.
- **Encoding**: `utf-8` (the default), `windows-1252` or `iso-8859-1`. `bom: true` writes a
  UTF-8 byte order mark; a reader accepts UTF-8 with or without one, and refuses one in a file
  that the format says is Windows-1252 or ISO-8859-1. A character that the encoding cannot
  write is an error when writing (XML writes a character reference instead); a byte that it
  does not define, or invalid UTF-8, is an error when reading, with its byte offset.
- **Line endings**: `crlf` or `lf`, written after every line, the last one included. Readers
  accept both.
- **Paths** name a value in a document: property names joined by dots, such as
  `parties.buyer.gln`. A path never goes through an array; a record type iterates instead.
- **Errors say where.** A reader stops at the first problem and names what applies: the file,
  the line, the character (counted as people count them, an emoji is one) and the byte, the
  record type and the column. A renderer names the document, the
  record type, the column and the path of the value. Nothing is guessed, rounded or dropped
  without a word.

## CSV

```yaml
formatVersion: 1
format: csv
encoding: windows-1252
lineEnding: crlf
separator: ";"
decimalMark: ","
files:
  - name: order-lines.csv
    header: true
    records:
      - name: line
        source: rows
        columns:
          - { name: ORDER_NO, field: order_number, groupBy: true, required: true }
          - { name: QUANTITY, field: quantity, type: decimal }
          - { name: UNIT_PRICE, field: unit_price, type: decimal, scale: 2 }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `separator` | `,` | One character between two values; `"\t"` for a tab. |
| `quote` | `"` | Character around a value that holds the separator, the quote or a line break; a quote inside is doubled (RFC 4180). |
| `quoting` | `minimal` | `minimal` quotes only what needs it, `all` quotes every value, `none` never quotes: a value that would need quotes is an error, and a reader takes the quote as an ordinary character. |
| `decimalMark` | `.` | `.` or `,`, for every decimal column; a column may set its own. |
| `lineEnding` | `crlf` | See above. |
| `files` | | One entry per file of a document, in order. Each has a `name`, `header` (a first line with the column names) and its `records`. |

### Record types and columns

A **record type** is one kind of line. Without `source`, it is written once per document,
from the document itself: the header of an order. With a `source`, such as `lines`, it is
written once per item of that array, and its fields are read in the item. The record types of a
file are written in their order, document after document.

A **column** has a `name` (the header line, and the name in errors) and exactly one of:

| Key | The value is |
| --- | --- |
| `field` | At this path in the item, or in the document for a record type without source. |
| `documentField` | At this path in the document, repeated on every record of the item type, such as the order number on every line. |
| `value` | This constant, such as `H` for a header record. A reader checks it. |

and optionally:

| Key | Meaning |
| --- | --- |
| `type` | `string` (the default): copied as is, and the value must be a string. `decimal`: a decimal string of the document (`"2.50"`), written with the decimal mark; a JSON number is refused, so no digit is lost in floating point. `integer`: a whole number, such as a line number, given as a JSON number or a string of digits, read back as a JSON number; it must fit a double exactly (up to 2^53 - 1). |
| `scale` | Decimals only: number of decimals written. Missing zeros are added; more non-zero decimals are an error, never rounded. A reader keeps the decimals it finds, so `1.5` written with scale 2 comes back as `1.50`, the same number. |
| `decimalMark` | Decimals only: overrides the one of the format. |
| `required` | The value must be present and not empty, when writing and when reading. |
| `groupBy` | For a `field` of a record type with a source: see below. |

A missing value is written as an empty value, and an empty value is left out when reading, as
a mapping does. A reader writes decimals as the canonical documents do: a point as decimal
mark and no leading zeros (`007,50` gives `"7.50"`).

### Several record types in one file

When a file has several record types, each needs a column with a `value` at the same place,
with a different value, so that a reader can tell which record a line is: `H` and `L` in the
first column, for instance. A record type without source must come first: it opens each
document. A header line (`header: true`) is only for a file with one record type.

### Several documents in one file

A reader returns every document a file holds, one at a time, as a mapping expects them:

- **With a record type without source**, each of its records starts a new document; the
  records that follow belong to it.
- **Otherwise**, records that follow each other with the same `documentField` and `groupBy`
  values belong to one document, and a new document starts when one changes. A document whose
  records come back later in the file, after another one, is an error. Without any such
  column, the whole file is one document.

### Several files per document

With several `files`, a document is spread over them: an order header file and an order lines
file, say. When reading, the parts are matched by the document fields that every file carries,
such as `documentNumber` (a `field` of the header record and a `documentField` of the line
record). The format must have one. A file whose first record type has no source must hold every
document; a file of items only holds nothing for a document without items, such as an order
without lines. Any other document found in one file but not in another is an error.

Examples: [`order-lines.csv.yaml`](v1/examples/order-lines.csv.yaml) (the rows of the
[order-to-csv mapping](../mapping/examples/order-to-csv.mapping.yaml), French conventions),
[`order-header-lines.csv.yaml`](v1/examples/order-header-lines.csv.yaml) (a canonical order
as `H` and `L` records, UTF-8 with a byte order mark) and
[`order-two-files.csv.yaml`](v1/examples/order-two-files.csv.yaml) (a header file and a lines
file).

## Fixed width

```yaml
formatVersion: 1
format: fixed-width
encoding: windows-1252
lineEnding: crlf
files:
  - name: ORDERS.TXT
    records:
      - name: line
        source: lines
        columns:
          - { name: RECORD, value: "02", width: 2 }
          - { name: LINE, field: lineNumber, type: integer, width: 4, pad: "0" }
          - { name: DESCRIPTION, field: product.description, width: 30, overflow: truncate }
          - { name: PRICE, field: unitPrice.amount, type: decimal, scale: 2, impliedDecimals: true, width: 9, pad: "0" }
          - { name: FILLER, value: "", width: 5 }
```

Files, record types and columns work as for CSV (see above), without a separator, quotes or a
header line: a column has a `width` instead, and a line is exactly as long as the widths of its
record type added up. Widths count characters, not bytes; in Windows-1252 and ISO-8859-1 they
are the same.

| Key | Default | Meaning |
| --- | --- | --- |
| `width` | | Number of characters of the column. |
| `align` | `right` for numbers, `left` otherwise | Side of the value; the padding fills the other side. |
| `pad` | a space | Character that fills the column. A pad other than a space needs `align: right`. An empty value is always written as spaces, so that it is never read as zero; a minus sign goes before zeros of padding (`-0012.50`). |
| `impliedDecimals` | `false` | Decimals with a `scale`: the digits without a decimal mark, the last `scale` of them being the decimals (`2.50` with scale 2 is `250`). |
| `overflow` | `error` | A value longer than the width is an error, or, for a string field, is cut to the width (`truncate`). |

A constant with an empty `value` is a filler: spaces, checked when reading. Record types in one
file are told apart by constants at the same place, such as `01` and `02` in the first two
characters.

The padding is not part of the value, so a string that starts or ends with the padding
character, on the side the padding fills, would lose it when read: writing it is an error.
When reading, every line must have the exact length of its record type, and each value comes
out of its padding before it is checked like a CSV value.

Example: [`order.fixed-width.yaml`](v1/examples/order.fixed-width.yaml).

## JSON

| Key | Default | Meaning |
| --- | --- | --- |
| `layout` | `document` | `document`: one document per file. `array`: the documents of a file in an array. `lines`: one document per line (JSON Lines). |
| `indent` | `2` | Spaces per level; `0` writes one line. The `lines` layout never indents. |
| `bom`, `lineEnding` | `false`, `lf` | See above. JSON is always UTF-8. |

Values are written as they are, in the order of their properties (as in JavaScript, a property
whose name is a whole number, such as `"10"`, comes first): decimal strings stay strings.
A value JSON cannot hold, such as `NaN`, `-0`, `undefined`, a hole in an array or a cycle, is an
error, not silently dropped or changed.
Example: [`order.json.yaml`](v1/examples/order.json.yaml).

## XML

```yaml
formatVersion: 1
format: xml
root: Order
wrapper: Orders
names: { documentNumber: Number, lines: Lines }
items: { lines: Line }
attributes: [lineNumber]
```

An object becomes an element with one child per property, in order. A string, a number or a
boolean becomes the text of an element, or an attribute.

| Key | Default | Meaning |
| --- | --- | --- |
| `root` | | Element of each document. |
| `wrapper` | | Element around the documents, so that a file holds several; without it a file holds exactly one. |
| `namespace` | | Default namespace, on the outermost element. |
| `names` | | Element or attribute name of a property, when it differs from the property name. A property whose name is not a valid XML name needs one. |
| `items` | | For an array property, the element of each item: the array becomes one element holding them. Without an entry, each item is an element named after the property. |
| `attributes` | | Properties written as attributes of their parent. |
| `encoding`, `bom`, `lineEnding` | `utf-8`, `false`, `lf` | See above. A character the encoding lacks is written as a character reference. |
| `declaration` | `true` | Writes `<?xml version="1.0" encoding="..."?>`; needed for any encoding but UTF-8. |
| `indent` | `2` | Spaces per level; `0` writes the document on one line. |

`null`, an array directly inside an array, two attributes of the same name, a number that
JavaScript writes with an exponent (`1e21`; give it as a decimal string) and characters that
XML 1.0 forbids are errors.
Example: [`orders.xml.yaml`](v1/examples/orders.xml.yaml).

## Checked in CI

The tests of [`packages/erp-formats`](../../packages/erp-formats) load every example against its
schema, check that broken variants fail, write the canonical examples with every format, and
read the CSV and fixed-width files back to the same documents, including with random documents.
