import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AcknowledgeOptions,
  acknowledge,
  CONTRL_ERROR_CODES,
  type ContrlOptions,
  contrl,
  contrlData,
  correlate,
  DEFAULT_CONTRL_ERROR_CODE,
  type InterchangeSummary,
  ISSUE_CODES,
  outcomeOf,
  readContrl,
  type SentInterchange,
  sentFrom,
  validate,
} from "./index.ts";
import { readSample } from "./testing/corpus.ts";
import { corpusRegistries } from "./testing/corpus-registry.ts";
import { bytesOf, textOf } from "./testing/helpers.ts";

const NOW = new Date("2030-10-15T08:30:00Z");

/** The CONTRL samples, each with the interchange it answers and the reference it was given. */
const ANSWERS = [
  [
    "contrl-s3-unoa-accepted",
    ["valid", "orders-d96a-s3-unoa-multi-message"],
    "IC000119",
    "accepted",
  ],
  ["contrl-s4-unow-accepted", ["valid", "orders-d01b-s4-unow-utf8"], "IC000120", "accepted"],
  ["contrl-s3-unoa-rejected", ["invalid", "unz-reference-mismatch"], "IC000121", "rejected"],
  [
    "contrl-s3-unoa-partially-rejected",
    ["invalid", "unt-count-mismatch"],
    "IC000122",
    "partially_rejected",
  ],
] as const;

const summaryOf = (bytes: Uint8Array): InterchangeSummary => {
  const [summary] = validate(bytes, { summary: true }).interchanges;
  if (summary === undefined) {
    throw new Error("no interchange");
  }
  return summary;
};

describe("a CONTRL written from what a validation found", () => {
  it.each(ANSWERS)(
    "%s is what is written for the interchange it answers",
    (name, [where, original], reference, outcome) => {
      const bytes = readSample(where, original);
      const [answer] = acknowledge(bytes, { reference, now: NOW, always: true }).interchanges;
      expect(answer?.outcome).toBe(outcome);
      expect(textOf(answer?.contrl ?? new Uint8Array())).toBe(textOf(readSample("valid", name)));
    },
  );

  it("is a file that validates, with a registry or without, and reads back as what it says", () => {
    for (const [name, [where, original], reference, outcome] of ANSWERS) {
      const [answer] = acknowledge(readSample(where, original), {
        reference,
        now: NOW,
        always: true,
      }).interchanges;
      const written = answer?.contrl ?? new Uint8Array();
      expect(validate(written).issues, name).toEqual([]);
      expect(validate(written, { registries: corpusRegistries }).issues.map((i) => i.code)).toEqual(
        ["MESSAGE_NOT_CHECKED"],
      );
      const [read] = readContrl(written).acknowledgements;
      expect(read?.outcome).toBe(outcome);
    }
  });

  it("answers only an interchange whose UNB asks for it (0031 is 1), unless told to", () => {
    const text = (ack: string) =>
      `UNB+UNOA:3+A:1+B:1+301015:0830+R1${ack}'UNH+1+ORDERS:D:96A:UN'BGM+220'UNT+3+1'UNZ+1+R1'`;
    const asked = summaryOf(bytesOf(text("++++1")));
    const notAsked = summaryOf(bytesOf(text("")));
    const no = summaryOf(bytesOf(text("++++0")));
    expect(asked.acknowledgementRequest).toBe(true);
    expect(notAsked.acknowledgementRequest).toBe(false);
    expect(no.acknowledgementRequest).toBe(false);
    const options: ContrlOptions = { reference: "C1", now: NOW };
    expect(contrl(asked, options)).not.toBeNull();
    expect(contrl(notAsked, options)).toBeNull();
    expect(contrl(no, options)).toBeNull();
    expect(contrl(notAsked, { ...options, always: true })).not.toBeNull();
    expect(acknowledge(bytesOf(text("")), options).interchanges[0]?.contrl).toBeNull();
  });

  it("cannot answer an interchange that has no UNB, and says it was rejected", () => {
    const bytes = bytesOf("UNH+1+ORDERS:D:96A:UN'BGM+220'UNT+3+1'UNZ+1+R1'");
    const [answer] = acknowledge(bytes, { reference: "C1", now: NOW, always: true }).interchanges;
    expect(answer?.contrl).toBeNull();
    expect(answer?.outcome).toBe("rejected");
  });

  it("takes the syntax, the character set and the line break it is given, and the date of its syntax", () => {
    const summary = summaryOf(readSample("valid", "orders-d96a-s3-unoa-multi-message"));
    const text = textOf(
      contrl(summary, {
        reference: "C9",
        now: new Date("2031-02-03T04:05:00Z"),
        always: true,
        syntaxVersion: "4",
        characterSet: "UNOC",
        lineBreak: "\r\n",
      }) ?? new Uint8Array(),
    );
    expect(text.split("\r\n")[1]).toBe(
      "UNB+UNOC:4+9520000000035:14+9520000000011:14+20310203:0405+C9'",
    );
    expect(text).toContain("UNH+1+CONTRL:4:2:UN'");
  });

  it("rejects with the first thing that was wrong, whichever level it was found at", () => {
    const base = "UNB+UNOA:3+A:1+B:1+301015:0830+R1++++1'";
    const rejectedBy = (body: string, ending: string) => {
      const [answer] = acknowledge(bytesOf(base + body), {
        reference: "C1",
        now: NOW,
      }).interchanges;
      expect(textOf(answer?.contrl ?? new Uint8Array())).toContain(`+4+${ending}'`);
    };
    rejectedBy("UNH+1+ORDERS:D:96A:UN'UNT+2+1'UNZ+2+R1'", "29+UNZ+1");
    rejectedBy("UNH+1+ORDERS:D:96A:UN'UNT+2+1'UNZ+1+R2'", "28+UNZ+2");
    // A segment that is missing is named by its tag, and has no position.
    rejectedBy("UNH+1+ORDERS:D:96A:UN'UNT+2+1'", "13+UNZ");
  });

  it("rejects a message with the position of the component when it is a component", () => {
    const base = "UNB+UNOA:3+A:1+B:1+301015:0830+R1++++1'";
    const body = "UNH+1+ORDERS:D:96A:UN'BGM+220+PO1+9'DTM+:20301015:102'UNS+S'UNT+5+1'UNZ+1+R1'";
    const [answer] = acknowledge(bytesOf(base + body), {
      reference: "C1",
      now: NOW,
      validate: {
        registries: [corpusRegistries[0] as NonNullable<(typeof corpusRegistries)[number]>],
      },
    }).interchanges;
    const lines = textOf(answer?.contrl ?? new Uint8Array()).split("\n");
    expect(lines).toContain("UCI+R1+A:1+B:1+7'");
    // An error in the body is told by a UCS (the third segment of the message) and a UCD.
    expect(lines).toContain("UCM+1+ORDERS:D:96A:UN+4'");
    expect(lines).toContain("UCS+3'");
    expect(lines).toContain("UCD+13+1:1'");
  });

  it("has an error code for every issue that can reject, or the default", () => {
    for (const code of Object.keys(CONTRL_ERROR_CODES)) {
      expect(ISSUE_CODES as string[]).toContain(code);
    }
    expect(CONTRL_ERROR_CODES.UNT_COUNT_MISMATCH).toBe("29");
    expect(CONTRL_ERROR_CODES.UNZ_REFERENCE_MISMATCH).toBe("28");
  });

  it("is built as data first, to be written or changed", () => {
    const summary = summaryOf(readSample("valid", "orders-d96a-s3-unoa-multi-message"));
    const data = contrlData(summary, { reference: "C1", now: NOW, always: true });
    expect(data?.segments.map((segment) => segment.tag)).toEqual([
      "UNB",
      "UNH",
      "UCI",
      "UCM",
      "UCM",
      "UNT",
      "UNZ",
    ]);
    expect(outcomeOf(summary)).toBe("accepted");
  });
});

