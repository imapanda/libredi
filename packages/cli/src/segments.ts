import type { Segment } from "@libredi/edifact";
import { plain } from "./plain.ts";

/** The values of a segment: for each element its repetitions, for each repetition its components. */
export function valuesOf(segment: Segment): string[][][] {
  return segment.elements.map((element) =>
    element.repetitions.map((repetition) => repetition.map((component) => component.text())),
  );
}

/**
 * `1=220  2=PO-0001`: the elements that have a value, by position, components joined with ":" and
 * repetitions with "*". It is for reading, not for writing back: the release characters are gone.
 */
export function describeElements(segment: Segment): string {
  const parts: string[] = [];
  for (const [i, element] of valuesOf(segment).entries()) {
    const text = element
      .map((repetition) => {
        const components = [...repetition];
        while (components.length > 0 && components[components.length - 1] === "") {
          components.pop();
        }
        return components.join(":");
      })
      .join("*");
    if (text !== "") {
      parts.push(`${i + 1}=${plain(text)}`);
    }
  }
  return parts.join("  ");
}
