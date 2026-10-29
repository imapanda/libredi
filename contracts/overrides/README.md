# EDIFACT partner overrides

The format of the rules a trading partner, or one flow with a partner, changes in the standard
definitions of an EDIFACT directory, without editing the registry. It is the second contract of
the validator, after the [registry](../registry/README.md) ([#47](https://github.com/imapanda/libredi/issues/47)).
How to write and use one is in [Partner overrides](../../docs/partner-overrides.md).

| Path | Content |
| --- | --- |
| [`overrides.schema.json`](overrides.schema.json) | The JSON Schema (draft 2020-12) of a document of overrides |
| [`examples/fictitious-retailer.overrides.json`](examples/fictitious-retailer.overrides.json) | A made-up document for the made-up directory of [`registry/examples`](../registry/examples/fictitious-registry.json): one rule of each kind |
| [`packages/registry`](../../packages/registry) | `validateOverrides()` (the schema) and `checkOverrides()` (the rules below that a schema cannot express), with their tests |
| [`packages/edifact`](../../packages/edifact) | `applyOverrides()` and the `overrides` option of `validate()`, with the tests that show an override changing a result |

A document is **not** a registry and is never merged into one on disk: the validator applies it to
the registry in memory, for one call. The registry stays the directory's, and the partner's rules
stay in their own file, which can be versioned, reviewed and removed on their own.

## One document per directory and flow

```json
{
  "schemaVersion": 1,
  "name": "Acme orders from Retailer",
  "directory": { "agency": "UN", "version": "D", "release": "96A" },
  "dataElements": { "1004": { "maxLength": 12 } },
  "composites": { "C507": { "components": { "2": { "status": "M" } } } },
  "segments": { "NAD": { "elements": { "3": { "status": "M" } } } },
  "codeLists": { "3035": { "add": { "AG": { "name": "Agent" } }, "remove": ["SU"] } },
  "messages": { "ORDERS": { "nodes": { "DTM": { "status": "M" }, "SG28/QTY": { "maxOccurs": 2 } } } },
  "severity": { "UNKNOWN_CODE": "warning", "VALUE_TOO_SHORT": "off" }
}
```

`schemaVersion` and `directory` are required; `name` and `description` are for people. Every other
section is optional, and all keys are as in the [registry](../registry/README.md): data element tags
of 4 digits, composites `C` or `S` and 3 digits, segment tags of 3 capital letters, message types
of 6, code list identifiers, positions counted from 1 (an empty element counts, a composite counts
as one).

| Section | Key | Changes |
| --- | --- | --- |
| `dataElements` | tag | `type`, `minLength`, `maxLength` of a simple data element: each given property replaces the registry's, the others stay. Wherever the element is used |
| `composites` | tag | `components.<position>.status`: makes a component mandatory (where its composite is present) or conditional. Wherever the composite is used |
| `segments` | tag | `elements.<position>`: `status` and `maxOccurs` (repetitions, syntax version 4) of a position of a segment, wherever the segment is used |
| `codeLists` | identifier | `closed` (true: another value is an error; false: at most a warning), `add` (codes the partner uses), `remove` (codes it does not accept) |
| `messages` | message type | `nodes.<selector>`: `status` and `maxOccurs` of a node of the structure |
| `severity` | issue code | `error`, `warning` or `off` (the issue is dropped) |

A **selector** of a message node is a segment tag (`DTM`: every segment node of that tag, at any
depth), a group identifier (`SG28`: that group, not its trigger) or `SG28/QTY` (the segment nodes
of that tag directly inside that group). Counts follow the registry: per occurrence of the parent.
Group identifiers are the registry's own (the example above is illustrative: look them up in the
registry in use). Where several selectors match one node, each property comes from the most
specific one, `SGn/TAG` over `TAG`; the others are kept. A selector cannot tell apart two nodes of
the same tag at the same level of a message (the two `UNS` of a message): it changes both.

## What it means

- **Order.** Several documents are applied in the order given and the last one wins, for the same
  property of the same item: a base document for a partner, then one for a flow.
- **Directory.** The rules of a document apply to the registry of its `directory` and to no other;
  a call with no such registry changes nothing by them. The **severities** are the call's, whatever
  the directory of the message: they are about issues, and the interchange has issues of its own
  (the counts of UNZ) that belong to no directory.
- **A code list judges only when it is closed.** On an open list a value that is not in the list is
  at most a warning, and only when the validator looks at all the lists, so `add` and `remove` have
  no effect there unless the document also sets `closed` to true.
- **A severity is changed wherever the code is found.** `MISSING_MANDATORY_ELEMENT` and
  `INVALID_DATA_TYPE` are also found in the envelope segments (UNB, UNT...): turning them off to
  relax an element rule relaxes those too.
- **Severity `off`** drops the issue: it is not counted, not listed and not in the summary a CONTRL
  is written from. The severity of the codes of a file that cannot be read (layer `tokenizer`: a bad
  UNA string, a cut-off file, a character the set does not allow, a message too large) cannot be
  changed, since a rule of a partner cannot make such a file readable: the schema refuses those
  codes.
- **Stricter or looser** is a matter of the values: a shorter `maxLength`, a mandatory component, a
  removed code are stricter; a longer one, a conditional position, an added code, an open list, a
  warning are looser. The validator judges them with the code it uses for the directory, so the
  messages are the same.
- **Objects are closed.** Unlike the other contracts, a property the schema does not know is an
  error, not ignored: a misspelt `maxLen` would otherwise be a rule that silently does nothing.
  The price is that a document using a property added later is refused by an older reader, which is
  the safe way round; a new property needs a new `schemaVersion`.

## Rules the schema cannot express

`checkOverrides()` in `packages/registry` implements them and reports each failure with a JSON
Pointer (a `/` in a key such as `SG28/QTY` is written `~1`):

1. The `directory` is the one of the registry the document is checked against.
2. Every data element, composite, segment, code list and message it names exists in the registry.
3. A position of a composite or a segment is not beyond the last one.
4. After the change, the `minLength` of a data element is not above its `maxLength`.
5. A code to add is not already in the list, a code to remove is in it, and no code is both.
6. A selector finds a node: a tag that is a segment node of the message, a group that exists, a
   segment directly inside the group.

Without them a rule that applies to nothing would pass unnoticed. `checkOverrides()` begins with the
schema and returns its problems alone for a document of the wrong shape, so it never throws on one.
A document applied after others is best checked against the registry they leave: the lengths of
both are compared, and a code the first added can be removed by the second. `libredi inspect
--overrides` does that and refuses the document (exit status 3) with these sentences.

Two things no check sees: a key written twice in the JSON text (every JSON reader keeps the last
one), and the engine given a document of the wrong shape, which may throw a `TypeError`.

## Compatibility

The rules are those of the other contracts ([`../README.md`](../README.md)), except that objects are
closed (above); `$schema` alone is allowed in a document, for editors. Removing or renaming a
property, making an optional one required, or adding a value to an enumeration (`status`, `type`,
`severity`) needs a new `schemaVersion`. The list of issue codes that `severity` accepts is the
catalogue of `@libredi/edifact` without the codes of the layer `tokenizer`; a test fails when the
two differ, so a new code is added to the schema in the same pull request that adds it to the
catalogue.

## Left open

- **Scoping a rule to one message type or one segment.** Data elements, composites, code lists and
  segments are changed wherever they are used, because the registry defines them once. A rule for
  `DTM` in `ORDERS` only needs either a node (`messages`, which are per message) or one document per
  flow, as the engine is called per flow anyway.
- **Rules between elements** ("if the date is there, the qualifier must be"): the registry has no
  dependency notes yet (see its [Left open](../registry/README.md#left-open)).
- **Adding a segment that the structure does not have.** The position of a new node in a message
  cannot be told by a tag alone; a partner that adds a segment needs a message structure of its own.
- **Where documents are kept and which one applies to which flow** is the job of the service that
  stores partners, not of this format.
