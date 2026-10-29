import {
  exampleMessage,
  ISSUE_CATALOGUE,
  type IssueCode,
  type ValidationLayer,
} from "../issues.ts";

/*
 * docs/validation-errors.md is written from the catalogue by this function, and a test compares
 * the two, so that the page cannot drift from the code. To update the page after changing the
 * catalogue: LIBREDI_UPDATE_DOCS=1 pnpm --filter @libredi/edifact test
 */

const LAYERS: readonly [ValidationLayer, string, string][] = [
  [
    "tokenizer",
    "File integrity",
    "Problems with the file itself, found while reading it: the UNA string, the segment tags, the character set, a file that is cut off, a message too large to check.",
  ],
  [
    "envelope",
    "Envelopes",
    "The segments that wrap the data: UNB and UNZ around an interchange, UNG and UNE around a group, UNH and UNT around a message. Checked without a registry.",
  ],
  [
    "structure",
    "Message structure",
    "Segment order, groups and how often a segment may occur, from the message structure of the registry.",
  ],
  [
    "element",
    "Data elements",
    "The values: mandatory data, types and lengths, from the segment and data element definitions of the registry.",
  ],
  ["code", "Code lists", "Coded values, against the code lists of the registry."],
];

const WIDTH = 98;

function wrap(text: string, indent = ""): string {
  const lines: string[] = [];
  let line = indent;
  for (const word of text.split(" ")) {
    if (line.length + word.length + 1 > WIDTH && line.trim() !== "") {
      lines.push(line.trimEnd());
      line = indent;
    }
    line += `${line.trim() === "" ? "" : " "}${word}`;
  }
  lines.push(line.trimEnd());
  return lines.join("\n");
}

const INTRO = `# Validation errors

What the validator tells you when a file is wrong, and how to read it. The validator is
\`validate(bytes)\` in [\`@libredi/edifact\`](../packages/edifact/README.md); each problem it finds is
an **issue**, and an issue is made to answer four questions for someone who does not know EDIFACT.

| Question | Field | Example |
| --- | --- | --- |
| What is wrong? | \`code\`, \`message\` | \`UNT_COUNT_MISMATCH\`: UNT gives the number of segments as 13, but the message has 12 |
| Where? | \`position\`, \`line\`, \`column\`, \`offset\` | segment 23 (UNT), element 1; line 23, column 5 |
| What was expected, what was found? | \`expected\`, \`found\` | \`12\` and \`13\` |
| What do I do about it? | \`hint\` | Count the segments from UNH to UNT inclusive and write that number in the first element of UNT |

Other fields: \`severity\` (\`error\`: the message cannot be trusted as it is; \`warning\`: it can, but
something is off) and \`layer\` (the layer of the validator that found the problem; for
\`MISSING_MANDATORY_ELEMENT\` and \`INVALID_DATA_TYPE\` it is \`envelope\` when the segment is one of the
envelope, which is checked without a registry). \`expected\` and \`found\` are short phrases, and are
\`null\` when there is nothing to compare.

- **The codes are stable.** They are the names of the sample corpus
  ([\`samples/edifact\`](../samples/edifact/README.md)). A program may switch on \`code\`; renaming one
  is a breaking change. Messages and hints are English text for people: they may be improved
  without notice, so do not parse them.
- **Positions** are the ones of the registry and the corpus: \`segment\` is the 1-based number of the
  segment in the interchange (UNB is 1, the UNA string is 0); \`element\` and \`component\` are
  1-based, a composite counts as one element and an empty element counts; \`repetition\` is the
  1-based number of the repetition of an element that uses the syntax 4 repetition separator,
  counted from the second: \`null\` means the element itself, which is its first repetition, and
  \`component\` counts within the repetition. A field is \`null\` when the issue is about something
  larger: a whole segment, a whole element, or the whole file.
  For a segment that is missing, \`segment\` is the first segment after the gap, or the one after
  the last when the file ends.
- **One cause, one issue.** When a file stops being readable (a cut-off file, a bad UNA string, a
  message too large for the memory budget), the check ends there with that issue and does not add
  the consequences, such as every segment that is missing after the cut; the report says it is not
  \`complete\`. A missing composite is one issue, not one for each of its components.
- **The text of the file is quoted with care.** A reference or a count taken from the file is cut
  after 32 characters and its control characters are shown as \`?\`, so that a message can be put in
  a log as it is.
- \`formatIssue(issue)\` writes an issue as a block for a terminal or a log.
- **A partner can change the severity of a code**, for one flow, or drop it: see
  [Partner overrides](partner-overrides.md). The codes under File integrity cannot be changed.
`;

export function catalogueMarkdown(): string {
  const out: string[] = [
    INTRO.trimEnd(),
    "",
    "## Catalogue",
    "",
    wrap(
      "The messages below are examples, with the values of the file in the place of the words in braces of the catalogue. The ones for file integrity are written by the reader of the file and name the place in its own words.",
    ),
    "",
  ];
  for (const [layer, title, about] of LAYERS) {
    const codes = (Object.keys(ISSUE_CATALOGUE) as IssueCode[]).filter(
      (code) => ISSUE_CATALOGUE[code].layer === layer,
    );
    if (codes.length === 0) {
      continue;
    }
    out.push(`### ${title}`, "", wrap(about), "");
    for (const code of codes) {
      const info = ISSUE_CATALOGUE[code];
      out.push(
        `#### \`${code}\``,
        "",
        `**${info.title}.** Severity: ${info.severity}.`,
        "",
        wrap(info.meaning),
        "",
        wrap(`Message: ${exampleMessage(code)}`),
        "",
        wrap(`What to do: ${info.hint}`),
        "",
      );
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}
