import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api, ApiError } from "../../api";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastHost } from "../../toast";
import { ReportOutro } from "../../report-outro";
import type { ClassroomReport, ReportMutationResponse } from "../../types";
import {
  GateCard,
  REPORT_REFLECTION_INCOMPLETE_SELECTOR,
  ReportLab,
  ReportStatus,
  activateReportGateDestination,
  focusReportGateDestination,
  reflectionCountLabel,
  reportGenerateButtonLabel,
  reportGenerateLabel,
  reportWaitLabel,
  summarizeReportGate,
  reflectionLength,
  limitInsertion,
  codePointLength,
  REFLECTION_MAX_LENGTH,
  reportConflictMessage,
  reportOutdatedAdvice,
  gradedExportRefusal,
  reportStatusChanged,
  revealWithOffset,
  RecordedMaterials,
} from "./report-lab";
import { useState } from "react";

afterEach(cleanup);

function report(state: ClassroomReport["state"]): ClassroomReport {
  return {
    markdown: "# report",
    provenance: {
      release_id: "a".repeat(32),
      session_version: "experiment-session-simple-v4",
      generated_at: "2026-08-13T00:00:00Z",
      years: [2020],
      session_fingerprint: "fingerprint",
      runs: [],
    },
    state,
    score: state === "graded" ? 93 : null,
    feedback: state === "graded" ? "证据链完整" : "",
    graded_by: state === "graded" ? "teacher" : null,
    generated_at: "2026-08-13T00:00:00Z",
    updated_at: "2026-08-13T00:00:00Z",
    submitted_at: state === "draft" ? null : "2026-08-13T00:01:00Z",
    graded_at: state === "graded" ? "2026-08-13T00:02:00Z" : null,
  };
}

