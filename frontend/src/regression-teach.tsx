import {
  displayBaselineLabel,
  FAMILY_STEPS,
  familyDirectionLabel,
  lessonFor,
  REGRESSION_FAMILIES,
} from "./regression-lessons";
import {
  BAR_UNIT_TITLES,
  barFigures,
  buildRegressionVerdict,
  depvarKind,
  globalInferenceIsSuppressed,
  lagSplitParts,
  SD_DEFINITION,
} from "./regression-verdict";
import { api } from "./api";
import { useAsync } from "./labs";
import { perPointDigits, perPointReading, snapshotOf, specSummary, xSpanLabel, xSum, type PerPointSource } from "./regression-workbench-table";
import type {
  CoefStat, CustomResult, RegressionOutcome, RegressionResponse, TeachingEstimate, TeachingOverviewResponse, WorkbenchOptions,
} from "./types";
import { DivergingBarChart, type DivergingBarRow } from "./viz/regression/diverging-bars";

interface SavedRegression {
  design?: RegressionResponse["design"];
  result?: RegressionResponse["result"];
}

export interface SiblingStepData {
  run?: SavedRegression;
  qualified_run?: SavedRegression;
  /** The workbench models saved in the step (改模型、对比); those marked 放入报告 go into the report's appendix. */
  custom_results?: CustomResult[];
}

const SAVED_BENCHMARK: RegressionResponse["benchmark"] = {
  backend: "saved",
  policy_coefs: [],
  max_abs_coef_diff: 0,
  max_abs_se_diff: 0,
  coef_check_passed: true,
  se_check_mode: "informational",
  notes: [],
};

function verdictFromSaved(outcome: RegressionOutcome, saved: SavedRegression | undefined) {
  if (!saved?.design || !saved?.result) return null;
  return buildRegressionVerdict(outcome, {
    design: saved.design,
    result: saved.result,
    benchmark: SAVED_BENCHMARK,
    disclaimer: "",
  });
}

/** Each step's own saved run is the only source; steps 11–14 never read each other. */
function familyRun(outcome: RegressionOutcome, getStep?: (step: number) => SiblingStepData | undefined): SavedRegression | undefined {
  const data = getStep?.(FAMILY_STEPS[outcome]);
  if (data?.run?.result?.diagnostics?.study_contract === "economics-v2") return data.run;
  return data?.qualified_run ?? data?.run;
}

/** "-0.33 个百分点 / -0.22 个百分点": the saved run's X and L1.X, in the headline's units ("—" without L1.X). */
export function lagParts(outcome: RegressionOutcome, saved: SavedRegression | undefined): string {
  if (!saved?.design || !saved.result) return "—";
  const parts = lagSplitParts(outcome, { design: saved.design, result: saved.result });
  return parts ? `${parts[0]} / ${parts[1]}` : "—";
}

export function familyVerdict(
  outcome: RegressionOutcome,
  getStep?: (step: number) => SiblingStepData | undefined,
) {
  return verdictFromSaved(outcome, familyRun(outcome, getStep));
}

/**
 * The four saved estimates as four bars on one axis. Their units differ, so each bar is the standardized size
 * ((β × 0.01) / sd(Y): Y's gap in standard deviations per 1 percentage point of X), and its end gives the native
 * value with its unit and the signed size ("-0.55 个百分点（-0.062 个标准差）"). Each bar is the step's SAVED run, as in the report.
 */
