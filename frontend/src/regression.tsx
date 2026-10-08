import { useEffect, useRef, useState } from "react";
import { ScrollableRegion } from "./a11y";
import { scrollIntoCourseContent } from "./content-scroll";
import { api, ApiError } from "./api";
import { percentagePoints } from "./format";
import { useAsync } from "./labs";
import { DEFAULT_BASELINES, displayBaselineLabel, GENERATED_DATA_NOTE, lessonFor, lessonQuestion } from "./regression-lessons";
import { nextRegressionSave } from "./regression-save";
import { formatPValue } from "./regression-statistics";
import {
  BAR_UNIT_TITLES,
  barFigures,
  barUnitFor,
  buildRegressionVerdict,
  differenceWords,
  teachingEffect,
  chartDisplayScale,
  countUnit,
  depvarKind,
  globalInferenceIsSuppressed,
  signed,
  type BarEstimate,
} from "./regression-verdict";
import type {
  DepvarKind,
  Meta,
  QuizCompletionState,
  RegressionDesignInfo,
  RegressionOutcome,
  RegressionResponse,
  RegressionStatus,
  Step,
  StepStateApi,
  TeachingEstimate,
  TeachingGroupsResponse,
  TeachingOverviewResponse,
  TeachingPanelResponse,
} from "./types";
import { TARIFF_IMPOSER, teachingExample, type TeachingExampleSelection } from "./teaching-example";
import { userFacingRequestError } from "./user-facing-error";
import { countryLabel, GroupChangeChart, sectorLabel } from "./viz";
import { DivergingBarChart, type DivergingBarRow } from "./viz/regression/diverging-bars";
import { NEGATIVE, POSITIVE, UNCERTAIN } from "./viz/regression/palette";

const ENTITY_LABEL: Record<string, string> = { entity_id: "国家×行业", country: "国家" };
export const TEACHING_MODEL_VERSION = "step10-tariff-teaching-v7";

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
      <span>解释变量：关税暴露 X</span>
      <span>数据：关税数据（国家×行业×年份）</span>
      <span>观察单位：{ENTITY_LABEL[design.entity] ?? design.entity}</span>
      <span>95% 区间按{ENTITY_LABEL[design.cluster] ?? design.cluster}计算（按{ENTITY_LABEL[design.cluster] ?? design.cluster}聚类）</span>
      <span>模型：双向固定效应</span>
      <span>样本：{sampleFilterLabel(design.sample_filter)}</span>
      <span>首年对美出口份额 w：各年固定用 2016 年的值</span>
    </div>
  );
}

/** Column names in the saved equation shown as symbols: "teaching_y_trade_ijt" reads "Y_ijt". */
export function equationSymbol(part: { text: string; term?: string }): string {
  if (part.term === "dependent") return part.text.replace(/^.*_(\w+)$/, "Y_$1");
  if (part.term === "policy") return part.text.replace(/^β·.*_(\w+)$/, "β·X_$1");
  return part.text;
}

/** "α_ij" with its index as a subscript. */
function withSubscripts(text: string) {
  return text.split(/(_\w+)/).filter(Boolean).map((token, index) => token.startsWith("_")
    ? <sub key={index}>{token.slice(1)}</sub>
    : <span key={index}>{token}</span>);
}

const FALLBACK_EQUATION = ["Y_ijt", " = ", "β·X_ijt", " + ", "α_ij", " + ", "λ_t", " + ", "ε_ijt"];

function DesignEquation({ design }: { design: RegressionDesignInfo }) {
  const parts = design.equation_parts?.length ? design.equation_parts.map(equationSymbol) : FALLBACK_EQUATION;
  const yLabel = displayBaselineLabel(design.depvar_label) || "本步的结果指标";
  return (
    <div>
      <div className="model-eq" role="group" aria-label="本步计算的公式">
        {parts.map((text, index) => <span key={`${text}-${index}`}>{withSubscripts(text)}</span>)}
      </div>
      {/* The five terms, always visible (a hover-only gloss went unnoticed). */}
      <ul className="model-eq-terms" aria-label="公式里各项的意思">
        <li><b>Y</b>：结果指标，本步是{yLabel}；i = 国家，j = 行业，t = 年份。</li>
        <li><b>β·X</b>：X 是关税暴露（首年对美出口份额 w × 加征税率 τ）；β 就是要算的估计值：X 每高 1 个百分点的国家×行业，Y 平均相差多少。</li>
        <li><b>α</b>：每个国家×行业自己的平均水平，先扣掉。</li>
        <li><b>λ</b>：每一年所有国家×行业共同的变化，先扣掉。</li>
        <li><b>ε</b>：剩下的随机波动。</li>
      </ul>
      <p className="muted">扣掉 α 和 λ 的做法叫“双向固定效应”：这样比较的是同一个国家×行业在不同年份、相对共同变化的起伏。</p>
      <DesignMeta design={design} />
    </div>
  );
}