describe("step 15 report states", () => {
  test("discards an old generation gate when a newer saved session has no missing materials", async () => {
    const blocked = [{ step: 15, title: "原创分析", missing: ["填写研究问题"] }];
    const generate = spyOn(api.classroom, "generateReport").mockRejectedValue(Object.assign(new Error("缺少材料"), { blocked }));
    const props = {
      state: { data: {}, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {} },
      report: null,
      reportGate: blocked,
      sessionStatus: "ready" as const,
      sessionUnsynced: false,
      sessionSyncing: false,
      onFlushSession: async () => {},
      onNavigateStep: () => {},
      onReportChanged: () => {},
    };
    try {
      const view = render(<ReportLab {...props} />);
      // While the saved records still miss items, the generate buttons say why and point to the list.
      const draft = screen.getByRole("button", { name: "只生成草稿（不提交）" });
      expect(draft.getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByText(/还有 1 项没完成，现在还不能生成报告/)).toBeDefined();
      await act(async () => { fireEvent.click(draft); });
      expect(generate).toHaveBeenCalledTimes(0);
      expect(view.container.querySelector(".report-gate-panel.report-gate-flash")).not.toBeNull();
      expect(screen.getByText("还不能生成报告")).toBeDefined();
      view.rerender(<ReportLab {...props} reportGate={[]} state={{ ...props.state, data: { research_question: "已保存的新分析" } }} />);
      expect(screen.queryByText("还不能生成报告")).toBeNull();
      expect(screen.getByRole("button", { name: "只生成草稿（不提交）" }).getAttribute("aria-disabled")).toBeNull();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "只生成草稿（不提交）" })); });
      expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      generate.mockRestore();
    }
  });

  test("a second click while the regenerate confirmation is open neither opens another nor strands the first", async () => {
    const generate = spyOn(api.classroom, "generateReport").mockRejectedValue(new Error("服务不可用"));
    const props = {
      state: { data: {}, save: () => {}, complete: true, syncing: false, syncError: null, syncNow: () => {} },
      report: report("graded"),
      reportGate: [],
      sessionStatus: "ready" as const,
      sessionUnsynced: false,
      sessionSyncing: false,
      onFlushSession: async () => {},
      onNavigateStep: () => {},
      onReportChanged: () => {},
    };
    try {
      render(<ReportLab {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "重新生成并提交" }));
        fireEvent.click(screen.getByRole("button", { name: "重新生成并提交" }));
      });
      expect(screen.getAllByRole("button", { name: "确定重新生成" })).toHaveLength(1);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确定重新生成" })); });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: "确定重新生成" })).toBeNull();
      // The guard is released again: cancelling and retrying still reaches the server.
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重新生成并提交" })); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "取消" })); });
      expect(generate).toHaveBeenCalledTimes(1);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重新生成并提交" })); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确定重新生成" })); });
      expect(generate).toHaveBeenCalledTimes(2);
    } finally {
      generate.mockRestore();
    }
  });

  test("does not generate or replace an existing report when flushing session edits fails", async () => {
    const generate = spyOn(api.classroom, "generateReport");
    const confirm = spyOn(window, "confirm").mockReturnValue(true);
    const changed: unknown[] = [];
    try {
      render(<ReportLab
        state={{ data: {}, save: () => {}, complete: true, syncing: false, syncError: "保存失败", syncNow: () => {} }}
        report={report("graded")} reportGate={[]} sessionStatus="ready" sessionUnsynced={true} sessionSyncing={false}
        onFlushSession={async () => { throw new Error("保存失败，请重试"); }} onNavigateStep={() => {}}
        onReportChanged={(response) => changed.push(response)}
      />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存失败，请先重试" })); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确定重新生成" })); });
      expect((await screen.findByRole("alert")).textContent).toContain("保存失败");
      expect(generate).not.toHaveBeenCalled();
      expect(changed).toEqual([]);
      expect(screen.getByText(/已评阅 · 93 分/)).toBeDefined();
    } finally {
      generate.mockRestore();
      confirm.mockRestore();
    }
  });

  test("renders draft, pending, and graded feedback distinctly", () => {
    expect(renderToStaticMarkup(<ReportStatus report={report("draft")} />)).toContain("尚未提交");
    expect(renderToStaticMarkup(<ReportStatus report={report("pending")} />)).toContain("等待教师评阅");
    const graded = renderToStaticMarkup(<ReportStatus report={report("graded")} />);
    expect(graded).toContain("93 分");
    expect(graded).toContain("证据链完整");
    // Without comments the score card says so, and the roadmap link no longer promises them.
    const silent = { ...report("graded"), feedback: "" };
    expect(renderToStaticMarkup(<ReportStatus report={silent} />)).toContain("老师没有写评语。");
    const page = renderToStaticMarkup(<ReportLab {...finishProps} report={silent} />);
    expect(page).toContain(">已评阅，查看分数<");
    // The score card comes before the submit panel.
    expect(page.indexOf("report-score-card")).toBeLessThan(page.indexOf("report-submit-panel"));
  });

  test("shows progress against both the minimum and the hard maximum", () => {
    expect(reflectionCountLabel(0, 40)).toBe("已写 0 / 2400 字 · 最低 40 字");
    expect(reflectionCountLabel(30, 40)).toBe("已写 30 / 2400 字 · 最低 40 字");
    expect(reflectionCountLabel(83, 40)).toBe("已写 83 / 2400 字 · 已达最低 40 字");
    expect(reflectionCountLabel(2400, 40)).toBe("已写 2400 / 2400 字 · 已达上限");
    // Full by the server's code points while emoji and line breaks count less on screen: say why, not "2380 / 2400".
    expect(reflectionCountLabel(2380, 40, 2400, true)).toBe("已写 2380 字 · 已达 2400 字上限（空格、换行和表情符号按实际字符计，可能占多个字）");
  });

  test("an outdated report says what updating does in each state", () => {
    expect(reportOutdatedAdvice("draft")).toBe("修改后请先点“重新生成草稿”，再提交或导出。");
    // A submitted report has no draft-only update: regenerating resubmits, and the teacher keeps the old one until then.
    expect(reportOutdatedAdvice("pending")).toContain("在你更新之前，老师那里仍是已提交的版本。点“更新报告并提交给老师”会按最新记录重新生成并再次提交");
    expect(reportOutdatedAdvice("pending")).not.toContain("请先重新生成");
    expect(reportOutdatedAdvice("graded")).toContain("老师那里仍是已评阅的版本");
    expect(reportOutdatedAdvice("graded")).toContain("清除原评分和评语");
  });

  test("uses resubmission semantics after submission or grading", () => {
    expect(reportGenerateLabel(null)).toBe("只生成草稿（不提交）");
    expect(reportGenerateLabel(report("draft"))).toBe("重新生成草稿");
    expect(reportGenerateLabel(report("pending"))).toBe("重新生成并提交");
    expect(reportGenerateLabel(report("graded"))).toBe("重新生成并提交");
  });

  test("keeps the generate action distinguishable from the step title", () => {
    const stepTitle = "生成实验报告";
    const first = reportGenerateLabel(null);
    expect(first).toBe("只生成草稿（不提交）");
    expect(first.includes(stepTitle)).toBe(false);
    const html = renderToStaticMarkup(<ReportLab
      state={{
        data: {},
        save: () => {},
        complete: true,
        syncing: false,
        syncError: null,
        syncNow: () => {},
      }}
      report={null}
      reportGate={[]}
      sessionStatus="ready"
      sessionUnsynced={false}
      sessionSyncing={false}
      onFlushSession={async () => {}}
      onNavigateStep={() => {}}
      onReportChanged={() => {}}
    />);
    expect(html).toContain(">只生成草稿（不提交）<");
    const generateButton = html.match(/<button[^>]*class="secondary"[^>]*>只生成草稿（不提交）<\/button>/)?.[0];
    expect(generateButton).toBeDefined();
    expect(generateButton).not.toContain("aria-label=");
  });

  test("puts restore and save status on the generate button itself", () => {
    expect(reportWaitLabel("loading", false, false)).toBe("正在恢复实验记录…");
    expect(reportWaitLabel("ready", true, false)).toBe("正在保存实验记录…");
    expect(reportWaitLabel("ready", false, false)).toBeNull();
    expect(reportWaitLabel("ready", true, false, "session changed")).toBe("保存失败，请先重试");
    // Beside the primary button's "保存失败，请先重试", the draft button keeps its own action.
    expect(reportGenerateButtonLabel(null, false, "ready", true, false, "offline")).toBe("重试保存后才能生成草稿");
    expect(reportGenerateButtonLabel(report("draft"), false, "ready", true, false, "offline")).toBe("重试保存后才能重新生成草稿");
    expect(reportGenerateButtonLabel(report("pending"), false, "ready", true, false, "冲突", true)).toBe("载入服务器版本后才能重新生成");
    expect(reportGenerateButtonLabel(null, false, "loading", false, false)).toBe("正在恢复实验记录…");
    expect(reportGenerateButtonLabel(null, true, "loading", false, false)).toBe("正在生成报告…");
  });

  test("renders actionable report-gate links", () => {
    const html = renderToStaticMarkup(<GateCard
      blocked={[{ step: 11, title: "回归实验", missing: ["保存有效回归"] }]}
      onNavigateStep={() => {}}
    />);
    expect(html).toContain("步骤 11");
    expect(html).toContain("保存有效回归");
    expect(html).toContain("gate-link");
    expect(html).toContain("继续步骤 11");
    expect(html).toContain("查看全部缺项（1）");
  });

  test("keeps the step-15 action local and focuses the first unfinished reflection field", () => {
    const html = renderToStaticMarkup(<GateCard
      blocked={[{ step: 15, title: "原创分析与反思", missing: ["填写证据解释"] }]}
      onNavigateStep={() => {}}
    />);
    expect(html).toContain("去写你的分析");
    expect(html).not.toContain("继续步骤 15");

    const navigated: number[] = [];
    const focused: string[] = [];
    let scheduled = 0;
    const activated = activateReportGateDestination(
      15,
      (step) => navigated.push(step),
      {
        getElementById: () => null,
        querySelector: (selector) => {
          expect(selector).toBe(REPORT_REFLECTION_INCOMPLETE_SELECTOR);
          return { focus: () => focused.push("unfinished-field") } as unknown as Element;
        },
      },
      {
        requestAnimationFrame: () => {
          scheduled += 1;
          return 1;
        },
      },
    );
    expect(activated).toBe(true);
    expect(navigated).toEqual([]);
    expect(scheduled).toBe(0);
    expect(focused).toEqual(["unfinished-field"]);
  });

  test("marks only below-minimum reflection fields as local focus candidates", () => {
    const html = renderToStaticMarkup(<ReportLab
      state={{
        data: {
          research_question: "123456789012",
          evidence_interpretation: "不足",
          limitations: "123456789012345678901234567890",
        },
        save: () => {},
        complete: true,
        syncing: false,
        syncError: null,
        syncNow: () => {},
      }}
      report={null}
      reportGate={[{ step: 15, title: "原创分析与反思", missing: ["填写证据解释"] }]}
      sessionStatus="ready"
      sessionUnsynced={false}
      sessionSyncing={false}
      onFlushSession={async () => {}}
      onNavigateStep={() => {}}
      onReportChanged={() => {}}
    />);
    expect(html.match(/data-report-reflection-incomplete="true"/g)).toHaveLength(1);
  });

  test("summarizes and groups a long gate before revealing every item", () => {
    const overview = summarizeReportGate([
      { step: 11, title: "贸易流回归", missing: ["完成理解题", "保存有效回归"] },
      { step: 1, title: "数据浏览", missing: ["记录单元格"] },
      { step: 15, title: "原创分析", missing: ["填写研究问题"] },
      { step: 2, title: "贸易流指标", missing: ["记录两个国家"] },
    ]);
    expect(overview.summary).toBe("步骤 1–14 中 3 个步骤还有 4 项待补齐；本步还有 1 项待完成");
    expect(overview.next?.step).toBe(1);
    expect(overview.groups.map((group) => group.label)).toEqual([
      "数据接入", "指标计算", "关税回归", "实验报告",
    ]);
  });

  test("focuses the destination task heading after a report-gate navigation", () => {
    const calls: unknown[] = [];
    const found = focusReportGateDestination(11, {
      getElementById: (id) => id === "step-task-title-11"
        ? { focus: (options) => calls.push(options) }
        : null,
    });
    expect(found).toBe(true);
    expect(calls).toEqual([{ preventScroll: true }]);
    expect(focusReportGateDestination(9, { getElementById: () => null })).toBe(false);
  });

  test("a step missing only its quiz (the server's quiz_only, whatever its message) opens at the quiz", () => {
    const focused: string[] = [];
    const root = {
      getElementById: (id: string) => ({ focus: () => focused.push(id), scrollIntoView: () => {} }),
    };
    const frames: (() => void)[] = [];
    const scheduler = { requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(() => callback(0)); return 1; } };
    const navigated: number[] = [];
    activateReportGateDestination(7, (step) => navigated.push(step), root, scheduler, true);
    activateReportGateDestination(8, (step) => navigated.push(step), root, scheduler, false);
    frames.forEach((frame) => frame());
    expect(navigated).toEqual([7, 8]);
    expect(focused).toEqual(["quiz-title-7", "step-task-title-8"]);
  });

  test("offers PDF export after a report has been generated", () => {
    const html = renderToStaticMarkup(<ReportLab
      state={{
        data: {},
        save: () => {},
        complete: true,
        syncing: false,
        syncError: null,
        syncNow: () => {},
      }}
      report={report("graded")}
      reportGate={[]}
      sessionStatus="ready"
      sessionUnsynced={false}
      sessionSyncing={false}
      onFlushSession={async () => {}}
      onNavigateStep={() => {}}
      onReportChanged={() => {}}
    />);
    expect(html).toContain("导出 PDF");
  });
});


