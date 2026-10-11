import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, ApiError } from "../api";
import { TeacherWorkspace } from "../app-shell";
import type { TeacherReport } from "../types";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GRADE_RUBRIC, GradeView, RELOADED_REVIEW_NOTE, REPORT_FILTER_LABELS, ReportRowAction, STALE_REVIEW_HINT, UNCHANGED_REVIEW_HINT, reportRowAction, reportsEmptyState,
  reviewPosition,
} from "./reports";

afterEach(cleanup);

const report: TeacherReport = {
  account_id: 7,
  username: "student",
  display_name: "学生",
  student_no: "S-1",
  enrollments: [],
  markdown: "# report",
  provenance: {
    release_id: "a".repeat(32),
    session_version: "experiment-session-simple-v3",
    generated_at: "2026-08-13T00:00:00Z",
    years: [2020],
    session_fingerprint: "fingerprint",
    runs: [],
  },
  state: "graded",
  score: 90,
  feedback: "旧评语",
  graded_by: "teacher",
  generated_at: "2026-08-13T00:00:00Z",
  updated_at: "2026-08-13T00:00:00Z",
  submitted_at: "2026-08-13T00:01:00Z",
  graded_at: "2026-08-13T00:02:00Z",
};

describe("report list action names", () => {
  test("row accessible names contain the visible verb and stay off the filter labels", () => {
    const pending = reportRowAction({ state: "pending", display_name: "深度测试主学生" });
    const graded = reportRowAction({ state: "graded", display_name: "深度测试主学生" });
    expect(pending.visible).toBe("评阅报告");
    expect(pending.accessible).toBe("评阅报告：深度测试主学生");
    expect(pending.accessible.includes(pending.visible)).toBe(true);
    expect(graded.visible).toBe("查看或修改评分");
    expect(graded.accessible).toBe("查看或修改评分：深度测试主学生");
    expect(graded.accessible.includes(graded.visible)).toBe(true);
    for (const label of Object.values(REPORT_FILTER_LABELS)) {
      expect(label.includes(pending.visible)).toBe(false);
      expect(label.includes(graded.visible)).toBe(false);
    }
  });

  test("renders the student-specific accessible name on the row button", () => {
    const html = renderToStaticMarkup(
      <ReportRowAction report={{ state: "pending", display_name: "深度测试主学生" }} onOpen={() => {}} />,
    );
    expect(html).toContain("aria-label=\"评阅报告：深度测试主学生\"");
    expect(html).toContain("评阅报告");
    expect(html).not.toContain(">评阅<");
  });
});

