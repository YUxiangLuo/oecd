import { afterEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api";
import type { StudentRow } from "../types";
import { TeacherDashboard, teacherDocumentTitle } from "./index";
import { VALID_ACTIVITY_HINT } from "./students";
import { TeacherReviewGuardProvider } from "./review-guard";

afterEach(cleanup);

const row: StudentRow = {
  id: 1, username: "s1", display_name: "很长很长的名字".repeat(8), student_no: "", demo_seed: false, last_login_at: null,
  created_at: "2026-09-01T00:00:00Z", report_state: null, score: null, submitted_at: null,
  verified_completed_count: 0, verified_total_steps: 15, verified_completed_steps: [], completion_missing: [],
  last_valid_activity: null, enrollments: [],
};

test("each teacher tab titles the window, and the students table explains 有效活动", async () => {
  const spies = [
    spyOn(api.classroom, "reports").mockResolvedValue({ reports: [] }),
    spyOn(api.classroom, "students").mockResolvedValue({ students: [row] }),
    spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] }),
  ];
  try {
    render(<TeacherReviewGuardProvider><TeacherDashboard user={{ username: "teacher", name: "老师", role: "teacher" }} /></TeacherReviewGuardProvider>);
    await waitFor(() => expect(document.title).toBe(teacherDocumentTitle("students")));
    expect(document.title).toBe("学生与进度 · 教师工作台 · 供应链仿真系统 · GVC Simulation Lab");
    expect(screen.getByText("创建账号、分配班级并查看学生已完成的步骤")).toBeTruthy();

    const header = screen.getByRole("columnheader", { name: "有效活动" });
    expect(header.getAttribute("title")).toBe(VALID_ACTIVITY_HINT);
    expect(document.getElementById(header.getAttribute("aria-describedby")!)?.textContent).toContain(VALID_ACTIVITY_HINT);
    expect((await screen.findByText(row.display_name)).className).toContain("student-name-cell");

    fireEvent.click(screen.getByRole("button", { name: /学期与班级/ }));
    expect(document.title).toBe("学期与班级 · 教师工作台 · 供应链仿真系统 · GVC Simulation Lab");
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
});
