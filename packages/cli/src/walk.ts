import {
  type InterchangeSummary,
  type MessageSummary,
  ParseError,
  parseMessages,
  type Segment,
  TokenizeError,
} from "@libredi/edifact";

/*
 * What `inspect` shows, in file order, as events that the text and the JSON writers turn into
 * output: the interchanges and messages come from the summary of the validation, and the segments
 * from a second, streaming read of the file, one message at a time, so that no output needs the
 * whole tree in memory.
 */

export type Event =
  | { readonly kind: "interchange"; readonly interchange: InterchangeSummary }
  | {
      readonly kind: "message";
      /** Counted from 1 in its interchange. */
      readonly number: number;
      readonly message: MessageSummary;
      /** The segments, UNH to UNT; null without the tree. */
      readonly segments: readonly Segment[] | null;
    }
  /** The segments between messages: UNB, UNG, UNE, UNZ, and any segment outside a message. */
  | { readonly kind: "segments"; readonly segments: readonly Segment[] };

export function* walk(
  bytes: Uint8Array,
  interchanges: readonly InterchangeSummary[],
  tree: boolean,
  memoryBudget?: number,
): Generator<Event> {
  if (!tree) {
    for (const interchange of interchanges) {
      yield { kind: "interchange", interchange };
      for (const [i, message] of interchange.messages.entries()) {
        yield { kind: "message", number: i + 1, message, segments: null };
      }
    }
    return;
  }
  const byIndex = new Map(interchanges.map((interchange) => [interchange.index, interchange]));
  const numbers = new Map<number, number>();
  let announced = 0;
  // An interchange is announced when the first thing in it is read, and the ones that no item came
  // from (a file that stops before its first message) at the end.
  function* announce(upTo: number): Generator<Event> {
    while (
      announced < interchanges.length &&
      (interchanges[announced] as InterchangeSummary).index <= upTo
    ) {
      yield { kind: "interchange", interchange: interchanges[announced++] as InterchangeSummary };
    }
  }
  try {
    for (const item of parseMessages(
      bytes,
      memoryBudget === undefined ? {} : { memoryBudget },
    ).items()) {
      const at = item.interchange.index;
      yield* announce(at);
      if (item.kind === "message") {
        const number = (numbers.get(at) ?? 0) + 1;
        numbers.set(at, number);
        const message = byIndex.get(at)?.messages[number - 1];
        if (message !== undefined) {
          yield { kind: "message", number, message, segments: item.segments };
        }
      } else {
        yield { kind: "segments", segments: item.segments };
      }
    }
  } catch (error) {
    // The validation has the issue; what was read before it is shown.
    if (!(error instanceof TokenizeError || error instanceof ParseError)) {
      throw error;
    }
  }
  yield* announce(Number.POSITIVE_INFINITY);
}
