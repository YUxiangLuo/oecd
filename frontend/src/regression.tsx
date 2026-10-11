import { useEffect, useRef, useState } from "react";
import { scrollIntoCourseContent } from "./content-scroll";
import { api, ApiError } from "./api";
import { groupedFixed, percentagePoints } from "./format";
import { useAsync } from "./labs";
import { DEFAULT_BASELINES, displayBaselineLabel, GENERATED_DATA_NOTE, GENERATED_Y_DISCLOSURE, lessonFor, lessonQuestion } from "./regression-lessons";
import { nextRegressionSave } from "./regression-save";
import {
  BAR_UNIT_TITLES,
  barFigures,
  barUnitFor,
  buildRegressionVerdict,
  differenceWords,
  lagSplitParts,
  chartDisplayScale,
  unitName,
  withCountUnit,
  depvarKind,
  globalInferenceIsSuppressed,
  headlineCoefficient,
  networkDigits,
  signed,
  shownPerPoint,
  type BarEstimate,
} from "./regression-verdict";
import { exampleWasChosen, workedNumbers } from "./labs/steps/shock-lab";
import type {
  ClassroomReport,
  DepvarKind,
  Meta,
  QuizCompletionState,
  RegressionDesignInfo,
  RegressionOutcome,
  RegressionResponse,
  RegressionStatus,
  ReportedCustomResult,
  Step,
  StepStateApi,
  TeachingEstimate,
  TeachingGroupSeries,
  TeachingGroupsResponse,
  TeachingOverviewResponse,
  TeachingPanelResponse,
} from "./types";
import { TARIFF_IMPOSER, teachingExample, type TeachingExampleSelection } from "./teaching-example";
import { userFacingRequestError } from "./user-facing-error";
import { countryLabel, GroupChangeChart, sectorLabel } from "./viz";
import type { GroupLine } from "./viz/regression/charts";
import { TAXED, TAXED_LATER, UNTAXED } from "./viz/regression/palette";
import { DivergingBarChart, type DivergingBarRow } from "./viz/regression/diverging-bars";
import { ConfirmModal } from "./teacher/ui";
import { RegressionModelWorkbench, type WorkbenchStepState } from "./regression-workbench";
import { NEGATIVE, POSITIVE, UNCERTAIN } from "./viz/regression/palette";

const ENTITY_LABEL: Record<string, string> = { entity_id: "国家×行业", country: "国家" };
export const TEACHING_MODEL_VERSION = "step10-tariff-teaching-v10";

/** Reveal a freshly calculated verdict inside the course's scroll container (see content-scroll.ts). */
export const scrollRegressionVerdict = scrollIntoCourseContent;

/** The saved design's sample rule in plain words; the stored text (a data contract) is kept as is. */
export function sampleFilterLabel(filter: string | undefined): string {
  if (!filter) return "—";
  if (/^排除 ROW/.test(filter)) return "不含 ROW（OECD 把其他国家合在一起的“世界其他地区”）和美国（加征关税的一方）";
  return filter.replace("(", "（").replace(")", "）");
}

function DesignMeta({ design }: { design: RegressionDesignInfo }) {
  return (
    <div className="design-meta">
      {/* Same name as the Y list and the report ("加权总度"); the schema label's "（入+出）" is a step 5 detail. */}
      <span>结果指标 Y：{displayBaselineLabel(design.depvar_label)}</span>
      <span>解释变量：{explanatoryText(design)}</span>
      <span>数据：关税数据（国家×行业×年份）</span>
      <span>观察单位：{ENTITY_LABEL[design.entity] ?? design.entity}</span>
      <span>95% 区间按{ENTITY_LABEL[design.cluster] ?? design.cluster}计算（按{ENTITY_LABEL[design.cluster] ?? design.cluster}聚类）</span>
      <span>模型：双向固定效应</span>
      <span>样本：{sampleFilterLabel(design.sample_filter)}</span>
      <span>首年对美出口份额 w：各年固定用 2016 年的值</span>
    </div>
  );
}

/** Short names of the controls in the equation ("γ₁·汇率_it"). */
const CONTROL_SYMBOLS: Record<string, string> = {
  teaching_exchange_rate_change: "汇率",
  log_gdp_proxy: "GDP",
  export_intensity: "开放度",
  manufacturing_va_share: "制造业占比",
};

/**
 * Column names in the saved equation shown as symbols: "teaching_y_trade_ijt" reads "Y_ijt", "β₂·…_lag1_ijt" reads
 * "β₂·L1.X_ijt", "γ₁·teaching_exchange_rate_change_it" reads "γ₁·汇率_it".
 */
export function equationSymbol(part: { text: string; term?: string }): string {
  if (part.term === "dependent") return part.text.replace(/^.*_(\w+)$/, "Y_$1");
  if (part.term === "policy") {
    const match = /^(β\S*)·teaching_tariff_exposure(?:_lag(\d))?_(\w+)$/.exec(part.text);
    if (match) return `${match[1]}·${match[2] ? `L${match[2]}.X` : "X"}_${match[3]}`;
    return part.text.replace(/^(β\S*)·.*_(\w+)$/, "$1·X_$2");
  }
  if (part.term === "control") {
    // The unit index is the last "_it" (a control's own name has underscores too).
    const match = /^(γ\S*)·(.+?)(?:__lag(\d))?_(it|ijt)$/.exec(part.text);
    if (match) return `${match[1]}·${match[3] ? `L${match[3]}.` : ""}${CONTROL_SYMBOLS[match[2]] ?? match[2]}_${match[4]}`;
  }
  return part.text;
}

