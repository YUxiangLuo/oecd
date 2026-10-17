import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, isApiErrorStatus } from "../../api";
import { RegressionEvidenceMatrix, RegressionSummaryBars, ReportedExperiments } from "../../regression-teach";
import type { SiblingStepData } from "../../regression-teach-logic";
import { scrollIntoCourseContent } from "../../content-scroll";
import { ReportMarkdown, preloadReportRenderer } from "../../report-renderer-lazy";
import { ReportOutro } from "../../report-outro";
import { clearToasts, showToast } from "../../toast";
import { ConfirmModal } from "../../teacher/ui";
import type { ClassroomReport, ReportGateItem, ReportMutationResponse, Step, StepStateApi, TeachingCountriesResponse } from "../../types";
import type { SessionStatus } from "../../use-session";
import { userFacingRequestError } from "../../user-facing-error";
import { recordedShockMaterialLabel } from "../../material-label";
import { useAsync } from "../shared";
import { REGRESSION_FAMILIES } from "../../regression-lessons";
import {
  REFLECTION_MAX_LENGTH, REPORT_REFLECTION_TITLE_ID, activateReportGateDestination, activateReportMaterialDestination,
  codePointLength, gradedExportRefusal, limitInsertion, pasteCutMessage, reflectionCountLabel, reflectionLength,
  reportAutosaveLabel, reportConflictMessage, reportGateVerb, reportGenerateButtonLabel, reportOutdatedAdvice,
  reportPrintTitle, reportStatusChanged, reportWaitLabel, revealWithOffset, summarizeReportGate,
} from "./report-lab-logic";

const fmtTime = (value: string | null | undefined) => value ? value.slice(0, 16).replace("T", " ") : "—";

interface ReportReflectionState extends Record<string, unknown> {
  research_question?: string;
  evidence_interpretation?: string;
  limitations?: string;
}


const REFLECTION_FIELDS: {
  key: keyof Pick<ReportReflectionState, "research_question" | "evidence_interpretation" | "limitations">;
  label: string;
  prompt: string;
  /** Said only to a student who put a model experiment in the report (most did not), after the prompt. */
  experimentPrompt?: string;
  /** Sentence starter shown only as placeholder text; never written into the report. */
  starter: string;
  /** Inserted before the starter's closing "。" for a student with a model experiment in the report. */
  experimentStarter?: string;
  min: number;
}[] = [
  { key: "research_question", label: "研究问题", prompt: "我比较了哪些国家、行业和年份？我想了解哪项指标的变化？请把步骤 1–9 的真实 ICIO 指标比较和步骤 10–14 的课程模拟关税回归分开写；回归用的是整个样本，不按步骤 10 的例子挑选，例子只用来换算展示。", starter: "句式参考：本实验用真实 ICIO 指标比较了……和……的……，想了解……；再用课程模拟回归看关税暴露 X 每高 1 个百分点，Y 在默认模型中两年累计平均高还是低。", min: 12 },
  {
    key: "evidence_interpretation",
    label: "结果解释",
    prompt: "引用保存的数字，写明对象、年份、指标、方向和区间，并标明是真实指标还是模拟回归。四步回归写默认模型的两年累计结果；方向不确定或没算出估计值时写明原因，不要写成“没有关联”。",
    experimentPrompt: "你还把模型实验记入了报告：写明改了什么、X 各项合计怎样变、样本是否相同（不同时写明原因）；换了因变量的写明是哪个指标；跨度照“你的模型实验”表中“X 各项合计”一栏括号里的写（如“仅当期 X”“三年累计”），不要一律写两年累计。",
    starter: "句式参考：真实 ICIO 指标探索的步骤……显示，……在……年的……为……；课程模拟的步骤 11 默认模型估计 X 每高 1 个百分点，Y 两年累计平均高（或低）……，95% 区间为……。",
    experimentStarter: "；模型实验“……”的 X 各项合计为……，与默认模型相比……",
    min: 40,
  },
  { key: "limitations", label: "局限与反思", prompt: "真实指标比较和模拟回归各有哪些限制？模拟结果不能当作真实政策效应；选例子换算也不是对该国家行业单独估计。控制变量、固定效应、滞后期及样本变化会怎样影响结论？下一步需要什么真实数据或检验？", starter: "句式参考：课程模拟回归展示 X 与 Y 的关联，不能推出真实政策效应；换一种固定效应或去掉……后结论会……；真实指标比较只覆盖……；若要进一步验证，需要……。", min: 30 },
];


