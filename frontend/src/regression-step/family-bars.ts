/** The family bars of a regression step (every Y of the family) and the 加税前后 chart's lines, markers and notes. */
import { displayBaselineLabel } from "../regression-lessons";
import {
  BAR_UNIT_TITLES,
  barFigures,
  barUnitFor,
  depvarKind,
  globalInferenceIsSuppressed,
  headlineCoefficient,
  signed,
  unitName,
  type BarEstimate,
} from "../regression-verdict";
import type {
  DepvarKind, RegressionOutcome, RegressionResponse, RegressionStatus, TeachingEstimate, TeachingGroupSeries,
} from "../types";
import type { GroupLine } from "../viz/regression/charts";
import { TAXED, TAXED_LATER, UNTAXED } from "../viz/regression/palette";
import { spokenBar, type DivergingBarRow } from "../viz/regression/diverging-bars";

const KINDS: readonly DepvarKind[] = ["share", "length", "position", "network"];
export const kindOf = (kind: string, outcome: RegressionOutcome): DepvarKind =>
  (KINDS as readonly string[]).includes(kind) ? kind as DepvarKind : depvarKind(outcome);

/** An overview row as a bar estimate: suppressed by the same rule as a run (status and support agree by construction). */
function overviewEstimate(item: TeachingEstimate): BarEstimate {
  return {
    coef: item.coef, ci_low: item.ci_low, ci_high: item.ci_high, depvar_std: item.depvar_within_std ?? null,
    suppressed: globalInferenceIsSuppressed(item.status, { status: item.status as RegressionStatus, suppress_inference: item.suppress_inference }),
  };
}

/** A run's estimate of its X as a bar estimate (the saved or just computed run of the selected Y). */
export function runEstimate(response: Pick<RegressionResponse, "design" | "result" | "model_snapshot">): BarEstimate {
  // The headline: the cumulative relation of X and L1.X (teaching data v10), as the overview's bars.
  const coefficient = headlineCoefficient(response);
  return {
    coef: coefficient?.coef ?? null, ci_low: coefficient?.ci_low ?? null, ci_high: coefficient?.ci_high ?? null,
    depvar_std: response.result.depvar_within_std ?? null,
    suppressed: globalInferenceIsSuppressed(response.result.status, response.result.support),
  };
}

/**
 * One bar per Y of the step's family, in the overview's order (the default first). Shares are drawn in 个百分点;
 * a family whose Ys differ in kind, or are not shares, in 个标准差 with the native value at the bar's end and
 * the native unit under the name. The selected Y's bar uses the run itself, so it repeats the headline's numbers.
 */
export function familyBarRows(
  outcome: RegressionOutcome,
  items: TeachingEstimate[],
  selectedKey: string | null,
  selected?: Pick<RegressionResponse, "design" | "result" | "model_snapshot"> | null,
): { rows: DivergingBarRow[]; unitTitle: string } {
  const unit = barUnitFor(items.map((item) => kindOf(item.kind, outcome)));
  const estimates = items.map((item) => ({
    kind: kindOf(item.kind, outcome),
    estimate: item.key === selectedKey && selected ? runEstimate(selected) : overviewEstimate(item),
  }));
  // Each bar keeps its own headline's digits (step 12: "-0.39" beside "+0.006"), as the report's chart.
  const rows = items.map((item, index): DivergingBarRow => {
    const { kind, estimate } = estimates[index];
    const isSelected = item.key === selectedKey;
    const figures = barFigures(estimate, kind, unit, false);
    const suppressed = estimate.suppressed;
    return {
      key: item.key,
      label: displayBaselineLabel(item.label),
      sublabel: unit === "sd" ? unitName(kind) : undefined,
      ...figures,
      selected: isSelected,
      note: suppressed ? "这次的数据不够判断方向，不显示 95% 区间" : undefined,
    };
  });
  return { rows, unitTitle: BAR_UNIT_TITLES[unit] };
}

/** The 加税前后 chart's lines: the two tariff waves and the untaxed countries (a group with no country has none). */
export function groupLines(series: TeachingGroupSeries): GroupLine[] {
  return [
    { key: "first", label: "第一批被加税", color: TAXED, points: series.first },
    { key: "second", label: "第二批被加税", color: TAXED_LATER, points: series.second, dashed: true },
    { key: "untaxed", label: "未被加税", color: UNTAXED, points: series.untaxed },
  ].filter((line) => line.points.length > 0);
}