/** "关税暴露 X、上一年的 X（L1.X）；控制变量：汇率变动" from the saved model; "关税暴露 X" for a single-X model. */
export function explanatoryText(design: Pick<RegressionDesignInfo, "spec" | "control_labels">): string {
  const lags = design.spec?.x_lags ?? [0];
  const xs = lags.map((lag) => (lag === 0 ? "关税暴露 X" : lag === 1 ? "上一年的 X（L1.X）" : `${lag} 年前的 X（L${lag}.X）`));
  const controls = Object.values(design.control_labels ?? {});
  return `${xs.join("、")}${controls.length ? `；控制变量：${controls.join("、")}` : ""}`;
}

/** "α_ij" with its index as a subscript. */
function withSubscripts(text: string) {
  return text.split(/(_\w+)/).filter(Boolean).map((token, index) => token.startsWith("_")
    ? <sub key={index}>{token.slice(1)}</sub>
    : <span key={index}>{token}</span>);
}

const FALLBACK_EQUATION = ["Y_ijt", " = ", "β·X_ijt", " + ", "α_ij", " + ", "λ_t", " + ", "ε_ijt"];

/** The step's model before and after the run: its equation and what each part does, the data facts folded. */
function DesignEquation({ design }: { design: RegressionDesignInfo }) {
  const parts = design.equation_parts?.length ? design.equation_parts.map(equationSymbol) : FALLBACK_EQUATION;
  const yLabel = displayBaselineLabel(design.depvar_label) || "本步的结果指标";
  const lagged = (design.spec?.x_lags ?? [0]).includes(1);
  const controls = Object.values(design.control_labels ?? {});
  return (
    <div className="reg-model-box">
      <div className="model-eq" role="group" aria-label="本步计算的公式">
        {parts.map((text, index) => <span key={`${text}-${index}`}>{withSubscripts(text)}</span>)}
      </div>
      {/* Three points, always visible (a hover-only gloss went unnoticed). */}
      <ul className="model-eq-terms" aria-label="公式里各项的意思">
        {lagged
          ? <li><b>β₁·X + β₂·L1.X</b>：当年和上一年的关税暴露。关税的影响可能分两年显现，β₁ 是当年的关联，β₂ 是次年再出现的关联，<b>两者之和是两年累计关联</b>，即本步的主结果。</li>
          : <li><b>β·X</b>：关税暴露（首年对美出口份额 w × 加征税率 τ）；β 是 X 每高 1 个百分点时 Y 平均相差多少。</li>}
        {controls.length > 0 && (
          <li><b>γ·{controls.join("、")}</b>：控制变量。它与加税同时变化、又与 Y 有关，放进模型是为了不把它的作用算到关税头上。</li>
        )}
        <li><b>α + λ</b>：先扣掉每个国家×行业自己的平均水平（α）和每年所有国家×行业共同的变化（λ），即“双向固定效应”；ε 是剩下的随机波动。Y 是{yLabel}，i = 国家，j = 行业，t = 年份。</li>
      </ul>
      <details className="reg-model-facts">
        <summary>数据、样本和区间的算法</summary>
        <DesignMeta design={design} />
      </details>
    </div>
  );
}

/** One step-10 example unit: its label and its final-year exposure X (a proportion). */
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

/** Defined with the other number formats (regression-verdict.ts); re-exported where it was first used. */
export { networkDigits };

export { groupedFixed };

