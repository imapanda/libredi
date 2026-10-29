# Validation errors

What the validator tells you when a file is wrong, and how to read it. The validator is
`validate(bytes)` in [`@libredi/edifact`](../packages/edifact/README.md); each problem it finds is
an **issue**, and an issue is made to answer four questions for someone who does not know EDIFACT.

| Question | Field | Example |
| --- | --- | --- |
| What is wrong? | `code`, `message` | `UNT_COUNT_MISMATCH`: UNT gives the number of segments as 13, but the message has 12 |
| Where? | `position`, `line`, `column`, `offset` | segment 23 (UNT), element 1; line 23, column 5 |
| What was expected, what was found? | `expected`, `found` | `12` and `13` |
| What do I do about it? | `hint` | Count the segments from UNH to UNT inclusive and write that number in the first element of UNT |

Other fields: `severity` (`error`: the message cannot be trusted as it is; `warning`: it can, but
something is off) and `layer` (the layer of the validator that found the problem; for
`MISSING_MANDATORY_ELEMENT` and `INVALID_DATA_TYPE` it is `envelope` when the segment is one of the
envelope, which is checked without a registry). `expected` and `found` are short phrases, and are
`null` when there is nothing to compare.

- **The codes are stable.** They are the names of the sample corpus
  ([`samples/edifact`](../samples/edifact/README.md)). A program may switch on `code`; renaming one
  is a breaking change. Messages and hints are English text for people: they may be improved
  without notice, so do not parse them.
- **Positions** are the ones of the registry and the corpus: `segment` is the 1-based number of the
  segment in the interchange (UNB is 1, the UNA string is 0); `element` and `component` are
  1-based, a composite counts as one element and an empty element counts; `repetition` is the
  1-based number of the repetition of an element that uses the syntax 4 repetition separator,
  counted from the second: `null` means the element itself, which is its first repetition, and
  `component` counts within the repetition. A field is `null` when the issue is about something
  larger: a whole segment, a whole element, or the whole file.
  For a segment that is missing, `segment` is the first segment after the gap, or the one after
  the last when the file ends.
- **One cause, one issue.** When a file stops being readable (a cut-off file, a bad UNA string, a
  message too large for the memory budget), the check ends there with that issue and does not add
  the consequences, such as every segment that is missing after the cut; the report says it is not
  `complete`. A missing composite is one issue, not one for each of its components.
- **The text of the file is quoted with care.** A reference or a count taken from the file is cut
  after 32 characters and its control characters are shown as `?`, so that a message can be put in
  a log as it is.
- `formatIssue(issue)` writes an issue as a block for a terminal or a log.
- **A partner can change the severity of a code**, for one flow, or drop it: see
  [Partner overrides](partner-overrides.md). The codes under File integrity cannot be changed.

## Catalogue

The messages below are examples, with the values of the file in the place of the words in braces
of the catalogue. The ones for file integrity are written by the reader of the file and name the
place in its own words.

### File integrity

Problems with the file itself, found while reading it: the UNA string, the segment tags, the
character set, a file that is cut off, a message too large to check.

#### `INVALID_UNA`

**The UNA service string is not valid.** Severity: error.

The UNA string, which declares the six service characters, uses a character that is not
punctuation, a decimal mark that is neither . nor ,, or the same character twice.

Message: The UNA service string is not valid: the component separator and the element separator
are both ':'.

What to do: Write UNA followed by six different punctuation marks: component separator, element
separator, decimal mark (. or ,), release character, repetition separator (a space before syntax
version 4) and segment terminator. The usual string is UNA:+.? '.

#### `UNEXPECTED_END_OF_FILE`

**The file ends too early.** Severity: error.

The file ends inside the UNA string, a segment tag or a segment, or right after a release
character. Everything delivered before is still checked, and what the cut took away is not
reported as missing.

Message: The file ends inside the NAD segment (segment 6): the segment terminator "'" is missing.

