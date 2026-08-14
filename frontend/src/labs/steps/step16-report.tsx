import { useEffect, useState } from "react";
import { api } from "../../api";
import { ReportMarkdown, preloadReportRenderer } from "../../report-renderer-lazy";
import { showToast } from "../../toast";
import type { ClassroomReport, ReportGateItem, ReportMutationResponse, StepStateApi } from "../../types";
import type { SessionStatus } from "../../use-session";

const fmtTime = (value: string | null | undefined) => value ? value.slice(0, 16).replace("T", " ") : "—";

interface ReportReflectionState extends Record<string, unknown> {
  research_question?: string;
  evidence_interpretation?: string;
  limitations?: string;
}

export const REFLECTION_MAX_LENGTH = 2400;

export function reflectionCountLabel(length: number, min: number): string {
  return length >= min
    ? `已写 ${length} 字 · 已达最低 ${min} 字`
    : `已写 ${length} 字 · 最低 ${min} 字`;
}

const REFLECTION_FIELDS: {
  key: keyof Pick<ReportReflectionState, "research_question" | "evidence_interpretation" | "limitations">;
  label: string;
  prompt: string;
  min: number;
}[] = [
  { key: "research_question", label: "研究问题", prompt: "明确结果变量、冲击与比较对象。", min: 12 },
  { key: "evidence_interpretation", label: "证据解释", prompt: "引用你保存的比较或回归结果，说明它支持什么、不支持什么。", min: 40 },
  { key: "limitations", label: "局限与反思", prompt: "讨论数据、处理定义、识别假设、网络干扰或外推边界。", min: 30 },
];

export function GateCard({ blocked, onNavigateStep }: { blocked: ReportGateItem[]; onNavigateStep: (step: number) => void }) {
  return (
    <section className="report-gate-panel">
      <div className="report-gate-head"><span className="report-gate-badge">!</span><b>还不能生成报告</b></div>
      <ul>
        {blocked.map((item, index) => (
          <li key={`${item.step}-${index}`}>
            {item.step > 0 ? (
              <button type="button" className="gate-link" onClick={() => onNavigateStep(item.step)}>
                步骤 {item.step} · {item.title}
              </button>
            ) : <b>{item.title}</b>}
            {" — "}{item.missing.join("；")}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReportStatus({ report }: { report: ClassroomReport }) {
  if (report.state === "draft") return <span className="muted">草稿 · 尚未提交</span>;
  if (report.state === "pending") return <span className="muted">提交于 {fmtTime(report.submitted_at)} · 等待教师评阅</span>;
  return (
    <div>
      <span className="muted">已评阅 · {report.score} 分 · {fmtTime(report.graded_at)}</span>
      {report.feedback && <p className="muted">教师评语：{report.feedback}</p>}
    </div>
  );
}

export function reportGenerateLabel(report: ClassroomReport | null) {
  if (!report) return "生成实验报告";
  return report.state === "pending" || report.state === "graded" ? "重新生成并提交" : "重新生成报告";
}

export function ReportLab({
  state,
  report,
  sessionStatus,
  sessionUnsynced,
  sessionSyncing,
  onFlushSession,
  onNavigateStep,
  onReportChanged,
}: {
  state: StepStateApi;
  report: ClassroomReport | null;
  sessionStatus: SessionStatus;
  sessionUnsynced: boolean;
  sessionSyncing: boolean;
  onFlushSession: () => Promise<void>;
  onNavigateStep: (step: number) => void;
  onReportChanged: (response: ReportMutationResponse) => void;
}) {
  const [blocked, setBlocked] = useState<ReportGateItem[]>([]);
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void preloadReportRenderer().catch(() => {}); }, []);

  const reflection = (state.data ?? {}) as ReportReflectionState;
  const busy = generating || submitting || printing;
  const waitForSave = sessionStatus !== "ready" || sessionUnsynced || sessionSyncing;

  const generate = async () => {
    setGenerating(true);
    setError(null);
    setBlocked([]);
    try {
      await onFlushSession();
      const response = await api.classroom.generateReport();
      onReportChanged(response);
      showToast(response.report.state === "pending" ? "新报告已重新提交" : "报告草稿已生成");
    } catch (cause) {
      const requestError = cause as Error & { blocked?: ReportGateItem[] };
      if (requestError.blocked) setBlocked(requestError.blocked);
      else setError(requestError.message);
    } finally {
      setGenerating(false);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onFlushSession();
      const response = await api.classroom.submitReport();
      onReportChanged(response);
      showToast(response.report.state === "graded" ? "报告已评阅" : "报告已提交，等待教师评阅");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const printReport = async () => {
    setPrinting(true);
    setError(null);
    try {
      await preloadReportRenderer();
      await new Promise<void>((resolve) => globalThis.requestAnimationFrame(() => resolve()));
      globalThis.print();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div className="report-lab">
      <section className="report-reflection" aria-labelledby="report-reflection-title">
        <div>
          <span className="reg-section-step">先完成 · 学生原创分析</span>
          <h3 id="report-reflection-title">用自己的话把证据连成论证</h3>
          <p>这些文字会完整进入报告；请引用自己实际保存的比较或回归。</p>
        </div>
        <div className="report-reflection-fields">
          {REFLECTION_FIELDS.map((field) => {
            const value = String(reflection[field.key] ?? "");
            const length = value.trim().split(/\s+/).join(" ").length;
            return (
              <label key={field.key}>
                <span><b>{field.label}</b><small>{reflectionCountLabel(length, field.min)}</small></span>
                <textarea
                  value={value}
                  rows={field.key === "research_question" ? 2 : 4}
                  maxLength={REFLECTION_MAX_LENGTH}
                  placeholder={field.prompt}
                  disabled={busy}
                  onChange={(event) => state.save({ [field.key]: event.target.value })}
                />
              </label>
            );
          })}
        </div>
      </section>

      <div className="report-actions">
        <button className="primary" disabled={busy || waitForSave} onClick={() => { void generate(); }}>
          {generating ? "服务端生成中…" : reportGenerateLabel(report)}
        </button>
        {report?.state === "draft" && (
          <button className="primary" disabled={busy || waitForSave} onClick={() => { void submit(); }}>
            {submitting ? "提交中…" : "提交报告给老师"}
          </button>
        )}
        {report && (
          <button className="secondary" disabled={busy} onClick={() => { void printReport(); }}>
            {printing ? "正在准备 PDF…" : "导出 PDF"}
          </button>
        )}
        {waitForSave && <span className="muted">请先保存最新实验记录</span>}
      </div>

      {blocked.length > 0 && <GateCard blocked={blocked} onNavigateStep={onNavigateStep} />}
      {error && <div className="error-box" role="alert">{error}</div>}

      {report ? (
        <>
          <section className="submit-card"><ReportStatus report={report} /></section>
          <div className="report-body"><ReportMarkdown markdown={report.markdown} /></div>
        </>
      ) : (
        <p className="muted">点击生成后，服务端会检查理解题、关键实验证据、有效回归与原创分析；缺项会在这里列出。</p>
      )}
    </div>
  );
}
