import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, ApiError } from "../api";
import { TeacherWorkspace } from "../app-shell";
import type { TeacherReport } from "../types";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GradeView, RELOADED_REVIEW_NOTE, REPORT_FILTER_LABELS, ReportRowAction, STALE_REVIEW_HINT, reportRowAction, reportsEmptyState,
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
    expect(graded.visible).toBe("查看/改评");
    expect(graded.accessible).toBe("查看/改评：深度测试主学生");
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
      fireEvent.click(screen.getByRole("button", { name: /报告评阅 批改与打分/ }));
      fireEvent.click(await screen.findByRole("button", { name: "评阅报告：学生" }));
      const feedback = await screen.findByRole("textbox", { name: "评语（可空）" });
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
    globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "报告内容已更新，请重新加载后评阅" }), {
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

      expect((await screen.findByRole("alert")).textContent).toContain("报告内容已更新");
      const reload = screen.getByRole("button", { name: "载入最新报告" });
      expect(reload.getAttribute("aria-describedby")).toBeTruthy();
      expect(document.getElementById(reload.getAttribute("aria-describedby")!)?.textContent).toBe(STALE_REVIEW_HINT);
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
      spyOn(api.classroom, "grade").mockRejectedValue(new ApiError(409, "报告内容已更新，请重新加载后评阅", "409")),
      detail,
    ];
    const confirm = spyOn(window, "confirm").mockReturnValue(false);
    try {
      renderReports();
      fireEvent.click(screen.getByRole("button", { name: /报告评阅 批改与打分/ }));
      fireEvent.click(await screen.findByRole("button", { name: "评阅报告：学生" }));
      fireEvent.change(await screen.findByRole("spinbutton"), { target: { value: "88" } });
      fireEvent.change(screen.getByRole("textbox", { name: "评语（可空）" }), { target: { value: "保留的评语" } });
      fireEvent.click(screen.getByRole("button", { name: "提交评阅" }));
      fireEvent.click(await screen.findByRole("button", { name: "载入最新报告" }));
      const note = await screen.findByText(RELOADED_REVIEW_NOTE);
      expect(confirm).not.toHaveBeenCalled();
      expect(detail).toHaveBeenCalledTimes(2);
      expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("88");
      expect((screen.getByRole("textbox", { name: "评语（可空）" }) as HTMLTextAreaElement).value).toBe("保留的评语");
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
      fireEvent.click(screen.getByRole("button", { name: /报告评阅 批改与打分/ }));
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
      fireEvent.click(screen.getByRole("button", { name: "查看/改评：学生" }));
      fireEvent.click(await screen.findByRole("button", { name: "← 返回列表" }));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "查看/改评：学生" }));
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
      fireEvent.click(screen.getByRole("button", { name: /报告评阅 批改与打分/ }));
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

  test("a failed list load reads as Chinese and can be retried", async () => {
    const reports = spyOn(api.classroom, "reports").mockRejectedValue(new TypeError("Failed to fetch"));
    const spies = [
      reports,
      spyOn(api.classroom, "students").mockResolvedValue({ students: [] }),
      spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] }),
    ];
    try {
      renderReports();
      fireEvent.click(screen.getByRole("button", { name: /报告评阅 批改与打分/ }));
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
