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
  headlineCoefficient,
  lagSplitParts,
  SD_DEFINITION,
} from "./regression-verdict";
import { api } from "./api";
import { useAsync } from "./labs";
import { experimentLabel, omittedSummary, perPointDigits, perPointReading, snapshotOf, specSummary, xSpanLabel, xSum } from "./regression-workbench-table";
import type { Experiment, FirstWaveDecomposition, RegressionOutcome, RegressionResponse, WorkbenchOptions } from "./types";
import { DivergingBarChart, type DivergingBarRow } from "./viz/regression/diverging-bars";

interface SavedRegression {
  design?: RegressionResponse["design"];
  result?: RegressionResponse["result"];
}

export interface SiblingStepData {
  /** The step's one saved run: the course default model on the step's default Y. */
  run?: SavedRegression;
  /** The one model experiment the step put into the report (改模型、对比), printed in the report's appendix. */
  experiment?: Experiment | null;
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
  return getStep?.(FAMILY_STEPS[outcome])?.run;
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
    // The step's headline, as on the step's page: the cumulative relation of X and L1.X (teaching data v10).
    const coefficient = headlineCoefficient({ design: run.design, result: run.result });
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
 * Step 15: the model experiment each of steps 11–14 put into the report, with its X-terms sum next to the step's
 * default model (the report's appendix recomputes both). Each links back to its step.
 */
export function ReportedExperiments({ getStep, onNavigateStep }: {
  getStep?: (step: number) => SiblingStepData | undefined;
  onNavigateStep?: (step: number) => void;
}) {
  const rows = REGRESSION_FAMILIES.flatMap((item) => {
    const experiment = getStep?.(item.step)?.experiment;
    return experiment ? [{ ...item, experiment, run: familyRun(item.outcome, getStep) }] : [];
  });
  const optionsQuery = useAsync<WorkbenchOptions>(() => api.regressionOptions(), ["regression-options"], { enabled: rows.length > 0 });
  const options = optionsQuery.status === "success" ? optionsQuery.data ?? null : null;
  return (
    <section className="reg-reported-models" aria-labelledby="reg-reported-models-title">
      <span className="reg-section-step">改模型、对比</span>
      <h3 id="reg-reported-models-title">你的模型实验</h3>
      {rows.length === 0
        ? <p className="muted">还没有放入报告的模型实验（选做）：在步骤 11–14 的“改模型、对比”里算出一个模型并点“放入报告”，报告附录会把它和默认模型并列。</p>
        : (
          <div className="table-wrap" role="region" aria-label="放入报告的模型实验，可横向滚动" tabIndex={0}>
            <table className="data-table reg-reported-table">
              <thead><tr><th>步骤</th><th>改动</th><th>设定</th><th>X 各项合计（X 每高 1 个百分点）</th><th>默认模型（两年累计）</th></tr></thead>
              <tbody>
                {rows.map(({ step, family, outcome, experiment, run }) => {
                  const sum = xSum(experiment.snapshot, experiment.spec);
                  // The step's default run, on the same Y as every experiment.
                  const stepDefault = run?.design && run.result ? snapshotOf({ design: run.design, result: run.result }) : null;
                  const defaultSum = stepDefault?.result.cumulative;
                  // Both numbers at the default's decimals, so the two read alike.
                  const digits = defaultSum && stepDefault ? perPointDigits(outcome, defaultSum, stepDefault) : undefined;
                  return (
                    <tr key={step}>
                      <th scope="row">
                        {onNavigateStep
                          ? <button type="button" className="link-button" onClick={() => onNavigateStep(step)}>步骤 {step} · {family}</button>
                          : `步骤 ${step} · ${family}`}
                      </th>
                      <td><b>{options ? experimentLabel(experiment.spec, options) : "…"}</b><br /><small className="muted">Y：{displayBaselineLabel(experiment.snapshot.depvar_label)}</small></td>
                      <td>{options ? <>
                        {specSummary(experiment.spec, options)}
                        {omittedSummary(experiment.snapshot, options).map((text) => <p className="muted" key={text}>{text}</p>)}
                      </> : "…"}</td>
                      <td>{sum ? `${perPointReading(outcome, sum, experiment.snapshot, digits)}（${xSpanLabel(experiment.spec)}）` : "—"}</td>
                      <td>{defaultSum && stepDefault ? perPointReading(outcome, defaultSum, stepDefault, digits) : "—"}</td>
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


/**
 * Under the three-group chart, once the default model is computed: the first wave's change in Y since before its
 * tariff as the fitted model splits it, in the chart's unit (shares in points), so the chart's drop and the
 * headline's coefficient are read as one thing. `scale` converts the Y's raw unit to the chart's.
 */
export function decompositionSentence(
  decomposition: FirstWaveDecomposition, metric: string, scale: number, unit: string, digits: number,
): string {
  // "8.4 个百分点", "0.320 个长度单位": the chart's unit, counted.
  const counted = unit.startsWith("个") ? unit : `个${unit}`;
  const amount = (value: number) => `${(value * scale).toFixed(digits)} ${counted}`;
  const signedAmount = (value: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value * scale).toFixed(digits)}`;
  const observed = decomposition.observed;
  const direction = observed < 0 ? "低" : "高";
  // "与 GDP 对数同步" keeps a space before a Latin name, "与汇率变动同步" none.
  const parts = decomposition.terms.map((term) => `${term.name === "x_terms" ? "与关税 X 相关" : `与${/^[A-Za-z]/.test(term.label) ? " " : ""}${term.label}同步`} ${signedAmount(term.change)}`);
  parts.push(`其余（各年共同的变化与噪声）${signedAmount(decomposition.remainder)}`);
  return `第一批被加税国家 ${decomposition.year} 年的${metric}比加税前（${decomposition.pre_years.join("、")} 年）平均${direction} ${amount(Math.abs(observed))}。按本次估计拆开：${parts.join("，")}。结论句里的估计只对应“与关税 X 相关”这一部分；第二批税率相同，但对美出口份额小、X 小，所以变化也小。`;
}
