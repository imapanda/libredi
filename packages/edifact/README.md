# @libredi/edifact

The UN/EDIFACT engine of Libredi. Today it holds the **tokenizer** (bytes in, a flat stream of
tokens out), **character sets** (UNOA, UNOB, UNOC, UNOW), the **splitter**, which finds the
messages of a file in constant memory, the **tree**, which reads one message at a time into
segments, elements and components with their positions, within a memory budget, and the
**serializer**, which writes a tree back: byte for byte when it was parsed, or from data that was
built or edited. **Syntax version 4** (the repetition separator) is read and written throughout.
The **validator** checks a file, its envelopes and, against a definition registry, the structure and
the data of its messages, and tells what is wrong in plain language.

The package is private to the monorepo and exports its TypeScript source, like the other
packages (see [development](../../docs/development.md#typescript-conventions)). Its interface is
deliberately narrow, bytes in and tokens, slices or messages out, so that a faster
implementation in another language could replace it behind the same shape (ADR 4).

## Use

```ts
import { Tokenizer, TokenKind, unescapeValue } from "@libredi/edifact";

for (const batch of new Tokenizer(bytes)) {
  for (let i = 0; i < batch.length; i++) {
    const kind = batch.kinds[i]; // one of the TokenKind values
    const start = batch.starts[i] as number; // byte offsets in `bytes`
    const end = batch.ends[i] as number;
    if (kind === TokenKind.EscapedText) {
      const value = unescapeValue(bytes, start, end, batch.separators.release);
    }
  }
}
```

- **Tokens**: `ServiceStringAdvice` (UNA), `SegmentTag`, `Text`, `EscapedText`,
  `ComponentSeparator`, `ElementSeparator`, `RepetitionSeparator`, `SegmentTerminator`.
  An empty element or component has no token: two separators in a row say it. A text token is
  always directly followed by a separator token.
- **No tree.** A token is three array cells (kind, start, end), not an object. Tokens come in
  batches of up to 4096 that reuse the same arrays (36 KiB), so memory does not depend on the
  size of the file. Read a batch before asking for the next one, and run one loop at a time:
  they share the batch, and a second loop that starts too early is refused.
- **Nothing is decoded by the tokenizer.** `Text` is a run of bytes; see "Character sets" for
  what reads them. All four character sets of the roadmap, UNOA, UNOB, UNOC and UNOW (UTF-8), keep
  the separators in the ASCII range, so scanning byte by byte is correct for them.
- **Positions**: every token has its byte offsets. Between two tokens, only line breaks and a
  leading UTF-8 byte order mark are skipped. `tokenizer.locate(offset)` gives the line and
  column (1-based, columns count bytes); it reads the input once to build an index of two numbers
  per 64 KiB, then a lookup scans at most one block. Errors do not use it: they carry their own
  position, found by a scan that allocates nothing.
- **Errors**: a `TokenizeError` carries a `code`, the `offset`, `line` and `column`, the number
  of the `segment` (UNB is 1, UNA is 0) and its `tag`. Every token before the problem is
  delivered first, then the loop's next step throws. A loop that stops early never sees the
  error, so a caller that must know whether the file is whole has to read to the end.
- **The input** must be a `Uint8Array` (a Node.js `Buffer` is one), smaller than 2 GiB, and must
  not be modified, resized or detached while a loop is running.

| Code | When |
| --- | --- |
| `INVALID_UNA` | A UNA service character is not an ASCII punctuation mark (a letter, a digit, a space outside the repetition position, a control character or a byte above 0x7E), two of them are the same, or the decimal mark is not `.` or `,`. |
| `UNEXPECTED_END_OF_FILE` | The file ends inside the UNA string, inside a tag, inside a segment, or right after a release character. Any cut file ends this way. |
| `INVALID_SEGMENT_TAG` | A segment does not start with three capital letters or digits followed by the element separator or the terminator. |

The codes are the working names of the [sample corpus](../../samples/edifact/README.md); the
error model of issue #46 may rename them.

## Locate the messages

```ts
import { splitMessages } from "@libredi/edifact";

const stream = splitMessages(bytes);
for (const message of stream) {
  message.start; // from the UNH tag ...
  message.end; // ... to just after UNT (or after the last segment, when UNT is missing)
  message.segmentCount;
  message.closed; // false when the message runs into the next UNH, UNG, UNE, UNZ, UNA or UNB, or the end of the file
  message.ung; // the span of the UNG of its group, or null
  message.interchange; // UNA, separators, syntax identifier and version, character set, UNB, locate()
}
stream.issues; // problems with values, see below (at most maxIssues of them)
stream.issueCount; // ... and how many there were in all
stream.messageCount; // messages handed out so far
```

- **Constant memory.** The splitter keeps no segment: a few numbers whatever the size of the file.
  A slice is a span of the input and the facts of its interchange. A worker can tokenize the span
  with `new Tokenizer(bytes.subarray(start, end))` when the interchange uses the default
  separators; a UNA with other characters cannot be handed over yet, because `Tokenizer` has no
  option to start with a given set of separators.
- **Nothing is checked about the structure.** A message without UNT, a segment outside any
  message, a UNE without UNG are all found as they are; the validator (issues #43 to #45)
  reports them. Segments outside messages (UNB, UNG, UNE, UNZ, loose segments) are not slices.
- **Several interchanges** in one file give slices whose `interchange` differs (`index` 0, 1, ...).
  An interchange starts at UNA or UNB, and ends at UNZ.
- A cut file ends the loop with the tokenizer's `TokenizeError`, after the messages before it.
  A stream reads its input once; a second loop yields nothing.

## Read the tree

```ts
import { parseInterchanges, parseMessages } from "@libredi/edifact";

for (const message of parseMessages(bytes)) {
  for (const segment of message.segments) {
    segment.tag; // "NAD"
    segment.text(2, 1); // component 1 of element 2, as text, or undefined
    const component = segment.component(2, 3);
    component?.position; // { segment: 5, tag: "NAD", element: 2, component: 3 }
    component?.start; // bytes of the value in the input, release characters included
  }
}

const { interchanges, issues } = parseInterchanges(bytes); // the whole file, kept in memory
```

- **A tree of nodes**: `Interchange` (UNA, separators, character set, `items`, UNB, UNZ), `Group`
  (UNG to UNE), `Message` (UNH to UNT), `Segment`, `Element`, `Component`. Each has `start` and
  `end`, the bytes it spans in the input. Elements and components come from `segment.elements`,
  `element.components` and `element.repetitions` (syntax 4: one list of components per repetition;
  one list otherwise; see [Syntax version 4](#syntax-version-4)).
- **Positions** are those of the sample corpus, the registry and the validator: the number of the
  segment in the interchange (UNA is 0, UNB is 1), the tag, and the element and component counted
  from 1. A composite counts as one element and an empty element counts; an empty component stands
  between two separators and has a `start` equal to its `end`. `interchange.locate(offset)` gives
  line and column.
- **Lossless.** The input is kept (`interchange.source`) and every node knows its bytes, so
  nothing of the file is lost: values keep their release characters until `text()` or `bytes()`
  asks for them without, and the bytes between two nodes (the line breaks after a terminator, a
  byte order mark in front of the first segment) are exactly the bytes between their spans.
  [`serialize`](#write) writes the tree back.
- **Nodes are views** on compact typed arrays, made when they are asked for. `segment.elements`
  builds its list on each call: keep it if you read it often. The arrays of a message of a few KB
  take about four times its size, against thirty and more for an object tree.
- **The structure is not judged.** A message without UNT (`unt` is null), a segment outside any
  message (an item of the interchange or of the group, next to messages), a UNE without UNG, a file
  with no UNB or no UNZ all come out as they are; the validator reports them.
- **Values are decoded with the character set of UNB** (`text()`), or as ISO 8859-1 when there is
  none. A value with a character the set does not allow is in the `issues` and still in the tree.
- **`parseMessages`** gives the messages of a file one at a time, each with its own arrays, so a
  message can be kept or dropped on its own. `parseMessages(bytes).items()` gives the messages
  and, between them, the segments that are not in a message (UNB, UNG, UNE, UNZ, loose segments)
  as `Envelope` items, so that a validator that reads a large file message by message still sees
  the envelope and its counts. `parseInterchanges` is the whole file at once, for small files: it
  throws the `TokenizeError` or `ParseError` and returns nothing. An interchange that is only a UNA
  string is an interchange (and an `Interchange` of its own); the stream does not hand out UNA
  strings, which `message.interchange.una` has.
- **`bytes()` is a copy**, even for an input that is a Node.js `Buffer`: writing to it does not
  change the file or the text of other nodes. `message.segments` cannot be changed.
- **A long element is paid for when it is asked for.** `element.components` makes one node for each
  component (about 80 bytes each), and `component.position` finds its repetition by a binary
  search; a million components are fine to read one at a time, not to list at once.

### Memory

- `memoryBudget` (default 64 MiB, from 4096 bytes to 2 GiB) is the most that the arrays of one
  message may use. A message of 9 KB takes 40 KiB, so the default allows messages of about 16 MB.
  The same limit applies to a run of segments that are not in a message (UNB, UNG, UNE, UNZ, loose
  segments). Arrays grow by doubling, up to what fits in the limit. A message that needs more stops
  the parse with a `ParseError` (`MESSAGE_TOO_LARGE`) that says where the message starts.
  `stream.peakWorkingBytes` is the most a message needed. While a message is copied out, the arrays
  and the copy exist together, so the peak of the process is up to about twice the budget.
- `maxTreeBytes` (default 256 MiB) caps the whole tree that `parseInterchanges` keeps. It counts the
  arrays of every message and about 2 KiB of nodes for each message and each run of segments between
  messages: that fixed cost is why the tree is **3.7 times the input for messages of a few KB**, and
  100 times and more for a file of tiny messages (`UNH+1+X'UNT+1+1'` is 16 bytes and costs 1.6 KB).
  A larger tree stops the parse with `TREE_TOO_LARGE`; read such a file with `parseMessages`.
- An element with more than 65,535 repetitions stops the parse with `TOO_MANY_ELEMENT_REPETITIONS`.

| Code of a `ParseError` | When |
| --- | --- |
| `MESSAGE_TOO_LARGE` | One message, or one run of segments outside messages, needs more than `memoryBudget`. |
| `TREE_TOO_LARGE` | The whole tree of `parseInterchanges` needs more than `maxTreeBytes`. |
| `TOO_MANY_ELEMENT_REPETITIONS` | An element has more than 65,535 repetitions. |

The bound is on what the parser holds, not on the input, which the caller has already read into a
`Uint8Array`, and not on the garbage of messages that were delivered and dropped: V8 collects the
arrays of dropped messages when it decides to. The benchmark shows both (live set and free-running
heap).

## Write

Two ways, for two jobs.

```ts
import {
  interchangeData,
  parseInterchanges,
  serialize,
  serializeData,
} from "@libredi/edifact";

// A tree that was parsed is written as it was read.
const result = parseInterchanges(bytes);
serialize(result); // the whole file, byte for byte (always a copy)
serialize(result.interchanges[0]); // one interchange, from its first byte to its last
serialize(message); // one message (UNH to UNT), or an envelope from parseMessages(...).items()

// A tree that is built or edited is described as data and written with the service characters
// and the character set it is given.
const data = interchangeData(result.interchanges[0]); // a parsed tree as plain data, to edit
serializeData({
  segments: [
    { tag: "UNB", elements: [["UNOC", "4"], ["SENDER", "14"], ["RECEIVER", "14"]] },
    { tag: "FTX", elements: ["AAI", [], [], { repetitions: [["ONE"], ["TWO", "2"]] }] },
    { tag: "UNZ", elements: ["1", "REF"] },
  ],
}); // UNA:+.?*'UNB+UNOC:4+SENDER:14+RECEIVER:14'FTX+AAI+++ONE*TWO:2'UNZ+1+REF'
```

- **`serialize(tree)`** takes a `ParseResult`, an `Interchange`, a `Message` or an `Envelope` and
  returns the bytes it was read from. A tree that was parsed has not changed, so nothing is
  rebuilt: the release characters that nobody needed, the line breaks (and how many), a byte
  order mark, a missing UNA string, all come back as they were. A `ParseResult` also holds what is
  between and around the interchanges, so a whole file comes back whatever it holds, even nothing
  but line breaks. It is a copy: the result does not share memory with the input.
- **`serializeData(data, options)`** writes what the data says. `data.segments` is a list of
  `{ tag, elements }`; an element is a value (`"220"`), a list of components (`["UNOC", "4"]`,
  `[]` for an empty element) or `{ repetitions: [[…], […]] }`; a value is a string, which is
  encoded for the character set, or a `Uint8Array`, which is written as it is. Values are
  escaped with the release character wherever they hold a service character; nothing else is
  added, left out or trimmed (a trailing empty element stays). `data.separators`, `characterSet`,
  `una`, `lineBreak` and `bom` are optional:

  | Field | Default |
  | --- | --- |
  | `separators` | what a reader assumes without a UNA string: `:+.? '`, or `:+.?*'` when the UNB announces syntax version 4 as the tokenizer sees it (see below). `declared` is not needed |
  | `characterSet` | the one the UNB names (first component of its first element), else UNOA |
  | `una` | true: the UNA string states the service characters. With `false` they must be those a reader assumes, or the file could not be read back |
  | `lineBreak` | none; CR and LF, written after the UNA string and after every segment |
  | `bom` | false |

  `options.checkCharacters` (default true) checks every value against the character set, as the
  parser does, with the service characters allowed; `options.maxBytes` (default 512 MiB) stops the
  output with `OUTPUT_TOO_LARGE`, before it writes past it. Text that the set cannot hold (the euro
  sign in UNOC, a lone surrogate in UNOW) is always refused.
- **`interchangeData(interchange, { values })`** turns a parsed interchange into such data: a
  copy, with text values and the separators, UNA string, byte order mark and line break of the
  file (the break after the UNA string, or after the first segment if none follows it). The
  character set is left out when the UNB names it, so that an edit of S001 is followed.
  `values: "bytes"` keeps the bytes exactly; text reads a broken UTF-8 sequence of UNOW as U+FFFD.
  Edit the copy and write it. Written without edits it gives the same bytes when the file escapes
  only what it must and uses one line break everywhere, which is true of every valid sample; a file
  that escapes more or mixes line breaks comes back normalised, and `serialize` is the way to keep
  it as it was.

Both write representation and know nothing of what a segment means or whether the interchange is
valid. The one rule they apply is the one the service characters decide: an element can only be
repeated when there is a repetition separator and the UNB announces version 4 (a fragment with no
UNB may repeat). A `SerializeError` has a `code` and a `position` (the segment, counted from 1 as
UNB is in a parsed tree, its tag, and the element and component counted from 1; segment 0 for
a problem with the service characters, the line break or the UNA string):

| Code | When |
| --- | --- |
| `INVALID_TAG` | A tag is not three capital letters or digits, or is `UNA` (written for you). |
| `INVALID_SEPARATORS` | The service characters are not ones a UNA string can state (see `INVALID_UNA`), or `una: false` with characters a reader would not guess. |
| `INVALID_LINE_BREAK` | The line break holds something other than CR and LF. |
| `REPETITION_NOT_ALLOWED` | An element has several repetitions and there is no repetition separator, or the UNB announces a version other than 4. |
| `INVALID_CHARACTER` | A text value has a character the set cannot hold, or a value has a character the set does not allow in data. |
| `OUTPUT_TOO_LARGE` | The output would be larger than `maxBytes`. |

## Syntax version 4

Syntax version 4 adds the **repetition separator**: an element can occur several times in a row,
as in `FTX+AAI+++FIRST NOTE*SECOND:2*THIRD'`, and the seventh character of the UNA string says
which character it is (syntax 3 keeps a space there).

- **Reading.** UNA declares the repetition separator, and the tokenizer uses it. Without a UNA
  string, a UNB that announces version 4 makes the asterisk the repetition separator, which is
  what that version assumes (ISO 9735-1:2002). The tokenizer sees it when the interchange starts
  with `UNB+`, an identifier of at most 32 bytes with no `+`, `?` or `'` in it, `:`, and then `4`
  as a whole component (followed by `+`, `:` or `'`): `UNB+UNOC:4+…` is, `UNB+UNOC:41+…` and
  `UNB+UNOC:3:4+…` are not. It is decided once, at the start of the interchange, before its
  first token, and applies until UNZ: an interchange that has no UNZ, followed by one with a UNB,
  keeps its characters (the splitter does start a new interchange at that UNB). A UNA string
  always wins over what UNB says: `UNA:+.? '` with `:4` has no repetition separator, and
  `UNA:+.?*'` with `:3` has one. A released asterisk (`?*`) is data in both.
- **In the tree.** An element that uses the separator has several `repetitions`, one list of
  components each; `element.components` is the first. It counts once in its segment, and the
  `position.component` of a component is counted within its repetition: the first component of
  every repetition is component 1. An element with an empty repetition (`A**B`) has an empty list
  for it. The parser keeps what is written, whatever the version; it counts at most 65,535
  repetitions in an element.
- **Writing.** `serializeData` writes the separator the data says, escapes it in values, and
  refuses a repetition when there is none or when the UNB announces another version
  (`REPETITION_NOT_ALLOWED`). Whether a reader would see the UNB as version 4 (the rule above) is
  what decides the default characters, so that `una: false` is only accepted for characters the
  reader will in fact assume.
- **`maxOccurs`.** The registry says an element may be repeated `maxOccurs` times and that
  repetition needs syntax version 4, whatever `maxOccurs` says
  ([registry](../../contracts/registry/README.md)). Neither the tokenizer nor the parser enforces
  it: reporting a repetition under syntax 3, or too many repetitions, is validation (#43 to #45).
  The serializer enforces the first half, because it is the service characters that decide it.
- **Service segments.** UNB, UNH, UNT, UNZ, UNG and UNE are the same in versions 3 and 4 as far as
  the engine goes; it reads S001 (identifier and version) from either. The segments that only
  version 4 has (UGH and UGT, UNO and UNP) are ordinary segments to the engine: they are in the
  tree where they stand, loose segments between messages, and are not interpreted.

## Validate

```ts
import { formatIssue, validate } from "@libredi/edifact";

const report = validate(bytes);
report.valid; // no error was found
for (const issue of report.issues) {
  issue.code; // "UNT_COUNT_MISMATCH": stable, switch on it
  issue.position; // { segment: 23, tag: "UNT", element: 1, component: null, repetition: null }
  issue.expected; // "12"
  issue.found; // "13"
  console.log(formatIssue(issue));
  // error UNT_COUNT_MISMATCH at line 23, column 5 (segment 23 UNT, element 1)
  //   UNT gives the number of segments as 13, but the message has 12 (UNH and UNT included).
  //   Hint: Count the segments from UNH to UNT inclusive and write that number in the first element of UNT. ...
}
```

`validate(bytes, { maxIssues, memoryBudget })` reads the file once, a message at a time (the memory
is that of the largest message), and never throws for a problem in the file: a file that stops the
tokenizer ends the check with an issue, and everything delivered before it has been checked. The
report holds the first issues of the file, in file order (at most `maxIssues`, default 1,000;
`issueCount` counts them all), the number of errors and warnings, `valid` (no error), `complete`
(false when the check stopped on an unreadable file, or on a message too large for the budget, so
that what follows was not checked) and how many messages and interchanges were read.

An **issue** answers four questions: what is wrong (`code`, `message`), where (`position`, `line`,
`column`, `offset`), what was expected and found (`expected`, `found`), and what to do about it
(`hint`). It also has a `severity` and the `layer` that found it. The codes are stable, taken from the
[sample corpus](../../samples/edifact/README.md); the messages and hints are English text for people
and may be improved. **[Validation errors](../../docs/validation-errors.md)** is the catalogue: every
code, what it means and what to do. A test keeps that page in step with `ISSUE_CATALOGUE`.

What is checked without a registry:

- **The file**: the UNA string, segment tags, a file that is cut off, the character set of UNB and
  every value against it, a message too large for the memory budget.
- **The envelopes** (ISO 9735): the mandatory data of UNB, UNZ, UNG, UNE, UNH and UNT; the syntax
  version (3 or 4); the number of segments in UNT (UNH and UNT included), of messages in UNE and
  of messages (or of groups, when there are some) in UNZ; the control references that UNT, UNE and
  UNZ repeat from UNH, UNG and UNB; a missing UNT, UNE, UNZ or UNB; a segment outside any message.
  A count is compared as a number (`03` is 3) and one that is not a whole number is
  `INVALID_DATA_TYPE`.
- **One cause, one issue**: when the file stops being readable, what is missing after the cut is not
  reported as well, and a composite that is missing is one issue, not one per component. Text taken
  from the file (a reference, a count) is cut after 32 characters and its control characters are
  shown as `?`, so that a message can go into a log as it is.

### With a registry

```ts
import { validate, type RegistryView } from "@libredi/edifact";

const registry = JSON.parse(readFileSync("d01b.json", "utf8")) as RegistryView; // see docs/registry-generator.md
const report = validate(bytes, { registries: [registry], codeLists: "closed" });
```

A registry is a document that follows [`contracts/registry`](../../contracts/registry/README.md),
generated on the operator's machine from the UN/ECE directories and never committed
([ADR 7](../../docs/adr/0007-standards-licensing.md)). `RegistryView` is the part of it that
validation reads, so this package does not depend on the registry package. The registry that matches
the message identifier of UNH (agency, version, release) is used for each message; a message that
no registry describes is not checked and gets a `MESSAGE_NOT_CHECKED` warning (without
`registries`, nothing is said).

- **Structure** (`MISSING_MANDATORY_SEGMENT`, `TOO_MANY_REPETITIONS`, `SEGMENT_OUT_OF_ORDER`,
  `UNKNOWN_SEGMENT`): the segments of a message against its structure, group by group. The checker
  reads one segment at a time, with a stack of the open groups and no look-ahead, as the structures
  of the directories allow: the next segment alone tells where it belongs. A mandatory segment that
  is missing is reported at the segment found in its place (or at UNT); a group is counted by the
  segment that opens it; a stray segment is one issue and is left out, so that it does not make
  the segments after it look missing.
- **Data elements** (`MISSING_MANDATORY_ELEMENT`, `INVALID_DATA_TYPE`, `VALUE_TOO_LONG`,
  `VALUE_TOO_SHORT`, `UNEXPECTED_ELEMENT`, `UNEXPECTED_COMPONENT`): for each position of a segment,
  a mandatory element or component that is empty, the type of each value (`n`: digits, with a minus
  sign and one decimal mark, the one of the UNA string; `a`: letters; `an`: anything), and its
  length in characters (digits only for a number; an escaped character counts once; in UNOW a
  character counts once, whatever its bytes). A composite that is empty is one issue, and a
  mandatory component is only needed where its composite is. An error on a simple data element has
  `component: null`.
- **Repetition** (`REPETITION_NOT_ALLOWED`, `ELEMENT_REPEATED_TOO_OFTEN`): an element that uses the
  repetition separator under a UNB that is not syntax version 4 (the rule of the registry), or more
  often than `maxOccurs`. `position.repetition` says which repetition, from the second.
- **Code lists** (`UNKNOWN_CODE`): `codeLists: "closed"` (default) enforces the lists that hold every
  valid value, as errors; `"all"` also looks at the open lists, which are only what the directory
  knows, and reports a value they lack as a warning; `"off"` skips them. A code is matched exactly
  (case counts).
- It does not check the envelope data against a registry (UNB, UNG, UNH, UNT, UNE, UNZ have their own
  rules above) or CONTRL.
- **Partner overrides** (below) change the rules of a registry for one flow.

### Partner overrides

```ts
import { applyOverrides, validate, type OverridesView } from "@libredi/edifact";

const report = validate(bytes, { registries: [registry], overrides: [retailer, retailerOrders] });
const forThisFlow = applyOverrides(registry, retailer); // the registry with the rules applied
```

A document of [`contracts/overrides`](../../contracts/overrides/README.md) changes, for one call,
the registry of its directory without editing it: stricter or looser data elements, positions and
composite components made mandatory or conditional, codes added to or removed from a list, lists
opened or closed, cardinalities of segments and groups in a message, and the severity of an issue
code (`error`, `warning`, or `off`, which drops the issue). Documents are applied in order, the last
winning; one for another directory changes nothing but the severities, which are the call's. The
validator judges the changed rules with the code it uses for the directory, so the issues and their
messages are the same ones. `applyOverrides` does not change its arguments and keeps its result for
a pair of objects, so that a service pays once for a flow: do not edit a registry or a document
after it was first used. `overrides` is a list, even for one document. The codes of a file that
cannot be read (layer `tokenizer`) cannot be changed. `OverridesView` is the part of the document
that is read, so this package does not depend on the registry package, whose `validateOverrides()`
and `checkOverrides()` check a document before it is used. [Partner
overrides](../../docs/partner-overrides.md) says what to write.

**Cost.** Checking the structure and every value of the generated orders of the benchmark (80 lines,
8.5 KB) costs about 130 µs per order on top of parsing, see the [benchmark](#benchmark). A definition
that refers to something the registry does not have (which `checkRegistry()` of the registry
package would report) is read as a free element instead of stopping the check.

**Testing against the real directories.** The tests use two registries written by hand for the corpus
(`src/testing/corpus-registry.ts`: invented names, only the segments the samples use, nothing from
the directories). To run the valid samples against registries you generated, give their paths:

```bash
LIBREDI_REGISTRIES=/path/to/d96a.json,/path/to/d01b.json pnpm --filter @libredi/edifact test
```

The test is skipped without it. The samples have never been checked against the real directories, so
a sample that fails there is a finding about the sample or about the registry; fix the sample.

## Acknowledge: CONTRL

```ts
import { acknowledge, correlate, readContrl, sentFrom, validate } from "@libredi/edifact";

// A file came in: validate it and answer each interchange in it.
const { interchanges, report } = acknowledge(bytes, {
  reference: (summary) => nextReference(summary), // the UNB reference of each CONTRL
  validate: { registries }, // optional: structure and data against registries
});
for (const { summary, outcome, contrl, notAnswered } of interchanges) {
  outcome; // "accepted", "partially_rejected" or "rejected"
  contrl; // the CONTRL as bytes, or null: see notAnswered
  notAnswered; // null, "not_requested" (UNB 0031 is not 1) or "no_address" (nobody to answer to)
}

// A CONTRL came in: what does it say, and about which interchange that we sent?
const [ours] = validate(sentBytes, { summary: true }).interchanges;
const sent = [sentFrom(ours)].filter((one) => one !== null); // null: no reference or parties
const { acknowledgements, complete } = readContrl(contrlBytes); // complete: the file was whole
const { correlations, pending } = correlate(acknowledgements, sent);
```

**Writing (#49).** `acknowledge(bytes, options)` validates the file with `summary: true` and builds
one CONTRL per interchange it could read, with `contrl(summary, options)` (or `contrlData`, the
same as data to change before it is written with `serializeData`). The layout is the one of the
CONTRL samples of the corpus, and the generated CONTRL is, byte for byte, the sample for the
interchange it answers (a test for each of the four): `UNB` (sender and recipient swapped, its own
reference, date and time), `UNH` (`CONTRL:D:3:UN` in syntax 3, `CONTRL:4:2:UN` in syntax 4), `UCI`
(the reference, sender and recipient of the interchange answered, and the action), one `UCM` for
each message (reference, identifier, action), `UNT`, `UNZ`.

- **Accepted**: `UCI` action 7 and every `UCM` 7.
- **Partly rejected**: `UCI` 7; a message with an error gets `UCM` action 4, and the others 7. An
  error in the UNH or UNT of the message goes in the `UCM`: the error code, the tag of the segment
  and the position of the element (`element`, or `element:component`). An error in a segment of
  the body is told as ISO 9735 does: a `UCS` with the position of the segment in the message (UNH
  is 1) and, when the segment as a whole is at fault, the error code; when a data element is, a
  `UCS` with the position only and a `UCD` with the error code and the position of the element.
  Only the first error of a message is told.
- **Rejected**: the interchange itself has an error (its UNB, UNG, UNE or UNZ, a file that is cut
  off, an unsupported syntax version): `UCI` action 4, the first error (the tag of the segment is
  said only when it is a service segment), and no `UCM`. A file that is cut off or stops being
  readable rejects the interchange it stopped in; if every interchange before it was whole, it is a
  new one, which is rejected without a record of what it was (`notAnswered: "no_address"`).
- **UNB 0031 is honoured**: a CONTRL is written for an interchange whose UNB asks for one (its ninth
  element, 0031, is `1`; any other value, or none, does not); without that `contrl()` gives null
  and `notAnswered` is `"not_requested"`, unless `always: true`. An interchange whose UNB does not
  say who sent it or who it is for cannot be answered either (`"no_address"`). It is `rejected`
  all the same, and its `summary` is there to log.
- It takes the service characters of the interchange answered, and its character set and syntax
  version unless `characterSet` and `syntaxVersion` say otherwise; the date and time are UTC and
  come from `now`; one line feed follows each segment, as in the corpus (`lineBreak`). Values taken
  from the interchange answered are copied as they came, with `?` for a character that the set of
  the CONTRL cannot hold. The `reference` of the CONTRL and `now` are checked: a reference that the
  set does not allow, or a date that is not one, is a `RangeError`.
- **The error codes** (UCI/UCM/UCS/UCD, `0085`) are in one table, `CONTRL_ERROR_CODES`, with
  `DEFAULT_CONTRL_ERROR_CODE` (12) for an issue the table does not know. **The corpus uses 28
  (references that do not match) and 29 (a control count that does not), and says they are written
  from memory of ISO 9735 and unverified; every other value of the table is also from memory.**
  Nobody has checked them against the standard or a partner's guideline: do it before relying on a
  CONTRL in production, and change the table and the corpus together. The `UCS` and `UCD` layout is
  from memory too, and the four samples have none.

`validate(bytes, { summary: true })` is what feeds it: `report.interchanges` has, for each
interchange, its UNB data (reference, sender, recipient, 0031), whether it was read to its UNZ
(`closed`), its messages (reference, identifier, offsets), how many errors each had and the first
one, which is the one nearest the start of the file. Every issue counts, including those beyond
`maxIssues`. It costs a record for each message, so it is off by default (`interchanges` is empty).

**Reading and correlating (#50).** `readContrl(bytes)` finds the CONTRL messages of a file (the
other messages are left alone, whether they are in a group or not) and gives one
`InterchangeAcknowledgement` for each `UCI`: the reference, sender and recipient it names, its
action and status (`accepted`, `rejected`, `received` for action 8, `unknown`), the error it gives,
and the messages (`UCM`) after it with theirs and with the `segmentErrors` that their `UCS` and
`UCD` give; `outcome` says `accepted`, `partially_rejected` (an accepted interchange with a
rejected message) or `rejected`. A file that is damaged does not throw: what was read before the
damage is returned and `complete` is false. `sentFrom(summary)` keeps what is needed of an
interchange that was sent (null when it has no reference or parties), and
`correlate(acknowledgements, sent)` matches them by reference and by sender and recipient (the
qualifiers are compared when both sides have one), each sent interchange once. A `Correlation` has
the interchange `sent` (null if none matches) and `problems`: `UNKNOWN_INTERCHANGE` (no interchange
sent has this reference), `PARTIES_DIFFER` (the reference is known but the parties are not),
`DUPLICATE_ACKNOWLEDGEMENT` (the interchange was already acknowledged by an earlier CONTRL),
`UNKNOWN_MESSAGE` (the CONTRL names a message the interchange did not have) and
`MESSAGE_NOT_ACKNOWLEDGED` (an accepted interchange whose CONTRL names some messages and leaves
out one it had). `pending` lists the interchanges sent that no acknowledgement named.

## Character sets

UNB names the character set in the first component of S001. The splitter reads that component as
ISO 646 (plain ASCII), which is how the start of UNB is always written, and checks every value
that follows against the set. A problem is an *issue*: it does not stop anything and loses
nothing. `issue.code` is `INVALID_CHARACTER` or `UNSUPPORTED_CHARSET` (the codes of the sample
corpus, which issue #46 may rename), with the offset, line and column, a plain message, and the
position in the terms of the registry (segment, tag, element, component counted from 1).

| Set | Allowed in a value |
| --- | --- |
| UNOA | Level A of ISO 9735: capital letters, digits, space and `. , - ( ) / = ! " % & * ; < > ' + : ?`. Lower case is **not** allowed. |
| UNOB | Every printable ISO 646 character: `0x20` to `0x7E`. |
| UNOC | ISO 8859-1: `0x20` to `0x7E` and `0xA0` to `0xFF`. |
| UNOW | Well-formed UTF-8 (no overlong form, surrogate or code point above U+10FFFF). |

- Control characters are never allowed, C1 (`0x80` to `0x9F`, `U+0080` to `U+009F`) included in
  UNOC and UNOW: a line break **inside** a value is an issue. Line breaks between segments are not.
- The service characters that UNA declares are always allowed, whatever the set.
- A release character comes before a whole character, never inside one: in UNOW, `C3 ? A9` (the
  release character between the two bytes of an "e acute") is an issue, because the check reads the
  bytes as they are written.
- S001 is read once per interchange, from its first repetition. Its first two components, as
  `syntaxIdentifier` and `syntaxVersion`, are kept to 32 characters, with `?` for anything that is not
  printable ASCII and `...` after a cut, so that a hostile file cannot put raw bytes or a megabyte
  of text in a message.
- An unsupported set (UNOD to UNOK, UNOX, UNOY, anything else) gives one `UNSUPPORTED_CHARSET`
  issue; `characterSet` is then null, values are read as ISO 8859-1 and not checked. Without a
  UNB (or without an S001) there is no set and no check.
- `decodeText(bytes, start, end, set)` turns the bytes of a value into text: UNOA, UNOB, UNOC and
  an unknown set as ISO 8859-1, UNOW as UTF-8 with U+FFFD for a broken sequence. Remove the release
  characters first with `unescapeValue`. `checkCharacters: false` skips the check.

## Rules it follows

- UNA gives the six service characters; without it the defaults `:+.? '` apply, with the
  asterisk as repetition separator for a UNB that announces syntax version 4. A UNA string
  may also start a second interchange in the same file; after UNZ the defaults apply again. A
  batch never mixes two sets of separators: it ends before a new, different UNA and after UNZ,
  and `batch.separators` holds the set for the whole batch. The same UNA string repeated does
  not end the batch.
- The release character makes the next byte data, whatever it is: a separator, a line break or
  the release character itself.
- CR, LF and CR LF are skipped between segments, before the first one, after UNA and at the end
  of the file. Inside a segment they are data, which the character set check will judge.
- The repetition separator exists when UNA declares one, or when there is no UNA string and the
  UNB announces syntax version 4 ([details](#syntax-version-4)). Otherwise `*` is plain text.
- A file of 2 GiB or more is refused: offsets are signed 32-bit integers, which V8 reads
  faster.

## Tests

`pnpm --filter @libredi/edifact test` runs:

- every valid sample of the [sample corpus](../../samples/edifact/README.md) against its
  `.expected.json`, written by an independent tool, and every prefix of every sample (a cut file
  ends in `UNEXPECTED_END_OF_FILE` at its last byte, never in anything else);
- every sample once more through the splitter (message counts and sizes, facts of the interchange,
  UNOC and UTF-8 values decoded to the text of the expected-result file, the character issues of
  the invalid samples at the positions of their expected-result files);
- every sample once more through the parser: the tree, read component by component, is the content
  of its expected-result file and what the tokens say; the segment, element and component
  positions and spans agree with the bytes;
- examples for each rule above, including a structure that is not what it should be (no UNT, no
  UNZ, loose segments, groups, several interchanges) and the memory budget (the error, its place,
  the segments outside messages, a 20 MB interchange parsed within 1 MiB);
- [fast-check](https://fast-check.dev) properties: any bytes survive escaping, a released byte
  never acts as a separator, an interchange written from a model is tokenized exactly as laid
  out for any legal separators and line breaks, several interchanges in one file keep their own
  separators, the result does not depend on the batch size, every byte is covered by a token or
  is a skipped line break, and `locate` agrees with a plain scan; messages written from a model
  (with or without UNT, in groups or not) are found where they were written; a value is reported
  if and only if it has a byte its character set does not allow; a tree written from a model has
  the segments, elements, repetitions, components, positions and spans of the model, and says
  what the tokens say; the same messages come out of `parseMessages` and `parseInterchanges`,
  whatever the batch size; arbitrary bytes parse into a consistent tree or stop with the
  tokenizer's error;
- every valid sample once more through the serializer: parse then `serialize` is byte-identical
  (the file, and each interchange), the messages and envelopes put end to end give the segments of
  the file (without its line breaks), and the tree written as data with `serializeData` gives the
  same bytes, with text values and with byte values; the five syntax 4 samples also parse to the
  same tree without their UNA string;
- CONTRL: the CONTRL generated for each interchange the four CONTRL samples answer is the sample, byte
  for byte; the file it makes validates and reads back as what it says; UNB 0031, no UNB, no
  address, syntax and character set (a value the set cannot hold is replaced, not an exception),
  date formats, the first error at each level, `UCS` and `UCD` for the errors of a body; the
  summary of a validation (attribution of errors to messages, including issues beyond `maxIssues`,
  a message without UNT, a file cut off in the first or the second message or interchange, several
  interchanges in a file, 20,000 messages without UNT in a time that does not grow with their
  number); reading the four samples, several interchanges in one CONTRL, a CONTRL in a group and a
  damaged one; correlation (matches, unknown, other parties, qualifiers, twice, messages named and
  forgotten, pending, 20,000 at once); a property that `acknowledge` never throws on a mutilated
  sample and that what it writes reads back;
- the validator with a registry: all 24 valid samples have no error and all 17 invalid samples give
  exactly their expected code and position, against the corpus registries; examples for each
  structure rule (missing, too often, out of order, unknown, groups, a message with no UNT), each
  data rule (type, length, escapes and non-ASCII, composites, extra elements and components, code
  lists in each mode, repetition in syntax 3 and 4), and the fictitious registry of
  `contracts/registry/examples`; an opt-in test of the valid samples against real registries;
- the validator: every valid sample has no issue, every invalid sample that needs no registry gives
  exactly its expected code and position, envelope examples for each rule and error (counts,
  references, groups, missing segments, a file cut at every point of a segment), the report
  (order, limit, formatting), and the catalogue (its text, the corpus codes it covers, and the page
  `docs/validation-errors.md`, which is written from it: `LIBREDI_UPDATE_DOCS=1` rewrites it);
- the serializer's own examples (escapes with other service characters, empty elements and
  components, each character set, each error and its position, the output limit, an edited
  interchange) and fast-check properties: a parsed file comes back byte for byte whatever the
  service characters, line breaks, byte order mark and number of interchanges; `serializeData`
  writes exactly the bytes of the independent writer of the tests for any model, including
  repetitions and interchanges that announce syntax version 4 without a UNA string; the bytes it
  writes are read back as the same data and written again as the same bytes; and text of each
  character set, outside ASCII too, comes back as the same text;
- syntax 4: the asterisk becomes a repetition separator in exactly the cases listed above (versions,
  identifier length, UNA winning, one decision per interchange, any batch size), and the plain
  tokenizer agrees on arbitrary interchanges of that kind and on thousands of random starts of UNB
  around the 32-byte and `:4` boundaries;
- a second, deliberately plain tokenizer (`src/testing/reference.ts`, one byte at a time, no
  tables, no batches) and a second, plain splitter on top of it (`src/testing/split-reference.ts`)
  that must give the same tokens, separators, errors, messages, interchange facts and issues on
  arbitrary bytes, on random envelopes and on real samples that are cut, bent, joined or have a
  byte changed.

## Benchmark

```bash
pnpm --filter @libredi/edifact bench               # about 10 MB, 15 runs
pnpm --filter @libredi/edifact bench -- --sweep    # also compare batch sizes
pnpm --filter @libredi/edifact bench -- --size-mb=100 --runs=5 --no-baseline  # memory does not grow
```

It generates a deterministic ORDERS interchange (1,087 orders of 80 lines, 443,498 segments,
9.25 MB, the shape measured in [languages](../../docs/research/languages.md)) and prints
throughput and memory. MB means 10^6 bytes. There is no threshold yet: issue #54 adds fuzzing
and a regression check in CI.

Measured on 2026-10-24, Node.js 26.12.1, AMD EPYC 9R45 (one core of a shared cloud machine, on a
quiet moment; runs agree within 5 %, but expect other machines to differ):

| What | Result |
| --- | --- |
| Tokenizer, counting tokens | 419 MB/s, 173 million tokens/s |
| Tokenizer, reading every token | 294 MB/s, 14 million segments/s |
| Tokenizer, also making a string of every tag and value | 261 MB/s |
| `splitMessages`, with the character check | 162 MB/s, 19,000 orders/s, 53 µs per 8.5 KB order |
| `splitMessages`, without the character check | 209 MB/s (the check adds about 28 % to the time) |
| `parseMessages`, building every message | 126 MB/s, 14,500 orders/s, **68 µs per 8.5 KB order** (3.4 % of the 2 ms budget of ADR 10) |
| `validate`, the file and its envelopes | 125 to 126 MB/s, 14,700 orders/s, **68 µs per order**: 4 µs more than parsing, 3.4 % of the 2 ms budget (measured on a quieter moment than the rows around it, where `parseMessages` ran at 133 MB/s) |
| `validate` with `summary: true`, the count and first error of each interchange and message | 122 MB/s, 14,300 orders/s, **70 µs per order**: under 2 µs more than `validate` (measured on a busy machine, load average 43 to 57, where the two rows differ by about 2 %) |
| `acknowledge`, that validation and the CONTRL, with one `UCM` for each of the 1,087 orders | 115 MB/s, 13,500 orders/s, **74 µs per order**: writing the CONTRL (about 7 KB) is not on a hot path, once per interchange, and below the noise of the row above |
| `validate` with a registry, the structure and every value | 43 to 44 MB/s, 5,050 to 5,150 orders/s, **195 to 198 µs per order**: about 131 µs more than parsing, 10 % of the 2 ms budget (a registry of the corpus: 20 segments, 80 lines of orders) |
| ... and visiting every segment, element and component | 86 MB/s, 10,000 orders/s |
| ... and reading every value as text | 31 MB/s, 3,600 orders/s, 277 µs per order |
| `parseInterchanges`, the whole file as one tree | 126 MB/s |
| `serialize`, a parsed tree | a copy of its bytes: 39 to 47 GB/s, the speed of memory |
| `serializeData`, one 8.5 KB order from text values | 7,800 to 8,000 orders/s, **125 to 128 µs per order** (6 % of the 2 ms budget of ADR 10) |
| ... from byte values | 10,000 to 10,700 orders/s |
| Parse an order, `interchangeData`, `serializeData` (the edit path) | 1,140 to 1,230 orders/s, 0.8 to 0.9 ms per order (about 42 % of the budget); most of it is making the data from the views |
| One tokenizer per 8.5 KB order | 31,000 to 34,000 orders/s, 30 to 32 µs per order |
| One tokenizer per 0.5 KB order | 360,000 orders/s, 2.8 µs per order |
| Memory of the tokenizer | 36 KiB while scanning, 9 MB or 90 MB of input alike |
| Memory of `splitMessages` | nothing held but the envelope; 0.5 MiB sampled for 9 MB of input and 3 MiB for 92 MB, all of it garbage of slices not yet collected |
| Memory of `parseMessages` | the arrays of one message: **40 KiB** for an 8.5 KB order, which is the bound; 1.4 to 2 MiB live (collected every 64 messages) for 9 MB and for 92 MB of input alike; left to V8, the heap reaches 33 MiB and 72 MiB, which is the garbage of messages that were delivered and dropped |
| Memory of `parseInterchanges` | the whole tree: **3.7 times the input** for orders of 8.5 KB (34 MB for 9.25 MB, 342 MB for 92.5 MB); **102 times** for a file of 16-byte messages, whose fixed cost is 1.6 KB each |
| Object tree (baseline, not used) | 42 to 49 MB/s, 320 MB retained for 9.25 MB (34.6 times the input) |

At 92.5 MB (`-- --size-mb=100`) `parseMessages` runs at 121 MB/s, 14,300 orders/s and 70 µs per
order, with the same 40 KiB bound. `parseInterchanges` falls to 39 MB/s there, because it builds
342 MB of arrays (and needs `maxTreeBytes` raised above its default of 256 MiB): for a file of that
size, loop over `parseMessages`.

Syntax version 4 without a UNA string costs the tokenizer one test per interchange, made before its
first token. Against the tokenizer of `main`, three alternating runs each: counting tokens 419 to
420 MB/s before and 410 to 415 after, reading every token 293 to 294 before and 291 to 293 after,
`splitMessages` 160 to 163 before and after, `parseMessages` 122 to 127 before and 126 to 128
after. One scenario moved for no reason I found: "one tokenizer per 8.5 KB order" runs at 285 to
289 MB/s on `main` and 263 to 267 on this branch inside the benchmark, whereas a stand-alone loop
of the same work gives 437 and 438 MB/s (six alternating runs each). The cost of the test is a
few comparisons per tokenizer, so I read that row as a difference in what the engine had
optimised by the time it got there, not as 2.5 µs of work.

The floor on the same machine, a loop that only looks every byte up in a table, is 2.5 GB/s. The
flat scanner of the language study reached 737 MB/s on Node 24 but only counted segments; this
tokenizer also writes the 3.8 million tokens of the file. Against the object tree it is 6 to 7
times faster, and still 6 times faster when it also builds a string for every value, as the tree
does. Building the tree costs about 40 µs per order on top of the 30 µs of tokenizing; the null
checks that let the splitter share its loop with the tree cost it about 7 %; walking it
through nodes costs more than building it, because every node is made on demand: a consumer that
reads a few values pays for a few. What was tried to get here, with the same benchmark: one table
lookup per byte instead of three for the byte that ends a value (+16 %), signed instead of unsigned
offsets (+3 to 5 %), one allocation for the three arrays and arrays sized to small inputs (a 0.5 KB
order went from 71 to 177 MB/s), a character table made once per interchange instead of looked up
for every value (the check went from 40 % to 23 % of the time of the splitter), `component(e, c)`
and `element.components` without the lists and nodes they do not need (visiting every node went from
34 to 85 MB/s); `bytes.length` as the loop bound was slower and was dropped.