/** One step-10 example unit: its label and its final-year exposure X (a proportion). */
/** An example followed from step 10: its X in the last year and whether it was taxed at all (τ > 0). */
export interface RegressionExample {
  label: string;
  x: number;
  tau?: number;
  /** The country that imposes the tariff (the USA): X = 0 by definition, and it is not in the regression sample. */
  imposer?: boolean;
}

/** Network units span closeness (~0.01) to weighted degree (thousands): keep about three significant figures. */
export function networkDigits(size: number): number {
  return size >= 100 ? 0 : size >= 10 ? 1 : size >= 1 ? 2 : size >= 0.1 ? 3 : size >= 0.01 ? 4 : 5;
}

/** Y change implied by the estimate for an example's X, in the step's display units. */
export function exampleEffect(outcome: RegressionOutcome, coef: number, x: number, design?: { depvar_kind?: string } | null): string {
  const change = coef * x;
  const kind = depvarKind(outcome, design);
  // A change that rounds to zero at the shown precision says so instead of printing "0.0000".
  const sized = (size: number, digits: number, unit: string) =>
    size > 0 && size < 0.5 * 10 ** -digits ? `不到 ${(10 ** -digits).toFixed(digits)} ${unit}` : `${size.toFixed(digits)} ${unit}`;
  if (kind === "share") return sized(Math.abs(change * 100), 2, "个百分点");
  if (kind === "length") return sized(Math.abs(change), 3, "个长度单位");
  if (kind === "position") return sized(Math.abs(change), 4, "个位置指数单位");
  const size = Math.abs(change);
  return sized(size, networkDigits(size), "个中心性原始单位");
}

const BADGE_COLORS = { negative: NEGATIVE, positive: POSITIVE, insufficient: UNCERTAIN, suppressed: UNCERTAIN } as const;

/**
 * The selected Y's reading, under the bar chart: one headline, a 方向明确／方向不确定 badge with the interval in
 * words, then three one-liners (the step 10 example, what not to claim, the generated-data note).
 */