export function GateCard({ blocked, onNavigateStep, flash = 0, verb = "生成" }: {
  blocked: ReportGateItem[];
  onNavigateStep: (step: number) => void;
  /** Bumped when a blocked generate button sends the student here: the panel briefly highlights. */
  flash?: number;
  verb?: "生成" | "更新";
}) {
  const overview = summarizeReportGate(blocked);
  const next = overview.next;
  if (!next) return null;
  const goToStep = (item: Pick<ReportGateItem, "step" | "quiz_only">) => {
    activateReportGateDestination(item.step, onNavigateStep, document, window, Boolean(item.quiz_only));
  };
  return (
    // The key restarts the highlight animation on every new flash.
    <section key={flash} className={flash ? "report-gate-panel report-gate-flash" : "report-gate-panel"} aria-labelledby="report-gate-title">
      <div className="report-gate-head">
        <span className="report-gate-badge" aria-hidden="true">!</span>
        <div className="report-gate-title">
          <h3 id="report-gate-title" tabIndex={-1}>还不能{verb}报告</h3>
          <span>{overview.summary}</span>
        </div>
        {next.step > 0 && (
          <button type="button" className="primary report-gate-next-button" onClick={() => goToStep(next)}>
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
              {/* Items, as the summary above counts them (a step can miss several). */}
              <h4 id={`report-gate-group-${groupIndex}`}>{group.label}<span>{group.items.reduce((count, item) => count + item.missing.length, 0)} 项</span></h4>
              <ul>
                {group.items.map((item, itemIndex) => (
                  <li key={`${item.step}-${itemIndex}`}>
                    {item.step > 0 ? (
                      <button type="button" className="gate-link" onClick={() => goToStep(item)}>
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

/** 你记录的材料: one line per step 1–14, in the same words each step's material card used, with a link back. */
export function RecordedMaterials({ steps, getStep, blocked, onNavigateStep }: {
  steps?: Pick<Step, "n" | "title" | "lab">[];
  getStep?: (step: number) => SiblingStepData | undefined;
  blocked: ReportGateItem[];
  onNavigateStep: (step: number) => void;
}) {
  const shockData = steps?.some((step) => step.n === 10) ? getStep?.(10) as Record<string, unknown> | undefined : undefined;
  const needsCountryLabels = recordedShockMaterialLabel(shockData) !== null;
  const countries = useAsync<TeachingCountriesResponse>(() => api.teachingCountries(), ["report-material-countries"], { enabled: needsCountryLabels });
  const overview = countries.status === "success" ? countries.data ?? undefined : undefined;
  const rows = (steps ?? []).filter((step) => step.n >= 1 && step.n <= 14).map((step) => {
    const data = getStep?.(step.n) as (Record<string, unknown> | undefined);
    // The material reasons only: the quiz is the step's other condition and has its own place in the gate card.
    const missing = blocked.filter((item) => item.step === step.n && !item.quiz_only).flatMap((item) => item.missing).filter((text) => !text.includes("理解题"));
    const label = step.n === 10 ? recordedShockMaterialLabel(data, overview)
      : typeof data?.material_label === "string" ? data.material_label : null;
    const recorded = missing.length === 0 && Boolean(data && Object.keys(data).some((key) => ["observation", "observations", "teaching_observation", "run"].includes(key)));
    // Steps 11–14: the model experiment the card lists on its second line, so the row says what the card says.
    const experiment = step.n >= 11 && step.n <= 14 && data?.experiment ? "另记入报告的模型实验：1 个（选做），见下方“你的模型实验”。" : null;
    return { step, label, missing, recorded, experiment };
  });
  if (!rows.length) return null;
  return (
    <section className="report-materials" aria-labelledby="report-materials-title">
      <h3 id="report-materials-title">你记录的材料</h3>
      <p className="muted">每步一条，和各步“本步报告材料”卡上写的一样；缺的点步骤名回去补。</p>
      {countries.status === "loading" && <p className="muted" role="status">正在核对步骤 10 例子的国家税况…</p>}
      {countries.status === "error" && <div className="error-box" role="alert">{userFacingRequestError(countries.error, "步骤 10 例子的国家税况读取失败")} 材料已保留，暂不显示国家税况。<button className="secondary" onClick={countries.retry}>重试国家税况</button></div>}
      <table>
        <thead><tr><th scope="col">步骤</th><th scope="col">状态</th><th scope="col">记录的材料</th></tr></thead>
        <tbody>
          {rows.map(({ step, label, missing, recorded, experiment }) => (
            <tr key={step.n}>
              <td><button type="button" className="gate-link" onClick={() => activateReportMaterialDestination(step.n, onNavigateStep)}>步骤 {step.n} · {step.title}</button></td>
              <td><span className={`material-chip material-chip--${recorded ? "recorded" : "missing"}`}>{recorded ? "已记录" : "未记录"}</span></td>
              <td>
                {recorded ? label?.trim() || "材料已保存，暂无摘要；可点步骤名查看。" : missing.length ? missing.join("；") : "尚未记录"}
                {experiment && <><br /><small className="muted">{experiment}</small></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

/** The grade as it is printed above the report: the PDF a student keeps carries the score and feedback,
 * which regenerating the report would clear. Hidden on screen, where the status card shows them. */
export function ReportPrintGrade({ report }: { report: ClassroomReport }) {
  if (report.state !== "graded") return null;
  return (
    <section className="report-print-grade" aria-hidden="true">
      <b>教师评阅 · {report.score} 分</b>
      <span>评阅时间：{fmtTime(report.graded_at)}　提交时间：{fmtTime(report.submitted_at)}</span>
      {report.feedback?.trim() ? <p><b>教师评语：</b>{report.feedback}</p> : <p>老师没有写评语。</p>}
    </section>
  );
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
  steps,
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
  /** The course's steps (titles for 你记录的材料). */
  steps?: Pick<Step, "n" | "title" | "lab">[];
}) {
  const [blocked, setBlocked] = useState<ReportGateItem[]>([]);
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outro, setOutro] = useState<ClassroomReport | null>(null);
  // The button that opened the receipt (查看提交回执与实验总结); null when it opened by itself after a submit.
  const outroOpener = useRef<HTMLElement | null>(null);
  const statusCardRef = useRef<HTMLElement>(null);
  // Bring a refused regeneration's explanation into view.
  const errorRef = useRef<HTMLDivElement>(null);
  const revealConflict = useRef<"error" | null>(null);
  // After "只生成草稿（不提交）" the page continues at the draft preview (scrolled to and focused), once the
  // parent has rendered the new report; a session restore does not move the page.
  const previewRef = useRef<HTMLDivElement>(null);
  const revealPreviewAfterDraft = useRef(false);
  useEffect(() => {
    if (!revealPreviewAfterDraft.current || report?.state !== "draft") return;
    revealPreviewAfterDraft.current = false;
    // The first draft renders through a lazy chunk: until the report article is in place the page is too short
    // to scroll the preview to the top (the scroll would be capped), so wait for it (at most about a second).
    let frames = 0;
    const reveal = () => {
      const preview = previewRef.current;
      if (!preview) return;
      if (!preview.querySelector("article") && frames++ < 60) {
        window.requestAnimationFrame(reveal);
        return;
      }
      const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      scrollIntoCourseContent(preview, reduced ? "auto" : "smooth");
      preview.focus({ preventScroll: true });
    };
    // Not cancelled when the report object is replaced again (a session sync): the reveal still happens once.
    window.requestAnimationFrame(reveal);
  }, [report]);
  // An in-page confirmation (not window.confirm) before a graded report is replaced; resolves with the answer.
  const [confirmRegenerate, setConfirmRegenerate] = useState<((ok: boolean) => void) | null>(null);
  const askRegenerate = () => new Promise<boolean>((resolve) => setConfirmRegenerate(() => resolve));
  const operationRef = useRef(false);
  const visibleBlocked = blocked.length > 0 ? blocked : reportGate ?? [];

  useEffect(() => { void preloadReportRenderer().catch(() => {}); }, []);
  // The report's folded sections print open (a closed details prints nothing), whether the export button or
  // Ctrl+P starts the print; afterwards they fold again.
  useEffect(() => {
    const opened: HTMLDetailsElement[] = [];
    const before = () => {
      document.querySelectorAll<HTMLDetailsElement>(".report-body details.report-section:not([open])").forEach((item) => {
        item.open = true;
        opened.push(item);
      });
    };
    const after = () => { opened.splice(0).forEach((item) => { item.open = false; }); };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);
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
  // What to say about a model experiment is asked only of a student who put one in the report.
  const hasExperiment = REGRESSION_FAMILIES.some(({ step }) => Boolean(getStep?.(step)?.experiment));
  // A paste beyond the limit is cut by the browser; say so instead of losing the end silently.
  const [pasteCut, setPasteCut] = useState<{ key: string; wide: boolean; replaced?: boolean; none?: boolean } | null>(null);
  // A new report was generated from the text as it stands: the earlier paste's cut warning no longer applies.
  const generatedAt = report?.generated_at;
  useEffect(() => { setPasteCut(null); }, [generatedAt]);
  // A shortened insertion re-renders the field with a value the browser did not type, which puts the caret at
  // the end; put it back right after the kept part of the insertion.
  const caretAfterCut = useRef<{ key: string; value: string; caret: number } | null>(null);
  const reflectionRoot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pending = caretAfterCut.current;
    if (!pending) return;
    const field = reflectionRoot.current?.querySelector<HTMLTextAreaElement>(`textarea[data-report-field="${pending.key}"]`);
    if (!field || field.value !== pending.value) return;
    caretAfterCut.current = null;
    field.setSelectionRange(pending.caret, pending.caret);
  });
  const [attemptedIncomplete, setAttemptedIncomplete] = useState(false);
  // Same split as the gate summary below: steps 1–14, plus global conditions (step 0) counted apart.
  const materialMissing = visibleBlocked.filter((item) => item.step > 0 && item.step < 15);
  const globalMissing = visibleBlocked.filter((item) => item.step <= 0).length;
  const busy = generating || submitting || printing;
  // The saved records still miss items: generating cannot succeed, so the generate buttons say why and point
  // to the list instead (while the session is saving, the list may be out of date and the click goes through).
  const gated = visibleBlocked.length > 0 && sessionStatus === "ready" && !sessionUnsynced && !sessionSyncing;
  const gatedCount = visibleBlocked.reduce((count, item) => count + item.missing.length, 0);
  const autosave = reportAutosaveLabel(sessionStatus, sessionUnsynced, sessionSyncing, state.syncError, Boolean(state.syncConflict));
  const generateOrShowGate = (submitAfter = false) => {
    if (gated) {
      // Short analysis fields are marked for assistive technology at once, not only after a server refusal.
      if (writtenCount < REFLECTION_FIELDS.length) setAttemptedIncomplete(true);
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
  const reportRef = useRef(report);
  reportRef.current = report;
  const reportChangedRef = useRef(onReportChanged);
  reportChangedRef.current = onReportChanged;

  /**
   * Read the server's report (a cheap GET of the session) and show it when it differs from this page's: another
   * tab may have regenerated it (clearing the grade) or the teacher may have graded it. Never applies the session
   * itself, so unsaved edits here stay. Resolves with the server's report, or undefined when the request failed.
   */
  const refreshReport = async (): Promise<ClassroomReport | null | undefined> => {
    const seen = reportRef.current;
    const latest = await api.classroom.session().catch(() => null);
    if (!latest) return undefined;
    // A generate or submit started meanwhile owns the report; its own response is newer than this read.
    if (latest.report && !operationRef.current && reportRef.current === seen && reportStatusChanged(seen, latest.report)) {
      reportChangedRef.current({ ...latest, report: latest.report });
    }
    return latest.report;
  };
  const refreshReportRef = useRef(refreshReport);
  refreshReportRef.current = refreshReport;
  // A tab left open on step 15 catches up when the student comes back to it.
  useEffect(() => {
    let inFlight = false;
    const onReturn = () => {
      if (document.visibilityState === "hidden" || inFlight || operationRef.current) return;
      inFlight = true;
      void refreshReportRef.current().finally(() => { inFlight = false; });
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);

  // A refused regeneration: its reason is brought into view, clear of the scroller's upper edge.
  useEffect(() => {
    const target = revealConflict.current;
    if (!target) return;
    revealConflict.current = null;
    const frame = window.requestAnimationFrame(() => {
      revealWithOffset(errorRef.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [error]);

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
      revealPreviewAfterDraft.current = !submitAfter;
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
        outroOpener.current = null;
        setOutro(finalReport);
      }
      else {
        showToast("报告草稿已生成，请预览后提交");
      }
    } catch (cause) {
      const requestError = cause as Error & { blocked?: ReportGateItem[] };
      if (requestError.blocked) {
        setBlocked(requestError.blocked);
        // Mark the short analysis fields for assistive technology once a submit was refused for them.
        if (requestError.blocked.some((item) => item.step === 15)) setAttemptedIncomplete(true);
      }
      else if (!generated && isApiErrorStatus(cause, 409)) {
        // The report changed under us: the teacher graded it, or it was submitted or regenerated in another
        // tab. Show the current state instead of a stale page, and say which of these happened.
        const latest = await api.classroom.session().catch(() => null);
        if (latest?.report) onReportChanged({ ...latest, report: latest.report });
        const reason = reportConflictMessage(report, latest?.report ?? null) ?? userFacingRequestError(cause, "报告生成失败");
        setError(reason);
        revealConflict.current = "error";
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
        outroOpener.current = null;
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

  // A graded report can be exported even when later edits are not in it yet: the PDF is the graded version,
  // with its score and feedback, which regenerating would clear.
  const exportable = Boolean(report && (!reportOutdated || report.state === "graded"));
  const printReport = async () => {
    if (busy || !exportable || !report) return;
    setPrinting(true);
    setError(null);
    const pageTitle = document.title;
    let restored = false;
    const printTitle = reportPrintTitle(report);
    const restoreTitle = () => {
      if (restored) return;
      restored = true;
      // Unless the page has set its own title since (another step).
      if (document.title === printTitle) document.title = pageTitle;
      window.removeEventListener("afterprint", restoreTitle);
    };
    try {
      // A graded PDF carries the grade: check the server still has it (another tab may have regenerated the
      // report, which clears it). When the check itself fails, the version shown is exported.
      if (report.state === "graded") {
        const latest = await refreshReport();
        if (latest !== undefined && (latest?.state !== "graded" || latest.graded_at !== report.graded_at || latest.updated_at !== report.updated_at)) {
          setError(gradedExportRefusal(latest));
          revealConflict.current = "error";
          return;
        }
      }
      await preloadReportRenderer();
      await new Promise<void>((resolve) => globalThis.requestAnimationFrame(() => resolve()));
      document.title = printTitle;
      window.addEventListener("afterprint", restoreTitle);
      globalThis.print();
    } catch (cause) {
      restoreTitle();
      setError(userFacingRequestError(cause, "PDF 导出失败"));
    } finally {
      // print() blocks until the dialog closes in most browsers; where it does not, afterprint restores it.
      window.setTimeout(restoreTitle, 30_000);
      setPrinting(false);
    }
  };

  return (
    <div className="report-lab">
      <section className="report-roadmap" aria-label="报告完成清单">
        <span className="reg-section-step">最后一步 · 完成报告</span>
        <h2>检查材料，写出分析并提交</h2>
        <ol>
          <li><b>1 · 检查实验材料</b><span>{state.syncConflict ? "保存已暂停，请先复制需要保留的内容，再按页面顶部说明处理" : state.syncError ? "保存失败，请先重试保存" : reportGate == null || sessionStatus !== "ready" ? "正在核对服务器记录" : sessionUnsynced || sessionSyncing ? "保存后将重新核对材料" : materialMissing.length || globalMissing ? `${[materialMissing.length ? `步骤 1–14 中 ${materialMissing.length} 个步骤还有 ${materialMissing.reduce((count, item) => count + item.missing.length, 0)} 项待补齐` : null, globalMissing ? `${globalMissing} 项其他条件未满足` : null].filter(Boolean).join("，")}，见下方入口` : "材料和理解题都已齐全"}</span></li>
          <li><b>2 · 写你的分析</b><span>{writtenCount} / 3 段达到最低字数 · 内容仍需自己核对</span></li>
          <li><b>3 · 提交给老师</b><span>{report && report.state !== "draft" && reportOutdated ? "报告需更新：之后的修改还没交给老师，请点“更新报告并提交给老师”" : report?.state === "pending" ? "已提交，等待评阅" : report?.state === "graded" ? <a href="#report-status-card" onClick={(event) => { event.preventDefault(); statusCardRef.current?.scrollIntoView?.({ block: "center" }); statusCardRef.current?.focus({ preventScroll: true }); }}>{report.feedback?.trim() ? "已评阅，查看分数与评语" : "已评阅，查看分数"}</a> : report ? (reportOutdated ? "草稿需更新，尚未提交" : "已有草稿，尚未提交") : "生成报告不等于提交"}</span></li>
        </ol>
        <nav className="reg-page-links" aria-label="报告页快捷入口">
          <a href={`#${REPORT_REFLECTION_TITLE_ID}`}>写分析</a>
          <a href="#report-submit-actions">提交与导出</a>
          {report && <a href="#report-preview">查看报告正文</a>}
        </nav>
      </section>
      {visibleBlocked.length > 0 && <GateCard blocked={visibleBlocked} onNavigateStep={onNavigateStep} flash={gateFlash} verb={reportGateVerb(report)} />}
      <RecordedMaterials steps={steps} getStep={getStep} blocked={reportGate ?? []} onNavigateStep={onNavigateStep} />
      {/* Open while the analysis is written (it cites these); folded once the report is handed in. */}
      <details className="report-reference" aria-labelledby="report-regression-results-title" open={!(report?.state === "pending" || report?.state === "graded")}>
        <summary><h3 id="report-regression-results-title" className="report-reference-title">四步回归结果</h3></summary>
        <p className="muted">四个 Y 的单位不同，条长都换算成标准差；条末先写各自单位的值。</p>
        <RegressionSummaryBars getStep={getStep} />
        <RegressionEvidenceMatrix getStep={getStep} />
        <ReportedExperiments getStep={getStep} onNavigateStep={onNavigateStep} />
        <p className="muted">课程模拟回归按你的例子换算的结果在步骤 11–14，不是该例子的单独估计；步骤 6–9 的真实 ICIO 图表读数会自动写进报告。这里只列出已保存的结果，结论要你自己写。</p>
      </details>
      <section className="report-reflection" aria-labelledby={REPORT_REFLECTION_TITLE_ID}>
        <div>
          <span className="reg-section-step">你的分析 · 自动保存</span>
          {autosave && <small className={`report-autosave${autosave === "未保存" ? " failed" : ""}`}>{autosave}</small>}
          <h3 id={REPORT_REFLECTION_TITLE_ID} tabIndex={-1}>回答三个问题</h3>
          <p>写清研究对象、主要结果和仍不能确定的内容。引用具体数字，并说明结论限制。文字按原样写进报告，“#”“**”等符号不会变成标题或粗体。</p>
        </div>
        <div className="report-reflection-fields" ref={reflectionRoot}>
          <div className="report-writing-checklist" role="note">
            <b>写作自检（字数达标不等于论证完整）</b>
            <span>① 点名比较对象　② 引用具体数字　③ 解释方向与区间　④ 说明不能推出什么</span>
          </div>
          {REFLECTION_FIELDS.map((field, index) => {
            const prompt = hasExperiment && field.experimentPrompt ? `${field.prompt}${field.experimentPrompt}` : field.prompt;
            const starter = hasExperiment && field.experimentStarter ? field.starter.replace(/。$/, `${field.experimentStarter}。`) : field.starter;
            const value = String(reflection[field.key] ?? "");
            const length = reflectionLength(value);
            const countId = `report-count-${field.key}`;
            const short = length < field.min;
            return (
              <label key={field.key}>
                <span><b>{index + 1}. {field.label}</b><small id={countId}>{reflectionCountLabel(length, field.min, REFLECTION_MAX_LENGTH, codePointLength(value) >= REFLECTION_MAX_LENGTH, codePointLength(value))}</small></span>
                <small id={`report-hint-${field.key}`} className="report-writing-hint">{prompt}</small>
                <textarea
                  aria-label={field.label}
                  data-report-field={field.key}
                  aria-describedby={`report-hint-${field.key} ${countId}${pasteCut?.key === field.key ? ` report-paste-${field.key}` : ""}`}
                  aria-invalid={attemptedIncomplete && short ? true : undefined}
                  value={value}
                  // Tall enough for the two-line placeholder (a starter sentence and “（输入后自动保存）”).
                  rows={field.key === "research_question" ? 3 : 4}
                  placeholder={`${starter}\n（输入后自动保存）`}
                  data-report-reflection-incomplete={length < field.min ? "true" : undefined}
                  disabled={busy}
                  onChange={(event) => {
                    // The limit counts code points as the server does, which a maxLength attribute (UTF-16
                    // units) would not. Only the newly pasted or typed part is shortened, at the caret; the
                    // student's existing text is never cut, and the cut is said.
                    const limited = limitInsertion(value, event.target.value, event.target.selectionEnd);
                    if (limited.cut) {
                      caretAfterCut.current = { key: field.key, value: limited.value, caret: limited.caret };
                      state.save({ [field.key]: limited.value });
                      setPasteCut({ key: field.key, wide: Boolean(limited.wide), replaced: Boolean(limited.replaced), none: Boolean(limited.none) });
                      return;
                    }
                    // The cut warning belongs to the paste that caused it: the next edit of any field clears it.
                    if (pasteCut) setPasteCut(null);
                    state.save({ [field.key]: event.target.value });
                  }}
                />
                {pasteCut?.key === field.key && (
                  <small id={`report-paste-${field.key}`} className="report-writing-hint" role="status">
                    {pasteCutMessage(pasteCut)}
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
          {/* The server keeps one report: regenerating a submitted one replaces it and submits it again in the same
              step (records.save_generated_report), so there is no draft-only update once it is submitted. */}
          <p>生成时间：{fmtTime(report.generated_at)}。实验记录自动保存不会更新报告。{reportOutdatedAdvice(report.state)}</p>
        </div>
      )}
      {/* A plain status line gets its own padded card, so focus (after the receipt closes) outlines a deliberate box;
          a graded report shows its score card instead. */}
      {report && <section className={report.state === "graded" ? "submit-card" : "submit-card submit-card-plain"} id="report-status-card" ref={statusCardRef} tabIndex={-1} aria-label="报告状态"><ReportStatus report={report} /></section>}
      <section className="report-submit-panel" aria-label="提交报告" id="report-submit-actions" tabIndex={-1}>
        <h3>{report && report.state !== "draft" ? (reportOutdated ? "报告需更新后重新提交" : "报告已交给老师") : "核对完毕后，完成提交"}</h3>
        {/* Once the current version is with the teacher, the pre-submit line no longer applies; only the PDF caveat does. */}
        <p>{report && report.state !== "draft" && !reportOutdated ? "导出 PDF 仅供个人留存，不能代替提交。" : "提交前会先保存文字并检查材料；导出 PDF 仅供个人留存，不能代替提交。"}</p>
        {/* Same amber callout as the re-run warning on steps 11–14: this action clears the teacher's grade. */}
        {report?.state === "graded" && <p className="reg-rerun-warning" role="note"><b>注意</b>{reportOutdated ? "“更新报告并提交给老师”" : "“重新生成并提交”"}会替换已评阅报告，并清除原评分和评语。</p>}
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
          {report && report.state !== "draft" && <button type="button" className="secondary" disabled={busy} onClick={(event) => { outroOpener.current = event.currentTarget; setOutro(report); }}>查看提交回执与实验总结</button>}
          {report && (
            <button type="button" className="secondary" disabled={busy || !exportable} onClick={() => { void printReport(); }}>
              {printing ? "正在准备 PDF…" : reportOutdated && report.state === "graded" ? "导出已评阅版本 PDF" : "导出 PDF"}
            </button>
          )}
          {/* Regenerating a current submitted report clears any grade, so it comes last. */}
          {(report && report.state !== "draft" && !reportOutdated) && (
            <button type="button" className="secondary" disabled={busy} aria-disabled={gated || undefined} aria-describedby={gated ? "report-gated-reason" : undefined} onClick={() => generateOrShowGate()}>
              {reportGenerateButtonLabel(report, generating, sessionStatus, sessionUnsynced, sessionSyncing, state.syncError, Boolean(state.syncConflict))}
            </button>
          )}
        </div>
        {gated && <p id="report-gated-reason" className="report-gated-reason" role="note">还有 {gatedCount} 项没完成，现在还不能{reportGateVerb(report)}报告；请先按上方“还不能{reportGateVerb(report)}报告”的清单补齐。</p>}
      </section>

      {error && <div ref={errorRef} className="error-box report-error" role="alert">{error}</div>}

      {report ? (
        <div className="report-body" id="report-preview" ref={previewRef} tabIndex={-1} role="region" aria-label="报告正文"><ReportPrintGrade report={report} /><ReportMarkdown markdown={report.markdown} foldSections /></div>
      ) : (
        <p className="muted">{gated ? "补齐上方清单中的缺项后，可以先生成草稿预览，再提交。" : "可以先生成草稿预览，再提交。"}区间包含 0、或者没算出估计值的结果，也要写进报告。</p>
      )}
      {confirmRegenerate && (
        <ConfirmModal
          title="重新生成已评阅的报告？"
          message="此报告已经评阅。重新生成会替换报告、清除现有评分和评语，并重新提交给老师。需要留档时，请先取消并导出 PDF：导出的 PDF 含评分与评语。"
          confirmLabel="确定重新生成"
          danger
          onConfirm={() => confirmRegenerate(true)}
          onClose={() => { confirmRegenerate(false); setConfirmRegenerate(null); }}
        />
      )}
      {outro && <ReportOutro report={outro} reportOutdated={reportOutdated} exportDisabled={busy} onClose={() => {
        setOutro(null);
        const opener = outroOpener.current;
        outroOpener.current = null;
        requestAnimationFrame(() => {
          // Opened from 查看提交回执与实验总结: back to that button (the dialog restores it; this keeps it there).
          if (opener?.isConnected) {
            opener.focus();
            return;
          }
          // Opened by itself after a submit (its button is gone): the status card at the top of the report area,
          // not the report body, whose top can be far above the window.
          const card = statusCardRef.current;
          revealWithOffset(card);
          card?.focus({ preventScroll: true });
        });
      }} onExport={() => { setOutro(null); void printReport(); }} />}
    </div>
  );
}
