/** The step's result card: the headline sentence, its interval in words, the step 10 example's conversion and the limits. */
import { groupedFixed, percentagePoints } from "../format";
import { GENERATED_Y_DISCLOSURE, lessonFor } from "../regression-lessons";
import { coversDesignSpan, designDeviation, designDeviationText, shownCoefficient, perPointDigits, perPointReading, xSpanLabel } from "../regression-workbench-table";
import {
  buildRegressionVerdict,
  differenceWords,
  lagSplitParts,
  withCountUnit,
  depvarKind,
  networkDigits,
  SD_DEFINITION,
  shownPerPoint,
  standardizedDigits,
  standardizedEffect,
} from "../regression-verdict";
import { workedNumbers } from "../labs/steps/shock-lab";
import type { CoefStat, RegressionOutcome, RegressionResponse } from "../types";
import { NEGATIVE, POSITIVE, UNCERTAIN } from "../viz/regression/palette";

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
  // grouped ("约为 -1,382 个中心性原始单位"), as in the report.
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
export const NETWORK_UNIT_NOTE = "中心性原始单位：本步的 Y 是课程生成的分数（高低顺序参照真实网络指标），不是步骤 5、9 的百万美元，不能和那两步的数值直接比较。";

const BADGE_COLORS = { negative: NEGATIVE, positive: POSITIVE, insufficient: UNCERTAIN, suppressed: UNCERTAIN } as const;

/**
 * The selected Y's reading, under the bar chart: one headline, a 方向明确／方向不确定 badge with the interval in
 * words, then three one-liners (the step 10 example, what not to claim, the generated-data note).
 */
