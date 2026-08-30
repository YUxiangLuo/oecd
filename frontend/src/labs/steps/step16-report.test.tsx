import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClassroomReport } from "../../types";
import { GateCard, ReportLab, ReportStatus, focusReportGateDestination, reflectionCountLabel, reportGenerateButtonLabel, reportGenerateLabel, reportWaitLabel } from "./step16-report";

function report(state: ClassroomReport["state"]): ClassroomReport {
  return {
    markdown: "# report",
    provenance: {
      release_id: "a".repeat(32),
      session_version: "experiment-session-simple-v2",
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

describe("step 16 report states", () => {
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
    expect(html).not.toContain("aria-label=");
  });

  test("puts restore and save status on the generate button itself", () => {
    expect(reportWaitLabel("loading", false, false)).toBe("正在恢复实验记录…");
    expect(reportWaitLabel("ready", true, false)).toBe("正在保存实验记录…");
    expect(reportWaitLabel("ready", false, false)).toBeNull();
    expect(reportGenerateButtonLabel(null, false, "loading", false, false)).toBe("正在恢复实验记录…");
    expect(reportGenerateButtonLabel(null, true, "loading", false, false)).toBe("服务端生成中…");
  });

  test("renders actionable report-gate links", () => {
    const html = renderToStaticMarkup(<GateCard
      blocked={[{ step: 12, title: "回归实验", missing: ["保存有效回归"] }]}
      onNavigateStep={() => {}}
    />);
    expect(html).toContain("步骤 12");
    expect(html).toContain("保存有效回归");
    expect(html).toContain("gate-link");
  });

  test("focuses the destination main after a report-gate navigation", () => {
    const calls: unknown[] = [];
    const found = focusReportGateDestination(12, {
      getElementById: (id) => id === "step-12-main-content"
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
