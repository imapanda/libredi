import { describe, expect, it } from "vitest";
import {
  interchangeData,
  parseInterchanges,
  parseMessages,
  serialize,
  serializeData,
} from "./index.ts";
import { readSample, samples } from "./testing/corpus.ts";

describe("valid samples", () => {
  const names = samples("valid");

  it.each(names)("%s: parse then serialize is byte-identical", (name) => {
    const bytes = readSample("valid", name);
    const result = parseInterchanges(bytes);
    expect(result.issues).toEqual([]);
    expect(Buffer.from(serialize(result)).equals(Buffer.from(bytes))).toBe(true);
    // Each interchange alone: from its first byte to its last.
    for (const interchange of result.interchanges) {
      const text = Buffer.from(serialize(interchange));
      expect(text.equals(Buffer.from(bytes.subarray(interchange.start, interchange.end)))).toBe(
        true,
      );
    }
  });

  it.each(names)(
    "%s: the messages and envelopes, put end to end, are the segments of the file",
    (name) => {
      const bytes = readSample("valid", name);
      const stream = parseMessages(bytes);
      const parts = [...stream.items()].map((item) => Buffer.from(serialize(item)));
      // The line breaks between the parts are not in any part.
      const strip = (buffer: Buffer) => buffer.toString("latin1").replace(/[\r\n]/g, "");
      const una = Buffer.from(bytes).toString("latin1").startsWith("UNA") ? 9 : 0;
      expect(parts.map(strip).join("")).toBe(strip(Buffer.from(bytes.subarray(una))));
    },
  );

  it.each(names)("%s: its tree, as data, is written back to the same bytes", (name) => {
    const bytes = readSample("valid", name);
    const [interchange] = parseInterchanges(bytes).interchanges;
    if (interchange === undefined) {
      throw new Error("no interchange");
    }
    for (const values of ["text", "bytes"] as const) {
      const data = interchangeData(interchange, { values });
      const out = serializeData(data);
      expect(Buffer.from(out).equals(Buffer.from(bytes)), `${name} as ${values}`).toBe(true);
    }
  });
});