describe("a summary of what a validation found", () => {
  it("is empty unless asked for", () => {
    expect(validate(readSample("valid", "orders-d96a-s3-unoa-multi-message")).interchanges).toEqual(
      [],
    );
  });

  it("has an interchange and its messages, and where each error was", () => {
    const [summary] = validate(readSample("invalid", "unt-count-mismatch"), {
      summary: true,
    }).interchanges;
    expect(summary).toMatchObject({
      index: 0,
      reference: "IC000005",
      sender: ["9520000000011", "14"],
      recipient: ["9520000000035", "14"],
      syntaxVersion: "3",
      characterSet: "UNOA",
      una: true,
      acknowledgementRequest: false,
      errorCount: 0,
    });
    expect(
      summary?.messages.map((m) => [m.reference, m.identifier.slice(0, 4), m.errorCount]),
    ).toEqual([
      ["1", ["ORDERS", "D", "96A", "UN"], 0],
      ["2", ["ORDERS", "D", "96A", "UN"], 1],
    ]);
    expect(summary?.messages[1]?.firstError).toMatchObject({
      code: "UNT_COUNT_MISMATCH",
      segment: 23,
      tag: "UNT",
      element: 1,
      component: null,
    });
    expect(summary?.messages[1]?.firstSegment).toBe(12);
    expect(summary?.messages[1]?.start).toBeGreaterThan(summary?.messages[0]?.end ?? 0);
  });

  it("puts the errors found in values on the message that holds them, even those not kept", () => {
    const text =
      "UNB+UNOA:3+A:1+B:1+301015:0830+R1'UNH+1+ORDERS:D:96A:UN'BGM+220'UNT+3+1'" +
      "UNH+2+ORDERS:D:96A:UN'BGM+aaa+bbb+ccc'UNT+3+2'UNZ+2+R1'";
    const report = validate(bytesOf(text), { summary: true, maxIssues: 1 });
    const [summary] = report.interchanges;
    expect(summary?.messages.map((m) => m.errorCount)).toEqual([0, 3]);
    expect(summary?.messages[1]?.firstError?.code).toBe("INVALID_CHARACTER");
    expect(summary?.errorCount).toBe(0);
    expect(outcomeOf(summary as InterchangeSummary)).toBe("partially_rejected");
  });

  it("puts a missing UNT on its message, and a missing UNZ on the interchange", () => {
    const text =
      "UNB+UNOA:3+A:1+B:1+301015:0830+R1'UNH+1+ORDERS:D:96A:UN'BGM+220'UNH+2+ORDERS:D:96A:UN'BGM+220'UNT+3+2'";
    const [summary] = validate(bytesOf(text), { summary: true }).interchanges;
    expect(summary?.messages.map((m) => m.errorCount)).toEqual([1, 0]);
    expect(summary?.errorCount).toBe(1);
  });

  it("keeps each interchange of a file apart, with the missing end of the first on the first", () => {
    const text =
      "UNB+UNOA:3+A:1+B:1+301015:0830+R1'UNH+1+ORDERS:D:96A:UN'BGM+220'UNT+3+1'" +
      "UNB+UNOA:3+C:1+D:1+301015:0830+R2'UNH+1+ORDERS:D:96A:UN'BGM+220'UNT+3+1'UNZ+1+R2'";
    const { interchanges } = validate(bytesOf(text), { summary: true });
    expect(interchanges.map((i) => [i.reference, i.errorCount, i.messages.length])).toEqual([
      ["R1", 1, 1],
      ["R2", 0, 1],
    ]);
  });
});

