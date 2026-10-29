# Partner overrides

A trading partner rarely follows the standard to the letter. One sends order numbers of 12
characters at most, another wants a date in every order, a third has a party code the directory
does not list. A **partner override** is a small JSON document that says so, for one partner or
one flow, so that the validator judges that flow's files by the partner's rules, while the registry
stays the directory's and every other flow is checked as before.

The format is [`contracts/overrides`](../contracts/overrides/README.md), a JSON Schema with an
example; this page says how to write one and what it does. The errors the validator reports are
the same, with the same codes and messages, as for the directory itself
([Validation errors](validation-errors.md)): an override changes whether and how severely something
is reported, not how it is described.

## What an override can change

| You want to... | Write |
| --- | --- |
| Allow a longer value, or require a shorter or longer one | `dataElements`: `maxLength`, `minLength` |
| Change the type of a value (alphabetic, numeric, alphanumeric) | `dataElements`: `type` |
| Require a component of a composite, or make it optional | `composites`: `components.<position>.status` |
| Require an element of a segment, make it optional, or allow it to repeat | `segments`: `elements.<position>`: `status`, `maxOccurs` |
| Accept a code the directory does not have | `codeLists`: `add` |
| Refuse a code the directory has | `codeLists`: `remove` |
| Stop treating a list as complete, or start | `codeLists`: `closed` |

A code list only judges a value when it is **closed** (every valid value is in it). On an open list
(`"closed": false`, which the directory uses for lists kept by someone else) a code that is not in
the list is not an error, so `add` and `remove` change nothing there unless the document also sets
`"closed": true`, or the validator is asked to look at all the lists (`codeLists: "all"`), where
the code is a warning. The registries the generator writes mark every list closed.
| Require a segment or a group, limit how often it may occur | `messages`: `nodes` |
| Make an issue a warning, an error, or ignore it | `severity` |

For example, a retailer that sends orders with a 12-character order number, always dates them, uses
its own code `AG` for agents, refuses the code `SU` and may repeat a quantity at most twice (the
group identifier `SG28` is the one of the registry the example was imagined with: look up the
identifiers in yours):

```json
{
  "schemaVersion": 1,
  "name": "Orders from Retailer",
  "directory": { "agency": "UN", "version": "D", "release": "96A" },
  "dataElements": { "1004": { "maxLength": 12 } },
  "codeLists": { "3035": { "add": { "AG": { "name": "Agent" } }, "remove": ["SU"] } },
  "messages": { "ORDERS": { "nodes": { "DTM": { "status": "M" }, "SG28/QTY": { "maxOccurs": 2 } } } }
}
```

Put the partner's quirks in the document and keep the reason in its `description`: it is the one
place that says why a file that fails the directory is accepted from this partner.

## How it is applied

- **To the registry, in memory, for one validation.** `applyOverrides(registry, document)` returns a
  copy of the registry with the rules applied and shares everything the document does not touch. The
  registry file is not changed, and the document is not merged into it anywhere. Applying the same
  document to the same registry gives the same object, so a service that validates many files for
  a flow pays for it once.
- **By directory.** A document is for one directory (`UN D.96A`). It changes the registry of that
  directory and no other, so a document for D.96A has no effect on a message of D.01B.
- **In order.** Several documents are applied one after the other and the last wins, for the same
  property of the same item. Use it for a base document of a partner and a document for one flow.
  Inside a document, where several selectors match one node (`DTM` and `SG1/DTM`), each property
  comes from the most specific one, `SGn/TAG` over `TAG`, and the other properties are kept.
- **Severities for the whole call.** `severity` is about issues, not about a directory, so it
  applies to every issue the call finds, including the counts of UNZ, which belong to no
  directory. `off` drops the issue as if it had not been found: it is not counted, listed or
  summarised, and a CONTRL written from the result does not mention it. A code is changed
  wherever the validator finds it, in every layer that uses it: `MISSING_MANDATORY_ELEMENT` and
  `INVALID_DATA_TYPE` are also found in UNB, UNT and the other envelope segments, so turning them
  off to relax a rule about an element relaxes those too.
