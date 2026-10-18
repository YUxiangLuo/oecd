import { mockReports } from "./report-api-fixture";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api";
import type { AcademicSemester, StudentRow } from "../types";
import { INITIAL_PASSWORD_HINT, TeacherDashboard, teacherDocumentTitle } from "./index";
import { FIRST_STEP_HINT, STARTED_HINT, VALID_ACTIVITY_HINT } from "./students";
import { TeacherReviewGuardProvider } from "./review-guard";

afterEach(cleanup);

const row: StudentRow = {
  id: 1, username: "s1", display_name: "很长很长的名字".repeat(8), student_no: "", demo_seed: false, last_login_at: null,
  created_at: "2026-09-01T00:00:00Z", report_state: null, report_outdated: false, score: null, submitted_at: null,
  verified_completed_count: 0, verified_total_steps: 15, verified_completed_steps: [], completion_missing: [],
  last_valid_activity: null, enrollments: [],
};

test("each teacher tab titles the window, and the students table explains 最近操作", async () => {
  const spies = [
    mockReports([]),
    spyOn(api.classroom, "students").mockResolvedValue({ students: [row] }),
    spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] }),
  ];
  try {
    render(<TeacherReviewGuardProvider><TeacherDashboard user={{ username: "teacher", name: "老师", role: "teacher" }} /></TeacherReviewGuardProvider>);
    await waitFor(() => expect(document.title).toBe(teacherDocumentTitle("students")));
    expect(document.title).toBe("学生与进度 · 教师工作台 · 供应链仿真系统 · GVC Simulation Lab");
    expect(screen.getByText("创建账号、分配班级并查看学生已完成的步骤")).toBeTruthy();

    const header = screen.getByRole("columnheader", { name: "最近操作" });
    expect(header.getAttribute("title")).toBe(VALID_ACTIVITY_HINT);
    expect(document.getElementById(header.getAttribute("aria-describedby")!)?.textContent).toContain(VALID_ACTIVITY_HINT);
    expect((await screen.findByText(row.display_name)).closest("td")?.className).toContain("student-name-cell");

    fireEvent.click(screen.getByRole("button", { name: /^学期与班级/ }));
    expect(document.title).toBe("学期与班级 · 教师工作台 · 供应链仿真系统 · GVC Simulation Lab");
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
});

const teacher = { username: "teacher", name: "老师", role: "teacher" } as const;

test("with no semester yet, 学生与进度 says to start in 学期与班级 and links there", async () => {
  const spies = [
    mockReports([]),
    spyOn(api.classroom, "students").mockResolvedValue({ students: [row] }),
    spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] }),
  ];
  try {
    render(<TeacherReviewGuardProvider><TeacherDashboard user={teacher} /></TeacherReviewGuardProvider>);
    expect((await screen.findByText(FIRST_STEP_HINT)).closest("[role=note]")).toBeTruthy();
    // The summary names the bucket by its rule, and its tooltip spells out that 0/15 can count as started.
    const started = screen.getByText("已开始（未提交）").closest("li")!;
    expect(started.getAttribute("title")).toBe(STARTED_HINT);
    expect(screen.queryByText("进行中")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "去“学期与班级”" }));
    expect(document.title).toBe(teacherDocumentTitle("semesters"));
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
});

test("调整班级 confirms the move in a toast; the first-step hint is gone once a semester exists", async () => {
  const semester: AcademicSemester = {
    id: 3, name: "2026 秋", is_active: true, created_at: "2026-09-01T00:00:00Z", student_count: 0,
    classes: [{ id: 7, term_id: 3, name: "国贸1班", is_active: true, created_at: "2026-09-01T00:00:00Z", student_count: 0 }],
  };
  const student = { ...row, display_name: "张三", last_login_at: "2026-10-08T15:55:00+09:00" };
  const spies = [
    mockReports([]),
    spyOn(api.classroom, "students").mockResolvedValue({ students: [student] }),
    spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [semester] }),
    spyOn(api.classroom, "setEnrollment").mockResolvedValue(undefined as never),
  ];
  const toasts: string[] = [];
  const listener = (event: Event) => toasts.push(String((event as CustomEvent<{ message: string }>).detail.message));
  window.addEventListener("gvcsim-toast", listener);
  try {
    render(<TeacherReviewGuardProvider><TeacherDashboard user={teacher} /></TeacherReviewGuardProvider>);
    await screen.findByText("张三");
    await waitFor(() => expect(api.classroom.semesters).toHaveBeenCalled());
    expect(screen.queryByText(FIRST_STEP_HINT)).toBeNull();
    // Narrow windows show only the date (CSS picks one of the two); the full time stays available.
    expect(document.querySelector(".time-cell .time-date")?.textContent).toBe("2026-10-08");
    expect(document.querySelector(".time-cell .time-date")?.getAttribute("title")).toBe("2026-10-08 15:55");

    fireEvent.click(screen.getByRole("button", { name: "调整班级：张三（s1）" }));
    await waitFor(() => expect(screen.getByLabelText("学期")).toBeTruthy());
    await waitFor(() => expect((screen.getByLabelText("学期") as HTMLSelectElement).value).toBe("3"));
    fireEvent.change(screen.getByLabelText("班级"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(toasts).toEqual(["已把 张三 分到“2026 秋 · 国贸1班”"]));
    expect(api.classroom.setEnrollment).toHaveBeenCalledWith(student.id, 3, 7);
  } finally {
    window.removeEventListener("gvcsim-toast", listener);
    spies.forEach((spy) => spy.mockRestore());
  }
});

test("a teacher still on the deployment's initial password is asked to change it, on every tab", async () => {
  const spies = [
    mockReports([]),
    spyOn(api.classroom, "students").mockResolvedValue({ students: [row] }),
    spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] }),
  ];
  const onChangePassword = mock(() => {});
  try {
    const user = { username: "teacher", name: "老师", role: "teacher", initial_password: true };
    const view = render(<TeacherReviewGuardProvider><TeacherDashboard user={user} onChangePassword={onChangePassword} /></TeacherReviewGuardProvider>);
    const note = await screen.findByText(INITIAL_PASSWORD_HINT);
    fireEvent.click(screen.getByRole("button", { name: /^学期与班级/ }));
    expect(screen.getByText(INITIAL_PASSWORD_HINT)).toBe(note);
    // Its own name: the top bar's 修改密码 stays the only button of that name.
    fireEvent.click(screen.getByRole("button", { name: "立即修改密码" }));
    expect(onChangePassword).toHaveBeenCalledTimes(1);
    // Once changed (the next login says so), or for the demo teacher (no handler), nothing is shown.
    view.rerender(<TeacherReviewGuardProvider><TeacherDashboard user={{ ...user, initial_password: false }} onChangePassword={onChangePassword} /></TeacherReviewGuardProvider>);
    expect(screen.queryByText(INITIAL_PASSWORD_HINT)).toBeNull();
    view.rerender(<TeacherReviewGuardProvider><TeacherDashboard user={user} /></TeacherReviewGuardProvider>);
    expect(screen.queryByText(INITIAL_PASSWORD_HINT)).toBeNull();
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
});
