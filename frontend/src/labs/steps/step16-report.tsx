import { useEffect, useRef, useState } from "react";
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

export function reflectionCountLabel(length: number, min: number, max = REFLECTION_MAX_LENGTH): string {
  if (length >= max) return `已写 ${max} / ${max} 字 · 已达上限`;
  return length >= min
    ? `已写 ${length} / ${max} 字 · 已达最低 ${min} 字`
    : `已写 ${length} / ${max} 字 · 最低 ${min} 字`;
}

const REFLECTION_FIELDS: {
  key: keyof Pick<ReportReflectionState, "research_question" | "evidence_interpretation" | "limitations">;
  label: string;
  prompt: string;
  min: number;
}[] = [
  { key: "research_question", label: "研究问题", prompt: "点明同一套壁垒冲击，以及贸易流、生产、长度、网络里你在看哪一类变化。", min: 12 },
  { key: "evidence_interpretation", label: "证据解释", prompt: "并读四步方向和区间是否过 0：谁像动了、谁看不出。不要把不同单位的系数比大小。", min: 40 },
  { key: "limitations", label: "局限与反思", prompt: "讨论拟真冲击、对照是否可比、网络外溢，以及「看不出」不等于没有效应。", min: 30 },
];

type ReportGateFocusRoot = {
  getElementById(id: string): Pick<HTMLElement, "focus"> | null;
};

/** Restore a useful keyboard position after the gate link itself unmounts. */
export function focusReportGateDestination(
  step: number,
  root: ReportGateFocusRoot = document,
): boolean {
  const target = root.getElementById(`step-${step}-main-content`);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

export function GateCard({ blocked, onNavigateStep }: { blocked: ReportGateItem[]; onNavigateStep: (step: number) => void }) {
  return (
    <section className="report-gate-panel">
      <div className="report-gate-head"><span className="report-gate-badge">!</span><b>还不能生成报告</b></div>
      <ul>
        {blocked.map((item, index) => (
          <li key={`${item.step}-${index}`}>
            {item.step > 0 ? (
              <button
                type="button"
                className="gate-link"
                onClick={() => {
                  onNavigateStep(item.step);
                  window.requestAnimationFrame(() => { focusReportGateDestination(item.step); });
                }}
              >
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

export const REPORT_GENERATE_FIRST_LABEL = "根据实验记录生成报告";

export function reportGenerateLabel(report: ClassroomReport | null) {
  if (!report) return REPORT_GENERATE_FIRST_LABEL;
  return report.state === "pending" || report.state === "graded" ? "重新生成并提交" : "重新生成报告";
}

export function reportWaitLabel(
  sessionStatus: SessionStatus,
  sessionUnsynced: boolean,
  sessionSyncing: boolean,
): string | null {
  if (sessionStatus !== "ready") return "正在恢复实验记录…";
  if (sessionSyncing || sessionUnsynced) return "正在保存实验记录…";
  return null;
}

export function reportGenerateButtonLabel(
  report: ClassroomReport | null,
  generating: boolean,
  sessionStatus: SessionStatus,
  sessionUnsynced: boolean,
  sessionSyncing: boolean,
): string {
  if (generating) return "服务端生成中…";
  return reportWaitLabel(sessionStatus, sessionUnsynced, sessionSyncing) ?? reportGenerateLabel(report);
}

export function ReportLab({
  state,
  report,
  reportGate,
  sessionStatus,
  sessionUnsynced,
  sessionSyncing,
  onFlushSession,
  onNavigateStep,
  onReportChanged,
}: {
  state: StepStateApi;
  report: ClassroomReport | null;
  reportGate: ReportGateItem[] | null;
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
  const visibleBlocked = blocked.length > 0 ? blocked : reportGate ?? [];

  useEffect(() => { void preloadReportRenderer().catch(() => {}); }, []);

  const reflection = (state.data ?? {}) as ReportReflectionState;
  const busy = generating || submitting || printing;
  const readyRef = useRef(sessionStatus === "ready");
  readyRef.current = sessionStatus === "ready";
  const flushRef = useRef(onFlushSession);
  flushRef.current = onFlushSession;

  const waitUntilReady = async () => {
    if (readyRef.current) return;
    const deadline = Date.now() + 15_000;
    await new Promise<void>((resolve, reject) => {
      const tick = () => {
        if (readyRef.current) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error("实验记录仍在恢复，请稍后再试"));
          return;
        }
        window.setTimeout(tick, 50);
      };
      tick();
    });
  };

  const generate = async () => {
    if (busy) return;
    setGenerating(true);
    setError(null);
    setBlocked([]);
    try {
      await waitUntilReady();
      await flushRef.current();
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
    if (busy) return;
    setSubmitting(true);
    setError(null);
    try {
      await waitUntilReady();
      await flushRef.current();
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
          <div className="report-writing-checklist" role="note">
            <b>写作自检（字数达标不等于论证完整）</b>
            <span>① 点名比较对象　② 引用具体数字　③ 解释方向与区间　④ 说明不能推出什么</span>
          </div>
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
        <button
          className="primary"
          disabled={busy}
          onClick={() => { void generate(); }}
        >
          {reportGenerateButtonLabel(report, generating, sessionStatus, sessionUnsynced, sessionSyncing)}
        </button>
        {report?.state === "draft" && (
          <button className="primary" disabled={busy} onClick={() => { void submit(); }}>
            {submitting ? "提交中…" : reportWaitLabel(sessionStatus, sessionUnsynced, sessionSyncing) ?? "提交报告给老师"}
          </button>
        )}
        {report && (
          <button className="secondary" disabled={busy} onClick={() => { void printReport(); }}>
            {printing ? "正在准备 PDF…" : "导出 PDF"}
          </button>
        )}
      </div>

      {visibleBlocked.length > 0 && <GateCard blocked={visibleBlocked} onNavigateStep={onNavigateStep} />}
      {error && <div className="error-box" role="alert">{error}</div>}

      {report ? (
        <>
          <section className="submit-card"><ReportStatus report={report} /></section>
          <div className="report-body"><ReportMarkdown markdown={report.markdown} /></div>
        </>
      ) : (
        <p className="muted">点击生成后，服务端会检查理解题、单元格与比较、四步是否各有一次可报告估计，以及三段原创分析；缺项会在这里列出。</p>
      )}
    </div>
  );
}