test("blocks stale snapshot export and submission after edits, saves and reloads until regeneration", () => {
  const original = report("draft");
  const props = {
    state: { data: {}, save: () => {}, complete: true, syncing: false, syncError: null, syncNow: () => {} },
    report: original, reportGate: [], sessionStatus: "ready" as const,
    sessionUnsynced: false, sessionSyncing: false, sessionUpdatedAt: "2026-08-12T23:59:00Z",
    onFlushSession: async () => {}, onNavigateStep: () => {}, onReportChanged: () => {},
  };
  const view = render(<ReportLab {...props} />);
  const disabled = (name: string) => (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
  expect(disabled("导出 PDF")).toBe(false);
  view.rerender(<ReportLab {...props} sessionUnsynced />);
  expect(screen.getByText("报告尚未包含最新修改")).toBeDefined();
  expect(disabled("导出 PDF")).toBe(true);
  // A stale draft offers “更新报告并提交给老师” instead of submitting the outdated snapshot.
  expect([...view.container.querySelectorAll(".report-actions button")].some((button) => button.textContent === "提交报告给老师")).toBe(false);
  view.unmount();
  const saved = { ...props, sessionUpdatedAt: "2026-08-13T00:05:00Z" };
  const restored = render(<ReportLab {...saved} report={{ ...original, updated_at: "2026-08-13T00:10:00Z" }} />);
  expect(disabled("导出 PDF")).toBe(true);
  restored.rerender(<ReportLab {...saved} report={{ ...original, generated_at: "2026-08-13T00:06:00Z" }} />);
  expect(disabled("导出 PDF")).toBe(false);
  expect(disabled("提交报告给老师")).toBe(false);
});

test("the server's report-current verdict wins over a newer session save time", () => {
  const props = {
    state: { data: {}, save: () => {}, complete: true, syncing: false, syncError: null, syncNow: () => {} },
    report: report("graded"), reportGate: [], sessionStatus: "ready" as const,
    sessionUnsynced: false, sessionSyncing: false, sessionUpdatedAt: "2026-08-14T00:00:00Z",
    onFlushSession: async () => {}, onNavigateStep: () => {}, onReportChanged: () => {},
  };
  // Typing a character and deleting it saves the session again but leaves the report inputs unchanged.
  const current = render(<ReportLab {...props} reportCurrent />);
  expect(screen.queryByText("报告需更新后重新提交")).toBeNull();
  expect((screen.getByRole("button", { name: "导出 PDF" }) as HTMLButtonElement).disabled).toBe(false);
  current.unmount();
  render(<ReportLab {...props} sessionUpdatedAt="2026-08-01T00:00:00Z" reportCurrent={false} />);
  expect(screen.getByText("报告需更新后重新提交")).toBeDefined();
});

const mutation = (state: ClassroomReport["state"]): ReportMutationResponse => ({
  report: report(state), report_gate: [], material_gate: [],
  completion: { steps: [], completed: [], completed_count: 0, total: 15 },
});
const finishProps = {
  state: { data: {}, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {} },
  report: null, reportGate: [], sessionStatus: "ready" as const, sessionUnsynced: false, sessionSyncing: false,
  onFlushSession: async () => {}, onNavigateStep: () => {}, onReportChanged: (_response: ReportMutationResponse) => {},
};

test("one-click finish flushes then generates then submits; outro appears only after acknowledged submission", async () => {
  const order: string[] = [];
  let acknowledge!: (value: ReportMutationResponse) => void;
  const generate = spyOn(api.classroom, "generateReport").mockImplementation(async () => { order.push("generate"); return mutation("draft"); });
  const submit = spyOn(api.classroom, "submitReport").mockImplementation(() => { order.push("submit"); return new Promise((resolve) => { acknowledge = resolve; }); });
  try {
    render(<><ReportLab {...finishProps} onFlushSession={async () => { order.push("flush"); }} onReportChanged={(r) => order.push(r.report.state)} /><ToastHost /></>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "生成并提交报告" })); });
    expect(order).toEqual(["flush", "generate", "draft", "submit"]);
    expect(generate).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { acknowledge(mutation("pending")); });
    const dialog = screen.getByRole("dialog", { name: "报告已提交" });
    expect(within(dialog).getByText("提交成功 · 等待教师评阅")).toBeTruthy();
    expect(within(dialog).getByText("计算并理解指标")).toBeTruthy();
    expect(within(dialog).getByText("看变化与全球位置")).toBeTruthy();
    expect(within(dialog).getByText("汇总四项回归结果")).toBeTruthy();
    expect(within(dialog).queryByText("比较与验证")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.activeElement?.textContent).toBe("报告已提交");
    expect(order).toEqual(["flush", "generate", "draft", "submit", "pending"]);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally { generate.mockRestore(); submit.mockRestore(); }
});

test("a 409 because the teacher just graded shows the current report, not a phantom draft", async () => {
  const generate = spyOn(api.classroom, "generateReport").mockRejectedValue(new ApiError(409, "报告或评分已更新，请刷新页面核对后再确认重新生成", "Conflict"));
  const latest = mutation("graded");
  const session = spyOn(api.classroom, "session").mockResolvedValue({ release_id: "a".repeat(32), session: { version: "experiment-session-simple-v4", steps: {}, shared: {} }, updated_at: null, ...latest });
  const changed: string[] = [];
  try {
    render(<ReportLab {...finishProps} report={report("pending")} onReportChanged={(r) => changed.push(r.report.state)} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /重新生成|更新报告/ })); });
    expect(changed).toEqual(["graded"]);
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("老师刚刚评阅了这份报告");
    expect(alert).not.toContain("草稿会保留");
  } finally { generate.mockRestore(); session.mockRestore(); }
});

