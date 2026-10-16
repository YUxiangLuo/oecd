import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { AcademicSemester } from "../types";
import { AcademicFilters, matchesAcademicFilter, UNASSIGNED_CLASS } from "./academic-filter";

afterEach(cleanup);

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

  test("semesters and classes in use come first, archived ones after", () => {
    const group = (id: number, name: string, is_active: boolean) => ({ id, term_id: 2, name, is_active, student_count: 0, created_at: "2026-09-01" });
    const semester = (id: number, name: string, is_active: boolean, classes = [] as AcademicSemester["classes"]): AcademicSemester =>
      ({ id, name, is_active, student_count: 0, created_at: "2026-09-01", classes });
    const semesters = [
      semester(1, "2025 春", false),
      semester(2, "2026 秋", true, [group(21, "旧班", false), group(22, "一班", true)]),
      semester(3, "2025 秋", false),
      semester(4, "2026 春", true),
    ];
    const options = (name: string) => Array.from((screen.getByLabelText(name) as HTMLSelectElement).options).map((option) => option.textContent);
    render(<AcademicFilters semesters={semesters} semesterId={2} classId={null} onSemesterChange={() => {}} onClassChange={() => {}} />);
    expect(options("筛选学期")).toEqual(["全部学生", "2026 秋", "2026 春", "2025 春（已归档）", "2025 秋（已归档）"]);
    expect(options("筛选班级")).toEqual(["该学期全部已分班学生", "该学期未分班", "一班", "旧班（已归档）"]);
  });
});
