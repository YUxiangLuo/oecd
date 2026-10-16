import { useEffect, useRef, useState, type ReactNode } from "react";
import { scrollIntoCourseContent } from "./content-scroll";
import { api } from "./api";
import { useAsync } from "./labs";
import { DEFAULT_BASELINES, displayBaselineLabel, GENERATED_DATA_NOTE, lessonFor, lessonQuestion } from "./regression-lessons";
import { chartDisplayScale, depvarKind, headlineCoefficient } from "./regression-verdict";
import { exampleWasChosen } from "./labs/steps/shock-lab";
import type {
  Meta,
  RegressionDesignInfo,
  ReportedCustomResult,
  Step,
  StepStateApi,
  TeachingGroupsResponse,
  TeachingOverviewResponse,
  TeachingPanelResponse,
  Experiment,
  WorkbenchOptions,
} from "./types";
import { TARIFF_IMPOSER, teachingExample, type TeachingExampleSelection } from "./teaching-example";
import { userFacingRequestError } from "./user-facing-error";
import { countryLabel, GroupChangeChart, sectorLabel } from "./viz";
import { DivergingBarChart } from "./viz/regression/diverging-bars";
import { RegressionModelWorkbench, type WorkbenchStepState } from "./regression-workbench";
import { perPointDigits, perPointReading, shownModelLabel } from "./regression-workbench-table";
import { MaterialCard } from "./material-card";
import { regressionMaterialLabel } from "./material-label";
import { DesignEquation } from "./regression-step/model-equation";
import { RegressionResultCard, type RegressionExample } from "./regression-step/result-card";
import { regressionRunSnapshotIdentity, savedRegressionResponse, TEACHING_MODEL_VERSION, type RegressionStepState } from "./regression-step/saved-run";
import {
  barPreviewText, degreeIdentity, familyBarRows, familyBarsTitle, forwardShareIdentity, tradeShareIdentity, GROUP_CHART_CAPTION, groupLines, kindOf,
  parallelTrendsNote, waveMarkers,
} from "./regression-step/family-bars";
import { INTERRUPTED_RUN_NOTE, useRegressionRun } from "./regression-step/use-regression-run";
import { DecompositionList } from "./regression-teach";

// The step's pieces, re-exported here: the page is what the course imports.
export { equationSymbol, explanatoryText, sampleFilterLabel } from "./regression-step/model-equation";
export {
  exampleEffect, exampleXText, lagSplit, NETWORK_UNIT_NOTE, RegressionResultCard, type RegressionExample,
} from "./regression-step/result-card";
export {
  regressionRunSnapshotIdentity, TEACHING_MODEL_VERSION, type RegressionStepState, type SavedRegressionRun,
} from "./regression-step/saved-run";
export {
  barPreviewText, degreeIdentity, familyBarRows, familyBarsTitle, forwardShareIdentity, tradeShareIdentity, GROUP_CHART_CAPTION, groupLines,
  NETWORK_DEGREE_IDENTITY, parallelTrendsNote, runEstimate, waveMarkers,
} from "./regression-step/family-bars";
export { INTERRUPTED_RUN_NOTE } from "./regression-step/use-regression-run";
export { groupedFixed } from "./format";
export { networkDigits } from "./regression-verdict";

/** Reveal a freshly calculated verdict inside the course's scroll container (see content-scroll.ts). */
export const scrollRegressionVerdict = scrollIntoCourseContent;

export function RegressionRequestError({ label, error, onRetry }: {
  label: string;
  error: string;
  onRetry: () => void;
}) {
  return (
    <div className="error-box async-error" role="alert">
      <span>{userFacingRequestError(error, `${label}加载失败`)}</span>
      <button type="button" className="secondary" onClick={onRetry}>重新加载{label}</button>
    </div>
  );
}


/**
 * One regression step (11–14). Each step is self-contained: it reads only its own saved run. One button runs the
 * course default model on the step's default Y; that run is the headline and the report material. The bars show
 * every Y of the family; a click on another bar previews its reading and saves nothing.
 */
