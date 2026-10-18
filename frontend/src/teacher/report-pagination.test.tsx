import { afterEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api";
import type { TeacherReportSummary } from "../types";
import { TeacherDashboard } from "./index";
import { mockReports } from "./report-api-fixture";
import { ReportsTab } from "./reports";
import { TeacherReviewGuardProvider } from "./review-guard";

afterEach(cleanup);
const user = { username: "teacher", name: "老师", role: "teacher" };
const rows: TeacherReportSummary[] = Array.from({ length: 53 }, (_, i) => ({
  account_id: i + 1, username: `student${i}`, display_name: `学生${i}`, student_no: `N${i}`,
  enrollments: [], state: "pending", score: null, submitted_at: "2026-10-18T00:00:00Z",
  updated_at: "2026-10-18T00:00:00Z", report_outdated: false,
}));

test("dashboard fetches counts without downloading a report list", async () => {
  const fixture = mockReports(rows);
  const students = spyOn(api.classroom, "students").mockResolvedValue({ students: [] });
  const semesters = spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] });
  try {
    render(<TeacherReviewGuardProvider><TeacherDashboard user={user} /></TeacherReviewGuardProvider>);
    await waitFor(() => expect(document.querySelector(".nav-badge")?.textContent).toBe("53"));
    expect(fixture.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^学期与班级/ }));
    await screen.findByRole("heading", { name: "学期与班级" });
    expect(fixture.list).not.toHaveBeenCalled();
    await waitFor(() => expect(fixture.summary).toHaveBeenCalledTimes(2));
  } finally { fixture.mockRestore(); students.mockRestore(); semesters.mockRestore(); }
});

test("report pagination and search fetch the requested page and reset filters to page one", async () => {
  const fixture = mockReports(rows);
  const semesters = spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] });
  const detail = spyOn(api.classroom, "reportDetail");
  try {
    render(<ReportsTab user={user} />);
    await screen.findByText("共 53 份 · 第 1 / 3 页，每页 25 份");
    expect(screen.queryByRole("button", { name: "评阅报告：学生25" })).toBeNull();
    screen.getByRole("button", { name: "下一页" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByRole("button", { name: "评阅报告：学生25" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "报告提交列表，可横向滚动" })));
    expect(fixture.list.mock.calls.at(-1)?.[0]?.page).toBe(2);
    expect(screen.queryByRole("button", { name: "评阅报告：学生0" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("共 53 份 · 第 3 / 3 页，每页 25 份");
    expect(screen.getAllByRole("button", { name: /^评阅报告：/ })).toHaveLength(3);
    expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("搜索姓名、用户名或学号"), { target: { value: "学生51" } });
    await screen.findByText("共 1 份 · 第 1 / 1 页，每页 25 份");
    expect(fixture.list.mock.calls.at(-1)?.[0]).toMatchObject({ q: "学生51", page: 1, state: "pending" });
    expect(detail).not.toHaveBeenCalled();
  } finally { fixture.mockRestore(); semesters.mockRestore(); detail.mockRestore(); }
});
