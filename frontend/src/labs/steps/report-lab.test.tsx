import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "../../api";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClassroomReport } from "../../types";
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
} from "./report-lab";

afterEach(cleanup);

function report(state: ClassroomReport["state"]): ClassroomReport {
  return {
    markdown: "# report",
    provenance: {
      release_id: "a".repeat(32),
      session_version: "experiment-session-simple-v3",
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
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "根据实验记录生成报告" })); });
      expect(screen.getByText("还不能生成报告")).toBeDefined();
      view.rerender(<ReportLab {...props} reportGate={[]} state={{ ...props.state, data: { research_question: "已保存的新分析" } }} />);
      expect(screen.queryByText("还不能生成报告")).toBeNull();
      expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      generate.mockRestore();
    }
  });

  test("does not generate or replace an existing report when flushing session edits fails", async () => {
    const generate = spyOn(api.classroom, "generateReport");
    const changed: unknown[] = [];
    try {
      render(<ReportLab
        state={{ data: {}, save: () => {}, complete: true, syncing: false, syncError: "保存失败", syncNow: () => {} }}
        report={report("graded")} reportGate={[]} sessionStatus="ready" sessionUnsynced={true} sessionSyncing={false}
        onFlushSession={async () => { throw new Error("保存失败，请重试"); }} onNavigateStep={() => {}}
        onReportChanged={(response) => changed.push(response)}
      />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存失败，请先重试" })); });
      expect((await screen.findByRole("alert")).textContent).toContain("保存失败");
      expect(generate).not.toHaveBeenCalled();
      expect(changed).toEqual([]);
      expect(screen.getByText(/已评阅 · 93 分/)).toBeDefined();
    } finally {
      generate.mockRestore();
    }
  });

  test("renders draft, pending, and graded feedback distinctly", () => {
    expect(renderToStaticMarkup(<ReportStatus report={report("draft")} />)).toContain("尚未提交");
    expect(renderToStaticMarkup(<ReportStatus report={report("pending")} />)).toContain("等待教师评阅");
    const graded = renderToStaticMarkup(<ReportStatus report={report("graded")} />);
    expect(graded).toContain("93 分");
    expect(graded).toContain("证据链完整");
  });

  test("shows progress against both the minimum and the hard maximum", () => {
    expect(reflectionCountLabel(0, 40)).toBe("已写 0 / 2400 字 · 最低 40 字");
    expect(reflectionCountLabel(30, 40)).toBe("已写 30 / 2400 字 · 最低 40 字");
    expect(reflectionCountLabel(83, 40)).toBe("已写 83 / 2400 字 · 已达最低 40 字");
    expect(reflectionCountLabel(2400, 40)).toBe("已写 2400 / 2400 字 · 已达上限");
  });

  test("uses resubmission semantics after submission or grading", () => {
    expect(reportGenerateLabel(null)).toBe("根据实验记录生成报告");
    expect(reportGenerateLabel(report("draft"))).toBe("重新生成报告");
    expect(reportGenerateLabel(report("pending"))).toBe("重新生成并提交");
    expect(reportGenerateLabel(report("graded"))).toBe("重新生成并提交");
  });

  test("keeps the generate action distinguishable from the step title", () => {
    const stepTitle = "生成实验报告";
    const first = reportGenerateLabel(null);
    expect(first).toBe("根据实验记录生成报告");
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
    expect(html).toContain(">根据实验记录生成报告<");
    const generateButton = html.match(/<button class="primary"[^>]*>根据实验记录生成报告<\/button>/)?.[0];
    expect(generateButton).toBeDefined();
    expect(generateButton).not.toContain("aria-label=");
  });

  test("puts restore and save status on the generate button itself", () => {
    expect(reportWaitLabel("loading", false, false)).toBe("正在恢复实验记录…");
    expect(reportWaitLabel("ready", true, false)).toBe("正在保存实验记录…");
    expect(reportWaitLabel("ready", false, false)).toBeNull();
    expect(reportWaitLabel("ready", true, false, "session changed")).toBe("保存失败，请先重试");
    expect(reportGenerateButtonLabel(null, false, "ready", true, false, "offline")).toBe("保存失败，请先重试");
    expect(reportGenerateButtonLabel(null, false, "loading", false, false)).toBe("正在恢复实验记录…");
    expect(reportGenerateButtonLabel(null, true, "loading", false, false)).toBe("服务端生成中…");
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
    expect(html).toContain("继续填写原创分析");
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
    expect(overview.summary).toBe("4 个步骤还有 5 项待补齐");
    expect(overview.next?.step).toBe(1);
    expect(overview.groups.map((group) => group.label)).toEqual([
      "数据接入", "指标计算", "回归设计与建模", "实验闭环",
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
  expect((view.container.querySelectorAll(".report-actions button")[1] as HTMLButtonElement).disabled).toBe(true);
  view.unmount();
  const saved = { ...props, sessionUpdatedAt: "2026-08-13T00:05:00Z" };
  const restored = render(<ReportLab {...saved} report={{ ...original, updated_at: "2026-08-13T00:10:00Z" }} />);
  expect(disabled("导出 PDF")).toBe(true);
  restored.rerender(<ReportLab {...saved} report={{ ...original, generated_at: "2026-08-13T00:06:00Z" }} />);
  expect(disabled("导出 PDF")).toBe(false);
  expect(disabled("提交报告给老师")).toBe(false);
});