describe("stale teacher report recovery", () => {
  test("guards workspace navigation, password changes, logout and unload without losing a cancelled draft", async () => {
    const pendingReport = { ...report, state: "pending" as const };
    const spies = [
      spyOn(api.classroom, "reports").mockResolvedValue({ reports: [pendingReport] }),
      spyOn(api.classroom, "reportDetail").mockResolvedValue(pendingReport),
      spyOn(api.classroom, "students").mockResolvedValue({ students: [] }),
      spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] }),
    ];
    const confirm = spyOn(window, "confirm").mockReturnValue(false);
    const logout = mock(() => {});
    const password = mock(() => {});
    let rejectSave!: (error: Error) => void;
    const grade = spyOn(api.classroom, "grade").mockReturnValue(new Promise((_resolve, reject) => { rejectSave = reject; }));
    try {
      render(<TeacherWorkspace user={{ username: "teacher", name: "老师", role: "teacher" }} meta={null}
        showPasswordChange={false} onRequestPasswordChange={password} onClosePasswordChange={() => {}}
        onPasswordChanged={() => {}} onLogout={logout} />);
      fireEvent.click(screen.getByRole("button", { name: /报告评阅 评阅与打分/ }));
      fireEvent.click(await screen.findByRole("button", { name: "评阅报告：学生" }));
      const feedback = await screen.findByRole("textbox", { name: "评语（选填）" });
      fireEvent.change(feedback, { target: { value: "不能丢失的评语" } });
      for (const name of [/学生与进度 账号/, /^修改密码$/, /^退出登录$/]) {
        fireEvent.click(screen.getByRole("button", { name }));
        expect((feedback as HTMLTextAreaElement).value).toBe("不能丢失的评语");
      }
      expect(confirm).toHaveBeenCalledTimes(3);
      expect(logout).not.toHaveBeenCalled();
      expect(password).not.toHaveBeenCalled();
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
      // Opening (then cancelling) password editing must not clear the review guard.
      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
      expect(password).toHaveBeenCalledTimes(1);
      confirm.mockReturnValue(false);
      fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
      expect(logout).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "提交评阅" }));
      const promptsBeforeSaving = confirm.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: /学生与进度 账号/ }));
      fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
      expect(confirm.mock.calls.length).toBe(promptsBeforeSaving);
      expect(logout).not.toHaveBeenCalled();
      expect((feedback as HTMLTextAreaElement).disabled).toBe(true);
      await act(async () => { rejectSave(new Error("保存失败")); });
      expect((feedback as HTMLTextAreaElement).value).toBe("不能丢失的评语");
      expect((feedback as HTMLTextAreaElement).disabled).toBe(false);
      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: /学生与进度 账号/ }));
      expect(screen.queryByRole("spinbutton")).toBeNull();
      const cleanUnload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(cleanUnload);
      expect(cleanUnload.defaultPrevented).toBe(false);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      confirm.mockRestore();
      grade.mockRestore();
    }
  });

  test("prompts for score or feedback edits, but not after reverting to the originals", () => {
    const confirm = spyOn(window, "confirm").mockReturnValue(false);
    const back = mock(() => {});
    try {
      render(<GradeView data={report} grader="teacher" onBack={back} onReload={() => {}} />);
      const score = screen.getByRole("spinbutton");
      const feedback = screen.getByRole("textbox");
      const leave = screen.getByRole("button", { name: "← 返回列表" });

      fireEvent.change(feedback, { target: { value: "仅修改评语" } });
      fireEvent.click(leave);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(back).not.toHaveBeenCalled();

      confirm.mockReturnValue(true);
      fireEvent.click(leave);
      expect(back).toHaveBeenCalledWith(false);

      back.mockClear();
      confirm.mockClear();
      fireEvent.change(feedback, { target: { value: report.feedback } });
      fireEvent.change(score, { target: { value: "91" } });
      fireEvent.change(score, { target: { value: String(report.score) } });
      fireEvent.click(leave);
      expect(confirm).not.toHaveBeenCalled();
      expect(back).toHaveBeenCalledWith(false);
    } finally {
      confirm.mockRestore();
    }
  });

  test("locks the submitted draft while saving and retains it after a network failure", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
    const grade = spyOn(api.classroom, "grade").mockReturnValue(pending);
    const backs: boolean[] = [];
    try {
      render(<GradeView data={report} grader="teacher" onBack={(changed) => backs.push(changed)} onReload={() => {}} />);
      const score = screen.getByRole("spinbutton") as HTMLInputElement;
      const feedback = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(score, { target: { value: "95" } });
      fireEvent.change(feedback, { target: { value: "本次未保存的评语" } });
      fireEvent.click(screen.getByRole("button", { name: "更新评阅" }));
      expect(score.disabled).toBe(true);
      expect(feedback.disabled).toBe(true);
      expect((screen.getByRole("button", { name: "← 返回列表" }) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => { reject(new Error("网络中断")); });
      expect((await screen.findByRole("alert")).textContent).toContain("网络中断");
      expect(score.disabled).toBe(false);
      expect(feedback.disabled).toBe(false);
      expect(score.value).toBe("95");
      expect(feedback.value).toBe("本次未保存的评语");
      expect(backs).toEqual([]);
      grade.mockResolvedValue({ ...report, score: 95, feedback: feedback.value });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "更新评阅" })); });
      expect(grade).toHaveBeenLastCalledWith(report.account_id, 95, "本次未保存的评语", report.updated_at);
      expect(backs).toEqual([true]);
    } finally {
      grade.mockRestore();
    }
  });

  test("announces a 409 and offers an explicit latest-report reload", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "老师甲刚把这份报告评为 84 分" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
    const reloads: unknown[] = [];
    const confirm = spyOn(window, "confirm").mockReturnValue(false);
    try {
      render(<GradeView data={report} grader="teacher" onBack={() => {}} onReload={(draft) => { reloads.push(draft); }} />);
      fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "77" } });
      const update = screen.getByRole("button", { name: "更新评阅" }) as HTMLButtonElement;
      fireEvent.click(update);

      const alert = await screen.findByRole("alert");
      // One message: the cause from the server, then what to do.
      expect(alert.textContent).toBe(`没有保存：老师甲刚把这份报告评为 84 分。${STALE_REVIEW_HINT}`);
      expect(document.querySelectorAll(".error-box")).toHaveLength(1);
      const reload = screen.getByRole("button", { name: "载入最新报告" });
      expect(reload.getAttribute("aria-describedby")).toBeTruthy();
      expect(document.getElementById(reload.getAttribute("aria-describedby")!)).toBe(alert);
      expect(update.disabled).toBe(true);
      fireEvent.click(reload);
      // Nothing is lost on reload, so there is no "leave" confirmation; the typed draft goes along.
      expect(confirm).not.toHaveBeenCalled();
      expect(reloads).toEqual([{ score: "77", feedback: report.feedback }]);
    } finally {
      globalThis.fetch = originalFetch;
      confirm.mockRestore();
    }
  });
});