test("a 409 because the report was submitted in another tab says so, not that it was graded", async () => {
  const generate = spyOn(api.classroom, "generateReport").mockRejectedValue(new ApiError(409, "报告或评分已更新，请刷新页面核对后再确认重新生成", "Conflict"));
  const latest = mutation("pending");
  const session = spyOn(api.classroom, "session").mockResolvedValue({ release_id: "a".repeat(32), session: { version: "experiment-session-simple-v4", steps: {}, shared: {} }, updated_at: null, ...latest });
  const changed: string[] = [];
  try {
    render(<ReportLab {...finishProps} report={report("draft")} onReportChanged={(r) => changed.push(r.report.state)} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重新生成草稿" })); });
    expect(changed).toEqual(["pending"]);
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("已在别处提交给老师");
    expect(alert).not.toContain("评分与评语");
  } finally { generate.mockRestore(); session.mockRestore(); }
});

test("the 409 message follows what changed on the server", () => {
  const graded = report("graded");
  expect(reportConflictMessage(report("pending"), graded)).toContain("老师刚刚评阅");
  expect(reportConflictMessage(graded, { ...graded, graded_at: "2026-08-14T00:00:00Z" })).toContain("老师刚刚评阅");
  expect(reportConflictMessage(null, report("draft"))).toContain("已在别处更新");
  expect(reportConflictMessage(report("pending"), { ...report("pending"), updated_at: "2026-08-14T00:00:00Z" })).toContain("已在别处更新");
  expect(reportConflictMessage(report("pending"), report("pending"))).toBeNull();
  expect(reportConflictMessage(report("pending"), null)).toBeNull();
});

test("draft generation keeps toast feedback when no outro is shown", async () => {
  const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(mutation("draft"));
  try {
    render(<><ReportLab {...finishProps} /><ToastHost /></>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "只生成草稿（不提交）" })); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("报告草稿已生成，请预览后提交");
  } finally { generate.mockRestore(); }
});

test("a generated draft brings the preview into view and focuses it", async () => {
  const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(mutation("draft"));
  try {
    const view = render(<ReportLab {...finishProps} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "只生成草稿（不提交）" })); });
    // The parent renders the new draft; the page then continues at the preview, not at the buttons.
    view.rerender(<ReportLab {...finishProps} report={report("draft")} />);
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("报告正文");
  } finally { generate.mockRestore(); }
});

test("a restored draft does not move focus to the preview", async () => {
  render(<ReportLab {...finishProps} report={report("draft")} />);
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
  expect(document.activeElement?.getAttribute("aria-label")).not.toBe("报告正文");
});

test("failed submission retains generated draft and never opens a success outro", async () => {
  const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(mutation("draft"));
  const submit = spyOn(api.classroom, "submitReport").mockRejectedValue(new Error("网络中断"));
  const changed: string[] = [];
  try {
    render(<ReportLab {...finishProps} onReportChanged={(r) => changed.push(r.report.state)} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "生成并提交报告" })); });
    expect(changed).toEqual(["draft"]);
    expect(screen.getByRole("alert").textContent).toContain("网络中断");
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally { generate.mockRestore(); submit.mockRestore(); }
});

for (const action of ["提交报告给老师", "生成并提交报告"]) {
  test(`${action} removes earlier draft feedback only after submission succeeds`, async () => {
    const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(mutation("draft"));
    let acknowledge!: (value: ReportMutationResponse) => void;
    const submit = spyOn(api.classroom, "submitReport").mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
    try {
      const view = render(<><ReportLab {...finishProps} /><ToastHost /></>);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "只生成草稿（不提交）" })); });
      if (action === "提交报告给老师") {
        view.rerender(<><ReportLab {...finishProps} report={report("draft")} /><ToastHost /></>);
      }
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: action })); });
      expect(view.container.querySelector(".toast-host")?.textContent).toContain("报告草稿已生成");
      expect(screen.queryByRole("dialog")).toBeNull();
      await act(async () => { acknowledge(mutation("pending")); });
      expect(screen.getByRole("dialog", { name: "报告已提交" })).toBeTruthy();
      expect(view.container.querySelector(".toast-host")).toBeNull();
    } finally { generate.mockRestore(); submit.mockRestore(); }
  });
}

test("material gate stops one-click submission and stays above the writing fields", async () => {
  const blocked = [{ step: 9, title: "网络图表材料", missing: ["记录两个国家"] }];
  const generate = spyOn(api.classroom, "generateReport").mockRejectedValue(Object.assign(new Error("缺项"), { blocked }));
  const submit = spyOn(api.classroom, "submitReport");
  try {
    const view = render(<ReportLab {...finishProps} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "生成并提交报告" })); });
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "继续步骤 9" })).toBeTruthy();
    const html = view.container.innerHTML;
    expect(html.indexOf("report-gate-panel")).toBeLessThan(html.indexOf('class="report-reflection"'));
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally { generate.mockRestore(); submit.mockRestore(); }
});

for (const button of ["重新生成并提交", "更新报告并提交给老师"]) {
  test(`graded report requires confirmation through ${button}, and cancelling does not mutate it`, async () => {
    const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(mutation("pending"));
    const submit = spyOn(api.classroom, "submitReport");
    let flushes = 0;
    let mutations = 0;
    const gradedReport = { ...report("graded"), updated_at: "2026-08-13T00:02:00.123456Z" };
    try {
      // “更新…” is offered for an outdated report, “重新生成并提交” only for a current one.
      render(<ReportLab {...finishProps} report={gradedReport}
        sessionUpdatedAt={button === "更新报告并提交给老师" ? "2026-08-14T00:00:00Z" : "2026-08-12T00:00:00Z"}
        onFlushSession={async () => { flushes++; }} onReportChanged={() => { mutations++; }} />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: button })); });
      const dialog = screen.getByRole("dialog", { name: "重新生成已评阅的报告？" });
      expect(dialog.textContent).toContain("清除现有评分和评语");
      await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "取消" })); });
      expect(screen.queryByRole("dialog", { name: "重新生成已评阅的报告？" })).toBeNull();
      expect(generate).not.toHaveBeenCalled();
      expect(flushes).toBe(0);
      expect(mutations).toBe(0);
      expect(screen.getByText(/已评阅 · 93 分/)).toBeTruthy();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: button })); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确定重新生成" })); });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledWith(gradedReport.updated_at);
      expect(flushes).toBe(1);
      expect(mutations).toBe(1);
      expect(submit).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "报告已提交" })).toBeTruthy();
    } finally { generate.mockRestore(); submit.mockRestore(); }
  });
}

test("a stale report conflict does not retry, submit, or replace the displayed report", async () => {
  const message = "报告或评分已更新，请刷新页面核对后再确认重新生成";
  const generate = spyOn(api.classroom, "generateReport").mockRejectedValue(new Error(message));
  const submit = spyOn(api.classroom, "submitReport");
  const changed = spyOn(finishProps, "onReportChanged");
  const pending = { ...report("pending"), updated_at: "2026-08-13T00:01:00.654321Z" };
  try {
    render(<ReportLab {...finishProps} report={pending} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重新生成并提交" })); });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(pending.updated_at);
    expect(submit).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText(message, { exact: false })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally { generate.mockRestore(); submit.mockRestore(); changed.mockRestore(); }
});

test("regenerating a submitted report uses server resubmission directly without a second submit", async () => {
  const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(mutation("pending"));
  const submit = spyOn(api.classroom, "submitReport");
  const confirm = spyOn(window, "confirm");
  try {
    render(<ReportLab {...finishProps} report={report("pending")} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重新生成并提交" })); });
    expect(confirm).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "报告已提交" })).toBeTruthy();
  } finally { generate.mockRestore(); submit.mockRestore(); confirm.mockRestore(); }
});