export function regressionSummaryRows(getStep?: (step: number) => SiblingStepData | undefined): { rows: DivergingBarRow[]; missing: string[] } {
  const rows: DivergingBarRow[] = [];
  const missing: string[] = [];
  for (const family of REGRESSION_FAMILIES) {
    const run = familyRun(family.outcome, getStep);
    if (!run?.design || !run.result) {
      missing.push(`步骤 ${family.step} · ${family.family}`);
      continue;
    }
    // The step's headline: the cumulative relation of X and L1.X (teaching data v10), else its X coefficient.
    const coefficient = run.result.cumulative ?? run.result.coefs[0] ?? null;
    const suppressed = globalInferenceIsSuppressed(run.result.status, run.result.support);
    const figures = barFigures({
      coef: coefficient?.coef ?? null, ci_low: coefficient?.ci_low ?? null, ci_high: coefficient?.ci_high ?? null,
      depvar_std: run.result.depvar_within_std ?? null, suppressed,
    }, depvarKind(family.outcome, run.design), "sd", true);
    rows.push({
      key: family.outcome,
      label: lessonFor(family.outcome, run.design.baseline, run.design.baseline_label).shortMetric,
      sublabel: `步骤 ${family.step} · ${family.family}`,
      ...figures,
      note: suppressed ? "这次的数据不够判断方向，不显示 95% 区间" : undefined,
    });
  }
  return { rows, missing };
}

export function RegressionSummaryBars({ getStep }: { getStep?: (step: number) => SiblingStepData | undefined }) {
  const { rows, missing } = regressionSummaryRows(getStep);
  return (
    <div className="reg-summary-bars">
      {rows.length > 0 && <DivergingBarChart rows={rows} unitTitle={BAR_UNIT_TITLES.sd} title="四步保存的结果（都换算成标准差）" />}
      {missing.length > 0 && <p className="muted reg-family-missing">{missing.join("、")}：还没计算</p>}
    </div>
  );
}

