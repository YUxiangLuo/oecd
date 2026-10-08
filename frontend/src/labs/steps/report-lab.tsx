import { useEffect, useRef, useState } from "react";
import { api, isApiErrorStatus } from "../../api";
import { RegressionEvidenceMatrix, RegressionFamilyPanels, type SiblingStepData } from "../../regression-teach";
import { ReportMarkdown, preloadReportRenderer } from "../../report-renderer-lazy";
import { ReportOutro } from "../../report-outro";
import { clearToasts, showToast } from "../../toast";
import { stepTaskTitleId } from "../../step-task-card";
import { ConfirmModal } from "../../teacher/ui";
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
  { key: "research_question", label: "研究问题", prompt: "我比较了哪些国家、行业和年份？我想了解哪项指标的变化？请区分指标比较和关税回归。", starter: "句式参考：本实验比较了……和……的……指标，想了解……；再用关税回归看这些指标怎样随关税暴露 X 变化。", min: 12 },
  { key: "evidence_interpretation", label: "结果解释", prompt: "引用保存的数字，注明对象、年份、指标、方向和区间。比较四项回归结果；方向不确定或没算出估计值时写明原因，不要写成“没有影响”。", starter: "句式参考：步骤……显示，……在……年的……为……；步骤 11 的回归估计关税暴露 X 每增加 1 个百分点，Y 平均……，95% 区间为……。", min: 40 },
  { key: "limitations", label: "局限与反思", prompt: "我的比较还有哪些限制？哪些结论不能推出？下一步需要什么数据或检验？", starter: "句式参考：回归只描述 X 与 Y 的关联，因此……；我的比较只覆盖……；若要进一步验证，需要……。", min: 30 },
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
  { label: "关税回归", first: 10, last: 14 },
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
  // Steps 1–14 (materials and quizzes) are counted apart from step 15's own analysis, the same split as the
  // roadmap above the gate; one combined count next to the roadmap's read as a contradiction.
  const earlier = blocked.filter((item) => item.step > 0 && item.step < 15);
  const stepCount = new Set(earlier.map((item) => item.step)).size;
  const globalCount = blocked.filter((item) => item.step <= 0).length;
  const count = (items: ReportGateItem[]) => items.reduce((total, item) => total + item.missing.length, 0);
  const missingCount = count(blocked);
  const ownCount = count(blocked.filter((item) => item.step >= 15));
  const scope = [
    stepCount > 0 ? `步骤 1–14 中 ${stepCount} 个步骤` : null,
    globalCount > 0 ? `${globalCount} 项其他条件` : null,
  ].filter(Boolean).join("、");
  const earlierCount = missingCount - ownCount;
  const parts = [
    earlierCount > 0 ? `${scope || "当前记录"}还有 ${earlierCount} 项待补齐` : null,
    ownCount > 0 ? `本步还有 ${ownCount} 项待完成` : null,
  ].filter(Boolean);
  return {
    groups,
    missingCount,
    next: ordered[0] ?? null,
    summary: parts.join("；") || "当前记录还有 0 项待补齐",
  };
}

