import { describe, expect, test } from "bun:test";
import { activeEnrollmentAccountIds, assignmentMatchesManifest, buildAssignmentPayload } from "./course-model";
import type { Assignment, EnrollmentRow } from "../types";

describe("teacher assignment publishing model", () => {
  test("always binds a new assignment to the server-supplied current manifest", () => {
    const payload = buildAssignmentPayload({
      slug: " lab-1 ", title: " 实验一 ", releaseTag: " r1 ", opensAt: "", dueAt: "",
    }, 8, "manifest-current");
    expect(payload).toEqual({
      course_run_id: 8,
      slug: "lab-1",
      title: "实验一",
      manifest_id: "manifest-current",
      release_tag: "r1",
      opens_at: null,
      due_at: null,
    });
  });

  test("flags an assignment frozen to another artifact set", () => {
    const assignment = { manifest_id: "old" } as Assignment;
    expect(assignmentMatchesManifest(assignment, "current")).toBe(false);
    expect(assignmentMatchesManifest({ ...assignment, manifest_id: "current" }, "current")).toBe(true);
  });

  test("uses persistent active enrollments rather than guessing from a student's current attempt", () => {
    const rows = [
      { account_id: 10, active: true },
      { account_id: 11, active: false },
    ] as EnrollmentRow[];
    expect([...activeEnrollmentAccountIds(rows)]).toEqual([10]);
  });
});