/**
 * An example's X in percentage points with the digits step 10 shows for it ("0.22444", not "0.22"), so the
 * conversion can be checked by hand; without w and τ, two decimals.
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
export const NETWORK_UNIT_NOTE = "中心性原始单位：本步的 Y 是课程按真实网络指标的排名校准生成的数值，不是步骤 5、9 的百万美元，不能和那两步的数值直接比较。";

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
  const unsignedEffect = verdict.effect.replace(/^[+−-]/, "");
  // The course model has X and L1.X: the headline is their sum, the relation over the tariff's year and the next.
  // Said only for that model (a sum of other X terms, or no sum at all, is not "两年累计").
  const lags = response.design.spec?.x_lags;
  const twoYears = Boolean(response.result.cumulative) && (lags == null || (lags.length === 2 && lags.includes(0) && lags.includes(1)));
  const plainResult = directional
    ? `${twoYears ? "两年累计" : ""}平均${verdict.state === "negative" ? words.lower : words.higher} ${unsignedEffect}`
    : `${twoYears ? "两年累计" : ""}平均相差 ${verdict.effect}，但高低方向不确定`;
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
      <ul className="reg-result-points">
        {!suppressed && verdict.coefficient && examples.length > 0 && (() => {
          // Only an example with X > 0 has a conversion, and only that conversion carries the interval's open
          // direction. When no example has one, "X = 0, nothing to convert" is said once, after the list.
          const converted = examples.filter((example) => !example.imposer && example.x > 0);
          const lastConverted = converted.at(-1);
          const noConversion = converted.length === 0;
          const unexposedTaxed = examples.some((example) => !example.imposer && example.x <= 0 && (example.tau ?? 0) > 0);
          const zeroNote = noConversion ? "" : "，X = 0，按估计没有与 X 相关的差异";
          return <li className="reg-example-effect">{!exampleSaved ? "按默认例子（步骤 10 还没有保存你的例子）" : exampleChosen ? "按你在步骤 10 选的例子" : "按步骤 10 的默认例子（你没有另选）"}换算{exampleYear ? `（用 ${exampleYear} 年的 X）` : ""}：{examples.map((example, index) => {
            const coef = verdict.coefficient!.coef;
            // An association, not a tariff effect: the difference in Y that goes with the example's X. With X = 0
            // the estimate implies no X-related difference (Y still moves with the shared yearly changes).
            const text = example.imposer
              ? <>{example.label} 属于加征关税的一方，按设计不在回归样本中，X 记为 0 只是定义，不做换算</>
              : example.x > 0
              ? (() => {
                const effect = exampleEffect(outcome, shownPerPoint(outcome, verdict.coefficient!, response.design), Number(exampleXText(example)), response.design);
                const lower = coef * example.x < 0;
                const tiny = effect.startsWith("不到");
                // "与 X 相关的差异约为 -12.83 个百分点（Y 偏低）"; below the shown precision it reads "不到 0.01 个百分点".
                // With an interval that includes 0 the sign is not settled, so 偏低/偏高 is left out and the open
                // direction is said once, after the last conversion.
                return <>{example.label} 的 X 为 {exampleXText(example)} 个百分点，按估计{twoYears ? "两年累计" : ""}与 X 相关的差异{tiny ? "" : "约为 "}<b>{tiny ? effect : `${lower ? "-" : "+"}${effect}`}</b>{directional ? `（Y 偏${lower ? words.lower : words.higher}）` : ""}{verdict.state === "insufficient" && example === lastConverted ? "，但区间包含 0，差异的高低方向并不确定" : ""}</>;
              })()
              : example.service
                ? <>{example.label} 是服务业，不在加税范围内（τ = 0）{zeroNote}</>
              : (example.tau ?? 0) > 0
                ? <>{example.label} 被加税但首年不向美国出口（w = 0）{zeroNote}</>
                : <>{example.label} 未被加税{zeroNote}</>;
            return <span key={example.label}>{index ? "；" : ""}{text}</span>;
          })}。
            {noConversion && `${examples.length === 1 ? "这个例子的 X = 0" : "两个例子的 X 都是 0"}，按估计没有与 X 相关的差异。如需看到不为 0 的换算，请回到步骤 10 ${examples.some((example) => example.service)
              ? "换一个货物行业（服务业不加税），如加拿大的汽车行业"
              : unexposedTaxed
              ? "换一个向美国出口的被加税国家或行业（如加拿大的汽车行业）"
              : examples.length === 1 ? "换成被加税的国家（如加拿大），或再选一个被加税的对照国家" : "选一个被加税的国家（如加拿大）"}。`}</li>;
        })()}
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
 * "其中当年 -0.33、次年再 -0.22 个百分点": the headline split over the tariff's year (X) and the next (L1.X), in the
 * headline's units; null when the run has no L1.X.
 */
export function lagSplit(outcome: RegressionOutcome, response: Pick<RegressionResponse, "design" | "result">): string | null {
  const parts = lagSplitParts(outcome, response);
  // The model box above the run button says what the two terms are; here only the split.
  return parts ? `其中当年 ${parts[0]}，次年再 ${parts[1]}。` : null;
}

/** 自动保存最近一次真实运行，供刷新恢复与报告复估。 */
export interface SavedRegressionRun {
  design: RegressionResponse["design"];
  result: RegressionResponse["result"];
  /** Server-provided data and interpretation boundary; persisted verbatim for restored runs. */
  disclaimer: string;
  /** Required for current teaching runs; optional only so old snapshots can be detected and rejected. */
  model_snapshot?: NonNullable<RegressionResponse["model_snapshot"]>;
  variable_catalog?: NonNullable<RegressionResponse["variable_catalog"]>;
}

interface RegressionStepState extends QuizCompletionState, Record<string, unknown> {
  run?: SavedRegressionRun;
  qualified_run?: SavedRegressionRun;
}

const SAVED_REGRESSION_BENCHMARK: RegressionResponse["benchmark"] = {
  backend: "saved",
  policy_coefs: [],
  max_abs_coef_diff: 0,
  max_abs_se_diff: 0,
  coef_check_passed: true,
  se_check_mode: "informational",
  notes: [],
};

function savedRegressionResponse(saved: SavedRegressionRun): RegressionResponse {
  return {
    design: saved.design,
    result: saved.result,
    benchmark: SAVED_REGRESSION_BENCHMARK,
    disclaimer: saved.disclaimer,
    model_snapshot: saved.model_snapshot,
    variable_catalog: saved.variable_catalog,
  };
}