test("restored graded receipt is available without submitting again; an outdated graded report still exports as graded", () => {
  const submit = spyOn(api.classroom, "submitReport");
  try {
    render(<ReportLab {...finishProps} report={report("graded")} sessionUnsynced />);
    fireEvent.click(screen.getByRole("button", { name: "查看提交回执与实验总结" }));
    const dialog = screen.getByRole("dialog", { name: "报告已评阅" });
    expect(within(dialog).getByText("已评阅 · 93 分")).toBeTruthy();
    expect(within(dialog).getByRole("region", { name: "教师评语" }).textContent).toBe("教师评语：证据链完整");
    const receipt = within(dialog).getByRole("region", { name: "报告提交回执" });
    expect(within(receipt).getByText(/后续修改尚未纳入这份报告/)).toBeTruthy();
    expect(within(receipt).getByText(/重新生成会清除当前评分与评语/)).toBeTruthy();
    expect(within(dialog).queryByText(/你可以离开页面/)).toBeNull();
    // The PDF is the graded version with its score and feedback, the record regenerating would clear.
    expect((within(dialog).getByRole("button", { name: "导出 PDF 留存" }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(dialog).queryByText("报告需要先更新，才能导出。")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  } finally { submit.mockRestore(); }
});

test("receipt distinguishes busy export from outdated content and preserves pending state", () => {
  const props = { report: report("pending"), onClose: () => {}, onExport: () => {} };
  const { rerender } = render(<ReportOutro {...props} exportDisabled />);
  expect(screen.queryByText(/后续修改尚未纳入/)).toBeNull();
  expect((screen.getByRole("button", { name: "导出 PDF 留存" }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<ReportOutro {...props} reportOutdated />);
  expect(screen.getByText(/后续修改尚未纳入/)).toBeTruthy();
  expect(screen.queryByText(/清除当前评分/)).toBeNull();
  // Outdated: the receipt leads with the caveat, never with "提交成功".
  const receipt = screen.getByRole("region", { name: "报告提交回执" });
  expect(receipt.firstElementChild?.textContent).toStartWith("报告需更新");
  expect(receipt.textContent).not.toContain("提交成功");
  expect(screen.getByText("已提交的版本 · 等待教师评阅")).toBeTruthy();
  expect((screen.getByRole("button", { name: "导出 PDF 留存" }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<ReportOutro {...props} />);
  expect(screen.getByText(/你可以离开页面/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "导出 PDF 留存" }) as HTMLButtonElement).disabled).toBe(false);
  // Graded: nothing is left to wait for, so the closing line no longer promises the teacher's review.
  rerender(<ReportOutro {...props} report={report("graded")} />);
  expect(screen.queryByText(/查看报告与老师的评阅/)).toBeNull();
  expect(screen.getByText("报告与评阅已保存在服务器上，可随时回到步骤 15 查看。")).toBeTruthy();
  // The receipt names when it was graded, as the step 15 card does.
  expect(screen.getByText(/^评阅时间：/)).toBeTruthy();
});

test("the graded warning names only the button on screen", () => {
  const current = render(<ReportLab {...finishProps} report={report("graded")} />);
  expect(current.container.querySelector(".reg-rerun-warning")?.textContent).toBe("注意“重新生成并提交”会替换已评阅报告，并清除原评分和评语。");
  current.unmount();
  const outdated = render(<ReportLab {...finishProps} report={report("graded")} sessionUpdatedAt="2026-08-14T00:00:00Z" />);
  expect(outdated.container.querySelector(".reg-rerun-warning")?.textContent).toBe("注意“更新报告并提交给老师”会替换已评阅报告，并清除原评分和评语。");
  outdated.unmount();
});

test("the submit panel drops the pre-submit line once the current version is with the teacher", () => {
  const panelText = (view: ReturnType<typeof render>) => view.container.querySelector(".report-submit-panel > p")?.textContent;
  const draft = render(<ReportLab {...finishProps} report={report("draft")} />);
  expect(panelText(draft)).toStartWith("提交前会先保存文字并检查材料");
  draft.unmount();
  const pending = render(<ReportLab {...finishProps} report={report("pending")} />);
  expect(panelText(pending)).toBe("导出 PDF 仅供个人留存，不能代替提交。");
  pending.unmount();
  const outdatedDraft = render(<ReportLab {...finishProps} report={report("draft")} sessionUpdatedAt="2026-08-14T00:00:00Z" />);
  expect(outdatedDraft.getByText("草稿需更新，尚未提交")).toBeTruthy();
  outdatedDraft.unmount();
});

test("each report state shows one action group in the submit panel, without duplicate update buttons", () => {
  const names = (view: ReturnType<typeof render>) =>
    [...view.container.querySelectorAll(".report-submit-panel .report-actions button")].map((button) => button.textContent);
  const none = render(<ReportLab {...finishProps} />);
  expect(names(none)).toEqual(["生成并提交报告", "只生成草稿（不提交）"]);
  none.unmount();
  const outdated = render(<ReportLab {...finishProps} report={report("graded")} sessionUpdatedAt="2026-08-14T00:00:00Z" />);
  expect(names(outdated)).toEqual(["更新报告并提交给老师", "查看提交回执与实验总结", "导出已评阅版本 PDF"]);
  outdated.unmount();
  const current = render(<ReportLab {...finishProps} report={report("graded")} sessionUpdatedAt="2026-08-12T00:00:00Z" />);
  expect(names(current)).toEqual(["查看提交回执与实验总结", "导出 PDF", "重新生成并提交"]);
  current.unmount();
});

test("an exported graded report carries the score and feedback, and the PDF is named after the report", async () => {
  const graded = { ...report("graded"), markdown: "# GVC 指标与关税实验报告\n\n学生：演示学生 05\n\n正文", generated_at: "2026-10-09T03:05:00" };
  const view = render(<ReportLab {...finishProps} report={graded} sessionUpdatedAt="2026-08-12T00:00:00Z" />);
  const block = view.container.querySelector(".report-body .report-print-grade");
  expect(block?.textContent).toContain("教师评阅 · 93 分");
  expect(block?.textContent).toContain("教师评语：证据链完整");
  const css = await Bun.file(new URL("../../report-finish.css", import.meta.url)).text();
  expect(css).toMatch(/\.report-print-grade \{ display: none; \}/);
  expect(css.slice(css.indexOf("@media print"))).toMatch(/\.report-print-grade \{\s*display: block/);
  // The regenerate warning points to the PDF instead of asking to copy the grade by hand.
  fireEvent.click(screen.getByRole("button", { name: "重新生成并提交" }));
  expect(screen.getByText(/请先取消并导出 PDF：导出的 PDF 含评分与评语/)).toBeTruthy();
  expect(screen.queryByText(/记下评分与评语/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  const titles: string[] = [];
  const print = spyOn(globalThis, "print").mockImplementation(() => { titles.push(document.title); });
  // A graded export first checks the server still has this graded version (it does here).
  const session = spyOn(api.classroom, "session").mockResolvedValue({
    release_id: "a".repeat(32), session: { version: "experiment-session-simple-v4", steps: {}, shared: {} }, updated_at: null,
    ...mutation("graded"), report: graded,
  });
  document.title = "步骤 15 · 生成实验报告";
  try {
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "导出 PDF" })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(print).toHaveBeenCalledTimes(1);
    expect(titles).toEqual(["实验报告 · 演示学生 05 · 2026-10-09"]);
    act(() => { window.dispatchEvent(new Event("afterprint")); });
    expect(document.title).toBe("步骤 15 · 生成实验报告");
    expect(session).toHaveBeenCalledTimes(1);
  } finally { print.mockRestore(); session.mockRestore(); }
});

test("a draft or pending report prints no grade block", () => {
  for (const state of ["draft", "pending"] as const) {
    const view = render(<ReportLab {...finishProps} report={report(state)} />);
    expect(view.container.querySelector(".report-print-grade")).toBeNull();
    view.unmount();
  }
});

test("analysis length counts visible code points as the server does; invisible characters count nothing", () => {
  expect(reflectionLength("  贸易 😀\n\n分析  ")).toBe(7);
  expect(reflectionLength("😀😀")).toBe(2);
  // The server's rule (report_gate.reflection_length): the joiners of a family emoji are invisible, its people
  // count; a flag is two regional-indicator code points; a combining accent adds nothing.
  expect(reflectionLength("👨‍👩‍👧")).toBe(3);
  expect(reflectionLength("🇨🇳")).toBe(2);
  expect(reflectionLength("e\u0301")).toBe(1);
  // Zero-width spaces and bidi controls alone are an empty answer.
  expect(reflectionLength("\u200b".repeat(40))).toBe(0);
  expect(reflectionLength("\u202e结果\u202c")).toBe(2);
  // Python's whitespace: U+001F splits words like a space.
  expect(reflectionLength("甲\u001f乙")).toBe(3);
});

describe("the 2,400 limit shortens only the inserted text", () => {
  const ending = "结尾十个字很重要啊";
  const original = "甲".repeat(REFLECTION_MAX_LENGTH - 1 - ending.length) + ending;

  test("an insert at the start keeps the student's ending and cuts the insertion", () => {
    expect(codePointLength(original)).toBe(REFLECTION_MAX_LENGTH - 1);
    const pasted = "插".repeat(18);
    const result = limitInsertion(original, pasted + original, pasted.length);
    expect(result.cut).toBe(true);
    expect(result.value).toBe("插" + original);
    expect(result.value.endsWith(ending)).toBe(true);
    expect(result.caret).toBe(1);
    expect(codePointLength(result.value)).toBe(REFLECTION_MAX_LENGTH);
  });

  test("an insert in the middle keeps both sides and the caret lands after the kept part", () => {
    const at = 100;
    const next = original.slice(0, at) + "中间插入" + original.slice(at);
    const result = limitInsertion(original, next, at + 4);
    expect(result.value).toBe(original.slice(0, at) + "中" + original.slice(at));
    expect(result.caret).toBe(at + 1);
  });

  test("an append at the end is cut at whole characters, never inside an emoji", () => {
    const base = "甲".repeat(REFLECTION_MAX_LENGTH - 3);
    const next = base + "😀👨‍👩‍👧乙";
    const result = limitInsertion(base, next, next.length);
    // 😀 is one code point; the family emoji is five, which no longer fits, so it is dropped whole.
    expect(result.value).toBe(base + "😀");
    expect(codePointLength(result.value)).toBeLessThanOrEqual(REFLECTION_MAX_LENGTH);
  });

  test("a paste over a selection replaces the selection and is cut, the text around it stays", () => {
    const next = original.slice(0, 10) + "替".repeat(30) + original.slice(20);
    const result = limitInsertion(original, next, 40);
    expect(result.value).toBe(original.slice(0, 10) + "替".repeat(11) + original.slice(20));
  });

  test("a change within the limit is kept as typed; without a caret the common tail is used", () => {
    expect(limitInsertion("abc", "abXc", 3)).toEqual({ value: "abXc", caret: 3, cut: false });
    const result = limitInsertion(original, "新新" + original, null);
    expect(result.value).toBe("新" + original);
    // A field already over the limit (saved elsewhere): deleting a character is not reported as a cut.
    const over = "超".repeat(REFLECTION_MAX_LENGTH + 5);
    expect(limitInsertion(over, over.slice(1), 0)).toEqual({ value: over.slice(1), caret: 0, cut: false });
  });

  test("the field keeps the ending, says the pasted part was cut and puts the caret after it", async () => {
    function Harness() {
      const [data, setData] = useState<Record<string, unknown>>({ limitations: original });
      return <ReportLab {...finishProps} state={{ ...finishProps.state, data, save: (patch) => setData((value) => ({ ...value, ...patch })) }} />;
    }
    render(<Harness />);
    const field = screen.getByRole("textbox", { name: "局限与反思" }) as HTMLTextAreaElement;
    const next = "粘贴".repeat(9) + original;
    // happy-dom leaves the caret at the end after a programmatic change: the common tail still decides.
    act(() => { fireEvent.change(field, { target: { value: next } }); });
    expect(field.value).toBe("粘" + original);
    expect(field.value.endsWith(ending)).toBe(true);
    expect(field.selectionStart).toBe(1);
    expect(screen.getByText(/刚粘贴或输入的文字有一部分没有保留，原有文字没有改动/)).toBeTruthy();
    expect(screen.getByText(/已写 2400 \/ 2400 字 · 已达上限/)).toBeTruthy();
  });

  test("the cut warning goes away with the next edit, in any field", () => {
    function Harness() {
      const [data, setData] = useState<Record<string, unknown>>({ limitations: original });
      return <ReportLab {...finishProps} state={{ ...finishProps.state, data, save: (patch) => setData((value) => ({ ...value, ...patch })) }} />;
    }
    render(<Harness />);
    const field = screen.getByRole("textbox", { name: "局限与反思" }) as HTMLTextAreaElement;
    act(() => { fireEvent.change(field, { target: { value: "粘贴".repeat(9) + original } }); });
    expect(screen.queryByText(/超过 2400 字上限/)).not.toBeNull();
    const other = screen.getByRole("textbox", { name: "研究问题" });
    act(() => { fireEvent.change(other, { target: { value: "我比较了中国和美国" } }); });
    expect(screen.queryByText(/超过 2400 字上限/)).toBeNull();
    expect(field.getAttribute("aria-describedby")).not.toContain("report-paste-");
  });
});

test("offline, the two report buttons read differently", () => {
  render(<ReportLab {...finishProps} state={{ ...finishProps.state, syncError: "网络连接中断" }} sessionUnsynced />);
  const labels = [...document.querySelectorAll(".report-submit-panel .report-actions button")].map((button) => button.textContent);
  expect(labels).toEqual(["保存失败，请先重试", "重试保存后才能生成草稿"]);
  expect(screen.getByText("未保存")).toBeTruthy();
});

test("the writing area shows the autosave state and says formatting marks stay as typed", () => {
  const { rerender } = render(<ReportLab {...finishProps} />);
  expect(screen.getByText("已保存")).toBeTruthy();
  for (const label of ["写分析", "提交与导出"]) {
    const target = screen.getByRole("link", { name: label }).getAttribute("href")!;
    expect(document.querySelector(target)?.getAttribute("tabindex")).toBe("-1");
  }
  expect(screen.getByText(/比较四步当前保存的 Y 在默认模型设定下/)).toBeTruthy();
  expect(screen.getByText(/“#”“\*\*”等符号不会变成标题或粗体/)).toBeTruthy();
  rerender(<ReportLab {...finishProps} sessionSyncing />);
  expect(screen.getByText("保存中…")).toBeTruthy();
  rerender(<ReportLab {...finishProps} sessionStatus="loading" />);
  expect(screen.queryByText("已保存")).toBeNull();
});

test("a blocked generate click marks the short analysis fields invalid at once; the gated hint is not contradicted", () => {
  const gate = [{ step: 8, title: "步骤 8", missing: ["记录报告材料"] }, { step: 15, title: "你的分析", missing: ["填写研究问题"] }];
  render(<ReportLab {...finishProps} reportGate={gate} state={{ ...finishProps.state, data: { research_question: "我比较了中国和美国的外国增加值项占比" } }} />);
  expect(screen.getByText(/补齐上方清单中的缺项后，可以先生成草稿预览/)).toBeTruthy();
  const field = (name: string) => screen.getByRole("textbox", { name }).getAttribute("aria-invalid");
  expect(field("结果解释")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "生成并提交报告" }));
  expect(field("结果解释")).toBe("true");
  expect(field("局限与反思")).toBe("true");
  expect(field("研究问题")).toBeNull();
});

test("in a save conflict the report actions ask for the server version, not a retry", () => {
  expect(reportWaitLabel("ready", true, false, "冲突", true)).toBe("请先载入服务器版本");
  expect(reportWaitLabel("ready", true, false, "网络中断")).toBe("保存失败，请先重试");
});

const sessionWith = (latest: ReportMutationResponse, steps: Record<string, unknown> = {}) => ({
  release_id: "a".repeat(32), updated_at: null, ...latest,
  session: { version: "experiment-session-simple-v4", steps, shared: {} } as never,
});
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

for (const path of ["refresh", "generate conflict"] as const) {
  test(`${path} preserves the server's complete learning state`, async () => {
    const latest = { ...sessionWith(mutation("graded")), quiz_revision: 7, quizzes: {}, report_current: false };
    const session = spyOn(api.classroom, "session").mockResolvedValue(latest);
    const generate = spyOn(api.classroom, "generateReport").mockRejectedValue(new ApiError(409, "报告已更新", "Conflict"));
    const changed: ReportMutationResponse[] = [];
    try {
      render(<ReportLab {...finishProps} report={report("pending")} onReportChanged={(response) => changed.push(response)} />);
      await act(async () => {
        if (path === "refresh") window.dispatchEvent(new Event("focus"));
        else fireEvent.click(screen.getByRole("button", { name: "重新生成并提交" }));
      });
      expect(session).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(path === "refresh" ? 0 : 1);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({ report: latest.report, quiz_revision: 7, quizzes: {}, report_current: false });
    } finally { session.mockRestore(); generate.mockRestore(); }
  });
}

test("a delayed refresh cannot replace a generation and submission that already completed", async () => {
  let resolveRead!: (value: ReturnType<typeof sessionWith>) => void;
  const session = spyOn(api.classroom, "session").mockImplementation(() => new Promise((resolve) => { resolveRead = resolve; }));
  const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(mutation("draft"));
  const submit = spyOn(api.classroom, "submitReport").mockResolvedValue(mutation("pending"));
  const changed: ClassroomReport["state"][] = [];
  function Harness() {
    const [current, setCurrent] = useState<ClassroomReport | null>(null);
    return <ReportLab {...finishProps} report={current} onReportChanged={(response) => {
      changed.push(response.report.state);
      setCurrent(response.report);
    }} />;
  }
  try {
    render(<Harness />);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "生成并提交报告" })); });
    expect(changed).toEqual(["draft", "pending"]);
    await act(async () => { resolveRead(sessionWith(mutation("graded"))); });
    expect(changed).toEqual(["draft", "pending"]);
  } finally { session.mockRestore(); generate.mockRestore(); submit.mockRestore(); }
});

test("once a submitted report exists, an unfinished answer blocks updating it, not generating it", () => {
  const gate = [{ step: 15, title: "你的分析", missing: ["填写研究问题"] }];
  render(<ReportLab {...finishProps} report={report("pending")} reportGate={gate} sessionUpdatedAt="2026-08-14T00:00:00Z" />);
  expect(screen.getByRole("heading", { name: "还不能更新报告" })).toBeTruthy();
  expect(screen.getByText("还有 1 项没完成，现在还不能更新报告；请先按上方“还不能更新报告”的清单补齐。")).toBeTruthy();
  expect(screen.queryByText(/还不能生成报告/)).toBeNull();
  cleanup();
  render(<ReportLab {...finishProps} reportGate={gate} />);
  expect(screen.getByRole("heading", { name: "还不能生成报告" })).toBeTruthy();
});

test("closing the receipt shown after a submit focuses the status card, in view, not the report body far above", async () => {
  const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(mutation("draft"));
  const submit = spyOn(api.classroom, "submitReport").mockResolvedValue(mutation("pending"));
  const revealed: Element[] = [];
  const scrolled = spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) { revealed.push(this); });
  function Harness() {
    const [current, setCurrent] = useState<ClassroomReport | null>(null);
    return <ReportLab {...finishProps} report={current} onReportChanged={(response) => setCurrent(response.report)} />;
  }
  try {
    render(<Harness />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "生成并提交报告" })); });
    const dialog = screen.getByRole("dialog", { name: "报告已提交" });
    revealed.length = 0;
    await act(async () => { fireEvent.keyDown(dialog, { key: "Escape" }); });
    await settle();
    expect(document.activeElement?.id).toBe("report-status-card");
    expect(revealed.at(-1)?.id).toBe("report-status-card");
    // A padded card, so the focus ring outlines a deliberate box rather than a bare line of text.
    expect(document.activeElement?.className).toBe("submit-card submit-card-plain");
    // The 研究问题 box is tall enough for its two-line placeholder.
    expect(screen.getByRole("textbox", { name: "研究问题" }).getAttribute("rows")).toBe("3");
    // The report body is a named region (its aria-label needs a role).
    expect(screen.getByRole("region", { name: "报告正文" }).className).toBe("report-body");
  } finally { generate.mockRestore(); submit.mockRestore(); scrolled.mockRestore(); }
});

