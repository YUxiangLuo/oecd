import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { RegressionEvidenceMatrix, type SiblingStepData } from "../../regression-teach";
import { ReportMarkdown, preloadReportRenderer } from "../../report-renderer-lazy";
import { showToast } from "../../toast";
import { stepTaskTitleId } from "../../step-task-card";
import type { ClassroomReport, ReportGateItem, ReportMutationResponse, StepStateApi } from "../../types";
import type { SessionStatus } from "../../use-session";
import { userFacingRequestError } from "../../user-facing-error";

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

export const REPORT_REFLECTION_TITLE_ID = "report-reflection-title";
export const REPORT_REFLECTION_INCOMPLETE_SELECTOR = "textarea[data-report-reflection-incomplete='true']:not(:disabled)";

type ReportGateFocusRoot = {
  getElementById(id: string): Pick<HTMLElement, "focus"> | null;
  querySelector?(selectors: string): Element | null;
};

type AnimationFrameScheduler = Pick<Window, "requestAnimationFrame">;

/** Restore a useful keyboard position after the gate link itself unmounts. */
export function focusReportGateDestination(
  step: number,
  root: ReportGateFocusRoot = document,
): boolean {
  const target = root.getElementById(stepTaskTitleId(step));
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

/** Step 15 is already mounted: return the student to the first unfinished writing field. */
export function focusReportReflection(root: ReportGateFocusRoot = document): boolean {
  const incomplete = root.querySelector?.(REPORT_REFLECTION_INCOMPLETE_SELECTOR) as Pick<HTMLElement, "focus"> | null | undefined;
  const target = incomplete ?? root.getElementById(REPORT_REFLECTION_TITLE_ID);
  if (!target) return false;
  target.focus();
  return true;
}

export function activateReportGateDestination(
  step: number,
  onNavigateStep: (step: number) => void,
  root: ReportGateFocusRoot = document,
  scheduler: AnimationFrameScheduler = window,
): boolean {
  if (step <= 0) return false;
  if (step === 15) return focusReportReflection(root);
  onNavigateStep(step);
  scheduler.requestAnimationFrame(() => { focusReportGateDestination(step, root); });
  return true;
}

const REPORT_GATE_STAGES = [
  { label: "数据接入", first: 1, last: 1 },
  { label: "指标计算", first: 2, last: 5 },
  { label: "可视化分析", first: 6, last: 9 },
  { label: "回归设计与建模", first: 10, last: 14 },
  { label: "实验闭环", first: 15, last: 15 },
] as const;

function reportGateStage(step: number): string {
  return REPORT_GATE_STAGES.find((stage) => step >= stage.first && step <= stage.last)?.label ?? "其他条件";
}

export function summarizeReportGate(blocked: ReportGateItem[]) {
  const ordered = [...blocked].sort((left, right) => {
    if (left.step <= 0 && right.step > 0) return 1;
    if (left.step > 0 && right.step <= 0) return -1;
    return left.step - right.step;
  });
  const groups = [...REPORT_GATE_STAGES.map(({ label }) => label), "其他条件"]
    .map((label) => ({ label, items: ordered.filter((item) => reportGateStage(item.step) === label) }))
    .filter((group) => group.items.length > 0);
  const stepCount = new Set(blocked.filter((item) => item.step > 0).map((item) => item.step)).size;
  const globalCount = blocked.filter((item) => item.step <= 0).length;
  const missingCount = blocked.reduce((total, item) => total + item.missing.length, 0);
  const scope = [
    stepCount > 0 ? `${stepCount} 个步骤` : null,
    globalCount > 0 ? `${globalCount} 项全局条件` : null,
  ].filter(Boolean).join("、");
  return {
    groups,
    missingCount,
    next: ordered[0] ?? null,
    summary: `${scope || "当前记录"}还有 ${missingCount} 项待补齐`,
  };
}

export function GateCard({ blocked, onNavigateStep }: { blocked: ReportGateItem[]; onNavigateStep: (step: number) => void }) {
  const overview = summarizeReportGate(blocked);
  const next = overview.next;
  if (!next) return null;
  const goToStep = (step: number) => { activateReportGateDestination(step, onNavigateStep); };
  return (
    <section className="report-gate-panel" aria-labelledby="report-gate-title">
      <div className="report-gate-head">
        <span className="report-gate-badge" aria-hidden="true">!</span>
        <div className="report-gate-title">
          <h3 id="report-gate-title">还不能生成报告</h3>
          <span>{overview.summary}</span>
        </div>
        {next.step > 0 && (
          <button type="button" className="primary report-gate-next-button" onClick={() => goToStep(next.step)}>
            {next.step === 15 ? "继续填写原创分析" : `继续步骤 ${next.step}`}
          </button>
        )}
      </div>
      <div className="report-gate-next">
        <span>建议下一步</span>
        <b>{next.step > 0 ? `步骤 ${next.step} · ` : ""}{next.title}</b>
        <p>{next.missing.join("；")}</p>
      </div>
      <details className="report-gate-details">
        <summary>查看全部缺项（{overview.missingCount}）</summary>
        <div className="report-gate-groups">
          {overview.groups.map((group, groupIndex) => (
            <section key={group.label} aria-labelledby={`report-gate-group-${groupIndex}`}>
              <h4 id={`report-gate-group-${groupIndex}`}>{group.label}<span>{group.items.length}</span></h4>
              <ul>
                {group.items.map((item, itemIndex) => (
                  <li key={`${item.step}-${itemIndex}`}>
                    {item.step > 0 ? (
                      <button type="button" className="gate-link" onClick={() => goToStep(item.step)}>
                        步骤 {item.step} · {item.title}
                      </button>
                    ) : <b>{item.title}</b>}
                    <span>{item.missing.join("；")}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </details>
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
  syncError: string | null = null,
): string | null {
  if (syncError) return "保存失败，请先重试";
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
  syncError: string | null = null,
): string {
  if (generating) return "服务端生成中…";
  return reportWaitLabel(sessionStatus, sessionUnsynced, sessionSyncing, syncError) ?? reportGenerateLabel(report);
}

export function ReportLab({
  state,
  report,
  sessionUpdatedAt,
  reportGate,
  sessionStatus,
  sessionUnsynced,
  sessionSyncing,
  onFlushSession,
  onNavigateStep,
  onReportChanged,
  getStep,
}: {
  state: StepStateApi;
  report: ClassroomReport | null;
  sessionUpdatedAt?: string | null;
  reportGate: ReportGateItem[] | null;
  sessionStatus: SessionStatus;
  sessionUnsynced: boolean;
  sessionSyncing: boolean;
  onFlushSession: () => Promise<void>;
  onNavigateStep: (step: number) => void;
  onReportChanged: (response: ReportMutationResponse) => void;
  getStep?: (step: number) => SiblingStepData | undefined;
}) {
  const [blocked, setBlocked] = useState<ReportGateItem[]>([]);
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visibleBlocked = blocked.length > 0 ? blocked : reportGate ?? [];

  useEffect(() => { void preloadReportRenderer().catch(() => {}); }, []);
  // A newer acknowledged session supersedes a gate returned for an older snapshot.
  useEffect(() => { setBlocked([]); }, [reportGate]);

  const reflection = (state.data ?? {}) as ReportReflectionState;
  const busy = generating || submitting || printing;
  const reportOutdated = Boolean(report && (sessionUnsynced || sessionSyncing
    || (sessionUpdatedAt && Date.parse(sessionUpdatedAt) > Date.parse(report.generated_at))));
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
      else setError(userFacingRequestError(cause, "报告生成失败"));
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
      setError(userFacingRequestError(cause, "报告提交失败"));
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
      setError(userFacingRequestError(cause, "PDF 导出失败"));
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div className="report-lab">
      <RegressionEvidenceMatrix getStep={getStep} />
      <section className="report-reflection" aria-labelledby={REPORT_REFLECTION_TITLE_ID}>
        <div>
          <span className="reg-section-step">先完成 · 学生原创分析</span>
          <h3 id={REPORT_REFLECTION_TITLE_ID} tabIndex={-1}>用自己的话把证据连成论证</h3>
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
                  data-report-reflection-incomplete={length < field.min ? "true" : undefined}
                  disabled={busy}
                  onChange={(event) => state.save({ [field.key]: event.target.value })}
                />
              </label>
            );
          })}
        </div>
      </section>

      {report && (
        <div className={`report-version-notice${reportOutdated ? " outdated" : ""}`} role="status">
          <b>{reportOutdated ? "报告尚未包含最新修改" : "报告为生成时的记录快照"}</b>
          <p>生成时间：{fmtTime(report.generated_at)}。实验记录自动保存不会更新报告；修改后请先重新生成，再提交或导出。
            {report.state === "graded" && "重新生成会重新提交报告，并清除原评分。"}</p>
        </div>
      )}
      <div className="report-actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => { void generate(); }}
        >
          {reportGenerateButtonLabel(report, generating, sessionStatus, sessionUnsynced, sessionSyncing, state.syncError)}
        </button>
        {report?.state === "draft" && (
          <button className="primary" disabled={busy || reportOutdated} onClick={() => { void submit(); }}>
            {submitting ? "提交中…" : reportWaitLabel(sessionStatus, sessionUnsynced, sessionSyncing, state.syncError) ?? "提交报告给老师"}
          </button>
        )}
        {report && (
          <button className="secondary" disabled={busy || reportOutdated} onClick={() => { void printReport(); }}>
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
        <p className="muted">点击生成后，服务端会检查理解题、单元格与比较、四步是否各有一次估计或完整的不可推断诊断，以及三段原创分析；缺项会在这里列出。</p>
      )}
    </div>
  );
}
