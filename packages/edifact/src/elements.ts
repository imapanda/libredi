import type { IssueSink } from "./envelope.ts";
import { type IssueDraft, shown } from "./issues.ts";
import type { LineColumn } from "./line-index.ts";
import type { ElementDef, PositionDef, SegmentDef } from "./registry.ts";
import type { Component, MessageInterchange, Segment } from "./tree.ts";

/*
 * Data element validation: the values of a segment against the definition of the registry. For each
 * position of the segment: whether a mandatory element or component has a value, whether an
 * element is repeated as often as it may be and whether the syntax version has repetition at all,
 * and for each value its type, its length, and its code list.
 *
 * It looks at the bytes of a value and makes a string of it only where it has to: a value with a
 * release character or outside ASCII, or one that is looked up in a code list.
 */

/** Which code lists are enforced. */
export type CodeListCheck = "closed" | "all" | "off";

export interface ElementContext {
  readonly interchange: MessageInterchange;
  readonly sink: IssueSink;
  readonly locate: (offset: number) => LineColumn;
  readonly codeLists: CodeListCheck;
}

const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const MINUS = 0x2d;

/** What is known of a value without making a string of it. */
interface Measure {
  /** Characters, by the rules of the type: digits only for a number. */
  length: number;
  /** The value, when the bytes were not enough to judge it (release characters, non-ASCII). */
  text: string | null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function checkSegment(segment: Segment, def: SegmentDef, context: ElementContext): void {
  const { sink, locate } = context;
  const elements = segment.elements;
  const positions = def.positions;
  const at = (
    element: number,
    component: number | null,
    repetition: number | null,
  ): Pick<IssueDraft, "segment" | "tag" | "element" | "component" | "repetition"> => ({
    segment: segment.number,
    tag: segment.tag,
    element,
    component,
    repetition,
  });

  for (let p = 0; p < positions.length; p++) {
    const position = positions[p] as PositionDef;
    const element = elements[p];
    const repetitions = element?.repetitions ?? [];
    const present = repetitions.some((components) => components.some((c) => !c.empty));
    if (!present) {
      if (position.mandatory) {
        sink.add(
          {
            ...at(p + 1, null, null),
            code: "MISSING_MANDATORY_ELEMENT",
            expected: position.label,
            found: "nothing",
            offset: element?.start ?? segment.end - 1,
          },
          locate,
        );
      }
      continue;
    }
    // Repetitions that are empty at the end are separators with nothing after them: not repetitions.
    let used = repetitions.length;
    while (used > 1 && isEmpty([repetitions[used - 1] as Component[]])) {
      used--;
    }
    if (used > 1) {
      const version = context.interchange.syntaxVersion;
      if (version !== null && version !== "4") {
        sink.add(
          {
            ...at(p + 1, null, 2),
            code: "REPETITION_NOT_ALLOWED",
            found: version,
            offset: repetitions[1]?.[0]?.start ?? segment.start,
          },
          locate,
        );
      } else if (used > position.maxOccurs) {
        sink.add(
          {
            ...at(p + 1, null, position.maxOccurs + 1),
            code: "ELEMENT_REPEATED_TOO_OFTEN",
            expected: `at most ${position.maxOccurs === 1 ? "once" : `${position.maxOccurs} times`}`,
            found: `${used} times`,
            offset: repetitions[position.maxOccurs]?.[0]?.start ?? segment.start,
          },
          locate,
        );
      }
    }
    for (let r = 0; r < repetitions.length; r++) {
      const components = repetitions[r] as Component[];
      const repetition = r > 0 ? r + 1 : null;
      if (position.components === null) {
        simple(
          segment,
          position,
          components,
          p + 1,
          repetition,
          context,
          element?.start ?? segment.end - 1,
        );
      } else {
        composite(
          segment,
          position,
          components,
          p + 1,
          repetition,
          context,
          element?.end ?? segment.end - 1,
        );
      }
    }
  }

  const extra = elements.findIndex((e, i) => i >= positions.length && !isEmpty(e.repetitions));
  if (extra >= 0) {
    sink.add(
      {
        ...at(extra + 1, null, null),
        code: "UNEXPECTED_ELEMENT",
        expected: `at most ${plural(positions.length, "element")}`,
        found: plural(elements.length - trailingEmpty(elements), "element"),
        offset: elements[extra]?.start ?? segment.start,
      },
      locate,
    );
  }
}

/** How many components there are once the empty ones at the end are left out. */
function usedComponents(components: readonly Component[]): number {
  let n = components.length;
  while (n > 0 && (components[n - 1] as Component).empty) {
    n--;
  }
  return n;
}

function isEmpty(repetitions: readonly (readonly Component[])[]): boolean {
  return repetitions.every((components) => components.every((c) => c.empty));
}

function trailingEmpty(elements: readonly { repetitions: Component[][] }[]): number {
  let n = 0;
  while (
    n < elements.length &&
    isEmpty((elements[elements.length - 1 - n] as { repetitions: Component[][] }).repetitions)
  ) {
    n++;
  }
  return n;
}

function simple(
  segment: Segment,
  position: PositionDef,
  components: readonly Component[],
  element: number,
  repetition: number | null,
  context: ElementContext,
  elementStart: number,
): void {
  const value = components[0];
  const where = { segment: segment.number, tag: segment.tag, element, component: null, repetition };
  if (value !== undefined && !value.empty && position.element !== null) {
    checkValue(position.element, value, where, context);
  } else if (position.mandatory && repetition === null) {
    context.sink.add(
      {
        ...where,
        code: "MISSING_MANDATORY_ELEMENT",
        expected: position.label,
        found: "nothing",
        offset: value?.start ?? elementStart,
      },
      context.locate,
    );
  }
  const extra = components.findIndex((c, i) => i > 0 && !c.empty);
  if (extra >= 0) {
    context.sink.add(
      {
        ...where,
        component: extra + 1,
        code: "UNEXPECTED_COMPONENT",
        expected: "no components",
        found: plural(usedComponents(components), "component"),
        offset: components[extra]?.start ?? segment.start,
      },
      context.locate,
    );
  }
}

function composite(
  segment: Segment,
  position: PositionDef,
  components: readonly Component[],
  element: number,
  repetition: number | null,
  context: ElementContext,
  elementEnd: number,
): void {
  const defs = position.components ?? [];
  if (components.every((c) => c.empty)) {
    return; // an empty repetition: the element as a whole is judged by its status
  }
  for (let c = 0; c < defs.length; c++) {
    const def = defs[c];
    const component = components[c];
    if (def === undefined) {
      break;
    }
    const where = {
      segment: segment.number,
      tag: segment.tag,
      element,
      component: c + 1,
      repetition,
    };
    if (component === undefined || component.empty) {
      if (def.mandatory) {
        context.sink.add(
          {
            ...where,
            code: "MISSING_MANDATORY_ELEMENT",
            expected: def.element.label,
            found: "nothing",
            offset: component?.start ?? elementEnd,
          },
          context.locate,
        );
      }
      continue;
    }
    checkValue(def.element, component, where, context);
  }
  const extra = components.findIndex((comp, i) => i >= defs.length && !comp.empty);
  if (extra >= 0) {
    context.sink.add(
      {
        segment: segment.number,
        tag: segment.tag,
        element,
        component: extra + 1,
        repetition,
        code: "UNEXPECTED_COMPONENT",
        expected: `at most ${plural(defs.length, "component")}`,
        found: plural(usedComponents(components), "component"),
        offset: components[extra]?.start ?? segment.start,
      },
      context.locate,
    );
  }
}

type Where = Pick<IssueDraft, "segment" | "tag" | "element" | "component" | "repetition">;

/** One value against its data element: type, then length, then code list. */
function checkValue(
  def: ElementDef,
  component: Component,
  where: Where,
  context: ElementContext,
): void {
  const { sink, locate, interchange } = context;
  const measure = measureOf(def, component, interchange);
  if (measure === null) {
    sink.add(
      {
        ...where,
        code: "INVALID_DATA_TYPE",
        name: def.label,
        expected:
          def.type === "n"
            ? `a number (digits, with "${String.fromCharCode(interchange.separators.decimalMark)}" as the decimal mark)`
            : "letters only",
        found: shown(component.text()),
        offset: component.start,
      },
      locate,
    );
    return;
  }
  if (measure.length > def.max) {
    sink.add(
      {
        ...where,
        code: "VALUE_TOO_LONG",
        name: def.label,
        expected: plural(def.max, "character"),
        found: plural(measure.length, "character"),
        offset: component.start,
      },
      locate,
    );
    return;
  }
  if (measure.length < def.min) {
    sink.add(
      {
        ...where,
        code: "VALUE_TOO_SHORT",
        name: def.label,
        expected: plural(def.min, "character"),
        found: plural(measure.length, "character"),
        offset: component.start,
      },
      locate,
    );
    return;
  }
  const codes = def.codes;
  if (
    codes !== null &&
    context.codeLists !== "off" &&
    (codes.closed || context.codeLists === "all")
  ) {
    const text = measure.text ?? component.text();
    if (!Object.hasOwn(codes.codes, text)) {
      sink.add(
        {
          ...where,
          code: "UNKNOWN_CODE",
          name: def.label,
          found: shown(text),
          severity: codes.closed ? "error" : "warning",
          ...(codes.closed
            ? {}
            : {
                message: `The ${where.tag} segment has the code ${shown(text)} in ${def.label}, which is not in its code list; the list is open (the directory only knows some of the codes), so the code may still be right.`,
              }),
          offset: component.start,
        },
        locate,
      );
    }
  }
}

/**
 * The length of a value in characters, or null when its type is wrong. A number is digits with
 * an optional minus sign in front and one decimal mark, and its length is that of the digits.
 */
function measureOf(
  def: ElementDef,
  component: Component,
  interchange: MessageInterchange,
): Measure | null {
  const bytes = interchange.source;
  const { release, decimalMark } = interchange.separators;
  let length = 0;
  let plain = true; // ASCII with no release character: the bytes are the characters
  let marks = 0;
  const end = component.end;
  for (let i = component.start; i < end; i++) {
    const byte = bytes[i] as number;
    if (byte === release || byte > 0x7f) {
      plain = false;
      break;
    }
  }
  if (!plain) {
    const text = component.text();
    let chars = 0;
    for (const _char of text) {
      chars++;
    }
    return typeCheck(def, text, decimalMark) ? { length: lengthOf(def, text, chars), text } : null;
  }
  if (def.type === "an") {
    return { length: end - component.start, text: null };
  }
  for (let i = component.start; i < end; i++) {
    const byte = bytes[i] as number;
    if (def.type === "n") {
      if (byte >= DIGIT_0 && byte <= DIGIT_9) {
        length++;
      } else if (byte === decimalMark && marks === 0) {
        marks++;
      } else if (!(byte === MINUS && i === component.start)) {
        return null;
      }
    } else if (!((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))) {
      return null;
    } else {
      length++;
    }
  }
  // A sign or a decimal mark alone is not a number.
  return def.type === "n" && length === 0 ? null : { length, text: null };
}

const LETTER = /^[\p{L}\p{M}]+$/u;

/** The slow path of the type, for text that is not plain ASCII. */
function typeCheck(def: ElementDef, text: string, decimalMark: number): boolean {
  if (def.type === "an") {
    return true;
  }
  if (def.type === "a") {
    return LETTER.test(text);
  }
  const mark = String.fromCharCode(decimalMark);
  let marks = 0;
  let digits = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (char >= "0" && char <= "9") {
      digits++;
    } else if (char === mark && marks === 0) {
      marks++;
    } else if (!(char === "-" && i === 0)) {
      return false;
    }
  }
  return digits > 0;
}

function lengthOf(def: ElementDef, text: string, chars: number): number {
  if (def.type !== "n") {
    return chars;
  }
  let digits = 0;
  for (const char of text) {
    if (char >= "0" && char <= "9") {
      digits++;
    }
  }
  return digits;
}
