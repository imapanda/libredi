# Mapping format

A mapping is a YAML file that turns one message into one [canonical
document](../canonical/README.md), or the other way round. It is meant to be read by a person,
written by an AI assistant, tested without a partner, and run in a sandbox
([ADR 6](../../docs/adr/0006-declarative-mappings-with-jsonata.md)). The format is described by
[`mapping.schema.json`](mapping.schema.json) (JSON Schema 2020-12). This page defines what a
mapping says, and how it must be read; the runner, [`@libredi/mapping`](../../packages/mapping/README.md),
executes it, and `libredi test <mapping>` runs its fixtures.

| Key | Content |
| --- | --- |
| `formatVersion` | Version of this format. Always `1` for now. |
| `name`, `description` | What the mapping is for. |
| `version` | Revision of this mapping, a whole number. A revision is promoted to production, never edited there. |
| `flow` | Direction, the message on the other side, and the canonical document. |
| `lookups` | Lookup tables, as data. |
| `fields` | What to produce: one JSONata expression per target field. |
| `fixtures` | Sample inputs with the output they must give. At least one. |

## Flow

```yaml
flow:
  direction: inbound        # the message is read and a canonical document is produced
  message: { syntax: csv, type: order-confirmation, version: "2" }
  canonical: { documentType: orderResponse, schemaVersion: 1 }
```

- `inbound` reads the message and produces the canonical document; `outbound` reads the
  canonical document and produces the message. A mapping is one-way: a partner that sends and
  receives needs two.
- `message` is whatever is on the other side: a partner message (`edifact`, `x12`) or a file of
  the ERP (`csv`, `fixed-width`, `json`, `xml`). `type` and `version` name it, for example
  `ORDERS` and `D.96A`.
- `canonical` names the document and the version of its schema, so a mapping keeps working when
  a version 2 appears.

The input and the output are JSON documents. Their shape depends on the syntax: the tree of the
EDIFACT parser, the rows of the CSV reader, and so on. Each fixture shows it, so a mapping can
be read without knowing the parser.

## Fields

`fields` lists the properties of the output object. Each property is one of three things:

```yaml
fields:
  documentNumber:                  # a value: one JSONata expression
    expression: rows[0].confirmation_number
  parties:                         # an object: its properties in turn
    fields:
      buyer:
        fields:
          gln: { expression: rows[0].buyer_gln }
  lines:                           # an array: one object per item that forEach selects
    forEach: rows
    fields:
      lineNumber: { expression: $number(line) }
```

One expression per field: a value is never built from several partial expressions. Constants
are expressions too: `expression: '"orderResponse"'` and `expression: "1"`. What an expression
can use, besides the input:

| Name | Is |
| --- | --- |
| `$` | The input; inside a `forEach`, the current item (the innermost one when they are nested). |
| `$root` | The whole input, also inside a `forEach`. Do not use `$$` or `%`: they are not supported. |
| `$lookups` | The lookup tables: `$lookup($lookups.units, unit)` gives the value for a key. |
| `$index` | Position of the current item in the innermost `forEach`, from 0. |

### Evaluation rules

Every runner follows them. The
[reference evaluator](../../packages/contracts/src/reference-evaluator.ts) is their executable
statement and runs the fixtures of the examples in CI; it is not the runner, which also
sandboxes and limits time, depth and memory.

- A property whose expression gives nothing (a missing input, an unknown lookup key, `null`) is
  left out. A group with no property left is left out too, and so is an item of a `forEach` that
  ends up empty, so the output never contains `{}`.
- A `forEach` expression is evaluated against the enclosing `$`. What it selects is taken as a
  list: one value is a list of one item. With no item at all the property is left out, not an
  empty array.
- A leaf may give an array of values. JSONata turns an array of one into its single element, so
  write `rows.note[]` to always get an array. An array of objects is a `forEach` group.
- The properties of an object come out in the order written. Fixtures compare JSON values, in
  which only the order of arrays counts.
