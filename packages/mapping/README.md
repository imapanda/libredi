# @libredi/mapping

Runs the mappings of [`contracts/mapping`](../../contracts/mapping/README.md): it turns one input
document into one output document, following the evaluation rules of that page. Mappings may be
drafted by an AI assistant and run in a hosted service for many customers, so the runner is a
sandbox ([ADR 6](../../docs/adr/0006-declarative-mappings-with-jsonata.md)): no function that runs
text as code or reads the clock, and limits on time, recursion depth, sequence length and memory.

It has two layers, so that the browser preview runs exactly what the translator runs
([ADR 10](../../docs/adr/0010-service-boundaries-and-communication.md)):

| Import | Runs in | What it does |
| --- | --- | --- |
| `@libredi/mapping` | Anywhere: no Node.js API | `compileMapping` parses the expressions once and maps documents; `diffJson` compares an output with a fixture |
| `@libredi/mapping/pool` | Node.js | `createMappingPool` runs the same code in worker threads that it can terminate, with a heap limit |

```ts
import { compileMapping } from "@libredi/mapping";
import { createMappingPool } from "@libredi/mapping/pool";

const output = await compileMapping(mapping).run(input); // the browser preview

const pool = createMappingPool({ size: 4, limits: { timeoutMs: 500 }, memoryMb: 128 });
const same = await pool.run(mapping, input); // the translator
await pool.close();
```

Both throw a `MappingError` with a `code`, a `message`, the output `field` being computed (such as
`lines[2].unit`) and the `position` in the expression when JSONata gives one. Nothing partial is
kept. `libredi test <mapping>` runs the fixtures of a mapping with the pool
([CLI](../cli/README.md#libredi-test)).

## What a mapping cannot do

| Limit | Default | Enforced by | Code |
| --- | --- | --- | --- |
| `$eval`, `$now`, `$millis`, `$random`, `$shuffle` | refused | the compiler, which looks in the syntax tree for those the expression reads without binding them itself, even in a branch never taken; they are also replaced by functions that throw when reached | `UNAVAILABLE_FUNCTION` |
| Time for one document | 1,000 ms (`timeoutMs`) | JSONata, between two steps of an evaluation, and the runner between two fields; the pool terminates a worker that has not answered 100 ms (`graceMs`) after the limit | `TIMEOUT` |
| Recursion depth | 500 nested evaluations (`maxDepth`), about 100 levels of a recursive function | JSONata | `TOO_DEEP` |
| Sequence length | 1,000,000 items (`maxSequence`), ranges `[1..n]` included | JSONata | `TOO_LONG` |
| Padding added by `$pad` | 100,000 characters (`maxPadLength`) | the runner's own `$pad`, the same as JSONata's otherwise | `TOO_LONG` |
| Length of a string | 1,000,000 characters (`maxStringLength`) | a check of the result of every step of an evaluation, and the runner's own `$join`, which checks before it builds | `TOO_LONG` |
| Heap of a worker | 128 MiB (`memoryMb`) | `resourceLimits.maxOldGenerationSizeMb` of the worker | `OUT_OF_MEMORY` |

An expression that does not parse is `INVALID_EXPRESSION`, one that fails (`$error`, a number that
is not one) `EXPRESSION_FAILED`, and a worker that stops for another reason `WORKER_FAILED`.

The time limit of the pure layer is checked between two steps: a single step that never ends, such
as a regular expression that backtracks (`$match(s, /(a+)+$/)`), is stopped only by the pool. Use
the pool for anything that is not a preview.

The memory limit is enforced by V8 as the heap grows. One allocation larger than what is left of
the limit plus 16 MiB makes V8 abort the whole process, not just the worker; this is how Node.js
worker threads are built. The ways found for an expression to make such an allocation from a
small input are capped: ranges and sequences by `maxSequence`, `$pad` by `maxPadLength`, a string
that doubles with `&` and `$join` of the same string many times by `maxStringLength`. The guard is
a list of known paths, not a proof: a document of hundreds of megabytes, or a function not yet
found, could still get there. The translator must bound the size of what it is given, and runs as
a service of its own whose crash restarts it; running each worker in a process of its own would
close the gap, at about 40 MiB per worker instead of 16.

## Choices

- **Expressions are compiled once** per mapping and per worker (the pool keeps the last 256 mappings
  in each worker), then evaluated with the input, `$root`, `$lookups` and `$index` as bindings.
- **The items of a `forEach` are mapped one after the other**, so that the error reported is always
  that of the first failing item. The reference evaluator maps them side by side; the output is the
  same.
- **The pool reads a mapping when first given** and keeps it as JSON for its workers: changing the
  object afterwards changes nothing.
- **The time of a document is counted from the moment its worker has loaded its code**, so that
  starting a worker does not eat into the limit of the first document.
- **A field named `__proto__`** is a field like another (the output is built with
  `Object.fromEntries`).

## Equivalence with the reference evaluator

[`reference-evaluator.ts`](../contracts/src/reference-evaluator.ts) in `@libredi/contracts` is the
executable statement of the evaluation rules. The tests check that this runner gives the same
output, property order included, for every fixture of the examples, for one small mapping per rule,
and for 200 random inputs to each example; and that both fail on the same inputs.

## Throughput

`pnpm --filter @libredi/mapping bench` maps the inputs of the two examples, with their lists of
lines made longer, on the main thread and through the pool. Measured with Node.js 26.12.1 on an
AMD EPYC 9R45 cloud machine (16 cores, load average under 1), in documents per second:

| Mapping | Lines | Input | Main thread | Pool of 1 worker | Pool of 4 workers |
| --- | --- | --- | --- | --- | --- |
| order to CSV rows | 3 | 0.7 KB | 12,433 | 9,920 | 38,177 |
| CSV rows to order response | 3 | 1.0 KB | 9,750 | 8,000 | 30,087 |
| order to CSV rows | 20 | 3.2 KB | 1,917 | 1,728 | 6,844 |
| CSV rows to order response | 20 | 6.4 KB | 1,867 | 1,691 | 6,618 |
| order to CSV rows | 80 | 12.0 KB | 483 | 436 | 1,781 |
| CSV rows to order response | 80 | 25.7 KB | 517 | 460 | 1,756 |

The cost grows with the number of fields evaluated: about 2 microseconds per field and item, of
which about 5 % is the check of string lengths. The pool costs about 10 % over the main thread
(copying the input and the output between threads) and scales with the workers. Against the
objective of ADR 10, about 500 typical orders per second per core end to end, mapping alone takes
all of a core for an order of 80 lines and about a third of it for 20 lines; parsing is measured in
the [EDIFACT benchmark](../edifact/README.md#benchmark).

## Tests

`pnpm --filter @libredi/mapping test` runs the equivalence tests above, each rule of the evaluation,
each limit (a runaway recursion stopped by the time limit, a backtracking regular expression stopped
by terminating its worker while the next document goes on, a deep recursion, a long sequence, a
huge padding, a string that doubles, a long join, a worker over its heap), `$eval` and the other
functions refused even when renamed, and the JSON comparison of the fixtures.