export function RegressionResultCard({ outcome, response, examples = [], exampleSaved = true, exampleChosen = true, exampleYear }: {
  outcome: RegressionOutcome;
  response: RegressionResponse;
  examples?: RegressionExample[];
  /** False when step 10 has not saved an example yet: the conversion uses the default example. */
  exampleSaved?: boolean;
  /** The saved example was picked by the student, not the default recorded because step 10 was shown. */
  exampleChosen?: boolean;
  /** The year whose X the conversion uses (the last year of the data). */
  exampleYear?: number;
}) {
  const verdict = buildRegressionVerdict(outcome, response);
  const lesson = lessonFor(outcome, response.design.baseline, response.design.baseline_label);
  const suppressed = verdict.state === "suppressed";
  const kind = depvarKind(outcome, response.design);
  const words = differenceWords(kind);
  const directional = verdict.state === "negative" || verdict.state === "positive";
  // An association within country×industry records (after each one's own mean and each year's common change), not
  // a causal effect: "X 每高 1 个百分点，
  // 外国增加值项占比平均低 0.55 个百分点". Once the word says the direction, the number drops its sign (the
  // parenthetical sizes are unsigned already, as in the report). With an interval that includes 0 (or none
  // shown) the sign is not settled, so the signed estimate is given without 高/低.
  // The headline keeps the short form; what a standard deviation is follows it on its own line.
  const unsignedEffect = verdict.effectBrief.replace(/^[+−-]/, "");
  const standardized = verdict.effect !== verdict.effectBrief;
  // The course model has X and L1.X: the headline is their sum, the relation over the tariff's year and the next.
  // Said only for that model (a sum of other X terms, or no sum at all, is not "两年累计").
  const lags = response.design.spec?.x_lags;
  const twoYears = Boolean(response.result.cumulative) && (lags == null || (lags.length === 2 && lags.includes(0) && lags.includes(1)));
  const plainResult = directional
    ? `${twoYears ? "两年累计" : ""}平均${verdict.state === "negative" ? words.lower : words.higher} ${unsignedEffect}`
    : `${twoYears ? "两年累计" : ""}平均相差 ${verdict.effectBrief}，但高低方向不确定`;
  const split = twoYears ? lagSplit(outcome, response) : null;
  // "外国增加值项占比平均低", but "GVC 位置指数 平均…" keeps a space after a Latin name.
  const metricGap = /[A-Za-z]$/.test(lesson.shortMetric) ? " " : "";
  const badgeColor = BADGE_COLORS[verdict.state];
  return (
    <section className={`verdict-card verdict-${verdict.state}`} aria-labelledby="reg-result-title">
      <p className="reg-generated-disclosure" role="note">{GENERATED_Y_DISCLOSURE}</p>
      <h3 id="reg-result-title" tabIndex={-1} className="reg-plain-verdict">
        {verdict.coefficient
          ? <span className="reg-headline-main">关税暴露 X 每高 1 个百分点，{lesson.shortMetric}{metricGap}<b>{plainResult}</b></span>
          : "没算出 X 的估计值"}
      </h3>
      {verdict.coefficient && (
        <p className="reg-verdict-direction">
          <span className="reg-direction-badge" style={{
            display: "inline-block", marginRight: 8, padding: "1px 9px", borderRadius: 999, fontSize: 12, fontWeight: 700,
            color: "#2a2f3a", background: `${badgeColor}26`, border: `1px solid ${badgeColor}`,
          }}>{directional ? "方向明确" : "方向不确定"}</span>
          <span className="reg-interval-words">{verdict.evidence}</span>
        </p>
      )}
      {verdict.coefficient && split && <p className="reg-lag-split">{split}</p>}
      {standardized && <p className="muted reg-sd-note">{SD_DEFINITION}。</p>}
      {/* A share Y reads in points here, but step 15 sets the four steps side by side in standard deviations: the
          same size is given once, so the number there can be found here. */}
      {!standardized && verdict.coefficient && !suppressed && (() => {
        const sd = standardizedEffect(verdict.coefficient.coef, response.result.depvar_within_std);
        return sd == null ? null : (
          <p className="muted reg-sd-note">换算成标准差：这 {unsignedEffect}约等于 {(Math.abs(sd) < 0.0005 ? "不到 0.001" : Math.abs(sd).toFixed(standardizedDigits(sd, null)))} 个标准差。{SD_DEFINITION}；步骤 15 用它并列比较单位不同的四步。</p>
        );
      })()}
      {verdict.coefficient && !suppressed && response.model_snapshot && "beta" in response.model_snapshot && (
        <p className="reg-design-value" role="note">{designValueSentence(outcome, response, verdict.coefficient)}</p>
      )}
      <ul className="reg-result-points">
        {!suppressed && verdict.coefficient && examples.length > 0 && (() => {
          // Only an example with X > 0 has a conversion, and only that conversion carries the interval's open
          // direction. When no example has one, "X = 0, nothing to convert" is said once, after the list.
          const converted = examples.filter((example) => !example.imposer && example.x > 0);
          const lastConverted = converted.at(-1);
          const noConversion = converted.length === 0;
          const unexposedTaxed = examples.some((example) => !example.imposer && example.x <= 0 && (example.tau ?? 0) > 0);
          const zeroNote = noConversion ? "" : "，X = 0 → 没有与 X 相关的差异";
          return <li className="reg-example-effect">换算到{exampleChosen && exampleSaved ? "你在步骤 10 选的例子" : "步骤 10 的默认例子"}{/* One bracket: what is not saved yet, then the year. */
            `（${[!exampleSaved ? "步骤 10 还没有保存你的例子" : "", exampleYear ? `用 ${exampleYear} 年的 X` : ""].filter(Boolean).join("；")}）`.replace("（）", "")}：<ul className="reg-example-list">{examples.map((example) => {
            const coef = verdict.coefficient!.coef;
            // An association, not a tariff effect: the difference in Y that goes with the example's X. With X = 0
            // the estimate implies no X-related difference (Y still moves with the shared yearly changes).
            const text = example.imposer
              ? <>{example.label}：加征关税的一方，不在回归样本中，不做换算</>
              : example.x > 0
              ? (() => {
                const effect = exampleEffect(outcome, shownPerPoint(outcome, verdict.coefficient!, response.design), Number(exampleXText(example)), response.design);
                const lower = coef * example.x < 0;
                const tiny = effect.startsWith("不到");
                // "与 X 相关的差异约为 -12.83 个百分点（Y 偏低）"; below the shown precision it reads "不到 0.01 个百分点".
                // With an interval that includes 0 the sign is not settled, so 偏低/偏高 is left out and the open
                // direction is said once, after the last conversion.
                return <>{example.label}：X = {exampleXText(example)} 个百分点 → {twoYears ? "两年累计" : ""}与 X 相关的差异{tiny ? "" : "约"} <b>{tiny ? effect : `${lower ? "-" : "+"}${effect}`}</b>{directional ? `（Y 偏${lower ? words.lower : words.higher}）` : ""}{verdict.state === "insufficient" && example === lastConverted ? "，但区间包含 0，高低方向并不确定" : ""}</>;
              })()
              : example.service
                ? <>{example.label}：不是货物行业，不加税（τ = 0）{zeroNote}</>
              : (example.tau ?? 0) > 0
                ? <>{example.label}：被加税但首年不向美国出口（w = 0）{zeroNote}</>
                : <>{example.label}：未被加税{zeroNote}</>;
            return <li key={example.label}>{text}</li>;
          })}</ul>
            {noConversion && `${examples.length === 1 ? "这个例子的 X = 0" : "两个例子的 X 都是 0"}，按估计没有与 X 相关的差异。如需看到不为 0 的换算，请回到步骤 10 ${examples.some((example) => example.service)
              ? "换一个货物行业（非货物行业不加税），如加拿大的汽车行业"
              : unexposedTaxed
              ? "换一个向美国出口的被加税国家或行业（如加拿大的汽车行业）"
              : examples.length === 1 ? "换成被加税的国家（如加拿大），或再选一个被加税的对照国家" : "选一个被加税的国家（如加拿大）"}。`}</li>;
        })()}
        {!suppressed && verdict.coefficient && examples.some((example) => !example.imposer && example.x > 0) && <li className="muted">换算 = 显示的系数 × 例子的 X，以 X = 0 为基准；不是两国的实际差距，也不是该行业实际的前后变化。</li>}
        {/* As the report says next to the number: step 14's unit is not the 百万美元 of steps 5 and 9. */}
        {kind === "network" && <li className="muted reg-unit-note">{NETWORK_UNIT_NOTE}</li>}
        <li className="reg-caveat"><b>解释限制</b> {lesson.dontClaim}</li>
      </ul>
      {verdict.warnings.length > 0 && (!suppressed || !verdict.coefficient) && (
        <ul aria-label="本次计算的限制">{verdict.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      )}
    </section>
  );
}

/**
 * "课程数据设定的两年累计为 -0.55 个百分点，你算出 -0.55，区间包含设定值": the course's design value next to the
 * estimate, so a student can see whether the model recovered the number the data were built around. The
 * zero-effect Y and the position ratio (no single design value) say so instead.
 */
export function designValueSentence(outcome: RegressionOutcome, response: Pick<RegressionResponse, "design" | "result" | "model_snapshot">, coefficient: CoefStat): string {
  const beta = response.model_snapshot?.beta;
  if (beta === undefined) return "";
  if (beta === null) return "课程设定：这个 Y 是两项模拟长度之比，没有单一的设定值，估计不与某个数对照。";
  const includesZero = coefficient.ci_low != null && coefficient.ci_high != null && coefficient.ci_low <= 0 && 0 <= coefficient.ci_high;
  if (beta === 0) return includesZero ? "课程设定：这个 Y 与 X 无关（设定值为 0），区间包含 0，与设定一致。" : "课程设定：这个 Y 与 X 无关（设定值为 0）；这次区间不含 0，是抽样波动，不是关联。";
  const source = { depvar_kind: response.design.depvar_kind ?? "", result: { suppressed: true } };
  const digits = perPointDigits(outcome, coefficient, { depvar_kind: source.depvar_kind, result: { suppressed: false } });
  const target = perPointReading(outcome, { coef: beta, ci_low: null, ci_high: null }, source, digits);
  const estimate = perPointReading(outcome, coefficient, source, digits);
  const lags = response.design.spec?.x_lags;
  if (lags != null && !coversDesignSpan({ x_lags: lags })) {
    return `课程数据设定的两年累计为 ${target}；这个模型算出 ${estimate}（${xSpanLabel({ x_lags: lags })}），跨度不同，不是同一个估计量，不与设定值比较。`;
  }
  const covered = coefficient.ci_low != null && coefficient.ci_high != null && coefficient.ci_low <= beta && beta <= coefficient.ci_high;
  const deviation = designDeviation(shownCoefficient(coefficient.coef, source.depvar_kind, digits), shownCoefficient(beta, source.depvar_kind, digits));
  const span = lags == null || (lags.length === 2 && lags.includes(0) && lags.includes(1)) ? "两年累计" : "X 各项合计";
  return `课程数据设定的${span}为 ${target}，你算出 ${estimate}，区间${covered ? "包含" : "不包含"}设定值（${designDeviationText(deviation)}）。`;
}

/**
 * "其中当年 -0.33、次年再 -0.22 个百分点": the headline split over the tariff's year (X) and the next (L1.X), in the
 * headline's units; null when the run has no L1.X.
 */
export function lagSplit(outcome: RegressionOutcome, response: Pick<RegressionResponse, "design" | "result">): string | null {
  const parts = lagSplitParts(outcome, response);
  // The model box above the run button says what the two terms are; here only the split.
  // "累计" and "平均" in the headline say two things: the two years added up, each an average over the records.
  return parts ? `其中当年 ${parts[0]}，次年再 ${parts[1]}，两者相加就是两年累计；“平均”指对所有国家×行业取平均。` : null;
}