- The result depends on the input alone: `$now()`, `$millis()`, `$random()`, `$shuffle()` and
  `$eval()` are not available. Pass a date in through the input if a mapping needs it.
- To refuse an unknown code instead of dropping the field, write
  `$lookup($lookups.units, unit) ?? $error("unknown unit")`. A thrown error, from `$error` or
  from a function such as `$number("")`, fails the whole document; nothing partial is kept.
- A mapping reads one document per input: whoever splits a file (the CSV reader, an interchange
  splitter) hands it one document at a time.

Canonical documents carry numbers as decimal strings (`"2.50"`), so copy them as they are and
use `$number` only where the target is a number, such as a line number.

## Lookup tables

```yaml
lookups:
  lineStatus: { A: accepted, C: changed, R: rejected }
```

A table maps string keys to string values. It is data, not code: it is shown in the console and
can be edited without touching an expression. Quote every key and value: YAML reads `01` as the
number 1 and `1.10` as 1.1, and the lookup would then miss. A numeric code is a string, so
convert a number first, `$lookup($lookups.codes, $string(code))`.

## Fixtures

```yaml
fixtures:
  - name: one line accepted, one changed, one rejected
    input: { rows: [ ... ] }
    expected: { documentType: orderResponse, ... }
```

Running the mapping on `input` must give exactly `expected`. A revision can be promoted to
production only when all its fixtures pass. For an inbound mapping `expected` is a canonical
document and for an outbound one `input` is; either way it must be valid against its schema.
Fixtures contain fictitious data only.

## Confidence and specification references

Any field may carry review metadata, optional and meant first for mappings that an AI assistant
drafts:

```yaml
unitPrice:
  fields: { amount: { expression: unit_price } }
  confidence: low                  # high, medium or low
  note: The guide does not say whether the price is net or gross.
  specRef:
    source: Sample ERP confirmation export guide, version 2
    location: Column UNIT_PRICE
```

- `confidence` says how sure the author is. The console is to show every `medium` and `low` field to
  the reviewer.
- **A field of `low` confidence blocks promotion** to production, like a failing fixture. A
  person reviews it, then raises `confidence` or removes it.
- `specRef` points at the passage of the specification that explains the field: `source` (a
  standard and its version, or an implementation guide), `location` (a section, a table or a
  segment) and an optional `url`. Point to the document; do not copy its text, which is often
  not ours to redistribute.
- `note` explains a choice to the next reader.

## Writing rules

- Start the file with `# yaml-language-server: $schema=../mapping.schema.json` (adjust the path)
  so that editors check it as you type.
- Do not use YAML anchors or merge keys (`&`, `*`, `<<`): parsers disagree on them, and repeated
  data is clearer in a fixture than a clever one.
- Quote an expression that starts with a backtick, a quote, `%` or `*`, or that contains a
  colon followed by a space, a `#` or, in flow style, a comma; or write it with `>-` over
  several lines.
- A column name with a hyphen or a space needs backticks in JSONata: `` `order-number` ``;
  without them `order-number` is a subtraction and gives nothing.
- Name the fixtures after what they show; the names are unique in a mapping.

## Checked in CI

[`mapping.test.ts`](../../packages/contracts/src/mapping.test.ts) checks that every example
passes the schema, that broken variants fail, that every expression is valid JSONata, that the
canonical side of every fixture is valid against the canonical schemas, that fixture names are
unique and that no anchors or merge keys are used, and that the reference evaluator turns every
fixture input into its expected output.

## Examples

| Example | Direction | Shows |
| --- | --- | --- |
| [`order-to-csv.mapping.yaml`](examples/order-to-csv.mapping.yaml) | outbound, canonical order to CSV rows | A reviewed mapping: `forEach`, a lookup table, `$root`, spec reference |
| [`csv-to-order-response.mapping.yaml`](examples/csv-to-order-response.mapping.yaml) | inbound, CSV rows to canonical order response | An AI draft: objects, constants, a deduced header status, a field of `low` confidence |
