/** Client-side twins of the server's text normalization (gvcsim/classroom/routes.py). */

const ZERO_WIDTH = /[​‌‍⁠﻿]/g;
const EDGES = /^[\s​‌‍⁠﻿]+|[\s​‌‍⁠﻿]+$/g;

/** Trim whitespace and the zero-width characters / BOM a pasted roster often carries, at both ends only. */
export function stripInvisibleEdges(value: string): string {
  return value.replace(EDGES, "");
}

/**
 * Canonical label (semester/class name, 姓名, 学号) as the server stores it: NFKC (full-width letters and
 * digits become half-width), zero-width characters dropped everywhere, whitespace runs collapsed to one space.
 */
export function normalizeLabel(value: string): string {
  return value.normalize("NFKC").replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
}