What to do: The file was probably cut off. Check that all of it was received or copied, and that
every segment ends with its terminator.

#### `INVALID_SEGMENT_TAG`

**A segment does not start with a valid tag.** Severity: error.

A segment does not begin with three capital letters or digits followed by the element separator or
the terminator.

Message: Segment 4 does not start with a valid tag: a tag is three capital letters or digits
followed by the element separator "+" or the segment terminator "'", but found "a".

What to do: A segment starts with a three-character tag such as BGM or NAD, then the element
separator or the terminator. Look for a stray character, a lowercase tag or a missing terminator
before this point.

#### `INVALID_CHARACTER`

**A character is not allowed in the character set.** Severity: error.

A value holds a byte that the character set named in UNB does not allow, such as a lowercase
letter in UNOA, a control character, or a broken UTF-8 sequence in UNOW.

Message: Invalid character in UNOA: "p" is not a character of UNOA.

What to do: Re-encode the file in the character set that UNB declares, or declare a wider one in
UNB: UNOB for lowercase letters, UNOC for Western European accents, UNOW (UTF-8) for any
character.

#### `UNSUPPORTED_CHARSET`

**The character set is not supported.** Severity: error.

The syntax identifier in UNB is not one of the character sets that are read: UNOA, UNOB, UNOC or
UNOW. Values are then read as ISO 8859-1 and not checked.

Message: The character set "UNOZ" is not supported (UNOA, UNOB, UNOC and UNOW are); values are
read as ISO 8859-1 and not checked.

What to do: Declare UNOA, UNOB, UNOC or UNOW in the first component of the first element of UNB,
and write the file in that set.

#### `MESSAGE_TOO_LARGE`

**A message is larger than the memory budget.** Severity: error.

A message, or a run of segments outside messages, needs more memory than the budget allows. The
check stops there; the file may be valid, only too large to check as it is.

Message: The message that starts here needs more than the memory budget of 67108864 bytes; raise
memoryBudget, or check that the file has the UNH and UNT segments it should.

What to do: Raise memoryBudget if the message really is that large. If it is not, a UNT is
probably missing, which makes the rest of the file one message.

#### `TOO_MANY_ELEMENT_REPETITIONS`

**An element is repeated too many times.** Severity: error.

An element has more than 65,535 repetitions. The check stops there.

Message: An element is repeated more than 65,535 times.

What to do: Look for a repetition separator used as ordinary text (write it with the release
character in front), or for a missing segment terminator.

### Envelopes

The segments that wrap the data: UNB and UNZ around an interchange, UNG and UNE around a group,
UNH and UNT around a message. Checked without a registry.

#### `UNSUPPORTED_SYNTAX_VERSION`

**The syntax version is not supported.** Severity: error.

The second component of the first element of UNB is not 3 or 4, the ISO 9735 syntax versions that
are read. An empty version is a missing mandatory element instead.

Message: UNB declares syntax version 9, which is not supported.

What to do: Use syntax version 3 or 4, as the second component of the first element of UNB (for
example UNOC:3).

#### `MISSING_ENVELOPE_SEGMENT`

**An envelope segment is missing.** Severity: error.

A message has no UNT, a group no UNE, an interchange no UNZ, or the messages are not preceded by a
UNB. The position is the segment found where the missing one belongs, or the one after the last
when the file ends.

Message: The UNT segment is missing.

What to do: Every UNB is closed by UNZ, every UNG by UNE and every UNH by UNT. Add the missing
segment, or check that the file was not cut off.

#### `UNEXPECTED_SEGMENT`

**A segment is where no segment can be.** Severity: error.

A segment that is not part of a message stands between messages, or UNT or UNE has nothing to
close.

Message: The BGM segment is between messages, where only the envelope segments UNB, UNG, UNE and
UNZ can be.