describe("teacher review flow", () => {
  const pendingReport = { ...report, state: "pending" as const, score: null, feedback: "" };

  function renderReports() {
    return render(<TeacherWorkspace user={{ username: "teacher", name: "老师", role: "teacher" }} meta={null}
      showPasswordChange={false} onRequestPasswordChange={() => {}} onClosePasswordChange={() => {}}
      onPasswordChanged={() => {}} onLogout={() => {}} />);
  }

  test("a 409 reload keeps the typed score and feedback and says so", async () => {
    const newer = { ...pendingReport, markdown: "# newer", updated_at: "2026-08-14T00:00:00Z" };
    const detail = spyOn(api.classroom, "reportDetail").mockResolvedValueOnce(pendingReport).mockResolvedValue(newer);
    const spies = [
      spyOn(api.classroom, "reports").mockResolvedValue({ reports: [pendingReport] }),
      spyOn(api.classroom, "students").mockResolvedValue({ students: [] }),
      spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] }),
      spyOn(api.classroom, "grade").mockRejectedValue(new ApiError(409, "学生刚重新提交了报告", "409")),
      detail,
    ];
    const confirm = spyOn(window, "confirm").mockReturnValue(false);
    try {
      renderReports();
      fireEvent.click(screen.getByRole("button", { name: /报告评阅 评阅与打分/ }));
      fireEvent.click(await screen.findByRole("button", { name: "评阅报告：学生" }));
      fireEvent.change(await screen.findByRole("spinbutton"), { target: { value: "88" } });
      fireEvent.change(screen.getByRole("textbox", { name: "评语（选填）" }), { target: { value: "保留的评语" } });
      fireEvent.click(screen.getByRole("button", { name: "提交评阅" }));
      fireEvent.click(await screen.findByRole("button", { name: "载入最新报告" }));
      const note = await screen.findByText(RELOADED_REVIEW_NOTE);
      expect(confirm).not.toHaveBeenCalled();
      expect(detail).toHaveBeenCalledTimes(2);
      expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("88");
      expect((screen.getByRole("textbox", { name: "评语（选填）" }) as HTMLTextAreaElement).value).toBe("保留的评语");
      await waitFor(() => expect(document.activeElement).toBe(note));
      // Still an unsaved draft against the newer report: leaving asks.
      fireEvent.click(screen.getByRole("button", { name: "← 返回列表" }));
      expect(confirm).toHaveBeenCalledTimes(1);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      confirm.mockRestore();
    }
  });

  test("focus goes to the student heading on open, the form via the skip link, and back to the list after saving", async () => {
    const graded = { ...pendingReport, state: "graded" as const, score: 90 };
    const reports = spyOn(api.classroom, "reports").mockResolvedValue({ reports: [pendingReport] });
    const spies = [
      reports,
      spyOn(api.classroom, "reportDetail").mockResolvedValue(pendingReport),
      spyOn(api.classroom, "students").mockResolvedValue({ students: [] }),
      spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] }),
      spyOn(api.classroom, "grade").mockImplementation(async () => {
        reports.mockResolvedValue({ reports: [graded] });
        return graded;
      }),
    ];
    try {
      renderReports();
      fireEvent.click(screen.getByRole("button", { name: /报告评阅 评阅与打分/ }));
      fireEvent.click(await screen.findByRole("button", { name: "评阅报告：学生" }));
      const heading = await screen.findByRole("heading", { level: 3, name: "学生（student）" });
      await waitFor(() => expect(document.activeElement).toBe(heading));
      fireEvent.click(screen.getByRole("link", { name: "跳到评阅表单" }));
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3, name: /评阅$/ }));

      // An invalid score is tied to its input and focus returns there.
      const score = screen.getByRole("spinbutton") as HTMLInputElement;
      fireEvent.change(score, { target: { value: "120" } });
      fireEvent.click(screen.getByRole("button", { name: "提交评阅" }));
      const scoreError = screen.getByRole("alert");
      expect(scoreError.textContent).toBe("分数须为 0–100 的整数");
      expect(score.getAttribute("aria-invalid")).toBe("true");
      expect(score.getAttribute("aria-describedby")).toBe(scoreError.id);
      expect(document.activeElement).toBe(score);
      fireEvent.change(score, { target: { value: "90" } });
      expect(score.getAttribute("aria-invalid")).toBeNull();

      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "提交评阅" })); });
      // The report left 待评阅, so its row is gone: the list region gets focus instead of the page.
      const list = await screen.findByRole("region", { name: "报告提交列表，可横向滚动" });
      await waitFor(() => expect(document.activeElement).toBe(list));

      // Back to 全部: the row is there, open it and return without changes; focus lands on that row's button.
      fireEvent.click(screen.getByRole("button", { name: "全部" }));
      fireEvent.click(screen.getByRole("button", { name: "查看或修改评分：学生" }));
      fireEvent.click(await screen.findByRole("button", { name: "← 返回列表" }));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "查看或修改评分：学生" }));
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  test("the list refreshes on request and when the window becomes visible again", async () => {
    const reports = spyOn(api.classroom, "reports").mockResolvedValue({ reports: [] });
    const spies = [
      reports,
      spyOn(api.classroom, "students").mockResolvedValue({ students: [] }),
      spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] }),
    ];
    try {
      renderReports();
      fireEvent.click(screen.getByRole("button", { name: /报告评阅 评阅与打分/ }));
      await screen.findByText("还没有学生提交报告");
      reports.mockResolvedValue({ reports: [pendingReport] });
      fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
      expect(await screen.findByRole("button", { name: "评阅报告：学生" })).toBeTruthy();
      // The nav badge was refreshed too.
      await waitFor(() => expect(document.querySelector(".nav-badge")?.textContent).toBe("1"));

      reports.mockResolvedValue({ reports: [pendingReport, { ...pendingReport, account_id: 8, display_name: "新同学" }] });
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(await screen.findByRole("button", { name: "评阅报告：新同学" })).toBeTruthy();
      await waitFor(() => expect(document.querySelector(".nav-badge")?.textContent).toBe("2"));
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  test("the 待评阅 count follows the term filter; the sidebar badge stays the global count and says so", async () => {
    const semesters = [
      { id: 1, name: "2026 秋", is_active: true, student_count: 1, created_at: "2026-09-01",
        classes: [{ id: 11, term_id: 1, name: "一班", is_active: true, student_count: 1, created_at: "2026-09-01" }] },
      { id: 2, name: "2027 春", is_active: true, student_count: 0, created_at: "2027-02-01", classes: [] },
    ];
    const autumn = { ...pendingReport, account_id: 8, display_name: "秋季学生", enrollments: [{ term_id: 1, term_name: "2026 秋", class_id: 11, class_name: "一班" }] };
    const spies = [
      spyOn(api.classroom, "reports").mockResolvedValue({ reports: [pendingReport, autumn] }),
      spyOn(api.classroom, "students").mockResolvedValue({ students: [] }),
      spyOn(api.classroom, "semesters").mockResolvedValue({ semesters }),
    ];
    try {
      renderReports();
      fireEvent.click(screen.getByRole("button", { name: /报告评阅 评阅与打分/ }));
      await screen.findByRole("button", { name: "评阅报告：秋季学生" });
      const pill = () => screen.getByRole("button", { name: /^待评阅/ }).querySelector(".seg-badge")?.textContent ?? null;
      expect(pill()).toBe("2");
      await waitFor(() => expect(document.querySelector(".nav-badge")?.textContent).toBe("2"));

      fireEvent.change(await screen.findByLabelText("筛选学期"), { target: { value: "1" } });
      expect(pill()).toBe("1");
      fireEvent.change(screen.getByLabelText("筛选学期"), { target: { value: "2" } });
      expect(pill()).toBeNull();
      expect(screen.getByText("没有匹配的报告")).toBeTruthy();
      expect(screen.getByText("筛选范围外还有 2 份待评阅报告；请调整筛选条件或关键词")).toBeTruthy();
      // The sidebar keeps counting every pending report, and its name says it is not filtered.
      expect(document.querySelector(".nav-badge")?.textContent).toBe("2");
      const nav = screen.getByRole("button", { name: /报告评阅/, current: "page" });
      expect(nav.getAttribute("title")).toBe("报告评阅（全部学期、班级共 2 份待评阅）");
      expect(nav.textContent).toContain("全部学期、班级共 2 份待评阅");
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  test("a failed list load reads as Chinese and can be retried", async () => {
    const reports = spyOn(api.classroom, "reports").mockRejectedValue(new TypeError("Failed to fetch"));
    const spies = [
      reports,
      spyOn(api.classroom, "students").mockResolvedValue({ students: [] }),
      spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] }),
    ];
    try {
      renderReports();
      fireEvent.click(screen.getByRole("button", { name: /报告评阅 评阅与打分/ }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("报告列表加载失败：网络连接中断");
      expect(alert.textContent).not.toContain("Failed to fetch");
      reports.mockResolvedValue({ reports: [] });
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      expect(await screen.findByText("还没有学生提交报告")).toBeTruthy();
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

test("an emptied 待评阅 list says the work is done instead of asking to change the filter", () => {
  expect(reportsEmptyState(0, "pending", false).title).toBe("还没有学生提交报告");
  expect(reportsEmptyState(3, "pending", false).title).toBe("暂无待评阅报告");
  expect(reportsEmptyState(3, "pending", true).title).toBe("没有匹配的报告");
});

test("the review header marks an archived class and the feedback counter ignores surrounding blanks", () => {
  const enrolled: TeacherReport = { ...report, enrollments: [{ term_id: 1, term_name: "秋季", class_id: 2, class_name: "一班" }] };
  const semesters = [{ id: 1, name: "秋季", is_active: true, student_count: 1, created_at: "2026-09-24",
    classes: [{ id: 2, term_id: 1, name: "一班", is_active: false, student_count: 1, created_at: "2026-09-24" }] }];
  const { container } = render(<GradeView data={enrolled} grader="teacher" semesters={semesters} onBack={() => {}} onReload={() => {}} />);
  expect(container.querySelector(".review-topbar")?.textContent).toContain("秋季 · 一班（已归档）");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "      " } });
  expect(container.querySelector(".grade-count")?.textContent).toBe("评语 0 / 4000 字");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "  很好  " } });
  expect(container.querySelector(".grade-count")?.textContent).toBe("评语 2 / 4000 字");
});

