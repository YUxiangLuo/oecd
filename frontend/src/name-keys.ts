/** Comparison only: NFKC + per-code-point lowercase, not casefold/contextual lowercase.
 * Not a visual-homoglyph detector. Display typography and emoji stay untouched. */
export function nameKey(value: string): string {
  return [...value.normalize("NFKC")].map((char) => char.toLowerCase()).join("")
    .replace(/[\p{Default_Ignorable_Code_Point}\u3164\u115f\u1160\uffa0\u2800]/gu, "")
    .replace(/^[\s\u0085]+|[\s\u0085]+$/gu, "");
}
