import { describe, expect, test } from "bun:test";
import { assignmentContextLabel } from "./assignment-context";
import type { StudentAssignmentContext } from "./types";

function context(patch: Partial<StudentAssignmentContext> = {}): StudentAssignmentContext {
  return {
    course_run_id: 1,
    course_run_code: "GVC",
    course_run_name: "GVC 实验课",
    course_run_term: "2026 秋",
    course_run_archived: false,
    assignment_id: 2,
    assignment_slug: "main",
    assignment_title: "16 步实验",
    assignment_manifest_id: "manifest",
    assignment_active: true,
    opens_at: null,
    due_at: null,
    enrollment_active: true,
    attempt_id: 3,
    attempt_no: 1,
    attempt_state: "active",
    current_step: 16,
    max_step: 16,
    submission_state: "graded",
    score: 92,
    feedback: "很好",
    graded_at: "2026-07-23T00:00:00Z",
    submitted_at: "2026-07-22T00:00:00Z",
    selected: true,
    historical: false,
    assignment_closed: false,
    ...patch,
  };
}

describe("assignmentContextLabel", () => {
  test("已评阅作业的分数在选择器中可见", () => {
    expect(assignmentContextLabel(context())).toContain("已评分 92");
  });

  test("历史作业有明确标记", () => {
    expect(assignmentContextLabel(context({ historical: true }))).toEndWith("·历史");
  });
});
