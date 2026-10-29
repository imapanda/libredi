# EDIFACT definition registry

The format of the registry: what the Libredi parser, validator and tools need to know about a
UN/EDIFACT directory such as D.96A or D.01B. It is the first contract of milestone M1 (issue
[#30](https://github.com/imapanda/libredi/issues/30), epic #29). The generator that writes it is
described in [Registry generator](../../docs/registry-generator.md).

A registry is **generated, never committed**. A generator downloads the official UNECE
directory files into the operator's volume and writes a registry document that follows this
schema, so that the operator is the licensee and the repository holds no derived UN data
([ADR 7](../../docs/adr/0007-standards-licensing.md)). This directory holds the schema and a
made-up example, nothing else.

| Path | Content |
| --- | --- |
| [`registry.schema.json`](registry.schema.json) | The JSON Schema (draft 2020-12) of a registry document |
| [`examples/fictitious-registry.json`](examples/fictitious-registry.json) | A hand-written registry of an invented directory: every feature of the format, no UN or GS1 text |
| [`packages/registry`](../../packages/registry) | Tests of the schema against the example and its broken variants, and `checkRegistry()` for the rules below that a schema cannot express |

The schema lives in `contracts/` and not in `packages/registry` because
[ADR 10](../../docs/adr/0010-service-boundaries-and-communication.md) puts language-neutral
interfaces there: a service in Go or Rust reads this file like any other contract, while
`packages/registry` is TypeScript code.

## One document per directory

A document describes one directory version (D.96A, D.01B, …) and holds five maps. Every map is
keyed by the tag used in EDIFACT.

| Property | Key | Describes |
| --- | --- | --- |
| `schemaVersion` | | Version of this format, `1`. A reader refuses a version it does not know. |
| `directory` | | `agency`, `version`, `release`: the three parts of the message identifier of a UNH segment (S009), for example `UN`, `D`, `01B`. They find the registry of a message. |
| `syntaxVersions` | | The ISO 9735 syntax versions (1 to 4) the registry can be used with. |
| `source` | | `kind` (`unece-directory` or `handwritten`). A registry built from UNECE files must also give the `archives` it was built from (name and SHA-256), the `generator` and `generatedAt`. |
| `dataElements` | 4 digits | Simple data elements. |
| `composites` | `C` or `S` and 3 digits | Composite data elements (`S` for the service composites of the syntax). |
| `segments` | 3 letters | Segments. |
| `codeLists` | identifier | Code lists. |
| `messages` | 6 letters | Message structures. A registry may hold only some of the messages of its directory. |

### Data elements

```json
"9002": { "name": "Example document number", "type": "an", "minLength": 1, "maxLength": 35 }
```

- `type` is `a` (alphabetic), `n` (numeric) or `an` (alphanumeric).
- `minLength` and `maxLength` are in characters. A fixed-length element such as `an3` has equal
  values; a variable one such as `an..35` has a minimum of 1. The decimal mark and the sign of a
  number are not counted.
- `codeList` names the list that gives the values of the element. An element without it is free.

### Composites and segments

A composite lists its `components`, a segment its `elements`, in order:

```json
"XPT": {
  "name": "Example party",
  "elements": [
    { "ref": "9005", "status": "M" },
    { "ref": "9006", "status": "M" },
    { "ref": "9007", "status": "C", "maxOccurs": 3 }
  ]
}
```

- The **position** of a component or an element is its index in the list, counted from 1. An
  empty element still counts, and a composite counts as one element. These are the numbers the
  tokenizer and the validator report as `position.element` and `position.component`.
- `ref` is the tag of a data element (4 digits) or, in a segment, of a composite (`C` or `S` and
  3 digits). A component can only be a simple data element.
- `status` is `M` (mandatory) or `C` (conditional). A mandatory component only has to be present
  where its composite is.
- `maxOccurs` on a segment element is how many times it may be repeated, 1 when absent. Repetition
  needs the repetition separator of syntax version 4: under syntax version 3 an element cannot be
  repeated, whatever `maxOccurs` says.
- A **simple** data element has no components. An error on one has `component` `null`: the error
  model ([validation errors](../../docs/validation-errors.md)) puts `component` only where the
  element is a composite.

### Code lists

```json
"9011": {
  "name": "Example quantity qualifiers",
  "closed": true,
  "codes": { "Q1": { "name": "Ordered quantity" }, "Q2": { "name": "Delivered quantity" } }
}
```

Code values are arbitrary text, so a code may be called `constructor` or `toString`: a reader
looks codes up as own properties of `codes` (`Object.hasOwn` in JavaScript), not with a plain
`codes[value]`.

`closed` tells the validator how much to trust the list. `true`: `codes` holds every valid value,
so another value is an error. `false`: the list is maintained elsewhere (a standards body, a
trading community) and `codes` is only what the directory knows, so another value is at most a
warning. Whether a closed list is enforced at all is the validator's setting (issue #45), not the
registry's.

### Messages

A message is a list of `nodes`: the segments and groups between UNH and UNT, in the order they
must appear.

- A `segment` node has a `tag`, a `status` and a `maxOccurs`.
- A `group` node has an `id` (`SG1`, `SG2`, …, unique in the message), a `status`, a `maxOccurs`,
  a `trigger` (the tag of the segment that opens each occurrence) and the `nodes` that follow the
  trigger. Groups nest. The trigger has no status and no `maxOccurs`: it is mandatory and occurs
  once per occurrence of the group.
- `sequence` (the number in the message table of the directory, such as `0020`) and `section`
  (`header`, `detail`, `summary`) are informative: they make error messages easier to read.
- The same segment may appear at several places with a different status and `maxOccurs` at each.
- Counts are **per occurrence of the parent**. A node inside a group is counted within one
  occurrence of the group, and a mandatory node of a group is only required in the occurrences
  that exist; whether the group itself is required follows its own `status`.
- The segment `UNS` (section control) is a service segment too, but the directory lists it in its
  message tables, so it is a node like any other and the registry defines it in `segments`. UNH
  and UNT are the only service segments left out of `nodes`.
- The structures of the directories are written so that the next segment alone tells where it
  belongs. Neither the schema nor `checkRegistry()` verifies this.

**Cardinality.** The least number of occurrences follows from `status` (`M`: 1, `C`: 0), so it
cannot contradict it. The most is `maxOccurs`, 1 when absent. A group occurs between that least
and `maxOccurs` times, and each occurrence starts with its trigger.

## Rules the schema cannot express

JSON Schema validates shape, not references. A reader that loads a registry (and a generator that
writes one) also applies these rules; `checkRegistry()` in `packages/registry` implements them
and reports each failure with a JSON Pointer.

Key shapes (the patterns on the keys of each map) are enforced by a schema validator only. Code
generated from the schema may not check them, so a reader validates a registry once, when it loads
it, and trusts it afterwards.

1. The `codeList` of a data element is a key of `codeLists`.
2. The `ref` of a component is a key of `dataElements`.
3. The `ref` of a segment element is a key of `dataElements` (4 digits) or of `composites`
   (`C` or `S`, then 3 digits).
4. The `tag` of a segment node and the `tag` of a group trigger are keys of `segments`.
5. Group `id`s are unique in a message, nested groups included.
6. `minLength` of a data element is not above its `maxLength`.

## What reads what

| Issue | Reads |
| --- | --- |
| Tree model and syntax 4 (#39, #41) | `directory` and `syntaxVersions` to pick a registry; the names and positions of elements and components; `maxOccurs` for repetition |
| Envelope validation (#43) | The definitions of UNH and UNT, which version 1 leaves to the service registries (see below) |
| Structure validation (#44) | `messages`: order, `status`, `maxOccurs`, groups and triggers |
| Element validation (#45) | `dataElements`: `type`, `minLength`, `maxLength`; `status` in segments and composites; `codeLists` and `closed` |
| Error messages (#46) | `name` and `description` of every definition, `sequence` and `section` |
| Partner overrides (#47) | Nothing: overrides are separate documents ([`contracts/overrides`](../overrides/README.md)) that refer to this one; the validator applies them on top of a registry |
| Registry generator (#32) | Writes it |

## Compatibility

The rules are those of the other contracts ([`../README.md`](../README.md)):

- Adding an **optional** property is compatible and does not change `schemaVersion`. Readers
  ignore properties they do not know, so the schema does not close its objects.
- Removing or renaming a property, or making one required, needs a new `schemaVersion`.
- Adding a value to an enumeration (`type`, `status`, `kind`, `section`, `source.kind`) can break a
  reader that checks the values strictly: it counts as a new `schemaVersion` too.
- A reader refuses a `schemaVersion` it does not know instead of guessing, and checks it before
  validating, since a validator can only say that the value "must equal 1".
- Because objects stay open, a misspelt optional property name is ignored instead of rejected.
  The tests of a generator must cover what it writes.

## Left open

Decided later, when the generator (#32) reads the real files, without breaking this version:

- **Dependency notes**, the rules that tie data elements of a segment together ("if one is
  present, the other must be"). They are not modelled yet. They would be an optional property of
  a segment or composite.
- **Which component carries the code list agency.** A coded component can name the agency of its
  list in a sibling component. The registry does not say which one, so the validator needs a rule
  or an extra property for externally maintained lists (#45).
- **Service definitions.** UNB, UNZ, UNG, UNE, UNH, UNT and CONTRL belong to ISO 9735, not to a
  directory. The proposal is one registry per syntax version, identified as the corpus identifies
  CONTRL (`D` and `3` for syntax 3, `4` and `2` for syntax 4; unverified), which is why `nodes`
  leaves UNH and UNT out. Still to settle: how such a registry is marked (a `role` property), how
  it is merged with a directory registry when both define the same element, and whether the
  interchange itself (UNB to UNZ) is described as a structure. The generator defines `UNS`
  itself, because every message table lists it and no directory file defines it. The segments
  `UGH` and `UGT` of syntax version 4 are in the same case, and two messages of D.01B (`JUPREQ`
  and `PAYDUC`) use them: the generator leaves those two out until a service registry defines them.
- **Names of positions.** A composite can use the same data element several times, so a message
  such as "expected 4440" is ambiguous. An optional `name` on a position would fix it.
- **Addresses of nodes.** `sequence` is informative and not required to be unique. Partner
  overrides ([`contracts/overrides`](../overrides/README.md)) point at a node by its segment tag, by
  its group identifier (`SGn`) or by `SGn/TAG`, which cannot tell apart two nodes of the same tag at
  the same level of a message; a uniqueness rule on `sequence` would let them.
- **Closed lists.** `closed` is required, but the UNTDID files do not say which lists are
  exhaustive. The generator marks every list that has codes as closed and leaves the strictness to
  the validator (#45), which can turn the check down per list or per partner (#47).
- **`syntaxVersions` of a directory.** A directory such as D.01B works with syntax 3 and 4. The
  generator takes the values from its table of directories (`directories.ts`), not from the files,
  which do not say.
- **Size.** A registry with every message of a directory may be large. A generator can emit
  only the messages an installation uses, since `messages` may be partial.
- **Types.** `packages/registry` has hand-written TypeScript types. They will be generated from
  the schema with the rest of the contract tooling (#182).

## The fictitious example

[`fictitious-registry.json`](examples/fictitious-registry.json) describes an invented directory
(`ZZ`, `Z`, `00A`) and an invented message, `SAMPLE`, with segments `XHD`, `XDT`, `XPT`, `XLN`,
`XQT` and `XTT`. It shows what a hand-written registry needs: the three data types, fixed and
variable lengths, a composite, a repeated element, a closed and an open code list, nested groups,
the three sections and the section separator segment `UNS`. The tests add the provenance of a
generated registry (`archives`, `generator`, `generatedAt`), which a hand-written one has no use
for.

Keep it that way. It must hold no text, no structure and no code list copied from the UN/EDIFACT
directories or from GS1 or EANCOM documents, whatever their licence says about reuse. The one
deliberate exception is `UNS`, its data element `0081` and the two codes `D` and `S`: ISO 9735
defines them for every message, and the names and descriptions here are invented. To test a
feature, extend this example or write another invented one. A registry built from the real files
is generated on the operator's machine and never added to this repository.