/** "2018 年第一批加税", "2019 年第二批加税"; a single start year reads "2018 年起加税". */
export function waveMarkers(years: readonly number[]): { year: number; label: string }[] {
  const names = ["第一批", "第二批", "第三批"];
  return years.length > 1
    ? years.map((year, index) => ({ year, label: `${year} 年${names[index] ?? `第 ${index + 1} 批`}加税` }))
    : years.map((year) => ({ year, label: `${year} 年起加税` }));
}

/**
 * Under the 加税前后 chart (teaching data v10): the raw gaps mix the tariff with the exchange-rate change of the same
 * years, which the regression separates; said without telling which way, so the student still finds it in the
 * workbench.
 */
export const GROUP_CHART_CAPTION = "图上的变化混有同一时期的其他变化（如汇率），回归会把它们分开，所以计算后下方的回归数字不必等于图上各组线之间的距离。";

/** Under the 加税前后 chart: the premise the regression rests on, and how little the chart can show of it. In teaching
 *  data v10 it holds by design only once the exchange-rate change is controlled (the chart's lines are not parallel). */
export function parallelTrendsNote(years: readonly number[], policyYear: number | null | undefined, groups = 2): string {
  const before = policyYear == null ? [] : years.filter((year) => year < policyYear);
  const count = ["", "一", "两", "三", "四", "五"][before.length] ?? String(before.length);
  const pre = before.length ? `加税前只有 ${before.join("、")} ${count}年可看` : "加税前的年份很少";
  const who = groups > 2 ? "各组" : "两组";
  return `这张图也用来看回归的前提：如果没有关税，扣掉汇率等同期变化后，${who}的走势应大致平行。${pre}，能检验的证据有限；被加税名单按对美货物顺差确定，不是随机分配。本课程的 Y 按设定生成，控制汇率、GDP 对数和贸易开放度后，这个前提按设计成立。`;
}

/** Step 14: weighted degree is in-degree + out-degree in every row (the report says the same under its chart). */
export const NETWORK_DEGREE_IDENTITY = "加权总度 = 加权入度 + 加权出度，所以这两条的原始值相加约等于加权总度那一条。";
const DEGREE_KEYS = ["weighted_degree", "weighted_indegree", "weighted_outdegree"];

export function degreeIdentity(items: TeachingEstimate[]): string | null {
  return DEGREE_KEYS.every((key) => items.some((item) => item.key === key)) ? NETWORK_DEGREE_IDENTITY : null;
}

/** Step 12's four forward shares add up to 100% of value added, so their four estimates add up to about 0. */
const FORWARD_SHARES = ["1_VA_D_share", "2_VA_RT_share", "3a_VA_GVC_S_share", "3b_VA_GVC_C_share"];

export function forwardShareIdentity(items: TeachingEstimate[]): string | null {
  const coefs = FORWARD_SHARES.map((key) => items.find((item) => item.key === key)?.coef);
  if (coefs.some((coef) => coef == null || !Number.isFinite(coef))) return null;
  const sum = (coefs as number[]).reduce((total, coef) => total + coef, 0);
  return `纯国内、传统贸易、简单 GVC、复杂 GVC 四项份额合计 100%，所以这四条相加约为 0（${Math.abs(sum) < 0.005 ? "0.00" : signed(sum, 2)}）；前向 GVC 生产总份额 = 简单 + 复杂（按未取整的原值精确相加，条旁取整后的数字可能相差末位 1）。本步默认的“复杂 GVC 生产份额”按增加值来源（前向）计算；“后向复杂 GVC 生产份额”按最终品（后向）计算，是另一项指标。`;
}

/** Step 11's two shares: the course data make 国内增加值出口占比 = 1 − 外国增加值项占比 − the small rest. */
export function tradeShareIdentity(items: TeachingEstimate[]): string | null {
  return ["FVA_share", "DVAex_share"].every((key) => items.some((item) => item.key === key))
    ? "课程数据里，国内增加值出口占比 = 100% − 外国增加值项占比 − 其余小项（重复计算等），所以这两条大小相近、方向相反。"
    : null;
}

/** The bars' title: a click (or Enter on the focused bar) shows that Y's reading; nothing is saved. */
export function familyBarsTitle(count: number): string {
  return `本步 ${count} 个 Y · 点击任一条查看该 Y 的读数（键盘：方向键切换，Enter 查看）`;
}

/** Under the bars after a click on another Y: its reading, and that the step's material stays the default Y. */
export function barPreviewText(row: DivergingBarRow, defaultLabel: string): string {
  return `预览 · ${spokenBar(row)}。本步的结论和报告材料仍是${defaultLabel}。`;
}