function canonicalSnapshot(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSnapshot).join(",")}]`;
  if (value && typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0);
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalSnapshot(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic identity of every saved setting, design field, and result field. */
export function regressionRunSnapshotIdentity(saved: SavedRegressionRun): string {
  return canonicalSnapshot({
    design: saved.design,
    result: saved.result,
    disclaimer: saved.disclaimer,
    model_snapshot: saved.model_snapshot,
    variable_catalog: saved.variable_catalog,
  });
}

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

const KINDS: readonly DepvarKind[] = ["share", "length", "position", "network"];
const kindOf = (kind: string, outcome: RegressionOutcome): DepvarKind =>
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

/**
 * After the report was submitted, this step's saved material differs from what the report used; said by what
 * replaced it on this visit (a bar click or the run button), or plainly after a reload.
 */
export const REPLACED_NOTICE = {
  bar: "已改为保存这个 Y 的结果；报告已提交，请到步骤 15 更新报告并重新提交给老师。",
  button: "已改为保存这次算出的结果；报告已提交，请到步骤 15 更新报告并重新提交给老师。",
  saved: "本步保存的结果与已提交报告里的不同；请到步骤 15 更新报告并重新提交给老师。",
} as const;

/** What the report was built from: its frozen copy of each step's saved runs. */
export type ReportRuns = ClassroomReport["provenance"]["runs"];

/**
 * Whether this step's saved runs (`run`, and `qualified_run` when it differs, as the report reads them) differ from
 * the runs the report was built from. Together with the report being out of date (the signal the sidebar and
 * step 15 use), this says the update is needed because of this step.
 */
export function stepMaterialChanged(
  stepNumber: number,
  data: { run?: Pick<SavedRegressionRun, "design" | "result">; qualified_run?: Pick<SavedRegressionRun, "design" | "result"> } | undefined,
  reportRuns: ReportRuns | undefined,
): boolean {
  const identity = (run: { design: unknown; result: unknown }) => canonicalSnapshot({ design: run.design, result: run.result });
  const saved = new Set([data?.run, data?.qualified_run].filter((run) => run != null).map(identity));
  const reported = new Set((reportRuns ?? []).filter((run) => run.step === stepNumber).map(identity));
  return saved.size !== reported.size || [...saved].some((item) => !reported.has(item));
}

/** The 加税前后 chart's lines: the two tariff waves and the untaxed countries; a server before v10 sends one taxed group. */
export function groupLines(series: TeachingGroupSeries): GroupLine[] {
  if (series.first?.length || series.second?.length) {
    return [
      { key: "first", label: "第一批被加税", color: TAXED, points: series.first ?? [] },
      { key: "second", label: "第二批被加税", color: TAXED_LATER, points: series.second ?? [], dashed: true },
      { key: "untaxed", label: "未被加税", color: UNTAXED, points: series.untaxed },
    ].filter((line) => line.points.length > 0);
  }
  return [
    { key: "taxed", label: "被加税国家组", color: TAXED, points: series.taxed },
    { key: "untaxed", label: "未被加税国家组", color: UNTAXED, points: series.untaxed },
  ];
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
export const GROUP_CHART_CAPTION = "图上的变化混有同一时期的其他变化（如汇率），回归会把它们分开，所以条形图的数字不必等于图上两条线的距离。";

/** Under the 加税前后 chart: the premise the regression rests on, and how little the chart can show of it. In teaching
 *  data v10 it holds by design only once the exchange-rate change is controlled (the chart's lines are not parallel). */
export function parallelTrendsNote(years: readonly number[], policyYear: number | null | undefined, groups = 2): string {
  const before = policyYear == null ? [] : years.filter((year) => year < policyYear);
  const count = ["", "一", "两", "三", "四", "五"][before.length] ?? String(before.length);
  const pre = before.length ? `加税前只有 ${before.join("、")} ${count}年可看` : "加税前的年份很少";
  const who = groups > 2 ? "各组" : "两组";
  return `这张图也用来看回归的前提：如果没有关税，扣掉汇率等同期变化后，${who}的走势应大致平行。${pre}，能检验的证据有限；被加税名单按对美货物顺差确定，不是随机分配。本课程的 Y 按设定生成，控制汇率变动后这一前提由设计保证。`;
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
  return `纯国内、传统贸易、简单 GVC、复杂 GVC 四项份额合计 100%，所以这四条相加约为 0（${Math.abs(sum) < 0.005 ? "0.00" : signed(sum, 2)}）；前向 GVC 生产总份额 = 简单 + 复杂（按未取整的原值精确相加，条旁取整后的数字可能相差末位 1）。`;
}

/** Steps whose run was still in flight when the student left the step (the request is aborted then). */
const interruptedRuns = new Set<RegressionOutcome>();
export const INTERRUPTED_RUN_NOTE = "上次计算没有完成，请重新计算。";

/** The bars' title: a click (or Enter on the focused bar) saves that Y. */
export function familyBarsTitle(count: number): string {
  return `本类 ${count} 个 Y · 点击任一条即改为保存该 Y（键盘：方向键切换，Enter 保存）`;
}

/**
 * One regression step (11–14). Each step is self-contained: it reads only its own saved run. One button runs the
 * step's default Y and draws a bar for every Y of the family; clicking a bar runs that Y, which becomes the
 * headline and the saved report material.
 */
export function RegressionRunLab({ step, meta, state, getStep, reportRuns, reportCustomResults, reportOutdated = false }: {
  step: Step;
  meta: Pick<Meta, "countries" | "sectors">;
  state: StepStateApi<RegressionStepState>;
  /** Read-only: the example the student chose in step 10. */
  getStep?: <T>(step: number) => T | undefined;
  /** The runs the current report was built from (its provenance). */
  reportRuns?: ReportRuns;
  /** The workbench models the current report printed (its provenance). */
  reportCustomResults?: ReportedCustomResult[];
  /** The report needs updating: the same signal as the sidebar and step 15 (unsaved edits, or the server says so). */
  reportOutdated?: boolean;
}) {
  const outcome = step.regression_outcome;
  // The button names the step's regression ("计算贸易流回归"), as the step title does.
  const runName = step.title.split("：")[0] || "回归";
  if (!outcome) return <div className="error-box">当前回归步骤缺少 regression_outcome 配置。</div>;
  const [result, setResult] = useState<RegressionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // A grey (方向不确定) bar is for reading its interval by hover; a click on it saves it, so ask first.
  const [pendingUncertain, setPendingUncertain] = useState<{ key: string; label: string } | null>(null);
  // A run cut off by leaving the step earlier: said once, until the next run starts.
  const [interrupted, setInterrupted] = useState(() => interruptedRuns.has(outcome));
  // Said by the polite live region after a bar saved its Y ("已保存：…"): keyboard focus stays on the bars.
  const [savedAnnouncement, setSavedAnnouncement] = useState("");
  // What replaced the saved material on this visit, for the notice's wording: a bar click or the run button.
  const [replacedBy, setReplacedBy] = useState<"bar" | "button" | null>(null);
  // A failed request is retried as it was: the Y of a failed bar click, not the Y saved before it.
  const [failedRequest, setFailedRequest] = useState<{ key: string | null; fromBar: boolean } | null>(null);
  const replacedNoticeRef = useRef<HTMLParagraphElement>(null);
  const revealReplacedNotice = useRef(false);
  const barErrorRef = useRef<HTMLDivElement>(null);
  const revealBarError = useRef(false);
  // The bars are fetched with the first run (or with a restored one), never before.
  const [overviewWanted, setOverviewWanted] = useState(false);
  // A 429 carries Retry-After: the retry button waits it out with a visible countdown.
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt == null) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= retryAt) setRetryAt(null);
    }, 500);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  const retryWait = retryAt == null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const runController = useRef<AbortController | null>(null);
  const verdictAnchorRef = useRef<HTMLDivElement>(null);
  const scrollToVerdictAfterRun = useRef(false);

  // Before the run: the taxed vs untaxed comparison that the regression then quantifies.
  const groupsQuery = useAsync<TeachingGroupsResponse>(() => api.teachingGroups(), ["teaching-groups"]);
  // The default model as the server describes it (its equation), shown above the run button before any result.
  const designKey = `regression-design:${outcome}`;
  const designQuery = useAsync<RegressionDesignInfo>(() => api.regressionDesign(outcome), [designKey], { requestKey: designKey });
  const modelDesign = result?.design ?? (designQuery.status === "success" ? designQuery.data ?? null : null);
  const groups = groupsQuery.status === "success" ? groupsQuery.data : null;
  const baselineOptions = groups?.baselines?.[outcome] ?? [];
  const defaultKey = baselineOptions.find((option) => option.default)?.key ?? DEFAULT_BASELINES[outcome];

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
      const label = `${countryLabel(country)}\u2060·\u2060${sectorLabel(example.industry)}`;
      if (country === TARIFF_IMPOSER) return [{ label, x: 0, imposer: true }];
      return row ? [{
        label, x: row.teaching_tariff_exposure, tau: row.teaching_tariff_rate_tau, w: row.teaching_export_share_w,
        service: !/^[ABC]/.test(example.industry),
      }] : [];
    })
    : [];

  useEffect(() => {
    mountedRef.current = true;
    // Said once: the note is in state now, and a later visit starts clean.
    interruptedRuns.delete(outcome);
    return () => {
      mountedRef.current = false;
      // Leaving the step aborts the run and nothing is saved: the step says so when the student comes back.
      if (runningRef.current) interruptedRuns.add(outcome);
      runController.current?.abort();
    };
  }, []);

  // 会话异步到达：刷新或换设备后恢复本步上次算出的结果（也就是报告材料里的那个 Y），而不是空白面板。
  const savedRun = state.data?.run;
  // After submission: the report is out of date and this step's saved runs are not the ones it was built from.
  // Going back to the Y the report used (e.g. 恢复默认 after a trial click) withdraws the notice, as the sidebar does.
  const showReplaced = Boolean(state.materialLocked && savedRun && reportOutdated
    && stepMaterialChanged(step.n, state.data, reportRuns));
  const savedRunIdentity = savedRun ? regressionRunSnapshotIdentity(savedRun) : null;
  const savedUsable = savedRun?.model_snapshot?.version === TEACHING_MODEL_VERSION && Boolean(savedRun.variable_catalog);
  const savedKey = savedRun?.design?.baseline ?? defaultKey;
  // A saved Y the current release does not offer is not shown as a result; the step starts again from its default.
  const groupsSettled = groupsQuery.status === "success" || groupsQuery.status === "error";
  const savedOffered = baselineOptions.length === 0 || baselineOptions.some((option) => option.key === savedKey);
  useEffect(() => {
    if (running || runningRef.current || result || !savedUsable || !groupsSettled || !savedOffered) return;
    setResult(savedRegressionResponse(savedRun!));
  }, [result, running, savedRunIdentity, groupsSettled, savedOffered]);
  const staleSavedY = savedUsable && groupsSettled && !savedOffered && !result;

  // The Y shown and saved: the last run's, else the step's default (never another step's choice).
  const selectedKey = result?.design.baseline ?? defaultKey;
  const selectedOption = baselineOptions.find((option) => option.key === selectedKey);
  const lesson = lessonFor(outcome, selectedKey, result?.design.baseline_label ?? selectedOption?.label);
  const overviewQuery = useAsync<TeachingOverviewResponse>(
    () => api.teachingOverview(),
    ["teaching-overview"],
    { enabled: overviewWanted || Boolean(result) },
  );
  const overviewItems = overviewQuery.status === "success" ? overviewQuery.data?.outcomes[outcome] ?? [] : [];

  /** Run one Y (null: the default) with the step's single model; the response replaces the saved material. */
  const run = async (key: string | null, fromButton: boolean) => {
    if (runningRef.current) return;
    runningRef.current = true;
    const controller = new AbortController();
    runController.current = controller;
    setRunning(true);
    setOverviewWanted(true);
    setError(null);
    setFailedRequest(null);
    setInterrupted(false);
    setSavedAnnouncement("");
    try {
      const response = await api.runRegression(outcome, controller.signal, key == null || key === defaultKey ? null : key);
      if (!mountedRef.current) return;
      if (response.model_snapshot?.version !== TEACHING_MODEL_VERSION || !response.variable_catalog) {
        throw new Error(`页面版本已更新，结果没有保存。请刷新页面后再点“计算${runName}”`);
      }
      const saved = nextRegressionSave(state.data, {
        design: response.design, result: response.result,
        disclaimer: response.disclaimer,
        model_snapshot: response.model_snapshot, variable_catalog: response.variable_catalog,
      });
      state.save({
        run: saved.run,
        ...(saved.qualified_run ? { qualified_run: saved.qualified_run } : {}),
      });
      // A bar click keeps keyboard focus on the bars (the live region says what was saved); only the button
      // moves on to the answer.
      scrollToVerdictAfterRun.current = fromButton;
      if (!fromButton) {
        setSavedAnnouncement(`已保存：${lessonFor(outcome, response.design.baseline, response.design.baseline_label).shortMetric}`);
      }
      // After the report was submitted, the notice (shown while this differs from the report) says what replaced it.
      if (state.materialLocked) {
        setReplacedBy(fromButton ? "button" : "bar");
        revealReplacedNotice.current = !fromButton;
      }
      setResult(response);
    } catch (cause) {
      focusSavedBarAfterRun.current = false;
      if (mountedRef.current) {
        // A bar (or 恢复默认) was saving another Y: said so ("保存国内增加值出口占比没有成功"), not as a calculation.
        const failedLabel = lessonFor(outcome, key ?? defaultKey, baselineOptions.find((option) => option.key === (key ?? defaultKey))?.label).shortMetric;
        setError(userFacingRequestError(cause, fromButton ? `${runName}未完成` : `保存“${failedLabel}”没有成功`));
        setFailedRequest({ key, fromBar: !fromButton });
        revealBarError.current = !fromButton;
        if (cause instanceof ApiError && cause.status === 429 && cause.retryAfter) {
          setNow(Date.now());
          setRetryAt(Date.now() + cause.retryAfter * 1000);
        }
      }
    } finally {
      if (runController.current === controller) runController.current = null;
      runningRef.current = false;
      if (mountedRef.current) setRunning(false);
    }
  };

  // 只在学生点运行按钮之后滚到结论；会话恢复和点条形图都不滚动。
  useEffect(() => {
    if (!result || !scrollToVerdictAfterRun.current) return;
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
  }, [result]);

  // 恢复默认 removes its own chip: keyboard focus moves to the bar that is saved now, not to the page.
  const focusSavedBarAfterRun = useRef(false);
  useEffect(() => {
    if (!result || !focusSavedBarAfterRun.current) return;
    focusSavedBarAfterRun.current = false;
    const frame = window.requestAnimationFrame(() => {
      verdictAnchorRef.current?.querySelector<SVGGElement>("[data-bar][data-selected='true']")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [result]);

  // A bar click after submission: the notice under the bars is brought into view (never focused, so keyboard focus
  // stays on the bars). The run button's path scrolls to the verdict anchor, which holds the bars and the notice.
  useEffect(() => {
    if (!showReplaced || !revealReplacedNotice.current) return;
    revealReplacedNotice.current = false;
    const frame = window.requestAnimationFrame(() => {
      const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      replacedNoticeRef.current?.scrollIntoView?.({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showReplaced, result]);

  const bars = result && overviewItems.length > 0 ? familyBarRows(outcome, overviewItems, selectedKey, result) : null;
  // A failed bar click: the error and its retry sit under the bars, where the click happened (the run card and
  // its button can be far above, out of view), and are brought into view; keyboard focus stays on the bars.
  const errorAtBars = Boolean(error && failedRequest?.fromBar && bars);
  useEffect(() => {
    if (!errorAtBars || !revealBarError.current) return;
    revealBarError.current = false;
    const frame = window.requestAnimationFrame(() => {
      const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      barErrorRef.current?.scrollIntoView?.({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [errorAtBars, error]);
  const identity = !bars ? null : outcome === "production" ? forwardShareIdentity(overviewItems) : outcome === "network" ? degreeIdentity(overviewItems) : null;
  const defaultLabel = lessonFor(outcome, defaultKey, baselineOptions.find((option) => option.default)?.label).shortMetric;
  const latinGap = /^[A-Za-z]/.test(lesson.shortMetric) ? " " : "";
  const replacedNotice = REPLACED_NOTICE[replacedBy ?? "saved"];
  // The retry repeats the failed request; a failed bar click names its Y ("重试：保存国内增加值出口占比").
  const failedKey = failedRequest?.key ?? defaultKey;
  const failedBarLabel = failedRequest?.fromBar
    ? lessonFor(outcome, failedKey, baselineOptions.find((option) => option.key === failedKey)?.label).shortMetric
    : null;

  return (
    <div className="reg-workbench">
      {/* 1 · The data first: the question and the three groups before and after the tariffs. */}
      <section className="reg-run-card">
        <span className="reg-section-step">先看数据</span>
        <h3>{lessonQuestion(outcome, selectedKey)}</h3>
        {staleSavedY && (
          <p className="reg-boundary" role="status">上次计算的 Y（{displayBaselineLabel(savedRun?.design?.baseline_label) || "—"}）不在当前课程数据中，已恢复为本步默认指标，请重新计算。</p>
        )}
        {groups && (() => {
          const series = selectedKey === defaultKey ? groups.outcomes[outcome] : groups.series?.[outcome]?.[selectedKey];
          if (!series) return null;
          const kind = result ? depvarKind(outcome, result.design) : kindOf(selectedOption?.kind ?? "", outcome);
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
              {/* One note: what the chart mixes in, and the premise it can only partly show. */}
              <p className="muted reg-gap-caption">{lines.length > 2 ? GROUP_CHART_CAPTION : ""}{parallelTrendsNote(groups.years, groups.policy_year, lines.length)}</p>
            </div>
          );
        })()}
        {groupsQuery.status === "error" && groupsQuery.error && (
          <RegressionRequestError label="分组对比图" error={groupsQuery.error} onRetry={groupsQuery.retry} />
        )}
      </section>

      {/* 2 · The course default model, said before it is computed; the run button computes it for every Y. */}
      <section className="reg-run-card">
        <span className="reg-section-step">默认模型</span>
        {modelDesign
          ? <DesignEquation design={modelDesign} />
          : designQuery.status === "error" && designQuery.error
            ? <RegressionRequestError label="模型说明" error={designQuery.error} onRetry={designQuery.retry} />
            : <div className="reg-request-state muted" role="status" aria-busy="true">正在读取模型…</div>}
        {/* Said before the run (the result card repeats it), so the Y is never read as OECD data first. */}
        {!result && <p className="muted reg-data-note reg-data-note-before" role="note">{GENERATED_DATA_NOTE}</p>}
        {/* Once a result exists, recalculating is a secondary action; it replaces saved material. */}
        {/* After a failed bar click the retry sits under the bars; this button recalculates the saved Y as usual. */}
        <button
          className={result && (!error || errorAtBars) ? "run-btn secondary" : "run-btn"}
          onClick={() => {
            if (running || retryWait > 0) return;
            void run(failedRequest && !errorAtBars ? failedRequest.key : result ? selectedKey : null, true);
          }}
          // aria-disabled while running keeps keyboard focus on the button instead of dropping it to the page.
          aria-disabled={running || retryWait > 0}
        >
          {running ? "正在计算…"
            : retryWait > 0 ? `重试（${retryWait} 秒后）`
              : error && !errorAtBars ? (failedBarLabel ? `重试：保存“${failedBarLabel}”` : `重试：计算${runName}`)
                : result ? `重新计算${runName}`
                  : groups ? `计算${runName}（用全部 ${groups.sample.rows.toLocaleString("zh-CN")} 条记录）` : `计算${runName}`}
        </button>
        {/* Mounted before it has text, so screen readers announce the change. */}
        <span className={running ? "muted reg-inline-status" : "sr-only"} role="status" aria-live="polite">{running ? "正在计算…" : savedAnnouncement}</span>
        {interrupted && !running && <p className="reg-boundary reg-interrupted-note" role="status">{INTERRUPTED_RUN_NOTE}</p>}
        {/* Before a replacement; afterwards the notice sits under the bars, where the click happened. */}
        {!running && savedRun && state.materialLocked && (!showReplaced || !bars) && (
          showReplaced
            ? <p className="reg-rerun-warning reg-replaced-notice" role="status">{replacedNotice}</p>
            : <p className="reg-rerun-warning" role="note"><b>报告已提交</b>重新计算或点击另一条，会替换报告材料里保存的结果；之后要到步骤 15 更新报告，并重新提交给老师。</p>
        )}
      </section>

      {/* One action: the run button above doubles as the retry (it shows the wait after "too many requests"). */}
      {error && !errorAtBars && <div className="error-box async-error" role="alert"><span>{error}</span></div>}

      {result && (
        <div className={error ? "reg-results reg-results-stale" : "reg-results"}>
          {error && !errorAtBars && <p className="reg-stale-note" role="note">这次计算没有成功；下面仍是上次保存的结果。</p>}
          {pendingUncertain && (
            <ConfirmModal
              title="改为保存方向不确定的这一项？"
              message={`“${pendingUncertain.label}”的 95% 区间包含 0，方向不确定。点“改为保存”后，本步写进报告的结果会改成这一项，不再是默认的${defaultLabel}。只想看它的区间，把鼠标停在条上（或用方向键选中）即可，不用点击。`}
              confirmLabel="改为保存"
              onConfirm={() => { const { key } = pendingUncertain; void run(key, false); }}
              onClose={() => setPendingUncertain(null)}
            />
          )}
          <div ref={verdictAnchorRef} className="verdict-anchor">
            {bars ? (
              <div className="reg-family-bars">
                <DivergingBarChart
                  rows={bars.rows}
                  unitTitle={bars.unitTitle}
                  title={familyBarsTitle(bars.rows.length)}
                  onSelect={(key) => {
                    if (key === selectedKey) return;
                    const row = bars.rows.find((item) => item.key === key);
                    if (row?.uncertain) setPendingUncertain({ key, label: row.label });
                    else void run(key, false);
                  }}
                  disabled={running}
                >
                  {/* A bar click saves its Y for the report: when that is not the step's default, say so and offer the way back. */}
                  {selectedKey !== defaultKey && (
                    <p className="reg-saved-chip" role="note">
                      <span>当前保存：{lesson.shortMetric}（不是本步默认）</span>
                      <span aria-hidden="true"> · </span>
                      <button type="button" className="reg-saved-chip-reset" aria-disabled={running || undefined}
                        onClick={() => { if (running) return; focusSavedBarAfterRun.current = true; void run(defaultKey, false); }}>
                        恢复默认（{defaultLabel}）
                      </button>
                    </p>
                  )}
                  {identity && <p className="muted reg-identity-note">{identity}</p>}
                  {/* Next to the bar that was clicked, so the student sees it without scrolling up. */}
                  {showReplaced && (
                    <p ref={replacedNoticeRef} className="reg-rerun-warning reg-replaced-notice" role="status">{replacedNotice}</p>
                  )}
                </DivergingBarChart>
                {/* Under the bars, not faded with them: what failed, that the bars still show the saved Y, and the retry. */}
                {errorAtBars && (
                  <div ref={barErrorRef} className="error-box async-error reg-bar-error" role="alert">
                    <span>{error}<span className="reg-bar-error-note">图和下面仍是上次保存的结果（{lesson.shortMetric}）。</span></span>
                    <button type="button" className="secondary" aria-disabled={running || retryWait > 0 || undefined}
                      onClick={() => {
                        if (running || retryWait > 0 || !failedRequest) return;
                        // The button goes with the error: keyboard focus moves to the bar being saved, then (on success)
                        // to the saved bar.
                        verdictAnchorRef.current?.querySelector<SVGGElement>(`[data-bar="${failedKey}"]`)?.focus();
                        focusSavedBarAfterRun.current = true;
                        void run(failedRequest.key, false);
                      }}>
                      {retryWait > 0 ? `重试（${retryWait} 秒后）` : `重试：保存“${failedBarLabel}”`}
                    </button>
                  </div>
                )}
              </div>
            ) : overviewQuery.status === "error" && overviewQuery.error
              ? <RegressionRequestError label="条形图" error={overviewQuery.error} onRetry={overviewQuery.retry} />
              : overviewQuery.status === "loading" && <div className="reg-request-state muted" role="status" aria-busy="true">正在绘制本类各 Y 的条形图…</div>}
            <RegressionResultCard outcome={outcome} response={result} examples={examples} exampleSaved={exampleSaved} exampleChosen={exampleChosen} exampleYear={lastYear} />
          </div>
        </div>
      )}

      {/* 3 · Change one setting at a time and read it next to the default model (open; optional for completion). */}
      {result && (
        <section className="reg-run-card reg-custom-section">
          <span className="reg-section-step">改模型、对比（选做）</span>
          <h3>换一种模型试试：每次改一处，和默认模型比较</h3>
          <RegressionModelWorkbench
            stepNumber={step.n}
            outcome={outcome}
            defaultResponse={result}
            state={state as unknown as StepStateApi<WorkbenchStepState>}
            reportCustomResults={reportCustomResults}
            reportOutdated={reportOutdated}
          />
        </section>
      )}
    </div>
  );
}
