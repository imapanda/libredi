import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEPARATORS,
  type InterchangeData,
  interchangeData,
  parseInterchanges,
  parseMessages,
  SerializeError,
  SYNTAX_4_SEPARATORS,
  serialize,
  serializeData,
} from "./index.ts";
import { bytesOf, textOf } from "./testing/helpers.ts";

const write = (data: InterchangeData, options?: Parameters<typeof serializeData>[1]): string =>
  textOf(serializeData(data, options));

const catchError = (run: () => unknown): SerializeError => {
  try {
    run();
  } catch (error) {
    if (error instanceof SerializeError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a SerializeError");
};

describe("serializeData: what is written", () => {
  it("writes a UNA string, the segments and the terminators, with no line break by default", () => {
    const text = write({
      segments: [
        { tag: "UNB", elements: [["UNOA", "3"], ["SENDER", "14"], "20301015"] },
        { tag: "UNZ", elements: ["0", "REF"] },
      ],
    });
    expect(text).toBe("UNA:+.? 'UNB+UNOA:3+SENDER:14+20301015'UNZ+0+REF'");
  });

  it("puts the line break after the UNA string and after every segment", () => {
    const text = write({
      lineBreak: "\r\n",
      segments: [
        { tag: "BGM", elements: ["220"] },
        { tag: "UNS", elements: ["S"] },
      ],
    });
    expect(text).toBe("UNA:+.? '\r\nBGM+220'\r\nUNS+S'\r\n");
  });

  it("writes empty elements and empty components as nothing between the separators", () => {
    const text = write({
      segments: [{ tag: "NAD", elements: ["BY", [], ["", "", "9"], "", ["X", ""]] }],
      una: false,
    });
    expect(text).toBe("NAD+BY++::9++X:'");
  });

  it("writes a segment with no element as its tag and the terminator", () => {
    expect(write({ segments: [{ tag: "UNS" }, { tag: "UNT", elements: [] }], una: false })).toBe(
      "UNS'UNT'",
    );
  });

  it("puts a release character before every service character in a value, and before itself", () => {
    const text = write({
      segments: [{ tag: "FTX", elements: ["AAI", [], [], "A+B:C?D'E"] }],
      una: false,
    });
    expect(text).toBe("FTX+AAI+++A?+B?:C??D?'E'");
  });

  it("escapes the characters of the service string it was given, not the default ones", () => {
    const separators = {
      component: 0x5e, // ^
      element: 0x7c, // |
      decimalMark: 0x2c,
      release: 0x21, // !
      repetition: null,
      terminator: 0x7e, // ~
      declared: true,
    };
    const text = write({
      separators,
      characterSet: "UNOB",
      segments: [{ tag: "FTX", elements: [["a+b", "c:d^e|f!g~h"]] }],
    });
    // + and : are plain data here.
    expect(text).toBe("UNA^|,! ~FTX|a+b^c:d!^e!|f!!g!~h~");
  });

  it("writes a repeated element with the repetition separator and escapes it in values", () => {
    const text = write({
      separators: SYNTAX_4_SEPARATORS,
      segments: [
        {
          tag: "FTX",
          elements: [
            "AAI",
            { repetitions: [["ONE"], ["TWO", "WITH *"], []] },
            { repetitions: [["ONLY"]] },
          ],
        },
      ],
    });
    expect(text).toBe("UNA:+.?*'FTX+AAI+ONE*TWO:WITH ?**+ONLY'");
  });

  it("copies bytes as they are, escaping them the same way", () => {
    const bytes = Uint8Array.from([0x41, 0x2b, 0xe9, 0x3f]);
    const out = serializeData({
      una: false,
      characterSet: "UNOC",
      segments: [{ tag: "FTX", elements: [[bytes]] }],
    });
    expect([...out]).toEqual([0x46, 0x54, 0x58, 0x2b, 0x41, 0x3f, 0x2b, 0xe9, 0x3f, 0x3f, 0x27]);
  });

  it("writes a byte order mark when asked", () => {
    const out = serializeData({ bom: true, una: false, segments: [{ tag: "UNS" }] });
    expect([...out.subarray(0, 4)]).toEqual([0xef, 0xbb, 0xbf, 0x55]);
  });

  it("writes nothing for no segments but the UNA string", () => {
    expect(write({ segments: [] })).toBe("UNA:+.? '");
    expect(write({ segments: [], una: false })).toBe("");
  });
});

describe("the example of the README", () => {
  it("writes what the README says it writes", () => {
    expect(
      write({
        segments: [
          {
            tag: "UNB",
            elements: [
              ["UNOC", "4"],
              ["SENDER", "14"],
              ["RECEIVER", "14"],
            ],
          },
          { tag: "FTX", elements: ["AAI", [], [], { repetitions: [["ONE"], ["TWO", "2"]] }] },
          { tag: "UNZ", elements: ["1", "REF"] },
        ],
      }),
    ).toBe("UNA:+.?*'UNB+UNOC:4+SENDER:14+RECEIVER:14'FTX+AAI+++ONE*TWO:2'UNZ+1+REF'");
  });
});

describe("serializeData: the service string", () => {
  it("states the syntax 4 default when the UNB announces version 4 and no characters are given", () => {
    const text = write({
      segments: [{ tag: "UNB", elements: [["UNOC", "4"]] }],
    });
    expect(text).toBe("UNA:+.?*'UNB+UNOC:4'");
  });

  it("leaves the UNA string out for the characters that the reader assumes anyway", () => {
    expect(
      write({ una: false, segments: [{ tag: "UNB", elements: [["UNOA", "3"], "A*B"] }] }),
    ).toBe("UNB+UNOA:3+A*B'");
    // Syntax 4 assumes the asterisk, so a value that has one needs its release character.
    expect(
      write({ una: false, segments: [{ tag: "UNB", elements: [["UNOA", "4"], "A*B"] }] }),
    ).toBe("UNB+UNOA:4+A?*B'");
  });

  it("refuses to leave out a UNA string that the reader could not guess", () => {
    const error = catchError(() =>
      serializeData({
        una: false,
        separators: { ...DEFAULT_SEPARATORS, element: 0x7c },
        segments: [{ tag: "UNS" }],
      }),
    );
    expect(error.code).toBe("INVALID_SEPARATORS");
    expect(error.message).toMatch(/UNA/);
  });

  it.each([
    ["component separator", { component: 0x5e }, "3"],
    ["element separator", { element: 0x7c }, "3"],
    ["decimal mark", { decimalMark: 0x2c }, "3"],
    ["release character", { release: 0x21 }, "3"],
    ["segment terminator", { terminator: 0x7e }, "3"],
    ["repetition separator under version 3", { repetition: 0x2a }, "3"],
    ["repetition separator under version 4", { repetition: 0x7c }, "4"],
    ["missing repetition separator under version 4", { repetition: null }, "4"],
  ])("needs a UNA string for another %s than the assumed one", (_name, change, version) => {
    const unb: InterchangeData["segments"] = [
      { tag: "UNB", elements: [["UNOA", version as string]] },
    ];
    const assumed = version === "4" ? SYNTAX_4_SEPARATORS : DEFAULT_SEPARATORS;
    const separators = { ...assumed, ...change, declared: true };
    expect(catchError(() => serializeData({ una: false, separators, segments: unb })).code).toBe(
      "INVALID_SEPARATORS",
    );
    expect(textOf(serializeData({ separators, segments: unb })).startsWith("UNA")).toBe(true);
    // The assumed characters are fine either way.
    expect(textOf(serializeData({ una: false, separators: assumed, segments: unb }))).toBe(
      `UNB+UNOA:${version}'`,
    );
  });

  it.each([
    ["the same character twice", { ...DEFAULT_SEPARATORS, component: 0x2b, declared: true }],
    ["a letter", { ...DEFAULT_SEPARATORS, element: 0x41, declared: true }],
    ["a decimal mark that is not . or ,", { ...DEFAULT_SEPARATORS, decimalMark: 0x3b }],
  ])("refuses service characters that the tokenizer would refuse: %s", (_name, separators) => {
    const error = catchError(() => serializeData({ separators, segments: [] }));
    expect(error.code).toBe("INVALID_SEPARATORS");
  });
});

describe("serializeData: repetition needs the repetition separator", () => {
  it("refuses to repeat an element when the service characters have no repetition separator", () => {
    const error = catchError(() =>
      serializeData({
        segments: [
          { tag: "UNB", elements: [["UNOA", "3"]] },
          { tag: "FTX", elements: ["AAI", { repetitions: [["A"], ["B"]] }] },
        ],
      }),
    );
    expect(error.code).toBe("REPETITION_NOT_ALLOWED");
    expect(error.position).toEqual({ segment: 2, tag: "FTX", element: 2, component: null });
    expect(error.message).toMatch(/syntax version 4/);
  });

  it("refuses to repeat an element under syntax version 3, even if a UNA string has an asterisk", () => {
    const error = catchError(() =>
      serializeData({
        separators: { ...SYNTAX_4_SEPARATORS, declared: true },
        segments: [
          { tag: "UNB", elements: [["UNOA", "3"]] },
          { tag: "FTX", elements: [{ repetitions: [["A"], ["B"]] }] },
        ],
      }),
    );
    expect(error.code).toBe("REPETITION_NOT_ALLOWED");
    expect(error.position).toEqual({ segment: 2, tag: "FTX", element: 1, component: null });
    expect(error.message).toMatch(/announces syntax version "3"/);
  });

  it("lets a fragment with no UNB repeat, when it has a repetition separator", () => {
    expect(
      write({
        separators: SYNTAX_4_SEPARATORS,
        segments: [{ tag: "FTX", elements: [{ repetitions: [["A"], ["B"]] }] }],
      }),
    ).toBe("UNA:+.?*'FTX+A*B'");
  });

  it("accepts one repetition whatever the service characters", () => {
    expect(
      write({ una: false, segments: [{ tag: "FTX", elements: [{ repetitions: [["A", "B"]] }] }] }),
    ).toBe("FTX+A:B'");
  });
});

describe("serializeData: tags", () => {
  it.each(["", "AB", "ABCD", "abc", "A B", "UNA", "A+B"])("refuses the tag %j", (tag) => {
    const error = catchError(() => serializeData({ segments: [{ tag }] }));
    expect(error.code).toBe("INVALID_TAG");
    expect(error.position.segment).toBe(1);
  });

  it("accepts digits and capital letters", () => {
    expect(write({ una: false, segments: [{ tag: "A1Z" }, { tag: "007" }] })).toBe("A1Z'007'");
  });
});

describe("serializeData: character sets", () => {
  const FTX = (value: string): InterchangeData["segments"] => [{ tag: "FTX", elements: [[value]] }];

  it("takes the set from the UNB when none is given, and UNOA when there is no UNB", () => {
    const out = serializeData({
      una: false,
      segments: [{ tag: "UNB", elements: [["UNOC", "3"]] }, ...FTX("\u00e9")],
    });
    expect([...out.subarray(-3)]).toEqual([0x2b, 0xe9, 0x27]);
    expect(catchError(() => serializeData({ una: false, segments: FTX("\u00e9") })).code).toBe(
      "INVALID_CHARACTER",
    );
  });

  it("writes UNOC and UNOW text as the set says, and refuses what the set cannot hold", () => {
    expect([...serializeData({ una: false, characterSet: "UNOC", segments: FTX("é") })]).toEqual([
      0x46, 0x54, 0x58, 0x2b, 0xe9, 0x27,
    ]);
    expect([...serializeData({ una: false, characterSet: "UNOW", segments: FTX("é€😀") })]).toEqual(
      [0x46, 0x54, 0x58, 0x2b, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80, 0x27],
    );
    const euro = catchError(() =>
      serializeData({ una: false, characterSet: "UNOC", segments: FTX("5 €") }),
    );
    expect(euro.code).toBe("INVALID_CHARACTER");
    expect(euro.position).toEqual({ segment: 1, tag: "FTX", element: 1, component: 1 });
    expect(euro.message).toMatch(/UNOC/);
    const lone = catchError(() =>
      serializeData({ una: false, characterSet: "UNOW", segments: FTX("a\ud800b") }),
    );
    expect(lone.code).toBe("INVALID_CHARACTER");
  });

  it.each([
    ["UNOC", "\u00ff", [0xff]],
    ["UNOW", "\u{10ffff}", [0xf4, 0x8f, 0xbf, 0xbf]],
    ["UNOW", "\ud83d\ude00", [0xf0, 0x9f, 0x98, 0x80]],
  ] as const)("writes the last character of %s", (characterSet, value, bytes) => {
    const out = serializeData({ una: false, characterSet, segments: FTX(value) });
    expect([...out.subarray(4, -1)]).toEqual(bytes);
  });

  it.each([
    ["UNOC", "\u0100"],
    ["UNOC", "\ud83d\ude00"],
    ["UNOB", "\u00e9"],
    ["UNOB", "\u0080"],
    ["UNOB", "\ud83d\ude00"],
    ["UNOA", "\u00ff"],
    ["UNOW", "\ud800"],
    ["UNOW", "\udc00"],
    ["UNOW", "\udfff"],
    ["UNOW", "a\ud800"],
    ["UNOW", "\ud800\ud800"],
    ["UNOW", "\ud800a"],
    ["UNOW", "\udc00\ud800"],
    ["UNOW", "\udc00\udc00"],
  ] as const)(
    "cannot write %s %j: no byte for it, whatever checkCharacters says",
    (characterSet, value) => {
      for (const checkCharacters of [true, false]) {
        const error = catchError(() =>
          serializeData({ una: false, characterSet, segments: FTX(value) }, { checkCharacters }),
        );
        expect(error.code).toBe("INVALID_CHARACTER");
        expect(error.message).toMatch(new RegExp(`cannot be written in ${characterSet}`));
      }
    },
  );

  it("writes values of any length, even when every byte needs a release character", () => {
    const specials = "+:?'";
    const long = specials.repeat(2000);
    const expected = `FTX+${[...long].map((c) => `?${c}`).join("")}'`;
    const fromText = serializeData({ una: false, characterSet: "UNOB", segments: FTX(long) });
    expect(textOf(fromText)).toBe(expected);
    const fromBytes = serializeData({
      una: false,
      characterSet: "UNOB",
      segments: [{ tag: "FTX", elements: [[bytesOf(long)]] }],
    });
    expect(textOf(fromBytes)).toBe(expected);
  });

  it("checks the values against the set, as the parser does, unless told not to", () => {
    const lowercase = {
      una: false,
      characterSet: "UNOA" as const,
      segments: FTX("hello"),
    };
    const error = catchError(() => serializeData(lowercase));
    expect(error.code).toBe("INVALID_CHARACTER");
    expect(error.position.component).toBe(1);
    expect(textOf(serializeData(lowercase, { checkCharacters: false }))).toBe("FTX+hello'");
    expect(textOf(serializeData({ ...lowercase, characterSet: "UNOB" }))).toBe("FTX+hello'");
  });

  it("does not take a line break or a control character in a value", () => {
    const error = catchError(() =>
      serializeData({ una: false, characterSet: "UNOB", segments: FTX("a\nb") }),
    );
    expect(error.code).toBe("INVALID_CHARACTER");
  });
});

describe("serializeData: options and limits", () => {
  it("accepts only line breaks as a line break", () => {
    const error = catchError(() => serializeData({ lineBreak: " ", segments: [] }));
    expect(error.code).toBe("INVALID_LINE_BREAK");
  });

  it("stops at maxBytes with OUTPUT_TOO_LARGE, whatever the way the limit is crossed", () => {
    const big = "X".repeat(10_000);
    const data: InterchangeData = {
      una: false,
      characterSet: "UNOB",
      segments: [{ tag: "FTX", elements: [[big]] }],
    };
    expect(catchError(() => serializeData(data, { maxBytes: 1000 })).code).toBe("OUTPUT_TOO_LARGE");
    expect(serializeData(data, { maxBytes: 10_005 }).length).toBe(10_005);
    expect(catchError(() => serializeData(data, { maxBytes: 10_004 })).code).toBe(
      "OUTPUT_TOO_LARGE",
    );
  });

  it("refuses a maxBytes that is not a positive integer", () => {
    expect(() => serializeData({ segments: [] }, { maxBytes: 0 })).toThrow(RangeError);
    expect(() => serializeData({ segments: [] }, { maxBytes: 1.5 })).toThrow(RangeError);
  });
});

const ORDER = [
  "UNA:+.?*'",
  "UNB+UNOC:4+SENDER:14+RECEIVER:14+20301015:0830+REF1'",
  "UNH+1+ORDERS:D:01B:UN'",
  "FTX+AAI+++ONE*TWO:2*LITERAL ?* STAR'",
  "NAD+BY+9520000000011::9++Dupont?+?? Pierre'",
  "UNT+4+1'",
  "UNZ+1+REF1'",
  "",
].join("\n");

describe("interchangeData: a parsed tree as data to edit", () => {
  const parse = (text: string) => {
    const [interchange] = parseInterchanges(bytesOf(text)).interchanges;
    if (interchange === undefined) {
      throw new Error("no interchange");
    }
    return interchange;
  };

  it("writes the same bytes back, when the file escapes only what it must", () => {
    const data = interchangeData(parse(ORDER));
    expect(textOf(serializeData(data))).toBe(ORDER);
  });

  it("describes the interchange: segments, repetitions, service characters, set", () => {
    const data = interchangeData(parse(ORDER));
    expect(data.una).toBe(true);
    expect(data.characterSet).toBeUndefined(); // the UNB names it
    expect(data.lineBreak).toBe("\n");
    expect(data.separators?.repetition).toBe(0x2a);
    expect(data.segments.map((segment) => segment.tag)).toEqual([
      "UNB",
      "UNH",
      "FTX",
      "NAD",
      "UNT",
      "UNZ",
    ]);
    expect(data.segments[2]?.elements).toEqual([
      ["AAI"],
      [],
      [],
      { repetitions: [["ONE"], ["TWO", "2"], ["LITERAL * STAR"]] },
    ]);
  });

  it("gives bytes instead of text when asked", () => {
    const data = interchangeData(parse(ORDER), { values: "bytes" });
    const nad = data.segments[3]?.elements?.[3];
    expect(nad).toEqual([Uint8Array.from(bytesOf("Dupont+? Pierre"))]);
    expect(textOf(serializeData(data))).toBe(ORDER);
  });

  it("is a copy that can be edited and written with the new values", () => {
    const data = interchangeData(parse(ORDER));
    const segments = data.segments.map((segment) =>
      segment.tag === "UNB"
        ? {
            ...segment,
            elements: [
              ["UNOC", "4"],
              ["ME", "14"],
            ],
          }
        : segment,
    );
    const text = write({ ...data, segments });
    expect(text).toBe(
      ORDER.replace("UNB+UNOC:4+SENDER:14+RECEIVER:14+20301015:0830+REF1", "UNB+UNOC:4+ME:14"),
    );
  });

  it("reads a character set it does not support as ISO 8859-1, which it writes back", () => {
    const bytes = Uint8Array.from([...bytesOf("UNB+UNOX:3+A'FTX+"), 0xe9, ...bytesOf("'UNZ+0+1'")]);
    const [interchange] = parseInterchanges(bytes).interchanges;
    if (interchange === undefined) {
      throw new Error("no interchange");
    }
    const data = interchangeData(interchange);
    expect(data.characterSet).toBe("UNOC");
    expect(data.segments[1]?.elements).toEqual([["\u00e9"]]);
    expect([...serializeData(data, { checkCharacters: false })]).toEqual([...bytes]);
  });

  it("takes the line break from the line of the UNA string, which may not be the one of the segments", () => {
    const text = "UNA:+.? '\r\nUNB+UNOA:3'\nUNZ+0+1'\n";
    expect(interchangeData(parse(text)).lineBreak).toBe("\r\n");
    expect(interchangeData(parse(text.slice(11))).lineBreak).toBe("\n");
  });

  it("gives the byte order mark to the first interchange of a file only", () => {
    const bytes = new Uint8Array(Buffer.from(`\uFEFF${ORDER}${ORDER}`, "utf8"));
    const [first, second] = parseInterchanges(bytes).interchanges;
    expect([first, second].map((i) => i && interchangeData(i).bom)).toEqual([true, false]);
  });

  it("keeps a missing UNA string, a byte order mark and a UNOW text", () => {
    const text = "﻿UNB+UNOW:3+A+B'FTX+AAI+++Grüße €'UNZ+0+1'";
    const utf8 = new Uint8Array(Buffer.from(text, "utf8"));
    const [interchange] = parseInterchanges(utf8).interchanges;
    if (interchange === undefined) {
      throw new Error("no interchange");
    }
    const data = interchangeData(interchange);
    expect(data.una).toBe(false);
    expect(data.bom).toBe(true);
    expect(data.characterSet).toBeUndefined();
    expect([...serializeData(data)]).toEqual([...utf8]);
  });
});

describe("serialize: a parsed tree is written as it was read", () => {
  it("gives the bytes of a whole file, line breaks and byte order mark included", () => {
    const text = `﻿\n${ORDER}\r\n\r\n${ORDER}`;
    const bytes = new Uint8Array(Buffer.from(text, "utf8"));
    const result = parseInterchanges(bytes);
    expect(result.interchanges).toHaveLength(2);
    const out = serialize(result);
    expect([...out]).toEqual([...bytes]);
    expect(out).not.toBe(bytes);
    expect(out.buffer).not.toBe(bytes.buffer);
  });

  it("gives the bytes of a file that holds no interchange", () => {
    for (const text of ["", "\n\r\n", "﻿", "﻿\n"]) {
      const bytes = new Uint8Array(Buffer.from(text, "utf8"));
      expect([...serialize(parseInterchanges(bytes))]).toEqual([...bytes]);
    }
  });

  it("gives the bytes of one interchange: from its UNA string or first segment to its last", () => {
    const bytes = bytesOf(`\n${ORDER}\n${ORDER}`);
    const [first, second] = parseInterchanges(bytes).interchanges;
    expect(textOf(serialize(first as NonNullable<typeof first>))).toBe(ORDER.trimEnd());
    expect(textOf(serialize(second as NonNullable<typeof second>))).toBe(ORDER.trimEnd());
  });

  it("gives the bytes of one message, UNH to UNT, and of the segments between messages", () => {
    const bytes = bytesOf(ORDER);
    const stream = parseMessages(bytes);
    const parts = [...stream.items()].map((item) => ({
      kind: item.kind,
      text: textOf(serialize(item)),
    }));
    expect(parts).toEqual([
      {
        kind: "envelope",
        text: "UNB+UNOC:4+SENDER:14+RECEIVER:14+20301015:0830+REF1'",
      },
      {
        kind: "message",
        text: "UNH+1+ORDERS:D:01B:UN'\nFTX+AAI+++ONE*TWO:2*LITERAL ?* STAR'\nNAD+BY+9520000000011::9++Dupont?+?? Pierre'\nUNT+4+1'",
      },
      { kind: "envelope", text: "UNZ+1+REF1'" },
    ]);
  });
});

describe("editing a parsed interchange", () => {
  const parse = (bytes: Uint8Array) => {
    const [interchange] = parseInterchanges(bytes).interchanges;
    if (interchange === undefined) {
      throw new Error("no interchange");
    }
    return interchange;
  };

  it("follows an edit of the character set in the UNB", () => {
    const bytes = Uint8Array.from([
      ...bytesOf("UNB+UNOC:3+A+B'FTX+AAI+++Cr"),
      0xe8,
      ...bytesOf("me'"),
    ]);
    const data = interchangeData(parse(bytes));
    const edited = {
      ...data,
      segments: data.segments.map((segment) =>
        segment.tag === "UNB" ? { ...segment, elements: [["UNOW", "3"], "A", "B"] } : segment,
      ),
    };
    const out = serializeData(edited);
    expect([...out.subarray(-7)]).toEqual([...bytesOf("Cr"), 0xc3, 0xa8, ...bytesOf("me'")]);
    // ... and what it wrote is read back as the same text.
    expect(interchangeData(parse(out)).segments[1]?.elements?.[3]).toEqual(["Cr\u00e8me"]);
  });

  it("takes the line break of the first segment when the UNA string is followed by none", () => {
    const text = "UNA:+.? 'UNB+UNOA:3'\nUNZ+0+1'\n";
    expect(interchangeData(parse(bytesOf(text))).lineBreak).toBe("\n");
    expect(write(interchangeData(parse(bytesOf(text))))).toBe("UNA:+.? '\nUNB+UNOA:3'\nUNZ+0+1'\n");
  });
});

describe("serializeData: what a reader sees in the UNB", () => {
  const FTX_REPEATED: InterchangeData["segments"] = [
    { tag: "FTX", elements: [{ repetitions: [["A"], ["B"]] }] },
  ];

  it("decides syntax 4 as the tokenizer does, not from the text of the version", () => {
    const long = "A".repeat(40);
    // The reader does not see a UNB of version 4 here, so there is no repetition separator.
    for (const identifier of [long, "UN:OC"]) {
      const error = catchError(() =>
        serializeData({
          una: false,
          segments: [{ tag: "UNB", elements: [[identifier, "4"]] }, ...FTX_REPEATED],
        }),
      );
      expect(error.code).toBe("REPETITION_NOT_ALLOWED");
      expect(error.message).toMatch(/no repetition separator/);
      // ... and the characters of syntax 4 are not left for it to guess.
      expect(
        catchError(() =>
          serializeData({
            una: false,
            separators: SYNTAX_4_SEPARATORS,
            segments: [{ tag: "UNB", elements: [[identifier, "4"]] }],
          }),
        ).code,
      ).toBe("INVALID_SEPARATORS");
    }
    const parsed = parseInterchanges(bytesOf(`UNB+${long}:4+X'FTX+A*B'UNZ+1+X'`)).interchanges[0];
    const data = interchangeData(parsed as NonNullable<typeof parsed>);
    expect(textOf(serializeData(data))).toBe(`UNB+${long}:4+X'FTX+A*B'UNZ+1+X'`);
  });

  it("writes a UNB with fewer elements and components than a version needs", () => {
    for (const elements of [undefined, [], [[]], ["UNOA"], [["UNOA"]], [["UNOA", ""]]]) {
      const out = serializeData({
        una: false,
        segments: [{ tag: "UNB", ...(elements === undefined ? {} : { elements }) }],
      });
      expect(textOf(out).startsWith("UNB")).toBe(true);
    }
  });

  it("does not take a released colon in the identifier for the one that ends it", () => {
    // `UNB+X?:4:3+`: the reader sees a released colon, not version 4, so it would not guess an asterisk.
    const error = catchError(() =>
      serializeData({
        una: false,
        separators: SYNTAX_4_SEPARATORS,
        segments: [{ tag: "UNB", elements: [["X:4", "3"]] }],
      }),
    );
    expect(error.code).toBe("INVALID_SEPARATORS");
  });

  it("refuses to repeat when there is no repetition separator, and says so", () => {
    const error = catchError(() =>
      serializeData({
        separators: { ...DEFAULT_SEPARATORS, declared: true },
        segments: [{ tag: "UNB", elements: [["UNOA", "4"]] }, ...FTX_REPEATED],
      }),
    );
    expect(error.code).toBe("REPETITION_NOT_ALLOWED");
    expect(error.message).toMatch(/no repetition separator/);
  });

  it.each(["5", "", "04"])("refuses to repeat under a UNB that announces version %j", (version) => {
    const error = catchError(() =>
      serializeData({
        separators: SYNTAX_4_SEPARATORS,
        segments: [{ tag: "UNB", elements: [["UNOA", version]] }, ...FTX_REPEATED],
      }),
    );
    expect(error.code).toBe("REPETITION_NOT_ALLOWED");
    expect(error.message).toMatch(/announces syntax version/);
  });
});

describe("serializeData: the service characters and the input it is given", () => {
  const characters = {
    component: 0x3a,
    element: 0x2b,
    decimalMark: 0x2e,
    release: 0x3f,
    repetition: null,
    terminator: 0x27,
  };

  it("does not need the declared field of the service characters", () => {
    expect(write({ separators: characters, segments: [{ tag: "UNS" }] })).toBe("UNA:+.? 'UNS'");
  });

  it.each([
    ["too large", { component: 300 }],
    ["negative", { element: -1 }],
    ["fractional", { release: 63.5 }],
    ["not a number", { terminator: Number.NaN }],
    ["negative, and a valid byte once wrapped", { component: 59 - 256 }],
    ["a repetition separator that is not a byte", { repetition: 256 }],
  ])("refuses a service character that is %s", (_name, change) => {
    const error = catchError(() =>
      serializeData({ separators: { ...characters, ...change }, segments: [] }),
    );
    expect(error.code).toBe("INVALID_SEPARATORS");
  });

  it("writes a typed array from another realm, as a value and as a component", () => {
    const foreign = runInNewContext("new Uint8Array([65, 66])") as Uint8Array;
    expect(foreign instanceof Uint8Array).toBe(false);
    expect(write({ una: false, segments: [{ tag: "FTX", elements: [foreign, [foreign]] }] })).toBe(
      "FTX+AB+AB'",
    );
  });

  it("writes a long line break and a byte order mark, whatever the size of the buffer", () => {
    const lineBreak = "\n".repeat(3000);
    const out = serializeData({
      bom: true,
      lineBreak,
      segments: [{ tag: "UNS" }, { tag: "UNT" }],
    });
    expect(out.length).toBe(3 + 9 + 3000 + 4 + 3000 + 4 + 3000);
    expect(textOf(out.subarray(3))).toBe(`UNA:+.? '${lineBreak}UNS'${lineBreak}UNT'${lineBreak}`);
  });
});

describe("serializeData: the output limit", () => {
  it("stops before writing past it, at the segment that crosses it", () => {
    const error = catchError(() =>
      serializeData(
        { una: false, segments: [{ tag: "ABC", elements: ["X"] }, { tag: "DEF" }] },
        { maxBytes: 9 },
      ),
    );
    expect(error.code).toBe("OUTPUT_TOO_LARGE");
    expect(error.position).toEqual({ segment: 2, tag: "DEF", element: null, component: null });
  });

  it("counts the UNA string and the byte order mark", () => {
    const error = catchError(() => serializeData({ segments: [] }, { maxBytes: 8 }));
    expect(error.code).toBe("OUTPUT_TOO_LARGE");
    expect(error.position.tag).toBe("UNA");
    expect(serializeData({ segments: [] }, { maxBytes: 9 })).toHaveLength(9);
    expect(
      catchError(() => serializeData({ bom: true, una: false, segments: [] }, { maxBytes: 2 }))
        .code,
    ).toBe("OUTPUT_TOO_LARGE");
  });

  it("refuses a value larger than the limit without escaping it first", () => {
    const huge = new Uint8Array(5_000_000).fill(0x41);
    const error = catchError(() =>
      serializeData(
        { una: false, segments: [{ tag: "FTX", elements: [[huge]] }] },
        { maxBytes: 1000 },
      ),
    );
    expect(error.code).toBe("OUTPUT_TOO_LARGE");
    expect(error.position).toEqual({ segment: 1, tag: "FTX", element: 1, component: 1 });
  });
});

describe("serialize: a copy of each kind of tree", () => {
  it("shares no memory with the input, for an interchange, a message and an envelope", () => {
    const bytes = bytesOf(ORDER);
    const original = Uint8Array.from(bytes);
    const result = parseInterchanges(bytes);
    const [interchange] = result.interchanges;
    const items = [...parseMessages(bytes).items()];
    const trees = [interchange, ...items] as const;
    expect(items).toHaveLength(3);
    for (const tree of trees) {
      const out = serialize(tree as NonNullable<typeof tree>);
      expect(out.buffer).not.toBe(bytes.buffer);
      out.fill(0);
      expect([...bytes]).toEqual([...original]);
    }
  });
});
