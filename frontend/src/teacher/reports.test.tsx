import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TeacherReport } from "../types";
import { renderToStaticMarkup } from "react-dom/server";
import { GradeView, REPORT_FILTER_LABELS, ReportRowAction, reportRowAction } from "./reports";

afterEach(cleanup);

const report: TeacherReport = {
  account_id: 7,
  username: "student",
  display_name: "学生",
  student_no: "S-1",
  markdown: "# report",
  provenance: {
    release_id: "a".repeat(32),
    session_version: "experiment-session-simple-v2",
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
