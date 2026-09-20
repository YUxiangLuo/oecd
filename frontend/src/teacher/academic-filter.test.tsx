import { describe, expect, test } from "bun:test";
import { matchesAcademicFilter, UNASSIGNED_CLASS } from "./academic-filter";

const enrollments = [
  { term_id: 1, term_name: "2026 春", class_id: 11, class_name: "1 班" },
  { term_id: 2, term_name: "2026 秋", class_id: 22, class_name: "2 班" },
];

describe("academic teacher filters", () => {
  test("distinguishes all, semester, class and unassigned students", () => {
    expect(matchesAcademicFilter(enrollments, null, null)).toBe(true);
    expect(matchesAcademicFilter(enrollments, 1, null)).toBe(true);
    expect(matchesAcademicFilter(enrollments, 1, 11)).toBe(true);
    expect(matchesAcademicFilter(enrollments, 1, 22)).toBe(false);
    expect(matchesAcademicFilter(enrollments, 1, UNASSIGNED_CLASS)).toBe(false);
    expect(matchesAcademicFilter([], 1, UNASSIGNED_CLASS)).toBe(true);
  });
});