What to do: Segments other than the envelope segments belong between a UNH and its UNT. Move the
segment into its message, or remove it.

#### `UNT_COUNT_MISMATCH`

**UNT counts the wrong number of segments.** Severity: error.

The first element of UNT is not the number of segments of the message, UNH and UNT included.

Message: UNT gives the number of segments as 13, but the message has 12 (UNH and UNT included).

What to do: Count the segments from UNH to UNT inclusive and write that number in the first
element of UNT. A sender that edits a message by hand must update it.

#### `UNT_REFERENCE_MISMATCH`

**UNT closes another message than UNH opened.** Severity: error.

The message reference in UNT is not the one in UNH.

Message: UNT closes message 2, but UNH opened message 1.

What to do: Write the message reference of UNH (its first element) as the second element of UNT.

#### `UNE_COUNT_MISMATCH`

**UNE counts the wrong number of messages.** Severity: error.

The first element of UNE is not the number of messages in the group.

Message: UNE gives the number of messages in the group as 3, but the group has 2.

What to do: Write the number of messages between UNG and UNE in the first element of UNE.

#### `UNE_REFERENCE_MISMATCH`

**UNE closes another group than UNG opened.** Severity: error.

The group reference in UNE is not the one in UNG.

Message: UNE closes group G2, but UNG opened group G1.

What to do: Write the group reference of UNG (its fifth element) as the second element of UNE.

#### `UNZ_COUNT_MISMATCH`

**UNZ counts the wrong number of messages or groups.** Severity: error.

The first element of UNZ is not the number of messages in the interchange, or the number of groups
when it holds groups.

Message: UNZ gives the number of messages in the interchange as 2, but it has 1.

What to do: Write the number of messages (or of groups, if the interchange uses groups) between
UNB and UNZ in the first element of UNZ.

#### `UNZ_REFERENCE_MISMATCH`

**UNZ closes another interchange than UNB opened.** Severity: error.

The interchange control reference in UNZ is not the one in UNB.

Message: UNZ closes interchange IC999999, but UNB opened interchange IC000001.

What to do: Write the interchange control reference of UNB (its fifth element) as the second
element of UNZ.

### Message structure

Segment order, groups and how often a segment may occur, from the message structure of the
registry.

#### `MESSAGE_NOT_CHECKED`

**A message has no definition, so it was not checked.** Severity: warning.

Registries were given, but none describes the message type, version, release and agency that UNH
names. The structure and the data of that message are not checked; its envelope is.

Message: No definition of the message ORDERS D 96A UN is loaded, so its structure and its data
were not checked.

What to do: Load the registry of that directory (the one made from the UN/ECE files for the
version in UNH), or ignore this warning if the message is not meant to be checked.

#### `MISSING_MANDATORY_SEGMENT`

**A mandatory segment is missing.** Severity: error.

The message structure requires a segment (or a group, by its first segment) that the message does
not have. The position is the segment found where the missing one belongs: the next segment, or
UNT when the message ends.

Message: The mandatory BGM segment is missing before the DTM segment.

What to do: Add the segment where the message structure puts it. The order of the segments
matters: a segment in the wrong place can look like a missing one.

#### `TOO_MANY_REPETITIONS`

**A segment or group occurs too often.** Severity: error.

A segment, or a group (counted by its first segment), occurs more times in its place than the
message structure allows. The position is the first occurrence that is too many.

Message: The BGM segment occurs more often than the message allows: 2 occurrences, and at most 1
occurrence.

What to do: Remove the extra occurrences, or check that a segment that starts a new group is not
missing in between.

#### `SEGMENT_OUT_OF_ORDER`

**A segment is in the wrong place.** Severity: error.

A segment that the message structure has stands where the structure cannot continue with it: it
belongs before the segments that precede it, or in a group that has not started.

Message: The FTX segment is out of order: at this point the message can continue with NAD, LIN or
UNS.

