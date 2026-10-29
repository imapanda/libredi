# @libredi/cli

The `libredi` command line program. Today it has two commands:

| Command | What it does |
| --- | --- |
| `libredi inspect <file>` | Shows the interchanges, messages and segments of an EDIFACT file and what is wrong with it, as text or as JSON ([#52](https://github.com/imapanda/libredi/issues/52)) |
| `libredi registry build` | Builds the EDIFACT definition registry from the UN/ECE directories ([Registry generator](../../docs/registry-generator.md)) |

```bash
pnpm --filter @libredi/cli libredi inspect orders.edi
pnpm --filter @libredi/cli libredi inspect orders.edi --json --registry ~/.local/share/libredi/registry
cat orders.edi | pnpm --filter @libredi/cli libredi inspect - --no-tree
```

`libredi` is also the `bin` of the package, which pnpm links inside the workspace. There is no
build step yet, so it is not installable outside it: Node.js does not strip types from a package
under `node_modules`, and bundling the program is for the release work. Run `libredi --help` or
`libredi inspect --help` for the options.

Started through pnpm, a relative path (the file, `--registry`) is relative to the folder where pnpm
was run (`INIT_CWD`), not to `packages/cli`; started with `node` directly, to the working directory.

## Where it lives

A package of its own, `packages/cli`, and not the registry generator or the EDIFACT engine:

- `@libredi/edifact` stays a library with no program and no file access (it works on bytes).
- `@libredi/registry` has `runCli`, the code of `libredi registry build`. It stays there and is
  exported as `@libredi/registry/cli`; the program here hands it the arguments that follow
  `registry`. Its own `libredi` script still works.
- This package depends on both, reads files, and is where the next commands (`validate` against a
  partner's rules, `ack`, `translate`) will go, one file for each.

`run(argv, context)` returns the exit status instead of exiting, and takes what it touches
(environment, output, standard input) in `context`, so the tests run the program in memory.

## `libredi inspect`

```text
libredi inspect <file> [options]
```

`<file>` is the EDIFACT file, or `-` for standard input. The file is read whole, then checked and
shown message by message; nothing is written or sent.

| Option | Meaning |
| --- | --- |
| `--json` | One JSON document instead of text (see below) |
| `--registry <path>` | A registry of [`contracts/registry`](../../contracts/registry/README.md) to check the messages against: a JSON file, or a folder of them such as the one `libredi registry build` writes (its `.json` files, links included, not hidden ones). Repeat for several. Without one, only the file and its envelopes are checked: there is no default registry, so that the result does not depend on the machine |
| `--overrides <path>` | A document of [partner overrides](../../docs/partner-overrides.md) ([`contracts/overrides`](../../contracts/overrides/README.md)): the rules a partner changes, applied on top of the registry of its directory, which a `--registry` must give. Repeat for several, the last one winning. Each is checked against its schema and against the registry as the documents before it leave it; one that is not valid, or names what that registry does not have, is refused (exit status 3, up to three problems shown). Rules about a directory need its `--registry`; a document of severities alone does not. A file named twice is applied twice, where it was named |
| `--no-tree` | Leave out the segments; the interchanges and messages are still listed |
| `--max-issues <n>` | Most issues to list; all are counted. Default 1000 |
| `--memory-budget <n>` | Most memory, in bytes, for the arrays of one message (4,096 to 2^31). Default 64 MiB. A message that needs more is reported as `MESSAGE_TOO_LARGE` and the check stops there |
| `--code-lists <mode>` | `closed` (default: the lists that hold every valid value), `all` (open lists too, as warnings) or `off` |
| `-h`, `--help` | Show the help |

What is checked is what [`validate`](../edifact/README.md#validate) checks, with the same codes and
messages ([Validation errors](../../docs/validation-errors.md)). A registry is checked against its
schema and its rules before it is used; two registries for one directory (`D.96A`) are refused, and
a file named twice is read once.

### Exit status

| Status | Meaning |
| --- | --- |
| 0 | The file has no error. Warnings do not count |
| 1 | The file has errors, or holds no interchange (an empty file) |
| 2 | The command line is wrong: no file, two files, an unknown option, a value that is not valid |
| 3 | The file, standard input, a registry or a document of overrides cannot be read, or is not valid |
| 4 | Something else went wrong: the output cannot be written (a full disk), or a bug |

Messages for 2, 3 and 4 go to standard error, prefixed `libredi:`, with nothing sensible on standard
output (the help of `--help` aside); a value of the file or a path in them is shown with its control
characters as `?`. For 0 and 1 everything goes to standard output, the same way whether the file is
valid or not. If the reader of standard output closes the pipe early (`libredi inspect big.edi |
head`), the program stops quietly with status 0.

### The text

The verdict and the issues come first, so that they are on the screen for a large file, then the
contents. Segments are numbered as in the issues (UNB is 1), and each value is shown as
`position=value`, with `:` between components and `*` between repetitions; an empty element is left
out, so `3=...` after `1=...` means the second was empty. Values are shown as they are decoded,
with their release characters removed, and a control character is shown as `?`.

```text
orders.edi: 280 bytes, 1 interchange, 1 message
Result: not valid (1 error)
No registry: only the file and its envelopes were checked (see --registry).

Issues
error UNZ_REFERENCE_MISMATCH at line 13, column 7 (segment 12 UNZ, element 2)
  UNZ closes interchange IC999999, but UNB opened interchange IC000001.
  Hint: Write the interchange control reference of UNB (its fifth element) as ...

Contents
Interchange 1: IC000001, 9520000000011:14 -> 9520000000035:14 (syntax UNOA:3, UNA string)  [1 error]
    1  UNB  1=UNOA:3  2=9520000000011:14  3=9520000000035:14  4=301015:0830  5=IC000001
  Message 1: ORDERS D.96A (UN), reference 1, 10 segments
    2    UNH  1=1  2=ORDERS:D:96A:UN:LBR001
    3    BGM  1=220  2=PO-0001  3=9
   12  UNZ  1=1  2=IC999999
```

When the file holds CONTRL messages, a last section, `Acknowledgements (CONTRL)`, says for each
interchange they name whether it was accepted, partly rejected or rejected, and the error of each
rejected message ([`readContrl`](../edifact/README.md#acknowledge-contrl)).

The contents do not show how groups (UNG to UNE) or the segment groups of a message nest; the issues
say where a segment is wrong. Everything taken from the file is shown with control characters, line
and paragraph separators and bidirectional overrides as `?`, in the issues too.

### The JSON

One document, written as the file is read and ending with a line break. `schemaVersion` is 1; a
change that breaks a reader increases it, and adding a field does not. Offsets are in bytes from the
start of the file, and `end` is the offset after the last byte, so `bytes.slice(start, end)` is the
segment or message.

| Field | Content |
| --- | --- |
| `schemaVersion`, `file`, `bytes` | The version of this layout, the file name given (`<stdin>` for `-`) and its size |
| `valid` | True when there is no error and at least one interchange: the exit status is 0 |
| `complete` | False when the check stopped before the end of the file (a cut-off file, a bad UNA string, a message too large for the memory budget); the issue says why |
| `counts` | `interchanges` (as many as `interchanges` below: one that could not be read counts), `messages`, `issues`, `errors`, `warnings`: all of them, including the issues beyond `--max-issues` |
| `registries` | The directories checked against, such as `D.96A (UN)`; empty without `--registry` |
| `overrides` | The documents of overrides applied, in order, as `{ file, name }` (`name` is null when the document has none); `[]` without `--overrides` |
| `issues` | The first issues in file order, as `validate` gives them: `code`, `severity`, `layer`, `position` (`segment`, `tag`, `element`, `component`, `repetition`), `expected`, `found`, `message`, `hint`, `offset`, `line`, `column` |
| `interchanges` | One object for each interchange, below |
| `acknowledgements` | What the CONTRL messages of the file say, as [`readContrl`](../edifact/README.md#acknowledge-contrl) gives them; `[]` for a file with none |

An interchange has `index` (from 0), `reference`, `sender` and `recipient` (`id`, `qualifier`,
`address`, or null), `syntaxIdentifier`, `syntaxVersion`, `characterSet`, `una`,
`acknowledgementRequest` (UNB 0031 is 1), `closed` (read to its UNZ), `errorCount`, `firstError`
(`code`, `segment`, `tag`, `element`, `component`, `offset`, or null) and `messages`. An interchange
with no readable UNB, or none at all, has null for what it could not give.

A message has `number` (from 1 in its interchange), `reference`, `type`, `version`, `release`,
`agency`, `associationCode` (the parts of the UNH identifier), `firstSegment`, `start`, `end`,
`errorCount`, `firstError` and, unless `--no-tree`, `segmentCount` and `segments`.

A segment has `number`, `tag`, `start`, `end` and `elements`: for each element, in order, its
repetitions (one unless the interchange repeats elements, syntax version 4), and for each
repetition its components as text. The position of an element is its index plus 1. An empty
element is `[[]]`; an empty component of a composite is `""`.

The segments between messages (UNB, UNG, UNE, UNZ and any segment outside a message) are not in the
JSON: the facts of the interchange stand for them.

### Limits

The file is read into memory whole, as the engine works on bytes, and the check keeps a record for
each message so that the contents can say which ones have errors. That costs a multiple of the
size of the file: measured on a file of 200,000 small orders (28 MB), the peak was about 250 MB with
the output to a file, whatever the format. The output itself is not kept: it is written in blocks of
64 KiB, and the program waits for the reader between two blocks, so a slow reader slows it down
instead of filling its memory. A message is read whole, as in the engine, and is bounded by
`--memory-budget`; a single message of millions of segments takes memory in proportion. Use
`--no-tree` for a file whose segments you do not need. A file of 2 GiB or more cannot be read.

The generated file of the [benchmark](../edifact/README.md#benchmark) (1,087 orders, 443,498
segments, 9.25 MB), measured with Node.js 26.12.1 on a quiet moment of a shared cloud machine,
output to `/dev/null`:

| Command | Time | Peak memory |
| --- | --- | --- |
| `inspect --no-tree` | 0.17 s | 121 MB |
| `inspect --json` | 0.68 s | 146 MB |
| `inspect` (text, every segment) | 0.91 s | 187 MB |

## Tests

`pnpm --filter @libredi/cli test` runs:

- every valid and invalid sample of the [sample corpus](../../samples/edifact/README.md) through
  `inspect`: the exit status, the JSON against the `.expected.json` of the sample (interchange,
  messages, every segment and value, the offsets, what a CONTRL says), the expected issues with their
  positions, with and without the hand-written registries of the corpus written to a folder as
  `libredi registry build` would;
- the command line (each usage error, a file that cannot be read, each way a registry can be
  unusable, relative paths), the text and JSON layouts, a file cut off, an empty file, values that
  would act on a terminal (in the text, in an issue, in a file name, on standard error), a memory
  budget, and 3,000 messages written in blocks, waiting for a slow reader and giving up when it
  fails;
- the program as a process: the five exit statuses, standard input, a closed pipe and a full disk.

The tests use only the fictitious registries of the corpus; no UN/EDIFACT directory is downloaded or
committed ([ADR 7](../../docs/adr/0007-standards-licensing.md)).
