/** The step's result card: the headline sentence, its interval in words, the step 10 example's conversion and the limits. */
import { GENERATED_Y_DISCLOSURE, lessonFor } from "../regression-lessons";
import {
  buildRegressionVerdict,
  differenceWords,
  depvarKind,
  SD_DEFINITION,
  shownPerPoint,
  lagSplitParts,
  teachingEffect,
  standardizedDigits,
  standardizedEffect,
} from "../regression-verdict";
import type { RegressionOutcome, RegressionResponse } from "../types";
import { NEGATIVE, POSITIVE, UNCERTAIN } from "../viz/regression/palette";
import { designValueSentence, exampleEffect, exampleXText, lagSplit, NETWORK_UNIT_NOTE, type RegressionExample } from "./result-text";

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
  // With X and L1.X, a sustained increment enters both terms from its second year onward.
  const lags = response.design.spec?.x_lags;
  const twoYears = Boolean(response.result.cumulative) && (lags == null || (lags.length === 2 && lags.includes(0) && lags.includes(1)));
  const plainResult = directional
    ? `平均${verdict.state === "negative" ? words.lower : words.higher} ${unsignedEffect}`
    : `平均相差 ${verdict.effectBrief}，但高低方向不确定`;
  const split = twoYears ? lagSplit(outcome, response) : null;
  const parts = split && !suppressed ? lagSplitParts(outcome, response) : null;
  // "外国增加值项占比平均低", but "GVC 位置指数 平均…" keeps a space after a Latin name.
  const metricGap = /[A-Za-z]$/.test(lesson.shortMetric) ? " " : "";
  const badgeColor = BADGE_COLORS[verdict.state];
  return (
    <section className={`verdict-card verdict-${verdict.state}`} aria-labelledby="reg-result-title">
      <p className="reg-generated-disclosure" role="note">{GENERATED_Y_DISCLOSURE}</p>
      <h3 id="reg-result-title" tabIndex={-1} className="reg-plain-verdict">
        {verdict.coefficient
          ? <span className="reg-headline-main">关税暴露 X {twoYears ? "持续高 1 个百分点时，从第二年起，" : "每高 1 个百分点，"}{lesson.shortMetric}{kind === "network" ? "（教学模拟分数）" : metricGap}<b>{plainResult}</b></span>
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
      {parts && verdict.coefficient && <div className="reg-lag-timing">
        <p>假设 X 从某年起持续高 1 个百分点，其他模型项保持相同：</p>
        <ul>
          <li><b>第一年</b>：只有当期 X 项，Y 相差 {parts[0]}。</li>
          <li><b>第二年及以后</b>：当期 X 项＋上一年 X 项，Y 相差 {teachingEffect(outcome, verdict.coefficient.coef, response.design, verdict.coefficient.ci_low != null && verdict.coefficient.ci_high != null ? [verdict.coefficient.ci_low, verdict.coefficient.ci_high] : null)}。</li>
        </ul>
        <p className="muted">合计的是系数，不是两个年份的 Y 变化相加。“平均”指控制其他变量和固定效应后的共同条件斜率，不是所有国家×行业的等权平均，也不代表因果效应。</p>
      </div>}
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
                return <>{example.label}：X = {exampleXText(example)} 个百分点 → {twoYears ? "X 持续保持该数值时，第二年起" : ""}与 X 相关的差异{tiny ? "" : "约"} <b>{tiny ? effect : `${lower ? "-" : "+"}${effect}`}</b>{directional ? `（Y 偏${lower ? words.lower : words.higher}）` : ""}{verdict.state === "insufficient" && example === lastConverted ? "，但区间包含 0，高低方向并不确定" : ""}</>;
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
