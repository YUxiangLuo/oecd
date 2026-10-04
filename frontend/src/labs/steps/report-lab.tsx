import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { RegressionEvidenceMatrix, type SiblingStepData } from "../../regression-teach";
import { ReportMarkdown, preloadReportRenderer } from "../../report-renderer-lazy";
import { ReportOutro } from "../../report-outro";
import { clearToasts, showToast } from "../../toast";
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
  /** Sentence starter shown only as placeholder text; never written into the report. */
  starter: string;
  min: number;
}[] = [
  { key: "research_question", label: "研究问题", prompt: "我比较了哪些国家、行业和年份？我想了解哪项指标的变化？请区分真实ICIO比较和模拟关税回归。", starter: "句式参考：本实验比较了……和……的……指标，想了解……；并用模拟关税数据练习读回归结果。", min: 12 },
  { key: "evidence_interpretation", label: "结果解释", prompt: "引用保存的数字，注明对象、年份、指标、方向和区间。比较四项回归结果；无法推断时写明原因，不要写成“没有效应”。", starter: "句式参考：步骤……显示，……在……年的……为……；步骤 11 的回归估计 X 每增加 1 个百分点，Y 平均……，95% 区间为……。", min: 40 },
  { key: "limitations", label: "局限与反思", prompt: "模拟关税X与结果Y不能证明真实政策效果。我的比较还有哪些限制？哪些结论不能推出？下一步需要什么数据或检验？", starter: "句式参考：X 与 Y 都是教学模拟数据，因此……；我的比较只覆盖……；若要进一步验证，需要……。", min: 30 },
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
  { label: "图表比较", first: 6, last: 9 },
  { label: "模拟回归", first: 10, last: 14 },
  { label: "实验报告", first: 15, last: 15 },
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
          <h3 id="report-gate-title" tabIndex={-1}>还不能生成报告</h3>
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
  const [outro, setOutro] = useState<ClassroomReport | null>(null);
  const operationRef = useRef(false);
  const visibleBlocked = blocked.length > 0 ? blocked : reportGate ?? [];

  useEffect(() => { void preloadReportRenderer().catch(() => {}); }, []);
  // A newer acknowledged session supersedes a gate returned for an older snapshot.
  useEffect(() => { setBlocked([]); }, [reportGate]);
  useEffect(() => {
    if (blocked.length > 0) document.getElementById("report-gate-title")?.focus();
  }, [blocked]);

  const reflection = (state.data ?? {}) as ReportReflectionState;
  const writtenCount = REFLECTION_FIELDS.filter((field) => String(reflection[field.key] ?? "").trim().replace(/\s+/g, " ").length >= field.min).length;
  const materialMissing = visibleBlocked.filter((item) => item.step !== 15);
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

  const generate = async (submitAfter = false) => {
    if (busy || operationRef.current) return;
    if (report?.state === "graded" && !window.confirm(
      "此报告已经评阅。重新生成会替换报告、清除现有评分和评语，并重新提交给老师。确定继续吗？",
    )) return;
    operationRef.current = true;
    setGenerating(true);
    setError(null);
    setBlocked([]);
    try {
      await waitUntilReady();
      await flushRef.current();
      // Bind replacement to the report the student saw (and, if graded, confirmed).
      const response = await api.classroom.generateReport(report?.updated_at ?? null);
      onReportChanged(response);
      let finalReport = response.report;
      if (submitAfter && response.report.state === "draft") {
        setSubmitting(true);
        const submitted = await api.classroom.submitReport();
        onReportChanged(submitted);
        finalReport = submitted.report;
      }
      if (finalReport.state !== "draft") {
        clearToasts();
        setOutro(finalReport);
      }
      else showToast("报告草稿已生成，请预览后提交");
    } catch (cause) {
      const requestError = cause as Error & { blocked?: ReportGateItem[] };
      if (requestError.blocked) setBlocked(requestError.blocked);
      else setError(userFacingRequestError(cause, submitAfter ? "报告生成或提交失败；已生成的草稿会保留，请核对状态后重试" : "报告生成失败"));
    } finally {
      setGenerating(false);
      setSubmitting(false);
      operationRef.current = false;
    }
  };

  const submit = async () => {
    if (busy || operationRef.current) return;
    operationRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await waitUntilReady();
      await flushRef.current();
      const response = await api.classroom.submitReport();
      onReportChanged(response);
      if (response.report.state !== "draft") {
        clearToasts();
        setOutro(response.report);
      }
      else showToast("报告仍为草稿，请核对后重试提交");
    } catch (cause) {
      setError(userFacingRequestError(cause, "报告提交失败"));
    } finally {
      setSubmitting(false);
      operationRef.current = false;
    }
  };

  const printReport = async () => {
    if (busy || reportOutdated) return;
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
      <section className="report-roadmap" aria-label="报告完成清单">
        <span className="reg-section-step">最后一步 · 完成报告</span>
        <h2>检查材料，写出分析并提交</h2>
        <ol>
          <li><b>1 · 检查实验材料</b><span>{state.syncError ? "保存失败，请先重试保存" : reportGate == null || sessionStatus !== "ready" ? "正在核对服务器记录" : sessionUnsynced || sessionSyncing ? "保存后将重新核对材料" : materialMissing.length ? `第 1–14 步中有 ${materialMissing.length} 处待补齐，见下方入口` : "已保存材料与理解题已齐"}</span></li>
          <li><b>2 · 写下自己的分析</b><span>{writtenCount} / 3 段达到最低字数 · 内容仍需自己核对</span></li>
          <li><b>3 · 提交给老师</b><span>{report?.state === "pending" ? "已提交，等待评阅" : report?.state === "graded" ? "已评阅，可查看反馈" : report ? "已有草稿，尚未提交" : "生成报告不等于提交"}</span></li>
        </ol>
      </section>
      {visibleBlocked.length > 0 && <GateCard blocked={visibleBlocked} onNavigateStep={onNavigateStep} />}
      <details className="report-reference"><summary>查看已保存的四项回归结果</summary>
        <RegressionEvidenceMatrix getStep={getStep} />
        <p className="muted">系数图和换算到例子可回到步骤 11–14 查看；步骤 6–9 的图表读数会自动写进报告。这里只列出已保存的结果，结论需要你自己写。</p>
      </details>
      <section className="report-reflection" aria-labelledby={REPORT_REFLECTION_TITLE_ID}>
        <div>
          <span className="reg-section-step">你的分析 · 自动保存</span>
          <h3 id={REPORT_REFLECTION_TITLE_ID} tabIndex={-1}>回答三个问题</h3>
          <p>写清研究对象、主要结果和仍不能确定的内容。引用具体数字，并说明结论限制。</p>
        </div>
        <div className="report-reflection-fields">
          <div className="report-writing-checklist" role="note">
            <b>写作自检（字数达标不等于论证完整）</b>
            <span>① 点名比较对象　② 引用具体数字　③ 解释方向与区间　④ 说明不能推出什么</span>
          </div>
          {REFLECTION_FIELDS.map((field, index) => {
            const value = String(reflection[field.key] ?? "");
            const length = value.trim().split(/\s+/).join(" ").length;
            return (
              <label key={field.key}>
                <span><b>{index + 1}. {field.label}</b><small>{reflectionCountLabel(length, field.min)}</small></span>
                <small id={`report-hint-${field.key}`} className="report-writing-hint">{field.prompt}</small>
                <textarea
                  aria-label={field.label}
                  aria-describedby={`report-hint-${field.key}`}
                  value={value}
                  rows={field.key === "research_question" ? 2 : 4}
                  maxLength={REFLECTION_MAX_LENGTH}
                  placeholder={`${field.starter}\n（输入后自动保存）`}
                  data-report-reflection-incomplete={length < field.min ? "true" : undefined}
                  disabled={busy}
                  onChange={(event) => state.save({ [field.key]: event.target.value })}
                />
              </label>
            );
          })}
        </div>
      </section>

      {/* Only an outdated snapshot needs a notice; the generation time is also on the status card below. */}
      {report && reportOutdated && (
        <div className="report-version-notice outdated" role="status">
          <b>报告尚未包含最新修改</b>
          <p>生成时间：{fmtTime(report.generated_at)}。实验记录自动保存不会更新报告；修改后请先重新生成，再提交或导出。
            {report.state === "graded" && "重新生成会重新提交报告，并清除原评分。"}</p>
        </div>
      )}
      <section className="report-submit-panel" aria-label="提交报告">
        <h3>{report && report.state !== "draft" ? "报告已交给老师" : "核对完毕后，完成提交"}</h3>
        <p>提交前会先保存文字并检查材料；导出 PDF 仅供个人留存，不能代替提交。
          {report?.state === "graded" && "重新生成并提交会替换已评阅报告并清除原评分。"}</p>
        {(!report || reportOutdated) && <button type="button" className="primary" disabled={busy} onClick={() => { void generate(true); }}>
          {submitting ? "正在提交报告…" : generating ? "正在整理报告…" : report ? "更新报告并提交给老师" : "生成并提交报告"}
        </button>}
        {report && report.state !== "draft" && <button type="button" className="secondary" disabled={busy} onClick={() => setOutro(report)}>查看提交回执与实验总结</button>}
      </section>
      <div className="report-actions">
        <button
          className="secondary"
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

      {error && <div className="error-box" role="alert">{error}</div>}

      {report ? (
        <>
          <section className="submit-card"><ReportStatus report={report} /></section>
          <div className="report-body" tabIndex={-1} aria-label="报告正文"><ReportMarkdown markdown={report.markdown} /></div>
        </>
      ) : (
        <p className="muted">也可以先生成草稿预览再提交；不显著或无法推断的诊断同样可以写进报告。</p>
      )}
      {outro && <ReportOutro report={outro} reportOutdated={reportOutdated} exportDisabled={busy} onClose={() => {
        setOutro(null);
        requestAnimationFrame(() => document.querySelector<HTMLElement>(".report-body")?.focus());
      }} onExport={() => { setOutro(null); void printReport(); }} />}
    </div>
  );
}