- **Not for a file that cannot be read.** A bad UNA string, a cut-off file, a character the character
  set does not allow, a message too large for the memory budget: no rule of a partner can make these
  acceptable, and the schema does not accept their codes in `severity`.
- **What is checked is judged the same way.** An override changes a length, a status or a list; the
  validator then checks the file with the code it uses for the directory. The messages quote the
  partner's rule and not the directory's: `... where the element allows 12 characters at most`.
- **Documents are not changed after use.** The result of `applyOverrides` is kept for a pair of
  objects, so a registry or a document that is edited after it was first used is not seen again
  by the validator (a severity, which is read at every call, is). Build a new object, or load the
  file again, when a document changes.

## Using it

From code, with [`@libredi/edifact`](../packages/edifact/README.md):

```ts
import { validate, type OverridesView } from "@libredi/edifact";
import { checkOverrides } from "@libredi/registry";

// Once, when the document is loaded: the shape, then what it names against the registry.
const problems = checkOverrides(document, registry); // the shape first, then the references
if (problems.length > 0) throw new Error(problems.map((p) => `${p.path} ${p.message}`).join("\n"));

const report = validate(bytes, { registries: [registry], overrides: [partnerBase, thisFlow] });
```

`OverridesView` is the part of the document the validator reads, so the engine does not depend on
the registry package; a document that passed the check above is one, and so is an `Overrides` of
the registry package. `overrides` is always a list, even for one document. For a document that is
applied after others, check it against the registry they leave (`applyOverrides` of the earlier
ones), which is what `libredi inspect` does: it then sees the codes they added, and the lengths of
both documents are compared. Where documents are stored, and which belong to a flow, is for the
service that stores partners.

From the command line:

```bash
libredi inspect order.edi --registry ~/.local/share/libredi/registry --overrides retailer.json
```

`--overrides` can be repeated (a file named twice is applied twice, where it was named). A document
with rules about a directory needs the registry of that directory among the `--registry`; one with
severities only does not. A document that is not valid, or does not fit that registry as the earlier
documents leave it, is refused (exit status 3) with a sentence for each of the first three
problems, for example:

```text
libredi: retailer.json does not fit the registry of D.96A (UN): /codeLists/3035/remove/0 code "XX" is not in code list "3035": there is nothing to remove
```

## Refused documents

A document is checked before it is used, so that a rule never does nothing without saying so:

- **The shape**, by the schema: the objects are closed, so a misspelt `maxLen` is an error and not
  a rule that is ignored; keys must look like what they are (4 digits for a data element, 3
  capital letters for a segment); values must be of the right kind (`maxLength` a whole number
  from 1, `status` `M` or `C`, `severity` `error`, `warning` or `off`, and only for a code whose
  severity can be changed).
- **The reference**, against the registry: the data element, composite, segment, code list, message,
  position, code, group or segment node it names must exist; a code to add must not be in the list
  already, one to remove must be; a length must not end up with its minimum above its maximum.

A document that passes is applied. The engine does not run these checks. Given a document of the
right shape it leaves alone what it names and the registry does not have, and does not fail; given
one of the wrong shape (a missing `directory`, `null` for a rule) it may throw a `TypeError`, as it
does for a registry that does not follow its schema. Two things the checks cannot see: a key that
is written twice in the JSON text (the last one is kept by every JSON reader, and no document is
left to tell), and the nodes of a message that have the same tag at the same level (such as the
two `UNS` of a message, which a selector cannot tell apart: the rule applies to both).

## What it does not do

- **Scope a rule to one message type.** Data elements, composites, code lists and segments are
  defined once in the registry, so a change applies wherever they are used. A rule that must hold in
  one message only is a rule on its nodes (`messages`), or a document for that flow.
- **Add a segment that the message structure lacks**, or reorder a structure. A partner whose
  messages differ that much needs a registry of its own.
- **Store documents or tell which one belongs to which partner.** That is the job of the service
  that holds partners and flows; this is the format and the engine.