test("the 评语 box comes before the rubric, so an open rubric never pushes it out of the panel", () => {
  const { container } = render(<GradeView data={report} grader="teacher" onBack={() => {}} onReload={() => {}} />);
  const textarea = container.querySelector(".grade-panel-body textarea")!;
  const rubric = container.querySelector(".grade-panel-body .grade-rubric")!;
  expect(textarea.compareDocumentPosition(rubric) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(textarea.getAttribute("rows")).toBe("6");
});

test("a report's place in its list gives 第 k / n 份 and its neighbours", () => {
  expect(reviewPosition([7, 8, 9], 7)).toEqual({ index: 0, total: 3, previous: null, next: 8 });
  expect(reviewPosition([7, 8, 9], 8)).toEqual({ index: 1, total: 3, previous: 7, next: 9 });
  expect(reviewPosition([7, 8, 9], 9)).toEqual({ index: 2, total: 3, previous: 8, next: null });
  expect(reviewPosition([7, 8, 9], 5)).toBeNull();
});

test("an unchanged graded review cannot be re-saved; a change re-enables it", () => {
  render(<GradeView data={report} grader="老师" onBack={() => {}} onReload={() => {}} />);
  const update = screen.getByRole("button", { name: "更新评阅" }) as HTMLButtonElement;
  expect(update.disabled).toBe(true);
  expect(screen.getByText(UNCHANGED_REVIEW_HINT)).toBeTruthy();
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "91" } });
  expect(update.disabled).toBe(false);
  expect(screen.queryByText(UNCHANGED_REVIEW_HINT)).toBeNull();
  expect(screen.getByText("评阅人：老师。学生重新生成报告后，本次评分会被清除。")).toBeTruthy();
});

