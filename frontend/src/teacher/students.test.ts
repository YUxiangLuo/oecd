import { describe, expect, test } from "bun:test";
import { PASSWORD_INPUT_PROPS, filterStudentsByStep } from "./students";
import type { StudentRow } from "../types";

const student = (id: number, maxStep: number, verified: number[]): StudentRow => ({
  id,
  username: `s${id}`,
  display_name: `学生${id}`,
  class_id: 1,
  class_name: "A",
  student_no: String(id),
  active: true,
  last_login_at: null,
  created_at: "",
  current_step: maxStep,
  max_step: maxStep,
  progress_at: null,
  submission_id: null,
  submission_state: null,
  score: null,
  submitted_at: null,
  verified_completed_count: verified.length,
  verified_completed_steps: verified,
  completion_missing: [],
  last_valid_activity: null,
});

describe("teacher progress filters", () => {
  const students = [student(1, 16, [1, 2]), student(2, 8, [1, 2, 3, 4, 5])];

  test("reached means navigation position, not completion", () => {
    expect(filterStudentsByStep(students, 12, "reached").map((item) => item.id)).toEqual([1]);
  });

  test("completed uses server-verified step ids", () => {
    expect(filterStudentsByStep(students, 5, "completed").map((item) => item.id)).toEqual([2]);
  });
});

describe("teacher password fields", () => {
  test("password creation/reset inputs are masked and opt out of old-password autofill", () => {
    expect(PASSWORD_INPUT_PROPS).toEqual({ type: "password", autoComplete: "new-password" });
  });
});
