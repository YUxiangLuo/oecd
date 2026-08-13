import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClassroomReport } from "../../types";
import { GateCard, ReportStatus, reportGenerateLabel } from "./step16-report";

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

  test("uses resubmission semantics after submission or grading", () => {
    expect(reportGenerateLabel(null)).toBe("生成实验报告");
    expect(reportGenerateLabel(report("draft"))).toBe("重新生成报告");
    expect(reportGenerateLabel(report("pending"))).toBe("重新生成并提交");
    expect(reportGenerateLabel(report("graded"))).toBe("重新生成并提交");
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
});