export function RegressionRunLab({ step, meta, state, getStep, reportCustomResults, reportOutdated = false, quiz }: {
  step: Step;
  /** The step's quiz panel: placed after the result, before the optional workbench. */
  quiz?: ReactNode;
  meta: Pick<Meta, "countries" | "sectors">;
  state: StepStateApi<RegressionStepState>;
  /** Read-only: the example the student chose in step 10. */
  getStep?: <T>(step: number) => T | undefined;
  /** The model experiments the current report printed (its provenance). */
  reportCustomResults?: ReportedCustomResult[];
  /** The report needs updating: the same signal as the sidebar and step 15 (unsaved edits, or the server says so). */
  reportOutdated?: boolean;
}) {
  const outcome = step.regression_outcome;
  // The button names the step's regression ("计算贸易流回归"), as the step title does.
  const runName = step.title.split("：")[0] || "回归";
  if (!outcome) return <div className="error-box">当前回归步骤缺少 regression_outcome 配置。</div>;
  // Another Y's bar was clicked: its reading is shown under the bars (nothing is saved).
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  // The bars are fetched with the first run (or with a restored one), never before.
  const [overviewWanted, setOverviewWanted] = useState(false);
  // The optional workbench is folded until opened; its options and tables load only then.
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const workbenchSummaryRef = useRef<HTMLElement>(null);
  const revealWorkbench = useRef(false);
  useEffect(() => {
    if (!workbenchOpen || !revealWorkbench.current) return;
    const frame = window.requestAnimationFrame(() => {
      revealWorkbench.current = false;
      const summary = workbenchSummaryRef.current;
      summary?.focus({ preventScroll: true });
      scrollIntoCourseContent(summary, "auto");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [workbenchOpen]);
  const verdictAnchorRef = useRef<HTMLDivElement>(null);
  const { result, setResult, error, running, runningRef, interrupted, retryWait, run, scrollToVerdictAfterRun } = useRegressionRun({
    outcome,
    runName,
    onStart: () => { setOverviewWanted(true); setPreviewKey(null); },
    onSaved: (saved) => {
      // The same estimate the headline prints (the X terms' sum, or a single X's coefficient), so the card and
      // step 15 repeat the headline's number.
      const stat = headlineCoefficient(saved);
      const source = { depvar_kind: saved.design.depvar_kind ?? "", result: { suppressed: false } };
      // The bounds at the estimate's own precision (the headline's), not at theirs.
      const digits = stat ? perPointDigits(outcome, stat, source) : undefined;
      state.save({ run: saved, material_label: regressionMaterialLabel({
        depvar: displayBaselineLabel(saved.design.depvar_label),
        reading: stat ? perPointReading(outcome, stat, source, digits) : null,
        interval: stat && stat.ci_low != null && stat.ci_high != null
          ? `${perPointReading(outcome, { ...stat, coef: stat.ci_low }, source, digits)} 至 ${perPointReading(outcome, { ...stat, coef: stat.ci_high }, source, digits)}`
          : null,
      }) });
    },
  });

  // Before the run: the taxed vs untaxed comparison that the regression then quantifies.
  const groupsQuery = useAsync<TeachingGroupsResponse>(() => api.teachingGroups(), ["teaching-groups"]);
  // The default model as the server describes it (its equation), shown above the run button before any result.
  const designKey = `regression-design:${outcome}`;
  const designQuery = useAsync<RegressionDesignInfo>(() => api.regressionDesign(outcome), [designKey], { requestKey: designKey });
  const modelDesign = result?.design ?? (designQuery.status === "success" ? designQuery.data ?? null : null);
  const groups = groupsQuery.status === "success" ? groupsQuery.data : null;
  const baselineOptions = groups?.baselines?.[outcome] ?? [];
  // The step's Y: its family's default, which the step title names. The result and the report use it only.
  const defaultKey = baselineOptions.find((option) => option.default)?.key ?? DEFAULT_BASELINES[outcome];
  const defaultOption = baselineOptions.find((option) => option.key === defaultKey);
  const lesson = lessonFor(outcome, defaultKey, result?.design.baseline_label ?? defaultOption?.label);

  // After the run: the estimate converted to the example(s) followed from step 10 (one country or two).
  const stepTen = getStep?.<TeachingExampleSelection & { teaching_observation?: unknown }>(10);
  const example = teachingExample(meta, stepTen);
  const exampleSaved = Boolean(stepTen?.teaching_observation);
  // As step 10 records it (exampleWasChosen): the default saved because the page was shown is not the student's pick.
  const exampleChosen = exampleWasChosen(stepTen, teachingExample(meta, undefined));
  const exampleCountries = [example.first, example.second].filter(Boolean);
  const exampleKey = `teaching-example:${exampleCountries.join(",")}:${example.industry}`;
  const exampleQuery = useAsync<TeachingPanelResponse>(
    () => api.teachingSeries(exampleCountries, example.industry),
    [exampleKey],
    { requestKey: exampleKey, enabled: exampleCountries.length >= 1 && Boolean(example.industry) },
  );
  const lastYear = exampleQuery.data?.years.at(-1);
  const examples: RegressionExample[] = exampleQuery.status === "success" && exampleQuery.data
    ? exampleCountries.flatMap((country): RegressionExample[] => {
      const row = exampleQuery.data!.rows.find((item) => item.country === country && item.year === lastYear);
      // Word joiners keep "·" with the country, so a line never starts with "·C29".
      const label = `${countryLabel(country)}⁠·⁠${sectorLabel(example.industry)}`;
      if (country === TARIFF_IMPOSER) return [{ label, x: 0, imposer: true }];
      return row ? [{
        label, x: row.teaching_tariff_exposure, tau: row.teaching_tariff_rate_tau, w: row.teaching_export_share_w,
        service: !/^[ABC]/.test(example.industry),
      }] : [];
    })
    : [];

  // 会话异步到达：刷新或换设备后恢复本步上次算出的结果（也就是报告材料），而不是空白面板。
  const savedRun = state.data?.run;
  const savedRunIdentity = savedRun ? regressionRunSnapshotIdentity(savedRun) : null;
  const savedVersionOk = savedRun?.model_snapshot?.version === TEACHING_MODEL_VERSION && Boolean(savedRun.variable_catalog);
  // Only a run on the step's default Y is the step's result (a record from before the Y was fixed is not restored).
  const groupsSettled = groupsQuery.status === "success" || groupsQuery.status === "error";
  const savedUsable = savedVersionOk && groupsSettled && savedRun?.design?.baseline === defaultKey;
  useEffect(() => {
    if (running || runningRef.current || result || !savedUsable) return;
    setResult(savedRegressionResponse(savedRun!));
  }, [result, running, savedRunIdentity, savedUsable]);
  const staleSavedY = savedVersionOk && groupsSettled && !savedUsable && !result;

  const overviewQuery = useAsync<TeachingOverviewResponse>(
    () => api.teachingOverview(),
    ["teaching-overview"],
    { enabled: overviewWanted || Boolean(result) },
  );
  const overviewItems = overviewQuery.status === "success" ? overviewQuery.data?.outcomes[outcome] ?? [] : [];

  // 只在学生点运行按钮之后滚到结论；会话恢复和点条形图都不滚动。The bars sit above the verdict and arrive with the
  // overview a moment after the result: scroll once they are in (or failed), so the target does not move afterwards.
  const overviewSettled = overviewQuery.status === "success" || overviewQuery.status === "error";
  useEffect(() => {
    if (!result || !overviewSettled || !scrollToVerdictAfterRun.current) return;
    scrollToVerdictAfterRun.current = false;
    const frame = window.requestAnimationFrame(() => {
      scrollRegressionVerdict(
        verdictAnchorRef.current,
        window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      );
      // The run button stays put, but a keyboard user should land on the answer, not stay behind it.
      document.getElementById("reg-result-title")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [result, overviewSettled]);

  const bars = result && overviewItems.length > 0 ? familyBarRows(outcome, overviewItems, defaultKey, result) : null;
  const previewRow = bars && previewKey ? bars.rows.find((row) => row.key === previewKey) ?? null : null;
  const identity = !bars ? null : outcome === "production" ? forwardShareIdentity(overviewItems) : outcome === "network" ? degreeIdentity(overviewItems) : outcome === "trade" ? tradeShareIdentity(overviewItems) : null;
  const latinGap = /^[A-Za-z]/.test(lesson.shortMetric) ? " " : "";
  const experiment = (state.data as { experiment?: Experiment | null } | undefined)?.experiment ?? null;
  const optionsQuery = useAsync<WorkbenchOptions>(() => api.regressionOptions(), ["regression-options"]);
  const experimentLine = experiment && optionsQuery.status === "success" && optionsQuery.data
    ? `另记入报告的模型实验：${shownModelLabel(experiment.spec, optionsQuery.data)}${experiment.baseline && experiment.baseline !== defaultKey ? `（Y：${displayBaselineLabel(baselineOptions.find((option) => option.key === experiment.baseline)?.label ?? experiment.baseline)}）` : ""}（选做）。`
    : experiment ? "另记入报告的模型实验：1 个（选做）。" : null;

  return (
    <div className="reg-workbench">
      {result && <nav className="reg-page-links" aria-label="回归页快捷入口">
        <a href="#regression-results">查看结果</a>
        <a href="#regression-model" onClick={(event) => {
          event.preventDefault();
          if (workbenchOpen) {
            workbenchSummaryRef.current?.focus({ preventScroll: true });
            scrollIntoCourseContent(workbenchSummaryRef.current, "auto");
          } else {
            revealWorkbench.current = true;
            setWorkbenchOpen(true);
          }
        }}>改模型、对比（选做）</a>
      </nav>}
      {/* 1 · The data first: the question and the three groups before and after the tariffs. */}
      <section className="reg-run-card">
        <span className="reg-section-step">先看数据</span>
        <h3>{lessonQuestion(outcome, defaultKey)}</h3>
        {(!defaultKey || defaultKey === DEFAULT_BASELINES[outcome]) && <p className="reg-y-definition">{lesson.definition}</p>}
        {staleSavedY && (
          <p className="reg-boundary" role="status">上次保存的结果（{displayBaselineLabel(savedRun?.design?.baseline_label) || "—"}）不是本步的 Y，请重新计算。</p>
        )}
        {groups && (() => {
          const series = groups.outcomes[outcome];
          if (!series) return null;
          const kind = result ? depvarKind(outcome, result.design) : kindOf(defaultOption?.kind ?? "", outcome);
          const display = chartDisplayScale(outcome, { depvar_kind: kind });
          // display.scale converts β to "per 1 percentage point of X"; the chart shows Y levels, which need ×100
          // for shares (percentage points) and ×1 for lengths and centrality.
          const levelScale = display.scale * 100;
          const lines = groupLines(series);
          const markers = waveMarkers(groups.policy_years ?? [groups.policy_year]);
          return (
            <div className="reg-group-figure">
              <GroupChangeChart
                years={groups.years}
                markers={markers}
                lines={lines}
                scale={levelScale}
                unit={display.unit ?? lesson.unit}
                title={`加税前后：各组${latinGap}${lesson.shortMetric}的平均变化`}
              />
              {result?.decomposition && (
                <DecompositionList decomposition={result.decomposition} metric={lesson.shortMetric} scale={levelScale}
                  unit={display.unit ?? lesson.unit} digits={kind === "share" ? 1 : kind === "network" ? 0 : 3} />
              )}
              {/* One note, folded: what the chart mixes in, and the premise it can only partly show. */}
              <details className="reg-gap-details">
                <summary>这张图怎么读</summary>
                <p className="muted reg-gap-caption">{lines.length > 2 ? GROUP_CHART_CAPTION : ""}{parallelTrendsNote(groups.years, groups.policy_year, lines.length)}</p>
              </details>
            </div>
          );
        })()}
        {groupsQuery.status === "error" && groupsQuery.error && (
          <RegressionRequestError label="分组对比图" error={groupsQuery.error} onRetry={groupsQuery.retry} />
        )}
      </section>

      {/* 2 · The course default model, said before it is computed; one button computes it. */}
      <section className="reg-run-card">
        <span className="reg-section-step">默认模型</span>
        {modelDesign
          ? <DesignEquation design={modelDesign} expanded={step.n === 11} />
          : designQuery.status === "error" && designQuery.error
            ? <RegressionRequestError label="模型说明" error={designQuery.error} onRetry={designQuery.retry} />
            : <div className="reg-request-state muted" role="status" aria-busy="true">正在读取模型…</div>}
        {/* Said before the run (the result card repeats it), so the Y is never read as OECD data first. */}
        {!result && <p className="muted reg-data-note reg-data-note-before" role="note">{GENERATED_DATA_NOTE}</p>}
        {/* Once a result exists, recalculating is a secondary action (the same model gives the same numbers). */}
        <button
          className={result && !error ? "run-btn secondary" : "run-btn"}
          onClick={() => {
            if (running || retryWait > 0) return;
            void run();
          }}
          // aria-disabled while running keeps keyboard focus on the button instead of dropping it to the page.
          aria-disabled={running || retryWait > 0}
        >
          {running ? "正在计算…"
            : retryWait > 0 ? `重试（${retryWait} 秒后）`
              : error ? `重试：计算${runName}`
                : result ? `重新计算${runName}`
                  : groups ? `计算${runName}（用全部 ${groups.sample.rows.toLocaleString("zh-CN")} 条记录）` : `计算${runName}`}
        </button>
        {/* Mounted before it has text, so screen readers announce the change. */}
        <span className={running ? "muted reg-inline-status" : "sr-only"} role="status" aria-live="polite">{running ? "正在计算…" : ""}</span>
        {interrupted && !running && <p className="reg-boundary reg-interrupted-note" role="status">{INTERRUPTED_RUN_NOTE}</p>}
      </section>

      {/* One action: the run button above doubles as the retry (it shows the wait after "too many requests"). */}
      {error && <div className="error-box async-error" role="alert"><span>{error}</span></div>}

      {result && (
        <div className={error ? "reg-results reg-results-stale" : "reg-results"}>
          {error && <p className="reg-stale-note" role="note">这次计算没有成功；下面仍是上次保存的结果。</p>}
          <div ref={verdictAnchorRef} className="verdict-anchor" id="regression-results" tabIndex={-1}>
            {bars ? (
              <div className="reg-family-bars">
                <DivergingBarChart
                  rows={bars.rows}
                  unitTitle={bars.unitTitle}
                  title={familyBarsTitle(bars.rows.length)}
                  onSelect={(key) => setPreviewKey(key === defaultKey ? null : key)}
                  disabled={running}
                >
                  {/* A click on another Y: its reading, here under the bars; the step's result stays the default Y. */}
                  {previewRow && (
                    <p className="reg-bar-preview" role="status">{barPreviewText(previewRow, lesson.shortMetric)}</p>
                  )}
                  {identity && <p className="muted reg-identity-note">{identity}</p>}
                </DivergingBarChart>
              </div>
            ) : overviewQuery.status === "error" && overviewQuery.error
              ? <RegressionRequestError label="条形图" error={overviewQuery.error} onRetry={overviewQuery.retry} />
              : overviewQuery.status === "loading" && <div className="reg-request-state muted" role="status" aria-busy="true">正在绘制本类各 Y 的条形图…</div>}
            <RegressionResultCard outcome={outcome} response={result} examples={examples} exampleSaved={exampleSaved} exampleChosen={exampleChosen} exampleYear={lastYear} />
            {exampleQuery.status === "error" && exampleQuery.error
              ? <RegressionRequestError label="步骤 10 例子换算" error={exampleQuery.error} onRetry={exampleQuery.retry} />
              : exampleQuery.status === "loading" && <div className="reg-request-state muted" role="status" aria-busy="true">正在读取步骤 10 例子，准备换算…</div>}
          </div>
        </div>
      )}

      {/* 3 · Change one setting at a time and read it next to the default model (folded; optional for completion). */}
      {result && (
        <details className="reg-run-card reg-custom-section" id="regression-model" open={workbenchOpen}
          onToggle={(event) => setWorkbenchOpen(event.currentTarget.open)}>
          <summary ref={workbenchSummaryRef}>
            <span className="reg-section-step">改模型、对比（选做）</span>
            <span className="reg-custom-title">换一种模型试试：每次改一处，和默认模型比较</span>
          </summary>
          {workbenchOpen && (
            <RegressionModelWorkbench
              stepNumber={step.n}
              outcome={outcome}
              defaultResponse={result}
              baselines={baselineOptions}
              state={state as unknown as StepStateApi<WorkbenchStepState>}
              reportCustomResults={reportCustomResults}
              reportOutdated={reportOutdated}
            />
          )}
        </details>
      )}

      {/* 本步报告材料: the default model's result (saved by 计算) and the one experiment put into the report. */}
      <MaterialCard
        state={result ? "recorded" : "missing"}
        summary={result
          ? (state.data?.material_label as string | undefined) ?? `默认模型：${displayBaselineLabel(result.design.depvar_label)}（已计算）`
          : `尚未记录：点“计算${runName}”后自动保存默认模型的结果。`}
        extra={result ? experimentLine : null}
        how={result ? "计算后自动保存，无需另外操作。" : undefined}
        syncing={state.syncing}
        syncError={state.materialSyncError ?? null}
        syncConflict={state.syncConflict}
        onRetrySync={state.syncNow}
      />

      {/* 5 · The quiz, after everything the step shows (the optional workbench included). */}
      {quiz}
    </div>
  );
}