test("closing a receipt opened from 查看提交回执与实验总结 returns focus to that button", async () => {
  render(<ReportLab {...finishProps} report={report("graded")} />);
  const opener = screen.getByRole("button", { name: "查看提交回执与实验总结" });
  opener.focus();
  fireEvent.click(opener);
  await act(async () => { fireEvent.keyDown(screen.getByRole("dialog", { name: "报告已评阅" }), { key: "Escape" }); });
  await settle();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test("a tab coming back shows a report changed elsewhere, and will not export a grade that is gone", async () => {
  const graded = report("graded");
  const session = spyOn(api.classroom, "session").mockResolvedValue(sessionWith({ ...mutation("graded"), report: graded }));
  const print = spyOn(globalThis, "print").mockImplementation(() => {});
  const changed: ClassroomReport["state"][] = [];
  try {
    render(<ReportLab {...finishProps} report={graded} sessionUpdatedAt="2026-08-14T00:00:00Z" onReportChanged={(response) => changed.push(response.report.state)} />);
    // Unchanged on the server: nothing to apply.
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(session).toHaveBeenCalledTimes(1);
    expect(changed).toEqual([]);
    // Another tab regenerated the report, which cleared the grade.
    const regenerated = { ...report("pending"), updated_at: "2026-08-13T01:00:00Z", generated_at: "2026-08-13T01:00:00Z" };
    session.mockResolvedValue(sessionWith({ ...mutation("pending"), report: regenerated }));
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(changed).toEqual(["pending"]);
    // This parent does not apply it, so the page still offers the graded PDF: the export checks again and refuses.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "导出已评阅版本 PDF" })); });
    await settle();
    expect(print).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(gradedExportRefusal(regenerated));
    expect(gradedExportRefusal(regenerated)).toContain("原评分和评语已清除，不能再导出已评阅版本");
  } finally { session.mockRestore(); print.mockRestore(); }
});

test("a combined emoji that does not fit is said to take several characters", async () => {
  const base = "甲".repeat(REFLECTION_MAX_LENGTH - 3);
  const family = limitInsertion(base, `${base}👨‍👩‍👧`, base.length + 8);
  expect([family.value, family.cut, family.wide]).toEqual([base, true, true]);
  expect(limitInsertion(base, `${base}乙乙乙乙`, base.length + 4).wide).toBe(false);
  function Harness() {
    const [data, setData] = useState<Record<string, unknown>>({ limitations: base });
    return <ReportLab {...finishProps} state={{ ...finishProps.state, data, save: (patch) => setData((value) => ({ ...value, ...patch })) }} />;
  }
  render(<Harness />);
  act(() => { fireEvent.change(screen.getByRole("textbox", { name: "局限与反思" }), { target: { value: `${base}👨‍👩‍👧` } }); });
  expect(screen.getByText(/这个表情按实际字符计算占多个字，剩余字数不够/)).toBeTruthy();
  expect(screen.queryByText(/一部分没有保留/)).toBeNull();
});

test("a refused regeneration reveals the teacher-grade conflict without replacing local answers", async () => {
  const generate = spyOn(api.classroom, "generateReport").mockRejectedValue(new ApiError(409, "报告或评分已更新，请刷新页面核对后再确认重新生成", "Conflict"));
  const newer = { research_question: "新的研究问题", evidence_interpretation: "新的结果解释", limitations: "新的局限" };
  const session = spyOn(api.classroom, "session").mockResolvedValue(sessionWith(mutation("graded"), { "15": { data: newer } }));
  const revealed: Element[] = [];
  const scrolled = spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) { revealed.push(this); });
  try {
    render(<ReportLab {...finishProps} report={report("pending")} state={{ ...finishProps.state, data: { research_question: "旧的研究问题", evidence_interpretation: "旧的结果解释", limitations: "旧的局限" } }} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /重新生成并提交/ })); });
    await settle();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("老师刚刚评阅了这份报告");
    expect((screen.getByRole("textbox", { name: "局限与反思" }) as HTMLTextAreaElement).value).toBe("旧的局限");
    expect(document.querySelector(".report-answers-outdated")).toBeNull();
    expect(revealed.at(-1) === alert).toBe(true);
  } finally { generate.mockRestore(); session.mockRestore(); scrolled.mockRestore(); }
});