describe("a CONTRL that came in", () => {
  const read = (name: string) => readContrl(readSample("valid", name)).acknowledgements;

  it("is read as the status of the interchange and of each message", () => {
    const [accepted] = read("contrl-s3-unoa-accepted");
    expect(accepted).toMatchObject({
      reference: "IC000005",
      sender: ["9520000000011", "14"],
      recipient: ["9520000000035", "14"],
      action: "7",
      status: "accepted",
      outcome: "accepted",
      code: null,
    });
    expect(accepted?.messages.map((m) => [m.reference, m.identifier, m.status])).toEqual([
      ["1", ["ORDERS", "D", "96A", "UN"], "accepted"],
      ["2", ["ORDERS", "D", "96A", "UN"], "accepted"],
    ]);
    const [rejected] = read("contrl-s3-unoa-rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      outcome: "rejected",
      code: "28",
      segment: "UNZ",
      element: 2,
      component: null,
      messages: [],
    });
    const [partial] = read("contrl-s3-unoa-partially-rejected");
    expect(partial?.outcome).toBe("partially_rejected");
    expect(
      partial?.messages.map((m) => [m.reference, m.status, m.code, m.segment, m.element]),
    ).toEqual([
      ["1", "accepted", null, null, null],
      ["2", "rejected", "29", "UNT", 1],
    ]);
    expect(read("contrl-s4-unow-accepted")[0]?.outcome).toBe("accepted");
  });

  it("leaves other messages alone, and reads several interchanges answered in one CONTRL", () => {
    expect(
      readContrl(readSample("valid", "orders-d96a-s3-unoa-multi-message")).acknowledgements,
    ).toEqual([]);
    const text =
      "UNB+UNOA:3+B:1+A:1+301015:0830+C1'UNH+1+CONTRL:D:3:UN'" +
      "UCI+R1+A:1+B:1+7'UCM+1+ORDERS:D:96A:UN+7'UCI+R2+A:1+B:1+8'UCI+R3+A:1+B:1+9'UNT+6+1'UNZ+1+C1'";
    const all = readContrl(bytesOf(text)).acknowledgements;
    expect(all.map((a) => [a.reference, a.status, a.outcome, a.messages.length])).toEqual([
      ["R1", "accepted", "accepted", 1],
      ["R2", "received", "received", 0],
      ["R3", "unknown", "unknown", 0],
    ]);
  });
});

