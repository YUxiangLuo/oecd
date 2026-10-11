/** Client-side twins of the server's text normalization (gvcsim/classroom/routes.py). */

const ZERO_WIDTH = /[​‌‍⁠﻿]/g;
const EDGES = /^[\s​‌‍⁠﻿]+|[\s​‌‍⁠﻿]+$/g;

/** Trim whitespace and the zero-width characters / BOM a pasted roster often carries, at both ends only. */
export function stripInvisibleEdges(value: string): string {
  return value.replace(EDGES, "");
}

/** Full-width punctuation (！＂＃…／ ：；…＠ ［＼…｀ ｛｜｝～｟｠), split out as runs: Chinese is written with it. */
const FULLWIDTH_PUNCTUATION = /([\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff60]+)/;

/**
 * Canonical label (semester/class name, 姓名, 学号) as the server stores it: NFKC (full-width letters and
 * digits become half-width) except full-width punctuation, kept as typed (“王五（转专业）”); zero-width
 * characters dropped everywhere, whitespace runs collapsed to one space.
 */
export function normalizeLabel(value: string): string {
  const folded = value.split(FULLWIDTH_PUNCTUATION).map((part, index) => (index % 2 ? part : part.normalize("NFKC"))).join("");
  return folded.replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
}

/**
 * What a teacher's search compares: the label with full-width punctuation folded as well, case-folded. Names keep
 * their Chinese punctuation as typed, but rows stored before that rule have it folded to ASCII, so “王五（” must also
 * find “王五(转专业)” (and the other way round).
 */
export function searchKey(value: string): string {
  return value.normalize("NFKC").replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim().toLowerCase();
}