test("graded rows get a secondary button; only reports still to grade get the solid one", () => {
  const graded = renderToStaticMarkup(<ReportRowAction report={{ state: "graded", display_name: "甲" }} onOpen={() => {}} />);
  const pending = renderToStaticMarkup(<ReportRowAction report={{ state: "pending", display_name: "乙" }} onOpen={() => {}} />);
  expect(graded).toContain('class="sm"');
  expect(pending).toContain('class="primary sm"');
});

describe("moving through the list while grading", () => {
  const pendingReport = { ...report, state: "pending" as const, score: null, feedback: "" };
  const queue = [7, 8, 9].map((id) => ({ ...pendingReport, account_id: id, username: `s${id}`, display_name: `学生${id}` }));

  function renderWorkspace() {
    return render(<TeacherWorkspace user={{ username: "teacher", name: "老师", role: "teacher" }} meta={null}
      showPasswordChange={false} onRequestPasswordChange={() => {}} onClosePasswordChange={() => {}}
      onPasswordChanged={() => {}} onLogout={() => {}} />);
  }

  test("保存并评阅下一份 saves and opens the next report of the filtered list; 上一份/下一份 keep the unsaved-changes guard", async () => {
    const grade = spyOn(api.classroom, "grade").mockImplementation(async (accountId) => ({ ...queue.find((item) => item.account_id === accountId)!, state: "graded" as const }));
    const spies = [
      grade,
      spyOn(api.classroom, "reports").mockResolvedValue({ reports: queue }),
      spyOn(api.classroom, "reportDetail").mockImplementation(async (accountId) => queue.find((item) => item.account_id === accountId)!),
      spyOn(api.classroom, "students").mockResolvedValue({ students: [] }),
      spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] }),
    ];
    const confirm = spyOn(window, "confirm").mockReturnValue(false);
    try {
      renderWorkspace();
      fireEvent.click(screen.getByRole("button", { name: /报告评阅 评阅与打分/ }));
      fireEvent.click(await screen.findByRole("button", { name: "评阅报告：学生7" }));
      await screen.findByRole("heading", { level: 3, name: "学生7（s7）" });
      expect(screen.getByText("第 1 / 3 份")).toBeTruthy();
      expect((screen.getByRole("button", { name: "‹ 上一份" }) as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "80" } });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存并评阅下一份" })); });
      expect(grade).toHaveBeenLastCalledWith(7, 80, "", report.updated_at);
      await screen.findByRole("heading", { level: 3, name: "学生8（s8）" });
      expect(screen.getByText("第 2 / 3 份")).toBeTruthy();

      // An unsaved draft asks before moving; cancelling keeps it.
      fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "70" } });
      fireEvent.click(screen.getByRole("button", { name: "下一份 ›" }));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("70");
      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "下一份 ›" }));
      await screen.findByRole("heading", { level: 3, name: "学生9（s9）" });
      expect(screen.getByText("第 3 / 3 份")).toBeTruthy();
      // The last report has no next: one plain save button, which returns to the list.
      expect((screen.getByRole("button", { name: "下一份 ›" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByRole("button", { name: "保存并评阅下一份" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "‹ 上一份" }));
      await screen.findByRole("heading", { level: 3, name: "学生8（s8）" });
      // The draft typed for 学生8 before leaving it was not carried over.
      expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("");
      expect(grade).toHaveBeenCalledTimes(1);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      confirm.mockRestore();
    }
  });

  test("a submitted report's status in 学生与进度 opens it in 报告评阅", async () => {
    const student = {
      id: 8, username: "s8", display_name: "学生8", student_no: "", demo_seed: false, last_login_at: null,
      created_at: "2026-09-01T00:00:00Z", report_state: "pending" as const, score: null, submitted_at: report.submitted_at,
      verified_completed_count: 15, verified_total_steps: 15, verified_completed_steps: [], completion_missing: [],
      last_valid_activity: null, enrollments: [],
    };
    const spies = [
      spyOn(api.classroom, "reports").mockResolvedValue({ reports: queue }),
      spyOn(api.classroom, "reportDetail").mockImplementation(async (accountId) => queue.find((item) => item.account_id === accountId)!),
      spyOn(api.classroom, "students").mockResolvedValue({ students: [student, { ...student, id: 3, username: "s3", display_name: "学生3", report_state: null }] }),
      spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] }),
    ];
    try {
      renderWorkspace();
      expect(screen.queryByRole("button", { name: /学生3（s3）$/ })).toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: "待评阅，打开报告：学生8（s8）" }));
      await screen.findByRole("heading", { level: 3, name: "学生8（s8）" });
      expect(document.title).toContain("报告评阅");
      expect(screen.getByText("第 1 / 1 份")).toBeTruthy();
      // Back goes where the teacher came from, and the button says so.
      expect(screen.queryByRole("button", { name: "← 返回列表" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "← 返回学生与进度" }));
      expect(await screen.findByRole("button", { name: "待评阅，打开报告：学生8（s8）" })).toBeTruthy();
      expect(document.title).toContain("学生与进度");
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "学生与进度" })));
      // Opened from the sidebar instead, the same report returns to the list.
      fireEvent.click(screen.getByRole("button", { name: /报告评阅 评阅与打分/ }));
      fireEvent.click(await screen.findByRole("button", { name: "评阅报告：学生8" }));
      fireEvent.click(await screen.findByRole("button", { name: "← 返回列表" }));
      expect(await screen.findByRole("button", { name: "评阅报告：学生8" })).toBeTruthy();
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

test("the rubric names the control group generically: with 38 untaxed countries it is not small", () => {
  const boundary = GRADE_RUBRIC.find(([title]) => title.startsWith("识别与边界"))?.[1] ?? "";
  expect(boundary).toContain("对照组的大小与可比性");
  expect(boundary).not.toContain("对照组少");
});

test("the rubric words the generated data as the student pages do, not as a simulation", () => {
  const boundary = GRADE_RUBRIC.find(([title]) => title.startsWith("识别与边界"))?.[1] ?? "";
  expect(boundary).toContain("由课程按设定生成");
  expect(boundary).toContain("汇率变动");
  expect(boundary).not.toContain("模拟");
});