test("an element is revealed at the top of the course scroller with room above it", () => {
  const calls: ScrollToOptions[] = [];
  const scroller = { scrollTop: 10, getBoundingClientRect: () => ({ top: 20 }), scrollTo: (options: ScrollToOptions) => calls.push(options) };
  const target = { closest: () => scroller, getBoundingClientRect: () => ({ top: 500 }) } as unknown as HTMLElement;
  revealWithOffset(target);
  expect(calls).toEqual([{ top: 474, left: 0, behavior: "smooth" }]);
});

test("the report status is compared by version, state and grade", () => {
  const graded = report("graded");
  expect(reportStatusChanged(graded, { ...graded })).toBe(false);
  expect(reportStatusChanged(graded, { ...graded, state: "pending", graded_at: null })).toBe(true);
  expect(reportStatusChanged(graded, { ...graded, updated_at: "2026-08-14T00:00:00Z" })).toBe(true);
  expect(reportStatusChanged(null, graded)).toBe(true);
});


test("the student's report folds its appendix sections, opens them all while printing, and folds the results panel once handed in", async () => {
  const sectioned = { ...report("draft"), markdown: "# 报告\n\n## 结论\n\n结论段\n\n## 理解题答题记录\n\n答题\n\n## 报告溯源\n\n溯源" };
  const view = render(<ReportLab {...finishProps} report={sectioned} />);
  await waitFor(() => expect(view.container.querySelectorAll(".report-body details.report-section")).toHaveLength(3));
  const open = () => [...view.container.querySelectorAll<HTMLDetailsElement>(".report-body details.report-section")].map((item) => item.open);
  expect(open()).toEqual([true, false, false]);
  // Ctrl+P or the export button: a closed details prints nothing, so every section opens for the print and folds back after.
  act(() => { window.dispatchEvent(new Event("beforeprint")); });
  expect(open()).toEqual([true, true, true]);
  act(() => { window.dispatchEvent(new Event("afterprint")); });
  expect(open()).toEqual([true, false, false]);
  // The 四步回归结果 panel is open while writing (a draft), folded once the report is with the teacher.
  const panel = () => view.container.querySelector<HTMLDetailsElement>("details.report-reference")!;
  expect(panel().open).toBe(true);
  expect(panel().querySelector("summary")?.textContent).toBe("四步回归结果");
  view.rerender(<ReportLab {...finishProps} report={{ ...sectioned, state: "pending" }} />);
  expect(panel().open).toBe(false);
  view.unmount();
});