What to do: Move the segment to its place in the message structure. Segments of a group follow the
segment that opens the group.

#### `UNKNOWN_SEGMENT`

**A segment is not part of the message.** Severity: error.

The segment is not in the structure of this message at all.

Message: The XYZ segment is not part of the structure of this message.

What to do: Remove the segment, or check the message type and version in UNH: this segment may
belong to another message.

### Data elements

The values: mandatory data, types and lengths, from the segment and data element definitions of
the registry.

#### `MISSING_MANDATORY_ELEMENT`

**A mandatory element or component is empty.** Severity: error.

A data element or component that the segment definition makes mandatory has no value. The envelope
segments (UNB, UNG, UNH, UNT, UNE, UNZ) have fixed definitions and are checked without a registry:
for them the issue has the layer `envelope`.

Message: The mandatory interchange control reference of the UNB segment is empty.

What to do: Give the element a value, even if the sender has nothing to say: a mandatory element
cannot be left out.

#### `INVALID_DATA_TYPE`

**A value is not of the right type.** Severity: error.

A value does not match the data type of its element: letters where digits are expected, or digits
where letters are expected. The counts of UNT, UNE and UNZ are checked without a registry: for
them the issue has the layer `envelope`.

Message: The LIN segment has ONE for line number (1082), but the value must be a number.

What to do: Check the value against the type of the element: numeric elements hold digits (and a
minus sign and the decimal mark of the UNA string), alphabetic elements hold letters.

#### `UNEXPECTED_ELEMENT`

**A segment has more elements than its definition.** Severity: error.

A segment has an element after the last one that its definition has.

Message: The BGM segment has 5 elements, but its definition has at most 4 elements.

What to do: Remove the extra elements, or check for a separator in a value that should have been
written with the release character in front.

#### `UNEXPECTED_COMPONENT`

**An element has more components than its definition.** Severity: error.

An element has a component after the last one that its definition has; a simple data element has
none. The position is that of the first component too many.

Message: The DTM segment has 4 components in an element that is defined with at most 3 components.

What to do: Remove the extra components, or write a component separator that is part of a value
with the release character in front.

#### `REPETITION_NOT_ALLOWED`

**An element is repeated in syntax version 3.** Severity: error.

An element uses the repetition separator, which only syntax version 4 has, and the interchange is
of an earlier version.

Message: The FTX segment repeats an element, which syntax version 3 does not allow.

What to do: Use syntax version 4 in UNB, or declare no repetition separator in the UNA string (a
space in its seventh position) and send the values in separate segments.

#### `ELEMENT_REPEATED_TOO_OFTEN`

**An element is repeated more often than allowed.** Severity: error.

An element has more repetitions than its definition allows.

Message: The FTX segment repeats an element 4 times, and the definition allows at most 3 times.

What to do: Remove the extra repetitions.

#### `VALUE_TOO_LONG`

**A value is longer than its element allows.** Severity: error.

A value has more characters than the maximum length of its data element.

Message: The BGM segment has 36 characters in document identifier (1004), where the element allows
35 characters at most.

What to do: Shorten the value to the length of the data element, or send it in a longer element if
the message has one.

#### `VALUE_TOO_SHORT`

**A value is shorter than its element requires.** Severity: error.

A value has fewer characters than the minimum length of its data element.

Message: The DTM segment has 6 characters in date value (2380), where the element needs 8
characters at least.

What to do: Write the value in full: fixed-length elements are not padded for you.

### Code lists

Coded values, against the code lists of the registry.

#### `UNKNOWN_CODE`

**A coded value is not in its code list.** Severity: error.

A value of an element that has a code list is not one of its codes. For a list that is only what
the directory knows (an open list) it is a warning, and only when the setting asks for it.

Message: The NAD segment has the code QQQ in party qualifier (3035), which is not in its code
list.

What to do: Use one of the codes of the list. The documentation of the message guideline of your
partner says which of them it uses.