describe("correlating an acknowledgement with what was sent", () => {
  const sentOf = (where: "valid" | "invalid", name: string): SentInterchange => {
    const sent = sentFrom(summaryOf(readSample(where, name)));
    if (sent === null) {
      throw new Error("no UNB");
    }
    return sent;
  };

  it("matches the CONTRL samples with the interchanges they answer", () => {
    for (const [name, [where, original], , outcome] of ANSWERS) {
      const sent = sentOf(where, original);
      const result = correlate(readContrl(readSample("valid", name)).acknowledgements, [sent]);
      expect(result.pending, name).toEqual([]);
      expect(result.correlations).toHaveLength(1);
      expect(result.correlations[0]?.sent).toBe(sent);
      expect(result.correlations[0]?.problems).toEqual([]);
      expect(result.correlations[0]?.acknowledgement.outcome).toBe(outcome);
    }
  });

  it("says what it could not match, and what was never acknowledged", () => {
    const one = sentOf("valid", "orders-d96a-s3-unoa-multi-message");
    const other: SentInterchange = { reference: "IC000777", sender: "X", recipient: "Y" };
    const wrongParty: SentInterchange = { ...one, recipient: "9520000000999" };
    const acknowledgements = readContrl(
      readSample("valid", "contrl-s3-unoa-accepted"),
    ).acknowledgements;
    expect(correlate(acknowledgements, [other])).toMatchObject({
      correlations: [{ sent: null, problems: ["UNKNOWN_INTERCHANGE"] }],
      pending: [other],
    });
    expect(correlate(acknowledgements, [wrongParty]).correlations[0]).toMatchObject({
      sent: null,
      problems: ["PARTIES_DIFFER"],
    });
    expect(correlate([], [one, other]).pending).toEqual([one, other]);
  });

  it("does not match one sent interchange twice", () => {
    const one = sentOf("valid", "orders-d96a-s3-unoa-multi-message");
    const twice = [
      ...readContrl(readSample("valid", "contrl-s3-unoa-accepted")).acknowledgements,
      ...readContrl(readSample("valid", "contrl-s3-unoa-accepted")).acknowledgements,
    ];
    const result = correlate(twice, [one]);
    expect(result.correlations.map((c) => [c.sent === one, c.problems])).toEqual([
      [true, []],
      [false, ["DUPLICATE_ACKNOWLEDGEMENT"]],
    ]);
  });

  it("notices messages that the CONTRL names and the interchange did not have, or forgot", () => {
    const one = { ...sentOf("valid", "orders-d96a-s3-unoa-multi-message") };
    const [accepted] = readContrl(readSample("valid", "contrl-s3-unoa-accepted")).acknowledgements;
    const fewer = correlate(
      [accepted as NonNullable<typeof accepted>],
      [{ ...one, messages: ["1"] }],
    );
    expect(fewer.correlations[0]?.problems).toEqual(["UNKNOWN_MESSAGE"]);
    const more = correlate(
      [accepted as NonNullable<typeof accepted>],
      [{ ...one, messages: ["1", "2", "3"] }],
    );
    expect(more.correlations[0]?.problems).toEqual(["MESSAGE_NOT_ACKNOWLEDGED"]);
    const unknown: SentInterchange = {
      reference: one.reference,
      sender: one.sender,
      recipient: one.recipient,
    };
    expect(
      correlate([accepted as NonNullable<typeof accepted>], [unknown]).correlations[0]?.problems,
    ).toEqual([]);
  });
});

describe("what the mutants showed", () => {
  const sent = (change: Partial<SentInterchange> = {}): SentInterchange => ({
    reference: "IC000005",
    sender: "9520000000011",
    recipient: "9520000000035",
    ...change,
  });
  const accepted = () =>
    readContrl(readSample("valid", "contrl-s3-unoa-accepted")).acknowledgements;

  it("reads a CONTRL only from a CONTRL message, whatever the segments are called", () => {
    const text =
      "UNB+UNOA:3+B:1+A:1+301015:0830+C1'UNH+1+ORDERS:D:96A:UN'UCI+R1+A:1+B:1+7'UNT+3+1'UNZ+1+C1'";
    expect(readContrl(bytesOf(text)).acknowledgements).toEqual([]);
  });

  it("needs the sender to match as well as the recipient", () => {
    const result = correlate(accepted(), [sent({ sender: "9520000000999" })]);
    expect(result.correlations[0]).toMatchObject({ sent: null, problems: ["PARTIES_DIFFER"] });
    expect(correlate(accepted(), [sent()]).correlations[0]?.sent).not.toBeNull();
  });

  it("does not ask a rejection for the messages it does not name", () => {
    const text =
      "UNB+UNOA:3+B:1+A:1+301015:0830+C1'UNH+1+CONTRL:D:3:UN'" +
      "UCI+IC000005+9520000000011:14+9520000000035:14+4+13+UNB'UCM+1+ORDERS:D:96A:UN+7'UNT+4+1'UNZ+1+C1'";
    const result = correlate(readContrl(bytesOf(text)).acknowledgements, [
      sent({ messages: ["1", "2"] }),
    ]);
    expect(result.correlations[0]?.problems).toEqual([]);
    expect(result.correlations[0]?.acknowledgement.outcome).toBe("rejected");
  });

  it("says where an interchange is in the file", () => {
    const bytes = readSample("valid", "orders-d96a-s3-unoa-multi-message");
    const [summary] = validate(bytes, { summary: true }).interchanges;
    expect(summary?.start).toBe(0);
    expect(summary?.end).toBe(bytes.length - 1); // the last line feed is not part of it
    expect(summary?.messages[0]?.start).toBeGreaterThan(summary?.start ?? 0);
    expect(summary?.messages.at(-1)?.end).toBeLessThan(summary?.end ?? 0);
  });

  it("an interchange rejected as a whole has the UCI action 4 and no UCM, whatever its messages", () => {
    const base = "UNB+UNOA:3+A:1+B:1+301015:0830+R1++++1'";
    const [answer] = acknowledge(
      bytesOf(`${base}UNH+1+ORDERS:D:96A:UN'BGM+220'UNT+3+1'UNZ+1+R2'`),
      { reference: "C1", now: NOW },
    ).interchanges;
    const lines = textOf(answer?.contrl ?? new Uint8Array()).split("\n");
    expect(lines.filter((line) => line.startsWith("UCM"))).toEqual([]);
    expect(lines).toContain("UCI+R1+A:1+B:1+4+28+UNZ+2'");
    expect(lines.at(-3)).toBe("UNT+3+1'");
  });

  it("writes the sender and the recipient of the answer the other way round", () => {
    const base = "UNB+UNOA:3+A:1:X+B:2:Y+301015:0830+R1++++1'";
    const [answer] = acknowledge(
      bytesOf(`${base}UNH+1+ORDERS:D:96A:UN'BGM+220'UNT+3+1'UNZ+1+R1'`),
      { reference: "C1", now: NOW },
    ).interchanges;
    const lines = textOf(answer?.contrl ?? new Uint8Array()).split("\n");
    expect(lines[1]).toMatch(/^UNB\+UNOA:3\+B:2:Y\+A:1:X\+/);
    expect(lines).toContain("UCI+R1+A:1:X+B:2:Y+7'");
  });
});

