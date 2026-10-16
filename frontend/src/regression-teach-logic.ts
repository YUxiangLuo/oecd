/**
 * The saved runs of steps 11–14 as the report and step 15 read them, and the first-wave split under the
 * three-group chart. Non-component logic, kept apart from regression-teach.tsx (Vite Fast Refresh).
 */
import { FAMILY_STEPS, lessonFor, REGRESSION_FAMILIES } from "./regression-lessons";
import { barFigures, buildRegressionVerdict, depvarKind, globalInferenceIsSuppressed, headlineCoefficient, lagSplitParts } from "./regression-verdict";
import type { Experiment, FirstWaveDecomposition, RegressionOutcome, RegressionResponse } from "./types";
import type { DivergingBarRow } from "./viz/regression/diverging-bars";

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
export function familyRun(outcome: RegressionOutcome, getStep?: (step: number) => SiblingStepData | undefined): SavedRegression | undefined {
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
/**
 * Under the three-group chart, once the default model is computed: the first wave's change in Y since before its
 * tariff as the fitted model splits it, in the chart's unit (shares in points), so the chart's drop and the
 * headline's coefficient are read as one thing. `scale` converts the Y's raw unit to the chart's.
 */
export function decompositionParts(
  decomposition: FirstWaveDecomposition, metric: string, scale: number, unit: string, digits: number,
): { lead: string; parts: { label: string; value: string; tariff: boolean }[]; tail: string } {
  // "8.4 个百分点", "0.320 个长度单位": the chart's unit, counted.
  const counted = unit.startsWith("个") ? unit : `个${unit}`;
  const amount = (value: number) => `${(value * scale).toFixed(digits)} ${counted}`;
  // Each part with its unit, as the total: a bare "−1.6" read as a number of nothing.
  const signedAmount = (value: number) => `${value >= 0 ? "+" : "-"}${Math.abs(value * scale).toFixed(digits)} ${counted}`;
  const observed = decomposition.observed;
  const direction = observed < 0 ? "低" : "高";
  // "与 GDP 对数同步" keeps a space before a Latin name, "与汇率变动同步" none.
  const parts = decomposition.terms.map((term) => ({
    label: term.name === "x_terms" ? "与关税 X 相关" : `与${/^[A-Za-z]/.test(term.label) ? " " : ""}${term.label}同步`,
    value: signedAmount(term.change),
    tariff: term.name === "x_terms",
  }));
  parts.push({ label: "其余（各年共同的变化与噪声）", value: signedAmount(decomposition.remainder), tariff: false });
  return {
    lead: `第一批被加税国家 ${decomposition.year} 年的${metric}，比加税前（${decomposition.pre_years.join("、")} 年平均）${direction} ${amount(Math.abs(observed))}。按默认模型（见下方）的估计，这个总变化等于下面各项之和：`,
    parts,
    // One point a sentence: what the regression's result is of the split, and why the example's number differs.
    tail: `回归结论只对应第一项：它约等于两年累计的系数 × 第一批国家 ${decomposition.year} 年的平均 X${decomposition.x_mean != null
      ? `（${(decomposition.x_mean * 100).toFixed(1)} 个百分点，按全部行业平均，非货物行业的 X 为 0，所以比步骤 10 的货物行业平均小）`
      : ""}。结果卡里的例子换算用的是例子自己的 X，数值可能大得多。`,
  };
}

/** The same split as one sentence (tests and plain-text readers). */
export function decompositionSentence(
  decomposition: FirstWaveDecomposition, metric: string, scale: number, unit: string, digits: number,
): string {
  const { lead, parts, tail } = decompositionParts(decomposition, metric, scale, unit, digits);
  return `${lead}${parts.map((part) => `${part.label} ${part.value}`).join("，")}。${tail}`;
}

/** The split as the page shows it: the total, one line a part (the tariff's part marked), then what to take from it. */
