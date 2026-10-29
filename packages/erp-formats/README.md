# @libredi/erp-formats

The files ERPs import and export. It writes documents (canonical documents, or what a mapping
gives) as CSV, fixed width, JSON or XML, and reads CSV and fixed width back into documents,
following a format configuration described in
[`contracts/erp-formats`](../../contracts/erp-formats/README.md). It knows nothing
about EDIFACT or mappings: the `translator` runs a mapping, then hands its result to a renderer,
or hands what a reader gives to a mapping.

## Use

```ts
import { loadCsvFormat, readCsv, renderCsv } from "@libredi/erp-formats";
import { parse } from "yaml";

const format = loadCsvFormat(parse(configurationText)); // throws a LayoutError listing problems
const files = renderCsv(format, [order]); // [{ name: "order-lines.csv", bytes }]
const documents = readCsv(format, { "order-lines.csv": bytes }); // one per document in the file
```

- `loadCsvFormat`, `loadFixedWidthFormat`, `loadJsonFormat` and `loadXmlFormat` check a
  configuration against its schema and the rules a schema cannot say (record types that cannot
  be told apart, overlapping paths, files that share no document field...) and fill in the
  defaults. They throw a
  `LayoutError` whose `problems` each have a JSON Pointer and a message.
- `renderCsv` and `renderFixedWidth` return one file per file of the format; `renderJson` and
  `renderXml` return the bytes of one file.
- `readCsv` and `readFixedWidth` take the bytes of each file of the format, by name, and return
  the documents.
- Reading or writing stops at the first problem with a `FormatError`: its `message` starts with
  the position in words, and `position` holds it as data (file, line, character, byte offset,
  record type, column, document and path).
- Decimal numbers stay strings from end to end and never go through floating point.

The schemas are imported, not read from disk, so a bundled service carries them.