/** Report-page summary of the four saved regression steps. */
export function RegressionEvidenceMatrix({
  getStep,
}: {
  getStep?: (step: number) => SiblingStepData | undefined;
}) {
  return (
    <section className="reg-evidence-matrix" aria-labelledby="reg-evidence-matrix-title">
      <div className="reg-evidence-matrix-head">
        <div>
          <span className="reg-section-step">四步结果汇总</span>
          <h3 id="reg-evidence-matrix-title">比较方向、不确定性和单位</h3>
        </div>
        <p>四个 Y 的单位不同，数字不能直接比较大小（括号里换算成标准差，{SD_DEFINITION}）；“—”表示该步还没有结果。四步用同一个模型，只换 Y。</p>
      </div>
      <div className="table-wrap" role="region" aria-label="四步结果汇总表，可横向滚动" tabIndex={0}>
        <table className="data-table reg-evidence-table">
          <thead>
            <tr><th>步骤</th><th>指标类型</th><th>方向</th><th>X 每高 1 个百分点，Y 两年累计平均相差</th><th>其中当年 / 次年</th><th>95% 区间</th><th>解释限制</th></tr>
          </thead>
          <tbody>
            {REGRESSION_FAMILIES.map((item) => {
              const verdict = familyVerdict(item.outcome, getStep);
              const design = familyRun(item.outcome, getStep)?.design;
              const lesson = lessonFor(item.outcome, design?.baseline, design?.baseline_label);
              return (
                <tr key={item.outcome}>
                  <th scope="row">{item.step}</th>
                  <td><b>{item.family}</b><span>{lesson.shortMetric}</span></td>
                  <td>{verdict ? (verdict.coefficient ? familyDirectionLabel(verdict.state) : "没算出估计值") : "还没计算"}</td>
                  <td><b>{verdict?.effectBrief ?? "—"}</b></td>
                  <td>{lagParts(item.outcome, familyRun(item.outcome, getStep))}</td>
                  <td>{verdict?.interval ?? "—"}</td>
                  <td>{lesson.dontClaim}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Step 15: the workbench models marked 放入报告 in steps 11–14, each with its X-terms sum next to the step's default
 * model (the report's appendix recomputes both). Each links back to its step.
 */
/** A course-overview row (a Y's default model) as a per-point reading's input; null when it has no estimate. */
function overviewEstimate(item: TeachingEstimate | undefined): { stat: Pick<CoefStat, "coef" | "ci_low" | "ci_high">; source: PerPointSource } | null {
  if (!item || item.coef == null) return null;
  const suppressed = item.suppress_inference || !(item.status === "ok" || item.status === "warning");
  return {
    stat: { coef: item.coef, ci_low: item.ci_low, ci_high: item.ci_high },
    source: { depvar_kind: item.kind, result: { suppressed } },
  };
}

export function ReportedCustomModels({ getStep, onNavigateStep }: {
  getStep?: (step: number) => SiblingStepData | undefined;
  onNavigateStep?: (step: number) => void;
}) {
  const rows = REGRESSION_FAMILIES.flatMap((item) => {
    const data = getStep?.(item.step);
    return (data?.custom_results ?? []).filter((model) => model.in_report).map((model) => ({ ...item, model, run: familyRun(item.outcome, getStep) }));
  });
  const optionsQuery = useAsync<WorkbenchOptions>(() => api.regressionOptions(), ["regression-options"], { enabled: rows.length > 0 });
  const options = optionsQuery.status === "success" ? optionsQuery.data ?? null : null;
  // A model on another Y than its step's saved run is compared with the course default on that Y, as the report's
  // appendix does: every Y's default estimate is in the course overview (the step's bar chart).
  const otherY = rows.some(({ model, run }) => run?.design?.baseline !== model.baseline);
  const overviewQuery = useAsync<TeachingOverviewResponse>(() => api.teachingOverview(), ["teaching-overview"], { enabled: otherY });
  const overview = overviewQuery.status === "success" ? overviewQuery.data ?? null : null;
  return (
    <section className="reg-reported-models" aria-labelledby="reg-reported-models-title">
      <span className="reg-section-step">改模型、对比</span>
      <h3 id="reg-reported-models-title">你放入报告的模型</h3>
      {rows.length === 0
        ? <p className="muted">还没有放入报告的自选模型（选做）：在步骤 11–14 的“改模型、对比”里保存模型并勾选“放入报告”，报告附录会列出它们。</p>
        : (
          <div className="table-wrap" role="region" aria-label="放入报告的模型，可横向滚动" tabIndex={0}>
            <table className="data-table reg-reported-table">
              <thead><tr><th>步骤</th><th>名称</th><th>设定</th><th>X 各项合计（X 每高 1 个百分点）</th><th>同一 Y 的默认模型（两年累计）</th></tr></thead>
              <tbody>
                {rows.map(({ step, family, outcome, model, run }) => {
                  const sum = xSum(model.snapshot, model.spec);
                  // The step's default run when it is on the model's Y; otherwise that Y's row of the course overview.
                  const sameY = run?.design && run.result && run.design.baseline === model.baseline;
                  const stepDefault = sameY ? snapshotOf({ design: run.design!, result: run.result! }) : null;
                  const overviewDefault = !sameY ? overviewEstimate(overview?.outcomes[outcome]?.find((item) => item.key === model.baseline)) : null;
                  const defaultSnapshot: PerPointSource | null = stepDefault ?? overviewDefault?.source ?? null;
                  const defaultSum = stepDefault?.result.cumulative ?? overviewDefault?.stat;
                  // Both numbers at the default's decimals, so the two read alike.
                  const digits = defaultSum && defaultSnapshot ? perPointDigits(outcome, defaultSum, defaultSnapshot) : undefined;
                  return (
                    <tr key={`${step}-${model.id}`}>
                      <th scope="row">
                        {onNavigateStep
                          ? <button type="button" className="link-button" onClick={() => onNavigateStep(step)}>步骤 {step} · {family}</button>
                          : `步骤 ${step} · ${family}`}
                      </th>
                      <td><b>{model.name}</b><br /><small className="muted">Y：{displayBaselineLabel(model.snapshot.depvar_label)}</small></td>
                      <td>{options ? specSummary(model.spec, options) : "…"}</td>
                      <td>{sum ? `${perPointReading(outcome, sum, model.snapshot, digits)}（${xSpanLabel(model.spec)}）` : "—"}</td>
                      <td>{defaultSum && defaultSnapshot ? perPointReading(outcome, defaultSum, defaultSnapshot, digits) : sameY || overviewQuery.status !== "loading" ? "—" : "…"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