test("你记录的材料 lists every step 1–14 in the words its material card used, and links a missing step back", () => {
  const steps = [1, 2, 6, 11, 15].map((n) => ({ n, title: `步骤名${n}`, lab: n === 15 ? "rep" : "viz" }));
  const data: Record<number, Record<string, unknown>> = {
    1: { observation: { row: "CHN_A01", column: "USA_A01", value: 1 }, material_label: "2020 年 CHN 中国·A01（供给）→ USA 美国·A01（使用）= 228.07 百万美元" },
    2: { observations: [{ country: "CHN" }] },
    11: { run: { result: {} }, material_label: "默认模型：外国增加值项占比两年累计 -0.55 个百分点" },
  };
  const navigated: number[] = [];
  render(<RecordedMaterials steps={steps as never} getStep={(n: number) => data[n] as never} blocked={[{ step: 6, title: "步骤名6", missing: ["请在一张读数完整的图表下点“把这张图记为本步报告材料”"] }]} onNavigateStep={(n: number) => { navigated.push(n); }} />);
  const rows = [...document.querySelectorAll(".report-materials tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent));
  expect(rows).toEqual([
    ["步骤 1 · 步骤名1", "已记录", "2020 年 CHN 中国·A01（供给）→ USA 美国·A01（使用）= 228.07 百万美元"],
    ["步骤 2 · 步骤名2", "已记录", "已记录（旧记录，到本步查看）"],
    ["步骤 6 · 步骤名6", "未记录", "请在一张读数完整的图表下点“把这张图记为本步报告材料”"],
    ["步骤 11 · 步骤名11", "已记录", "默认模型：外国增加值项占比两年累计 -0.55 个百分点"],
  ]);
  fireEvent.click(screen.getByRole("button", { name: "步骤 6 · 步骤名6" }));
  expect(navigated).toEqual([6]);
});
