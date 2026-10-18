/** The result card's sentences: the step 10 example's conversion, the course's design value and the lag split. */
import { groupedFixed, percentagePoints } from "../format";
import { WEAK_EXAMPLE_NOTE } from "../regression-lessons";
import { coversDesignSpan, designDeviation, designDeviationText, shownCoefficient, perPointDigits, perPointReading, xSpanLabel } from "../regression-workbench-table";
import { depvarKind, lagSplitParts, networkDigits, withCountUnit } from "../regression-verdict";
import { workedNumbers } from "../labs/steps/shock-lab";
import type { CoefStat, RegressionOutcome, RegressionResponse } from "../types";

/** An example followed from step 10: its X in the last year and whether it was taxed at all (τ > 0). */
export interface RegressionExample {
  label: string;
  x: number;
  tau?: number;
  /** The first-year export share to the USA: with τ, X is shown at step 10's digits (workedNumbers). */
  w?: number;
  /** The country that imposes the tariff (the USA): X = 0 by definition, and it is not in the regression sample. */
  imposer?: boolean;
  /** A service industry: the tariff falls on goods only (ICIO A–C), so τ and X are 0 in every country. */
  service?: boolean;
}

/**
 * An example's X in percentage points with the digits step 10 shows for it (workedNumbers: "0.0015" for a tiny X,
 * not "0.00"), so the conversion can be checked by hand; without w and τ, two decimals.
 */
export function exampleXText(example: Pick<RegressionExample, "x" | "w" | "tau">): string {
  return example.w != null && example.tau != null && Number.isFinite(example.w) && Number.isFinite(example.tau)
    ? workedNumbers(example.w, example.tau, example.x).x
    : percentagePoints(example.x);
}

/**
 * Y change implied by the estimate for an example's X, in the step's display units: the headline's rounded estimate
 * per point (shownPerPoint) times X as shown in points, so "-0.55 × 20.44 = -11.24" checks by hand.
 */
export function exampleEffect(outcome: RegressionOutcome, perPoint: number, xPoints: number, design?: { depvar_kind?: string } | null): string {
  const change = perPoint * xPoints;
  const kind = depvarKind(outcome, design);
  // A change that rounds to zero at the shown precision says so instead of printing "0.0000"; thousands are
  // grouped ("约为 -1,382 个模拟分数单位"), as in the report.
  // The position index has no unit: a bare number.
  // Half up on the decimal product, as by hand: 0.018 × 23.25 = 0.4185 reads 0.419 (toFixed alone gives 0.418).
  const halfUp = (size: number, digits: number) => Math.round(Number((size * 10 ** digits).toPrecision(12))) / 10 ** digits;
  const sized = (size: number, digits: number) => withCountUnit(
    size > 0 && size < 0.5 * 10 ** -digits ? `不到 ${(10 ** -digits).toFixed(digits)}` : groupedFixed(halfUp(size, digits), digits), kind,
  );
  if (kind === "share") return sized(Math.abs(change), 2);
  if (kind === "length") return sized(Math.abs(change), 3);
  if (kind === "position") return sized(Math.abs(change), 4);
  const size = Math.abs(change);
  return sized(size, networkDigits(size));
}

/** Step 14's unit, worded as the report's line beside the step 14 numbers (gvcsim/report_render.py). */
export const NETWORK_UNIT_NOTE = "模拟分数单位：本步的 Y 是课程生成的分数（高低顺序参照真实网络指标），不是步骤 5、9 的百万美元，不能和那两步的数值直接比较。";

/**
 * "课程数据设定的当期＋滞后合计为 -0.55 个百分点，你算出 -0.55，区间包含设定值": the course's design value next to the
 * estimate, so a student can see whether the model recovered the number the data were built around. The
 * zero-effect Y and the position ratio (no single design value) say so instead.
 */
export function designValueSentence(outcome: RegressionOutcome, response: Pick<RegressionResponse, "design" | "result" | "model_snapshot">, coefficient: CoefStat): string {
  const beta = response.model_snapshot?.beta;
  if (beta === undefined) return "";
  if (beta === null) return "课程设定：这个 Y 是两项模拟长度之比，没有单一的设定值，估计不与某个数对照。";
  const includesZero = coefficient.ci_low != null && coefficient.ci_high != null && coefficient.ci_low <= 0 && 0 <= coefficient.ci_high;
  if (beta === 0) {
    const interval = coefficient.ci_low == null || coefficient.ci_high == null
      ? "区间不完整，无法判断是否包含 0。"
      : includesZero
        ? "本次区间包含 0，与零设定相容，但不显著不等于证明没有关联。"
        : "本次区间不含 0；样本中的显著结果不改变生成方程的零设定，也不证明因果效应。";
    return `课程生成方程中 X 的系数设为 0。${interval}${WEAK_EXAMPLE_NOTE}`;
  }
  const source = { depvar_kind: response.design.depvar_kind ?? "", result: { suppressed: true } };
  const digits = perPointDigits(outcome, coefficient, { depvar_kind: source.depvar_kind, result: { suppressed: false } });
  const target = perPointReading(outcome, { coef: beta, ci_low: null, ci_high: null }, source, digits);
  const estimate = perPointReading(outcome, coefficient, source, digits);
  const lags = response.design.spec?.x_lags;
  if (lags != null && !coversDesignSpan({ x_lags: lags })) {
    return `课程数据设定的当期＋滞后合计为 ${target}；这个模型算出 ${estimate}（${xSpanLabel({ x_lags: lags })}），跨度不同，不是同一个估计量，不与设定值比较。`;
  }
  const covered = coefficient.ci_low != null && coefficient.ci_high != null && coefficient.ci_low <= beta && beta <= coefficient.ci_high;
  const deviation = designDeviation(shownCoefficient(coefficient.coef, source.depvar_kind, digits), shownCoefficient(beta, source.depvar_kind, digits));
  const span = lags == null || (lags.length === 2 && lags.includes(0) && lags.includes(1)) ? "当期＋滞后合计" : "X 各项合计";
  return `课程数据设定的${span}为 ${target}，你算出 ${estimate}，区间${covered ? "包含" : "不包含"}设定值（${designDeviationText(deviation)}）。`;
}

/** The two X coefficients, distinguished from the first and second years of a sustained change in X. */
export function lagSplit(outcome: RegressionOutcome, response: Pick<RegressionResponse, "design" | "result">): string | null {
  const parts = lagSplitParts(outcome, response);
  return parts ? `当期 X 项：${parts[0]}；上一年 X 项（L1.X）：${parts[1]}。上方结果取两项系数之和。` : null;
}
