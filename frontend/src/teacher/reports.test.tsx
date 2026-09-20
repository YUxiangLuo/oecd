import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "../api";
import type { TeacherReport } from "../types";
import { renderToStaticMarkup } from "react-dom/server";
import { GradeView, REPORT_FILTER_LABELS, ReportRowAction, reportRowAction } from "./reports";

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
    let reloads = 0;
    try {
      render(<GradeView data={report} grader="teacher" onBack={() => {}} onReload={() => { reloads += 1; }} />);
      const update = screen.getByRole("button", { name: "更新评阅" }) as HTMLButtonElement;
      fireEvent.click(update);

      expect((await screen.findByRole("alert")).textContent).toContain("报告内容已更新");
      const reload = screen.getByRole("button", { name: "加载最新报告" });
      expect(update.disabled).toBe(true);
      fireEvent.click(reload);
      expect(reloads).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