export function RegressionResultCard({ outcome, response, examples = [], exampleSaved = true, exampleYear }: {
  outcome: RegressionOutcome;
  response: RegressionResponse;
  examples?: RegressionExample[];
  /** False when step 10 has not saved an example yet: the conversion uses the default example. */
  exampleSaved?: boolean;
  /** The year whose X the conversion uses (the last year of the data). */
  exampleYear?: number;
}) {
  const verdict = buildRegressionVerdict(outcome, response);
  const lesson = lessonFor(outcome, response.design.baseline, response.design.baseline_label);
  const suppressed = verdict.state === "suppressed";
  const kind = depvarKind(outcome, response.design);
  const words = differenceWords(kind);
  const directional = verdict.state === "negative" || verdict.state === "positive";
  // An association across country×industry records, not a change over time: "X 每高 1 个百分点的国家×行业，
  // 外国增加值项占比平均低 0.55 个百分点". Once the word says the direction, the number drops its sign (the
  // parenthetical sizes are unsigned already, as in the report). With an interval that includes 0 (or none
  // shown) the sign is not settled, so the signed estimate is given without 高/低.
  const unsignedEffect = verdict.effect.replace(/^[+−-]/, "");
  const plainResult = directional
    ? `平均${verdict.state === "negative" ? words.lower : words.higher} ${unsignedEffect}`
    : `平均相差 ${verdict.effect}，但高低方向不确定`;
  // "外国增加值项占比平均低", but "GVC 位置指数 平均…" keeps a space after a Latin name.
  const metricGap = /[A-Za-z]$/.test(lesson.shortMetric) ? " " : "";
  const badgeColor = BADGE_COLORS[verdict.state];
  return (
    <section className={`verdict-card verdict-${verdict.state}`} aria-labelledby="reg-result-title">
      <h3 id="reg-result-title" tabIndex={-1} className="reg-plain-verdict">
        {verdict.coefficient
          ? <span className="reg-headline-main">关税暴露 X 每高 1 个百分点的国家×行业，{lesson.shortMetric}{metricGap}<b>{plainResult}</b></span>
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
      <ul className="reg-result-points">
        {!suppressed && verdict.coefficient && examples.length > 0 && (() => {
          // Only an example with X > 0 has a conversion, and only that conversion carries the interval's open
          // direction. When no example has one, "X = 0, nothing to convert" is said once, after the list.
          const converted = examples.filter((example) => !example.imposer && example.x > 0);
          const lastConverted = converted.at(-1);
          const noConversion = converted.length === 0;
          const unexposedTaxed = examples.some((example) => !example.imposer && example.x <= 0 && (example.tau ?? 0) > 0);
          const zeroNote = noConversion ? "" : "，X = 0，按估计没有与 X 相关的差异";
          return <li className="reg-example-effect">{exampleSaved ? "按你在步骤 10 选的例子" : "按默认例子（步骤 10 还没有保存你的例子）"}换算{exampleYear ? `（用 ${exampleYear} 年的 X）` : ""}：{examples.map((example, index) => {
            const coef = verdict.coefficient!.coef;
            // An association, not a tariff effect: the difference in Y that goes with the example's X. With X = 0
            // the estimate implies no X-related difference (Y still moves with the shared yearly changes).
            const text = example.imposer
              ? <>{example.label} 属于加征关税的一方，按设计不在回归样本中，X 记为 0 只是定义，不做换算</>
              : example.x > 0
              ? (() => {
                const effect = exampleEffect(outcome, coef, example.x, response.design);
                const lower = coef * example.x < 0;
                const tiny = effect.startsWith("不到");
                // "与 X 相关的差异约为 -12.83 个百分点（Y 偏低）"; below the shown precision it reads "不到 0.01 个百分点".
                // With an interval that includes 0 the sign is not settled, so 偏低/偏高 is left out and the open
                // direction is said once, after the last conversion.
                return <>{example.label} 的 X 为 {percentagePoints(example.x)} 个百分点，按估计与 X 相关的差异{tiny ? "" : "约为 "}<b>{tiny ? effect : `${lower ? "-" : "+"}${effect}`}</b>{directional ? `（Y 偏${lower ? words.lower : words.higher}）` : ""}{verdict.state === "insufficient" && example === lastConverted ? "，但区间包含 0，差异的高低方向并不确定" : ""}</>;
              })()
              : (example.tau ?? 0) > 0
                ? <>{example.label} 被加税但首年不向美国出口（w = 0）{zeroNote}</>
                : <>{example.label} 未被加税{zeroNote}</>;
            return <span key={example.label}>{index ? "；" : ""}{text}</span>;
          })}。
            {noConversion && `${examples.length === 1 ? "这个例子的 X = 0" : "两个例子的 X 都是 0"}，换算不出与 X 相关的差异。想看换算，回步骤 10 ${unexposedTaxed
              ? "换一个向美国出口的加税国家或行业（如加拿大的汽车行业）"
              : examples.length === 1 ? "换成加税的国家（如加拿大），或再选一个加税的对比国家" : "选一个加税的国家（如加拿大）"}。`}</li>;
        })()}
        <li className="reg-caveat"><b>解释限制</b> {lesson.dontClaim}</li>
        <li className="muted reg-data-note">{GENERATED_DATA_NOTE}</li>
      </ul>
      {verdict.warnings.length > 0 && (!suppressed || !verdict.coefficient) && (
        <ul aria-label="本次计算的限制">{verdict.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      )}
    </section>
  );
}

/** Column names in the coefficient table, as the page names them (the code stays in the report appendix). */
const COEFFICIENT_NAMES: Record<string, string> = { teaching_tariff_exposure: "关税暴露 X" };

/**
 * The raw coefficients, with their scale said in the header: X is stored as a share (0.01 = 1 percentage
 * point), so a coefficient is "Y per 1.00 of X". The column next to it repeats the page's reading, "Y per
 * 1 percentage point of X", so the two numbers can be matched (for lengths and centrality they differ 100×).
 */
export function RegressionCoefficientTable({ response }: { response: RegressionResponse }) {
  const outcome = response.design.outcome;
  const display = chartDisplayScale(outcome, response.design);
  return (
    <ScrollableRegion className="table-wrap" label="完整回归系数表，可横向滚动">
      <table className="data-table">
        <thead><tr>
          <th>变量</th>
          <th>X 每高 1 个百分点，Y 平均相差（{display.unit}）</th>
          <th>系数（X 按份额计）</th>
          <th>95% 区间（按系数计）</th>
          <th>标准误（按国家计算）</th>
          <th>t 值</th>
          <th>p 值</th>
        </tr></thead>
        <tbody>{response.result.coefs.map((coef) => {
          const globallySuppressed = globalInferenceIsSuppressed(
            response.result.status, response.result.support,
          );
          const inferenceAllowed = !globallySuppressed;
          const ciLow = inferenceAllowed ? coef.ci_low : null;
          const ciHigh = inferenceAllowed ? coef.ci_high : null;
          const p = inferenceAllowed ? coef.p : null;
          return (
            <tr key={coef.name}>
              <td>{COEFFICIENT_NAMES[coef.name] ?? coef.name}</td>
              <td>{coef.name === response.design.shock_col ? teachingEffect(outcome, coef.coef, response.design) : "—"}</td>
              <td>{coef.coef.toFixed(4)}</td>
              <td>{ciLow != null && ciHigh != null ? `[${ciLow.toFixed(4)}, ${ciHigh.toFixed(4)}]` : "—"}</td>
              {/* With inference suppressed, SE and t are not read either (the backend keeps them for integrity checks). */}
              <td>{inferenceAllowed && coef.se != null ? coef.se.toFixed(4) : "—"}</td><td>{inferenceAllowed && coef.t != null ? coef.t.toFixed(2) : "—"}</td><td>{formatPValue(p)}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </ScrollableRegion>
  );
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
    coef: item.coef, ci_low: item.ci_low, ci_high: item.ci_high, depvar_std: item.depvar_std,
    suppressed: globalInferenceIsSuppressed(item.status, { status: item.status as RegressionStatus, suppress_inference: item.suppress_inference }),
  };
}

/** A run's estimate of its X as a bar estimate (the saved or just computed run of the selected Y). */
export function runEstimate(response: Pick<RegressionResponse, "design" | "result" | "model_snapshot">): BarEstimate {
  const expected = response.model_snapshot?.x_columns ?? [response.design.shock_col];
  const coefficient = response.result.coefs.find((item) => expected.includes(item.name)) ?? null;
  return {
    coef: coefficient?.coef ?? null, ci_low: coefficient?.ci_low ?? null, ci_high: coefficient?.ci_high ?? null,
    depvar_std: response.result.depvar_std ?? null,
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
  const rows = items.map((item): DivergingBarRow => {
    const kind = kindOf(item.kind, outcome);
    const isSelected = item.key === selectedKey;
    const figures = barFigures(isSelected && selected ? runEstimate(selected) : overviewEstimate(item), kind, unit);
    const suppressed = isSelected && selected ? runEstimate(selected).suppressed : overviewEstimate(item).suppressed;
    return {
      key: item.key,
      label: displayBaselineLabel(item.label),
      sublabel: unit === "sd" ? countUnit(kind).replace(/^个/, "") : undefined,
      ...figures,
      selected: isSelected,
      note: suppressed ? "这次的数据不够判断方向，不显示 95% 区间" : undefined,
    };
  });
  return { rows, unitTitle: BAR_UNIT_TITLES[unit] };
}

/** Step 12's four forward shares add up to 100% of value added, so their four estimates add up to about 0. */
const FORWARD_SHARES = ["1_VA_D_share", "2_VA_RT_share", "3a_VA_GVC_S_share", "3b_VA_GVC_C_share"];

export function forwardShareIdentity(items: TeachingEstimate[]): string | null {
  const coefs = FORWARD_SHARES.map((key) => items.find((item) => item.key === key)?.coef);
  if (coefs.some((coef) => coef == null || !Number.isFinite(coef))) return null;
  const sum = (coefs as number[]).reduce((total, coef) => total + coef, 0);
  return `纯国内、传统贸易、简单 GVC、复杂 GVC 四项份额合计 100%，所以这四条相加约为 0（${Math.abs(sum) < 0.005 ? "0.00" : signed(sum, 2)}）。`;
}

/**
 * One regression step (11–14). Each step is self-contained: it reads only its own saved run. One button runs the
 * step's default Y and draws a bar for every Y of the family; clicking a bar runs that Y, which becomes the
 * headline and the saved report material.
 */
export function RegressionRunLab({ step, meta, state, getStep }: {
  step: Step;
  meta: Pick<Meta, "countries" | "sectors">;
  state: StepStateApi<RegressionStepState>;
  /** Read-only: the example the student chose in step 10. */
  getStep?: <T>(step: number) => T | undefined;
}) {
  const outcome = step.regression_outcome;
  // The button names the step's regression ("计算贸易流回归"), as the step title does.
  const runName = step.title.split("：")[0] || "回归";
  if (!outcome) return <div className="error-box">当前回归步骤缺少 regression_outcome 配置。</div>;
  const [result, setResult] = useState<RegressionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [replacedAfterSubmit, setReplacedAfterSubmit] = useState(false);
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
  const groups = groupsQuery.status === "success" ? groupsQuery.data : null;
  const baselineOptions = groups?.baselines?.[outcome] ?? [];
  const defaultKey = baselineOptions.find((option) => option.default)?.key ?? DEFAULT_BASELINES[outcome];

  // After the run: the estimate converted to the example(s) followed from step 10 (one country or two).
  const stepTen = getStep?.<TeachingExampleSelection & { teaching_observation?: unknown }>(10);
  const example = teachingExample(meta, stepTen);
  const exampleSaved = Boolean(stepTen?.teaching_observation);
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
      const label = `${countryLabel(country)}·${sectorLabel(example.industry)}`;
      if (country === TARIFF_IMPOSER) return [{ label, x: 0, imposer: true }];
      return row ? [{ label, x: row.teaching_tariff_exposure, tau: row.teaching_tariff_rate_tau }] : [];
    })
    : [];

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runController.current?.abort();
    };
  }, []);

  // 会话异步到达：刷新或换设备后恢复本步上次算出的结果（也就是报告材料里的那个 Y），而不是空白面板。
  const savedRun = state.data?.run;
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
      // A bar click keeps keyboard focus on the bars; only the button moves on to the answer.
      scrollToVerdictAfterRun.current = fromButton;
      // After the report was submitted, this run has already replaced the saved material: the notice says so.
      if (state.materialLocked) setReplacedAfterSubmit(true);
      setResult(response);
    } catch (cause) {
      if (mountedRef.current) {
        setError(userFacingRequestError(cause, `${runName}没有算完`));
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

  const bars = result && overviewItems.length > 0 ? familyBarRows(outcome, overviewItems, selectedKey, result) : null;
  const identity = outcome === "production" && bars ? forwardShareIdentity(overviewItems) : null;
  const latinGap = /^[A-Za-z]/.test(lesson.shortMetric) ? " " : "";

  return (
    <div className="reg-workbench">
      <section className="reg-run-card">
        <h3>{lessonQuestion(outcome, selectedKey)}</h3>
        {staleSavedY && (
          <p className="reg-boundary" role="status">上次算的 Y（{displayBaselineLabel(savedRun?.design?.baseline_label) || "—"}）在当前课程数据里没有，已换回本步默认指标，请重新计算。</p>
        )}
        {/* Said before the run (the result card repeats it), so the Y is never read as OECD data first. */}
        {!result && <p className="muted reg-data-note reg-data-note-before" role="note">{GENERATED_DATA_NOTE}</p>}
        {/* Once a result exists, recalculating is a secondary action; it replaces saved material. */}
        <button
          className={result && !error ? "run-btn secondary" : "run-btn"}
          onClick={() => { if (!running && retryWait === 0) void run(result ? selectedKey : null, true); }}
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
        {!running && savedRun && state.materialLocked && (
          <p className="reg-rerun-warning" role="note">
            <b>报告已提交</b>{replacedAfterSubmit
              ? "报告材料里保存的结果已换成这次算出的结果；请到步骤 15 更新报告，并重新提交给老师。"
              : "重新计算或点另一条，会替换报告材料里保存的结果；之后要到步骤 15 更新报告，并重新提交给老师。"}
          </p>
        )}
        {groups && (() => {
          const series = selectedKey === defaultKey ? groups.outcomes[outcome] : groups.series?.[outcome]?.[selectedKey];
          if (!series) return null;
          const kind = result ? depvarKind(outcome, result.design) : kindOf(selectedOption?.kind ?? "", outcome);
          const display = chartDisplayScale(outcome, { depvar_kind: kind });
          // display.scale converts β to "per 1 percentage point of X"; the chart shows Y levels, which need ×100
          // for shares (percentage points) and ×1 for lengths and centrality.
          const levelScale = display.scale * 100;
          const coefficient = result ? runEstimate(result) : null;
          const gap = coefficient?.coef != null && groups.mean_exposure_taxed != null && !coefficient.suppressed
            ? coefficient.coef * groups.mean_exposure_taxed : null;
          // Network Y ranges from closeness (~0.01) to weighted degree (thousands), so its decimals follow the gap.
          const digits = kind === "network" ? networkDigits(Math.abs((gap ?? 0) * levelScale)) : kind === "position" ? 4 : kind === "length" ? 3 : 2;
          const shown = (gap ?? 0) * levelScale;
          // The weak Y's interval includes 0: the gap's sign is not settled, as the verdict says.
          const uncertain = coefficient?.ci_low != null && coefficient.ci_high != null && coefficient.ci_low <= 0 && coefficient.ci_high >= 0;
          return (
            <div className="reg-group-figure">
              <GroupChangeChart
                years={groups.years}
                policyYear={groups.policy_year}
                taxed={series.taxed}
                untaxed={series.untaxed}
                scale={levelScale}
                unit={display.unit ?? lesson.unit}
                title={`加税前后：两组${latinGap}${lesson.shortMetric}的平均变化`}
                estimate={gap == null ? null : { gap, label: `回归估计的差距 ${shown > 0 ? "+" : ""}${shown.toFixed(digits)} ${countUnit(kind)}`, uncertain }}
              />
            </div>
          );
        })()}
        {groupsQuery.status === "error" && groupsQuery.error && (
          <RegressionRequestError label="分组对比图" error={groupsQuery.error} onRetry={groupsQuery.retry} />
        )}
      </section>

      {/* One action: the run button above doubles as the retry (it shows the wait after "too many requests"). */}
      {error && <div className="error-box async-error" role="alert"><span>{error}</span></div>}

      {result && (
        <div className={error ? "reg-results reg-results-stale" : "reg-results"}>
          {error && <p className="reg-stale-note" role="note">这次计算没有成功；下面仍是上次保存的结果。</p>}
          <div ref={verdictAnchorRef} className="verdict-anchor">
            {bars ? (
              <div className="reg-family-bars">
                <DivergingBarChart
                  rows={bars.rows}
                  unitTitle={bars.unitTitle}
                  title={`本类 ${bars.rows.length} 个 Y · 点一条，换成它并保存`}
                  onSelect={(key) => { if (key !== selectedKey) void run(key, false); }}
                  disabled={running}
                />
                {identity && <p className="muted reg-identity-note">{identity}</p>}
              </div>
            ) : overviewQuery.status === "error" && overviewQuery.error
              ? <RegressionRequestError label="条形图" error={overviewQuery.error} onRetry={overviewQuery.retry} />
              : overviewQuery.status === "loading" && <div className="reg-request-state muted" role="status" aria-busy="true">正在画本类各个 Y 的条形图…</div>}
            <RegressionResultCard outcome={outcome} response={result} examples={examples} exampleSaved={exampleSaved} exampleYear={lastYear} />
          </div>
          <details className="technical-details">
            <summary>模型设定</summary>
            <DesignEquation design={result.design} />
          </details>
          <details className="technical-details">
            <summary>详细数字（可选）</summary>
            <RegressionCoefficientTable response={result} />
            {/* Only when the table actually shows one (the table hides p when inference is suppressed). */}
            {!globalInferenceIsSuppressed(result.result.status, result.result.support)
              && result.result.coefs.some((coef) => formatPValue(coef.p) === "<0.0001")
              && <p className="muted">很小的 p 值显示为 &lt;0.0001，不是说概率为零。</p>}
            <p className="muted">表里的“系数”按 X 以份额计：X 每高 1（即 100 个百分点），Y 平均相差多少。{depvarKind(outcome, result.design) === "share"
              ? "这一步的 Y 是份额，页面也按百分点读，X 和 Y 都换成百分点后倍数正好抵消：两列是同一个数，左列按页面精度四舍五入。"
              : "除以 100，就是页面上“X 每高 1 个百分点”时的数。"}</p>
            <p className="muted">共 {result.result.n_obs.toLocaleString("zh-CN")} 条记录 = {result.result.n_entities.toLocaleString("zh-CN")} 个国家×行业 × {result.result.n_times} 年；95% 区间按 {result.result.n_clusters} 个国家计算；{result.result.r2_within == null ? "这次结果没有组内 R²" : `组内 R² = ${result.result.r2_within.toFixed(3)}（扣掉各国家×行业的平均水平和每年共同变化后，模型能解释的那部分变动所占比例）`}。</p>
          </details>
        </div>
      )}
    </div>
  );
}