describe("what the review of the CONTRL found", () => {
  const ASKING = "UNB+UNOA:3+A:1+B:1+301015:0830+R1++++1'";
  const MSG = "UNH+1+ORDERS:D:96A:UN'BGM+220'UNT+3+1'";
  const answer = (text: string, options: Partial<AcknowledgeOptions> = {}) =>
    acknowledge(bytesOf(text), { reference: "C1", now: NOW, ...options });
  const lines = (contrlBytes: Uint8Array | null) =>
    textOf(contrlBytes ?? new Uint8Array()).split("\n");

  it("answers an interchange whose references and parties the character set does not allow", () => {
    for (const text of [
      "UNB+UNOA:3+abc:1+B:1+301015:0830+R1++++1'",
      "UNB+UNOA:3+A:1+B:1+301015:0830+r1++++1'",
      "UNB+UNOX:3+abc:1+B:1+301015:0830+r1++++1'",
      "UNB+UNOA:3+A:1+B:1+301015:0830+R1++++1'UNH+1+ord:D:96A:UN'",
    ]) {
      const [one] = answer(`${text}${text.includes("UNH") ? "" : MSG}UNZ+1+R1'`).interchanges;
      expect(one?.contrl, text).not.toBeNull();
    }
    // A character the set of the CONTRL cannot hold at all is replaced.
    const unoc = new Uint8Array(
      Buffer.from("UNB+UNOC:3+é:1+B:1+301015:0830+R1++++1'" + MSG + "UNZ+1+R1'", "latin1"),
    );
    const [one] = acknowledge(unoc, {
      reference: "C1",
      now: NOW,
      characterSet: "UNOA",
    }).interchanges;
    expect(lines(one?.contrl ?? null)[1]).toBe("UNB+UNOA:3+B:1+??:1+301015:0830+C1'");
  });

  it("never throws on a file, and has one answer for each interchange it could read", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ANSWERS.map(([, [where, original]]) => readSample(where, original))),
        fc.array(
          fc.record({ at: fc.nat(1200), cut: fc.nat(6), insert: fc.string({ maxLength: 5 }) }),
          { maxLength: 4 },
        ),
        (original, edits) => {
          let text = Buffer.from(original).toString("latin1");
          for (const { at, cut, insert } of edits) {
            text = text.slice(0, at) + insert + text.slice(at + cut);
          }
          const result = acknowledge(bytesOf(text), { reference: "C1", now: NOW, always: true });
          expect(result.interchanges.length).toBe(result.report.interchanges.length);
          for (const one of result.interchanges) {
            expect(one.contrl === null).toBe(one.notAnswered !== null);
            if (one.contrl !== null) {
              expect(readContrl(one.contrl).complete).toBe(true);
            }
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it("blames the interchange that is cut off, not the last message or interchange that was read", () => {
    const first = `${ASKING}${MSG}UNZ+1+R1'`;
    const cutInSecondMessage = answer(`${ASKING}${MSG}UNH+2+ORDERS:D:96A:UN'BGM+22`);
    const [one] = cutInSecondMessage.interchanges;
    expect(one?.outcome).toBe("rejected");
    expect(lines(one?.contrl ?? null)).toContain("UCI+R1+A:1+B:1+4+12'");
    expect(lines(one?.contrl ?? null).some((line) => line.startsWith("UCM"))).toBe(false);
    expect(cutInSecondMessage.report.complete).toBe(false);

    // The first interchange is whole and is accepted; the second is cut off in its first message.
    const second = answer(`${first}UNB+UNOA:3+C:1+D:1+301015:0830+R2++++1'UNH+1+ORD`);
    expect(second.interchanges.map((i) => [i.summary.reference, i.outcome, i.notAnswered])).toEqual(
      [
        ["R1", "accepted", null],
        ["R2", "rejected", null],
      ],
    );
    expect(lines(second.interchanges[0]?.contrl ?? null)).toContain("UCI+R1+A:1+B:1+7'");
    expect(lines(second.interchanges[1]?.contrl ?? null)).toContain("UCI+R2+C:1+D:1+4+12+UNH'");
    // Garbage after a message, in an interchange that is not closed.
    const garbage = answer(`${ASKING}${MSG}@@@`);
    expect(garbage.interchanges[0]?.outcome).toBe("rejected");
    expect(lines(garbage.interchanges[0]?.contrl ?? null)).toContain("UCI+R1+A:1+B:1+4+12'");
  });

  it("has nothing to answer for a file with no interchange it could read the address of", () => {
    const nothing = answer("");
    expect(nothing.interchanges).toEqual([]);
    expect(nothing.report).toMatchObject({ valid: true, complete: true });
    for (const text of ["UNA:::.? 'UNB+A", "garbage", "UNB+UNOA:3+A"]) {
      const result = answer(text);
      expect(result.report, text).toMatchObject({ valid: false, complete: false });
      // The interchange that could not be read is there to be told about, with no one to tell.
      expect(
        result.interchanges.map((i) => [i.outcome, i.contrl, i.notAnswered, i.summary.reference]),
        text,
      ).toEqual([["rejected", null, "no_address", null]]);
    }
  });

  it("asks for the reference of a CONTRL only when one will be written", () => {
    const asked: string[] = [];
    const text =
      `${ASKING}${MSG}UNZ+1+R1'` +
      `UNB+UNOA:3+A:1+B:1+301015:0830+R2'${MSG}UNZ+1+R2'` + // does not ask
      `UNB+UNOA:3+C:1+D:1+301015:0830+R3++++1'${MSG}UNZ+1+R3'`;
    const result = answer(text, {
      reference: (summary) => {
        asked.push(summary.reference ?? "");
        return `C${asked.length}`;
      },
    });
    expect(asked).toEqual(["R1", "R3"]);
    expect(result.interchanges.map((i) => lines(i.contrl)[1]?.split("+").at(-1))).toEqual([
      "C1'",
      undefined,
      "C2'",
    ]);
  });

  it("refuses a reference or a date that cannot be written", () => {
    const summary = summaryOf(bytesOf(`${ASKING}${MSG}UNZ+1+R1'`));
    for (const reference of ["", "A".repeat(15), "ab", "A+B".replace("+", "\u0001")]) {
      expect(() => contrl(summary, { reference, now: NOW }), JSON.stringify(reference)).toThrow(
        RangeError,
      );
    }
    expect(() => contrl(summary, { reference: "C1", now: new Date("x") })).toThrow(RangeError);
    expect(contrl(summary, { reference: "A".repeat(14), now: NOW })).not.toBeNull();
    expect(contrl(summary, { reference: "A?B", now: NOW })).not.toBeNull();
  });

  it("cannot answer an interchange whose sender has no identification", () => {
    const summary = summaryOf(bytesOf(`UNB+UNOA:3+:14+B:1+301015:0830+R1++++1'${MSG}UNZ+1+R1'`));
    expect(contrl(summary, { reference: "C1", now: NOW })).toBeNull();
    expect(
      answer(`UNB+UNOA:3+:14+B:1+301015:0830+R1++++1'${MSG}UNZ+1+R1'`).interchanges[0]?.notAnswered,
    ).toBe("no_address");
  });

  it("takes 1, and only 1, in UNB element 9 as a request", () => {
    for (const [value, asks] of [
      ["1", true],
      ["2", false],
      ["", false],
      ["0", false],
      ["01", false],
    ] as const) {
      const text = `UNB+UNOA:3+A:1+B:1+301015:0830+R1++++${value}'${MSG}UNZ+1+R1'`;
      expect(summaryOf(bytesOf(text)).acknowledgementRequest, value).toBe(asks);
    }
  });

  it("says an error in a segment as a whole with the UCS, and one in an element with a UCS and a UCD", () => {
    const registry = corpusRegistries[0] as NonNullable<(typeof corpusRegistries)[number]>;
    const noBgm = `${ASKING}UNH+1+ORDERS:D:96A:UN'DTM+137:20301015:102'UNS+S'UNT+4+1'UNZ+1+R1'`;
    const [one] = answer(noBgm, { validate: { registries: [registry] } }).interchanges;
    expect(lines(one?.contrl ?? null)).toEqual(
      expect.arrayContaining(["UCM+1+ORDERS:D:96A:UN+4'", "UCS+2+13'"]),
    );
    const [read] = readContrl(one?.contrl ?? new Uint8Array()).acknowledgements;
    expect(read?.messages[0]?.segmentErrors).toEqual([{ position: 2, code: "13", elements: [] }]);

    const badElement = `${ASKING}UNH+1+ORDERS:D:96A:UN'BGM+220'DTM+:20301015:102'UNS+S'UNT+5+1'UNZ+1+R1'`;
    const [two] = answer(badElement, { validate: { registries: [registry] } }).interchanges;
    const [read2] = readContrl(two?.contrl ?? new Uint8Array()).acknowledgements;
    expect(read2?.messages[0]?.segmentErrors).toEqual([
      { position: 3, code: null, elements: [{ code: "13", element: 1, component: 1 }] },
    ]);
    expect(read2?.messages[0]).toMatchObject({ status: "rejected", code: null });
  });

  it("tells an error in a simple data element of a service segment without a component", () => {
    const text = `${ASKING}${MSG}UNZ+1+r1'`;
    const [one] = answer(text).interchanges;
    expect(lines(one?.contrl ?? null)).toContain("UCI+R1+A:1+B:1+4+21+UNZ+2'");
  });

  it("is told about the first error of the file, whoever found it first", () => {
    const text = `${ASKING}UNH+1+ORDERS:D:96A+7'BGM+2a0'UNT+3+1'UNZ+1+R1'`;
    const [summary] = validate(bytesOf(text), { summary: true }).interchanges;
    const first = summary?.messages[0]?.firstError;
    expect(first?.code).toBe("MISSING_MANDATORY_ELEMENT");
    expect(first?.offset).toBeLessThan(text.indexOf("BGM"));
  });

  it("has the error table it says it has", () => {
    expect(CONTRL_ERROR_CODES).toEqual({
      UNT_REFERENCE_MISMATCH: "28",
      UNE_REFERENCE_MISMATCH: "28",
      UNZ_REFERENCE_MISMATCH: "28",
      UNT_COUNT_MISMATCH: "29",
      UNE_COUNT_MISMATCH: "29",
      UNZ_COUNT_MISMATCH: "29",
      UNSUPPORTED_SYNTAX_VERSION: "2",
      UNSUPPORTED_CHARSET: "2",
      MISSING_MANDATORY_ELEMENT: "13",
      MISSING_MANDATORY_SEGMENT: "13",
      MISSING_ENVELOPE_SEGMENT: "13",
      INVALID_DATA_TYPE: "12",
      VALUE_TOO_LONG: "12",
      VALUE_TOO_SHORT: "12",
      INVALID_CHARACTER: "21",
      UNKNOWN_CODE: "14",
      SEGMENT_OUT_OF_ORDER: "15",
      UNKNOWN_SEGMENT: "15",
      UNEXPECTED_SEGMENT: "15",
      UNEXPECTED_ELEMENT: "16",
      UNEXPECTED_COMPONENT: "16",
      TOO_MANY_REPETITIONS: "16",
      ELEMENT_REPEATED_TOO_OFTEN: "16",
      REPETITION_NOT_ALLOWED: "15",
    });
    expect(DEFAULT_CONTRL_ERROR_CODE).toBe("12");
  });

  it("writes a UNA string even when the interchange answered had none", () => {
    const text = `UNB+UNOA:3+A:1+B:1+301015:0830+R1++++1'${MSG}UNZ+1+R1'`;
    const [summary] = validate(bytesOf(text), { summary: true }).interchanges;
    expect(summary?.una).toBe(false);
    expect(lines(contrl(summary as InterchangeSummary, { reference: "C1", now: NOW }))[0]).toBe(
      "UNA:+.? '",
    );
  });

  it("reads a CONTRL in a group, and what is damaged does not throw", () => {
    const grouped =
      "UNB+UNOA:3+B:1+A:1+301015:0830+C1'UNG+CONTRL+B:1+A:1+301015:0830+G1+UN+D:3'" +
      "UNH+1+CONTRL:D:3:UN'UCI+R1+A:1+B:1+7'UNT+3+1'UNE+1+G1'UNZ+1+C1'";
    expect(readContrl(bytesOf(grouped)).acknowledgements.map((a) => a.reference)).toEqual(["R1"]);
    const cut = readContrl(
      bytesOf("UNB+UNOA:3+B:1+A:1+301015:0830+C1'UNH+1+CONTRL:D:3:UN'UCI+R1+A:1+B:1+7"),
    );
    expect(cut).toEqual({ acknowledgements: [], complete: false });
    const twoThenDamage = `${grouped}UNH+2+CONTRL:D:3:UN'UCI+R9`;
    const partial = readContrl(bytesOf(twoThenDamage));
    expect(partial.complete).toBe(false);
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 120 }), (bytes) => {
        expect(() => readContrl(bytes)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it("matches the party by identification and, when both give one, by qualifier", () => {
    const [accepted] = readContrl(readSample("valid", "contrl-s3-unoa-accepted")).acknowledgements;
    const base: SentInterchange = {
      reference: "IC000005",
      sender: "9520000000011",
      recipient: "9520000000035",
    };
    const ack = accepted as NonNullable<typeof accepted>;
    expect(
      correlate([ack], [{ ...base, senderQualifier: "14" }]).correlations[0]?.sent,
    ).not.toBeNull();
    expect(correlate([ack], [{ ...base, senderQualifier: "1" }]).correlations[0]?.problems).toEqual(
      ["PARTIES_DIFFER"],
    );
    expect(correlate([ack], [{ ...base, sender: "" }]).correlations[0]?.problems).toEqual([
      "PARTIES_DIFFER",
    ]);
  });

  it("correlates many acknowledgements at once without comparing each with each", () => {
    const many = Array.from(
      { length: 20000 },
      (_unused, i): SentInterchange => ({
        reference: `R${i}`,
        sender: "A",
        recipient: "B",
      }),
    );
    const acknowledgements = many.map((sent) => ({
      reference: sent.reference,
      sender: ["A"],
      recipient: ["B"],
      action: "7",
      status: "accepted" as const,
      messages: [],
      outcome: "accepted" as const,
      code: null,
      segment: null,
      element: null,
      component: null,
    }));
    const started = performance.now();
    const result = correlate(acknowledgements, many);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.pending).toEqual([]);
    expect(result.correlations.every((c) => c.problems.length === 0)).toBe(true);
  });

  it("finds the messages with no UNT of 20,000 messages in a time that does not grow with their number", () => {
    const text = `${ASKING}${"UNH+1+ORDERS:D:96A:UN'BGM+220'".repeat(20000)}`;
    const started = performance.now();
    const report = validate(bytesOf(text), { summary: true });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(report.interchanges[0]?.messages.length).toBe(20000);
    expect(report.interchanges[0]?.messages.filter((m) => m.errorCount > 0).length).toBe(20000);
  });
});

describe("what the mutants of the second round showed", () => {
  const ASKING = "UNB+UNOA:3+A:1+B:1+301015:0830+R1++++1'";
  const MSG = "UNH+1+ORDERS:D:96A:UN'BGM+220'UNT+3+1'";
  const summaries = (text: string) => validate(bytesOf(text), { summary: true }).interchanges;

  it("cannot answer an interchange that names no sender or no recipient at all", () => {
    for (const unb of [
      "UNB+UNOA:3++B:1+301015:0830+R1++++1'",
      "UNB+UNOA:3+A:1++301015:0830+R1++++1'",
      "UNB+UNOA:3+A:1+:14+301015:0830+R1++++1'",
    ]) {
      const [one] = acknowledge(bytesOf(`${unb}${MSG}UNZ+1+R1'`), {
        reference: "C1",
        now: NOW,
      }).interchanges;
      expect(one?.summary.reference, unb).toBe("R1");
      expect([one?.contrl, one?.notAnswered], unb).toEqual([null, "no_address"]);
    }
  });

  it("knows which interchanges were read to their UNZ", () => {
    const closed = (text: string) => summaries(text).map((one) => one.closed);
    expect(closed(`${ASKING}${MSG}UNZ+1+R1'`)).toEqual([true]);
    expect(closed(`${ASKING}${MSG}`)).toEqual([false]);
    expect(closed(`${ASKING}${MSG}UNZ+1`)).toEqual([false]);
    expect(closed(`${ASKING}${MSG}UNZ+1+R1'${ASKING}${MSG}`)).toEqual([true, false]);
  });

  it("puts the error that stops a file in the interchange that was open, or in a new one", () => {
    const rows = (text: string) =>
      summaries(text).map((one) => [
        one.index,
        one.reference,
        one.closed,
        one.errorCount,
        one.firstError?.code ?? null,
      ]);
    expect(rows(`${ASKING}${MSG}UNZ+1+R1'@@@`)).toEqual([
      [0, "R1", true, 0, null],
      [1, null, false, 1, "INVALID_SEGMENT_TAG"],
    ]);
    expect(rows("@@@")).toEqual([[0, null, false, 1, "INVALID_SEGMENT_TAG"]]);
    expect(
      rows(`${ASKING}${MSG}UNZ+1+R1'${ASKING}${MSG}UNZ+1+R1'@@@`).map((row) => row[0]),
    ).toEqual([0, 1, 2]);
  });

  it("counts a value found wrong just before the file stops, for the interchange it stopped in", () => {
    // The message is not over when the file stops: the value belongs to the interchange.
    const text = `${ASKING}UNH+1+ORDERS:D:96A:UN'BGM+2\u0001'@@@`;
    const [one] = summaries(text);
    expect(one).toMatchObject({ reference: "R1", errorCount: 2 });
    expect(one?.firstError?.code).toBe("INVALID_CHARACTER");
  });

  it("reads the element and the component of a UCD in the order they are written", () => {
    const text =
      "UNB+UNOA:3+B:1+A:1+301015:0830+C1'UNH+1+CONTRL:D:3:UN'UCI+R1+A:1+B:1+7'" +
      "UCM+1+ORDERS:D:96A:UN+4'UCS+3'UCD+12+4:2'UCD+13+5'UNT+7+1'UNZ+1+C1'";
    const [one] = readContrl(bytesOf(text)).acknowledgements;
    expect(one?.messages[0]?.segmentErrors).toEqual([
      {
        position: 3,
        code: null,
        elements: [
          { code: "12", element: 4, component: 2 },
          { code: "13", element: 5, component: null },
        ],
      },
    ]);
  });

  it("does not match a party that has no identification, not even with one sent with none", () => {
    const [read] = readContrl(readSample("valid", "contrl-s3-unoa-accepted")).acknowledgements;
    const ack = { ...(read as NonNullable<typeof read>), sender: ["", "14"] };
    const sent: SentInterchange = {
      reference: ack.reference,
      sender: "",
      recipient: ack.recipient[0] as string,
    };
    expect(correlate([ack], [sent]).correlations[0]?.problems).toEqual(["PARTIES_DIFFER"]);
  });

  it("does not fault a CONTRL that accepts a whole interchange without naming its messages", () => {
    const text =
      "UNB+UNOA:3+B:1+A:1+301015:0830+C1'UNH+1+CONTRL:D:3:UN'UCI+R1+A:1+B:1+7'UNT+3+1'UNZ+1+C1'";
    const { acknowledgements } = readContrl(bytesOf(text));
    const sent: SentInterchange = {
      reference: "R1",
      sender: "A",
      recipient: "B",
      messages: ["1", "2"],
    };
    expect(correlate(acknowledgements, [sent]).correlations[0]).toMatchObject({
      sent,
      problems: [],
    });
  });
});