export function GateCard({ blocked, onNavigateStep, flash = 0 }: {
  blocked: ReportGateItem[];
  onNavigateStep: (step: number) => void;
  /** Bumped when a blocked generate button sends the student here: the panel briefly highlights. */
  flash?: number;
}) {
  const overview = summarizeReportGate(blocked);
  const next = overview.next;
  if (!next) return null;
  const goToStep = (step: number) => { activateReportGateDestination(step, onNavigateStep); };
  return (
    // The key restarts the highlight animation on every new flash.
    <section key={flash} className={flash ? "report-gate-panel report-gate-flash" : "report-gate-panel"} aria-labelledby="report-gate-title">
      <div className="report-gate-head">
        <span className="report-gate-badge" aria-hidden="true">!</span>
        <div className="report-gate-title">
          <h3 id="report-gate-title" tabIndex={-1}>还不能生成报告</h3>
          <span>{overview.summary}</span>
        </div>
        {next.step > 0 && (
          <button type="button" className="primary report-gate-next-button" onClick={() => goToStep(next.step)}>
            {next.step === 15 ? "去写你的分析" : `继续步骤 ${next.step}`}
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
  // Graded: a score card, so the score and the teacher's comments are the first thing on the page.
  return (
    <div className="report-score-card">
      <b className="report-grade">已评阅 · {report.score} 分</b>
      <span className="muted">评阅时间：{fmtTime(report.graded_at)}</span>
      {report.feedback?.trim()
        ? <div className="report-feedback" tabIndex={0} role="region" aria-label="教师评语"><b>教师评语：</b>{report.feedback}</div>
        : <span className="muted">老师没有写评语。</span>}
    </div>
  );
}

export const REPORT_GENERATE_FIRST_LABEL = "只生成草稿（不提交）";

export function reportGenerateLabel(report: ClassroomReport | null) {
  if (!report) return REPORT_GENERATE_FIRST_LABEL;
  return report.state === "pending" || report.state === "graded" ? "重新生成并提交" : "重新生成草稿";
}

/** Characters as the server counts them (Python ``len`` of the whitespace-collapsed text): code points, so an
 * emoji is one character, not two UTF-16 units. */
export function reflectionLength(text: string): number {
  return [...text.trim().split(/\s+/).join(" ")].length;
}

export function reportWaitLabel(
  sessionStatus: SessionStatus,
  sessionUnsynced: boolean,
  sessionSyncing: boolean,
  syncError: string | null = null,
  syncConflict = false,
): string | null {
  // In a conflict a retry cannot succeed: the student has to load the server version first.
  if (syncConflict) return "请先载入服务器版本";
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
  syncConflict = false,
): string {
  if (generating) return "正在生成报告…";
  return reportWaitLabel(sessionStatus, sessionUnsynced, sessionSyncing, syncError, syncConflict) ?? reportGenerateLabel(report);
}

export function ReportLab({
  state,
  report,
  sessionUpdatedAt,
  reportCurrent,
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
  /** Server verdict (step 15 completion): the report was built from the session's current report inputs. */
  reportCurrent?: boolean | null;
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
  const statusCardRef = useRef<HTMLElement>(null);
  // An in-page confirmation (not window.confirm) before a graded report is replaced; resolves with the answer.
  const [confirmRegenerate, setConfirmRegenerate] = useState<((ok: boolean) => void) | null>(null);
  const askRegenerate = () => new Promise<boolean>((resolve) => setConfirmRegenerate(() => resolve));
  const operationRef = useRef(false);
  const visibleBlocked = blocked.length > 0 ? blocked : reportGate ?? [];

  useEffect(() => { void preloadReportRenderer().catch(() => {}); }, []);
  // A newer acknowledged session supersedes a gate returned for an older snapshot.
  useEffect(() => { setBlocked([]); }, [reportGate]);
  // A gate panel the student is sent to highlights briefly, so the click visibly did something.
  const [gateFlash, setGateFlash] = useState(0);
  const showGate = () => {
    setGateFlash((value) => value + 1);
    window.requestAnimationFrame(() => {
      const title = document.getElementById("report-gate-title");
      title?.closest("section")?.scrollIntoView?.({ block: "center" });
      title?.focus({ preventScroll: true });
    });
  };
  useEffect(() => {
    if (blocked.length > 0) {
      setGateFlash((value) => value + 1);
      document.getElementById("report-gate-title")?.focus();
    }
  }, [blocked]);

  const reflection = (state.data ?? {}) as ReportReflectionState;
  const writtenCount = REFLECTION_FIELDS.filter((field) => reflectionLength(String(reflection[field.key] ?? "")) >= field.min).length;
  // A paste beyond the limit is cut by the browser; say so instead of losing the end silently.
  const [pasteCut, setPasteCut] = useState<string | null>(null);
  const [attemptedIncomplete, setAttemptedIncomplete] = useState(false);
  // Same split as the gate summary below: steps 1–14, plus global conditions (step 0) counted apart.
  const materialMissing = visibleBlocked.filter((item) => item.step > 0 && item.step < 15);
  const globalMissing = visibleBlocked.filter((item) => item.step <= 0).length;
  const busy = generating || submitting || printing;
  // The saved records still miss items: generating cannot succeed, so the generate buttons say why and point
  // to the list instead (while the session is saving, the list may be out of date and the click goes through).
  const gated = visibleBlocked.length > 0 && sessionStatus === "ready" && !sessionUnsynced && !sessionSyncing;
  const gatedCount = visibleBlocked.reduce((count, item) => count + item.missing.length, 0);
  const generateOrShowGate = (submitAfter = false) => {
    if (gated) {
      showGate();
      return;
    }
    void generate(submitAfter);
  };
  // The server compares content fingerprints, so typing and deleting a character (or changing a view-only
  // setting) leaves the report current; the timestamp is only a fallback before the server has answered.
  const reportOutdated = Boolean(report && (sessionUnsynced || sessionSyncing
    || (typeof reportCurrent === "boolean"
      ? !reportCurrent
      : sessionUpdatedAt && Date.parse(sessionUpdatedAt) > Date.parse(report.generated_at))));
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
    // Hold the guard while the confirmation is open, so a second click cannot start another run
    // (which would replace the pending resolver and leave this call suspended).
    operationRef.current = true;
    if (report?.state === "graded" && !(await askRegenerate())) {
      operationRef.current = false;
      return;
    }
    setGenerating(true);
    setError(null);
    setBlocked([]);
    let generated = false;
    try {
      await waitUntilReady();
      await flushRef.current();
      // Bind replacement to the report the student saw (and, if graded, confirmed).
      const response = await api.classroom.generateReport(report?.updated_at ?? null);
      generated = true;
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
      else {
        showToast("报告草稿已生成，请预览后提交");
        // The generate button is disabled while busy and the page changes under it: continue at the new status.
        window.requestAnimationFrame(() => statusCardRef.current?.focus({ preventScroll: false }));
      }
    } catch (cause) {
      const requestError = cause as Error & { blocked?: ReportGateItem[] };
      if (requestError.blocked) {
        setBlocked(requestError.blocked);
        // Mark the short analysis fields for assistive technology once a submit was refused for them.
        if (requestError.blocked.some((item) => item.step === 15)) setAttemptedIncomplete(true);
      }
      else if (!generated && isApiErrorStatus(cause, 409)) {
        // The report changed under us (typically the teacher just graded it): show the current state
        // instead of a stale page and a message about a draft that was never generated.
        const latest = await api.classroom.session().catch(() => null);
        if (latest?.report) onReportChanged({ report: latest.report, completion: latest.completion, report_gate: latest.report_gate, material_gate: latest.material_gate });
        setError("这份报告刚刚有了新的评阅或更新，页面已显示最新状态。请先查看评分与评语，再决定是否重新生成。");
      } else setError(userFacingRequestError(cause, generated ? "报告已生成为草稿，但提交给老师失败，请重试提交" : "报告生成失败"));
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
          <li><b>1 · 检查实验材料</b><span>{state.syncConflict ? "另一处已更新记录，请先点页面顶部的“载入服务器版本”" : state.syncError ? "保存失败，请先重试保存" : reportGate == null || sessionStatus !== "ready" ? "正在核对服务器记录" : sessionUnsynced || sessionSyncing ? "保存后将重新核对材料" : materialMissing.length || globalMissing ? `${[materialMissing.length ? `步骤 1–14 中 ${materialMissing.length} 个步骤还有 ${materialMissing.reduce((count, item) => count + item.missing.length, 0)} 项待补齐` : null, globalMissing ? `${globalMissing} 项其他条件未满足` : null].filter(Boolean).join("，")}，见下方入口` : "材料和理解题都已齐全"}</span></li>
          <li><b>2 · 写你的分析</b><span>{writtenCount} / 3 段达到最低字数 · 内容仍需自己核对</span></li>
          <li><b>3 · 提交给老师</b><span>{report && report.state !== "draft" && reportOutdated ? "报告需更新：之后的修改还没交给老师，请重新生成并提交" : report?.state === "pending" ? "已提交，等待评阅" : report?.state === "graded" ? <a href="#report-status-card" onClick={(event) => { event.preventDefault(); statusCardRef.current?.scrollIntoView?.({ block: "center" }); statusCardRef.current?.focus({ preventScroll: true }); }}>{report.feedback?.trim() ? "已评阅，查看分数与评语" : "已评阅，查看分数"}</a> : report ? "已有草稿，尚未提交" : "生成报告不等于提交"}</span></li>
        </ol>
      </section>
      {visibleBlocked.length > 0 && <GateCard blocked={visibleBlocked} onNavigateStep={onNavigateStep} flash={gateFlash} />}
      <details className="report-reference"><summary>查看已保存的四项回归结果</summary>
        <p className="muted">四个 Y 的单位不同，每张图各用自己的轴；只比较方向和区间是否包含 0。</p>
        <RegressionFamilyPanels getStep={getStep} />
        <RegressionEvidenceMatrix getStep={getStep} />
        <p className="muted">按你的例子换算的结果在步骤 11–14；步骤 6–9 的图表读数会自动写进报告。这里只列出已保存的结果，结论要你自己写。</p>
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
            const length = reflectionLength(value);
            const countId = `report-count-${field.key}`;
            const short = length < field.min;
            return (
              <label key={field.key}>
                <span><b>{index + 1}. {field.label}</b><small id={countId}>{reflectionCountLabel(length, field.min)}</small></span>
                <small id={`report-hint-${field.key}`} className="report-writing-hint">{field.prompt}</small>
                <textarea
                  aria-label={field.label}
                  aria-describedby={`report-hint-${field.key} ${countId}${pasteCut === field.key ? ` report-paste-${field.key}` : ""}`}
                  aria-invalid={attemptedIncomplete && short ? true : undefined}
                  value={value}
                  rows={field.key === "research_question" ? 2 : 4}
                  placeholder={`${field.starter}\n（输入后自动保存）`}
                  data-report-reflection-incomplete={length < field.min ? "true" : undefined}
                  disabled={busy}
                  onChange={(event) => {
                    // The limit counts characters as the server and the counter do (an emoji is one), which a
                    // maxLength attribute (UTF-16 units) would not; text beyond it is cut and the cut is said.
                    const characters = [...event.target.value];
                    if (characters.length > REFLECTION_MAX_LENGTH) {
                      state.save({ [field.key]: characters.slice(0, REFLECTION_MAX_LENGTH).join("") });
                      setPasteCut(field.key);
                      return;
                    }
                    if (pasteCut === field.key) setPasteCut(null);
                    state.save({ [field.key]: event.target.value });
                  }}
                />
                {pasteCut === field.key && (
                  <small id={`report-paste-${field.key}`} className="report-writing-hint" role="status">
                    内容超过 {REFLECTION_MAX_LENGTH} 字上限，超出的部分没有保留；请精简后再补充。
                  </small>
                )}
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
      {report && <section className="submit-card" id="report-status-card" ref={statusCardRef} tabIndex={-1} aria-label="报告状态"><ReportStatus report={report} /></section>}
      <section className="report-submit-panel" aria-label="提交报告">
        <h3>{report && report.state !== "draft" ? (reportOutdated ? "报告需更新后重新提交" : "报告已交给老师") : "核对完毕后，完成提交"}</h3>
        <p>提交前会先保存文字并检查材料；导出 PDF 仅供个人留存，不能代替提交。</p>
        {/* Same amber callout as the re-run warning on steps 11–14: this action clears the teacher's grade. */}
        {report?.state === "graded" && <p className="reg-rerun-warning" role="note"><b>注意</b>重新生成并提交会替换已评阅报告，并清除原评分和评语。</p>}
        {/* One action group per state: the primary action first, never two buttons doing the same thing. */}
        <div className="report-actions">
          {(!report || reportOutdated) && <button type="button" className="primary" disabled={busy} aria-disabled={gated || undefined} aria-describedby={gated ? "report-gated-reason" : undefined} onClick={() => generateOrShowGate(true)}>
            {submitting ? "正在提交报告…" : generating ? "正在生成报告…"
              : reportWaitLabel(sessionStatus, sessionUnsynced, sessionSyncing, state.syncError, Boolean(state.syncConflict)) ?? (report ? "更新报告并提交给老师" : "生成并提交报告")}
          </button>}
          {report?.state === "draft" && !reportOutdated && (
            <button type="button" className="primary" disabled={busy} onClick={() => { void submit(); }}>
              {submitting ? "提交中…" : reportWaitLabel(sessionStatus, sessionUnsynced, sessionSyncing, state.syncError, Boolean(state.syncConflict)) ?? "提交报告给老师"}
            </button>
          )}
          {/* Draft only (no report, or a draft): a submitted report is updated by the primary action above, or
              regenerated here only when it is current (e.g. to pick up a newer report layout). */}
          {(!report || report.state === "draft") && (
            <button type="button" className="secondary" disabled={busy} aria-disabled={gated || undefined} aria-describedby={gated ? "report-gated-reason" : undefined} onClick={() => generateOrShowGate()}>
              {reportGenerateButtonLabel(report, generating, sessionStatus, sessionUnsynced, sessionSyncing, state.syncError, Boolean(state.syncConflict))}
            </button>
          )}
          {report && report.state !== "draft" && <button type="button" className="secondary" disabled={busy} onClick={() => setOutro(report)}>查看提交回执与实验总结</button>}
          {report && (
            <button type="button" className="secondary" disabled={busy || reportOutdated} onClick={() => { void printReport(); }}>
              {printing ? "正在准备 PDF…" : "导出 PDF"}
            </button>
          )}
          {/* Regenerating a current submitted report clears any grade, so it comes last. */}
          {(report && report.state !== "draft" && !reportOutdated) && (
            <button type="button" className="secondary" disabled={busy} aria-disabled={gated || undefined} aria-describedby={gated ? "report-gated-reason" : undefined} onClick={() => generateOrShowGate()}>
              {reportGenerateButtonLabel(report, generating, sessionStatus, sessionUnsynced, sessionSyncing, state.syncError, Boolean(state.syncConflict))}
            </button>
          )}
        </div>
        {gated && <p id="report-gated-reason" className="report-gated-reason" role="note">还有 {gatedCount} 项没完成，现在还不能生成报告；请先按上方“还不能生成报告”的清单补齐。</p>}
      </section>

      {error && <div className="error-box" role="alert">{error}</div>}

      {report ? (
        <div className="report-body" tabIndex={-1} aria-label="报告正文"><ReportMarkdown markdown={report.markdown} /></div>
      ) : (
        <p className="muted">可以先只生成草稿看看，再提交。区间包含 0、或者没算出估计值的结果，也要写进报告。</p>
      )}
      {confirmRegenerate && (
        <ConfirmModal
          title="重新生成已评阅的报告？"
          message="此报告已经评阅。重新生成会替换报告、清除现有评分和评语，并重新提交给老师。需要留档时，请先在“查看提交回执与实验总结”里记下评分与评语。"
          confirmLabel="确定重新生成"
          danger
          onConfirm={() => confirmRegenerate(true)}
          onClose={() => { confirmRegenerate(false); setConfirmRegenerate(null); }}
        />
      )}
      {outro && <ReportOutro report={outro} reportOutdated={reportOutdated} exportDisabled={busy} onClose={() => {
        setOutro(null);
        requestAnimationFrame(() => document.querySelector<HTMLElement>(".report-body")?.focus());
      }} onExport={() => { setOutro(null); void printReport(); }} />}
    </div>
  );
}
