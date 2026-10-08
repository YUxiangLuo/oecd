import { useEffect, useRef, useState } from "react";
import { ScrollableRegion } from "./a11y";
import { scrollIntoCourseContent } from "./content-scroll";
import { api, ApiError } from "./api";
import { percentagePoints } from "./format";
import { useAsync } from "./labs";
import { ReadingCards } from "./labs/steps/viz/reading-cards";
import { baselineKeyOf, displayBaselineLabel, GENERATED_DATA_NOTE, lessonFor, lessonQuestion, VIZ_STEPS } from "./regression-lessons";
import { nextRegressionSave } from "./regression-save";
import { formatPValue } from "./regression-statistics";
import {
  buildRegressionVerdict,
  differenceWords,
  INTERVAL_FIRST_MENTION,
  teachingEffect,
  chartDisplayScale,
  countUnit,
  depvarKind,
  globalInferenceIsSuppressed,
} from "./regression-verdict";
import { splitPolicyCoefficients } from "./regteach";
import type {
  Meta,
  QuizCompletionState,
  RegressionDesignInfo,
  RegressionOutcome,
  RegressionResponse,
  Step,
  StepStateApi,
  TeachingGroupsResponse,
  TeachingPanelResponse,
} from "./types";
import { TARIFF_IMPOSER, teachingExample, type TeachingExampleSelection } from "./teaching-example";
import { userFacingRequestError } from "./user-facing-error";
import { BinScatterChart, CoefForestChart, countryLabel, GroupChangeChart, sectorLabel } from "./viz";

const ENTITY_LABEL: Record<string, string> = { entity_id: "国家×行业", country: "国家" };
export const TEACHING_MODEL_VERSION = "step10-tariff-teaching-v6";

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
        <li><b>β·X</b>：X 是关税暴露（首年对美出口份额 w × 加征税率 τ）；β 就是要算的估计值：X 每增加 1 个百分点，Y 平均变化多少。</li>
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
  return `${size.toFixed(networkDigits(size))} 个中心性原始单位`;
}

/** The result is a coefficient plot plus short sentences: what changed, for the student's example, how sure, what not to claim. */
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
  const display = chartDisplayScale(outcome, response.design);
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
  return (
    <section className={`verdict-card verdict-${verdict.state}`} aria-labelledby="reg-result-title">
      <div className="verdict-kicker">回归结果</div>
      {/* The headline answers the step's question with the number; the direction reading follows as a sub-line. */}
      <h3 id="reg-result-title" tabIndex={-1} className="reg-plain-verdict">
        {verdict.coefficient
          ? <>
            <span className="reg-headline-main">关税暴露 X 每高 1 个百分点的国家×行业，{lesson.shortMetric}{metricGap}<b>{plainResult}</b></span>
            <span className="reg-headline-interval">{suppressed ? "这次不显示 95% 区间" : `${INTERVAL_FIRST_MENTION}：${verdict.intervalShort}`}</span>
          </>
          : "没算出 X 的估计值"}
      </h3>
      {verdict.coefficient && <p className="reg-verdict-direction">{verdict.title}</p>}
      <p className="muted reg-data-note" role="note">{GENERATED_DATA_NOTE}</p>
      {verdict.coefficient && response.result.binscatter && response.result.binscatter.bins.length >= 2 && (
        <BinScatterChart
          bins={response.result.binscatter.bins}
          slope={response.result.binscatter.slope * display.scale}
          slopeUnit={countUnit(kind)}
          slopeWords={directional ? words : undefined}
          xLabel="X 扣掉平均水平后的高低（个百分点）"
          yLabel={`${lesson.shortMetric}（${display.unit}）`}
          xScale={100}
          yScale={display.scale * 100}
          title="回归在量什么：X 越大，Y 平均怎样变"
        />
      )}
      {verdict.coefficient && (
        <CoefForestChart
          coefs={splitPolicyCoefficients(response).policy}
          globalStatus={response.result.status}
          globalSupport={response.result.support}
          scale={display.scale}
          unit={display.unit}
          labels={{ teaching_tariff_exposure: lesson.shortMetric }}
          title="X 每高 1 个百分点，Y 平均相差多少"
        />
      )}
      <ul className="reg-result-points">
        <li>{verdict.evidence}</li>
        {!suppressed && verdict.coefficient && examples.length > 0 && (
          <li className="reg-example-effect">{exampleSaved ? "按你在步骤 10 选的例子" : "按默认例子（步骤 10 还没有保存你的例子）"}换算{exampleYear ? `（用 ${exampleYear} 年的 X）` : ""}：{examples.map((example, index) => {
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
                // With an interval that includes 0 the sign is not settled, so 偏低/偏高 is left out.
                return <>{example.label} 的 X 为 {percentagePoints(example.x)} 个百分点，按估计与 X 相关的差异{tiny ? "" : "约为 "}<b>{tiny ? effect : `${lower ? "-" : "+"}${effect}`}</b>{directional ? `（Y 偏${lower ? words.lower : words.higher}）` : ""}</>;
              })()
              : (example.tau ?? 0) > 0
                ? <>{example.label} 被加税但首年不向美国出口（w = 0），X = 0，按估计没有与 X 相关的差异</>
                : <>{example.label} 未被加税，X = 0，按估计没有与 X 相关的差异</>;
            return <span key={example.label}>{index ? "；" : ""}{text}</span>;
          })}{verdict.state === "insufficient" ? "；但区间包含 0，差异的高低方向并不确定" : ""}。
            {examples.every((example) => example.x <= 0 && !((example.tau ?? 0) > 0)) && (examples.length === 1
              ? "你选的例子 X = 0，换算不出与 X 相关的差异。想看换算，回步骤 10 换成加税的国家（如加拿大），或再选一个加税的对比国家。"
              : "两个例子的 X 都是 0，换算不出与 X 相关的差异。想看换算，回步骤 10 选一个加税的国家（如加拿大）。")}</li>
        )}
      </ul>
      {verdict.warnings.length > 0 && (!suppressed || !verdict.coefficient) && (
        <ul aria-label="本次计算的限制">{verdict.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      )}
      <p className="reg-caveat" role="note"><b>解释限制</b>{lesson.dontClaim}</p>
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


export function RegressionRequestLoading({ designLoading }: {
  designLoading: boolean;
}) {
  if (!designLoading) return null;
  return <div className="reg-request-state muted" role="status" aria-live="polite" aria-busy="true">正在准备公式…</div>;
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

/**
 * One regression step (11–14). Each step is self-contained: it reads only its own saved run,
 * never another step's state, and shows one chart with a short reading after the run.
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
  // Which same-family indicator calibrates Y: null is the step's fixed default. It starts from the saved
  // run (so a refresh shows the Y the student last ran) until the student picks another one.
  const [baseline, setBaseline] = useState<string | null>(null);
  const baselineChosen = useRef(false);
  const [baselineNotice, setBaselineNotice] = useState<string | null>(null);
  const [result, setResult] = useState<RegressionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [replacedAfterSubmit, setReplacedAfterSubmit] = useState(false);
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
  const runButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const runController = useRef<AbortController | null>(null);
  const verdictAnchorRef = useRef<HTMLDivElement>(null);
  const scrollToVerdictAfterRun = useRef(false);

  const designRequestKey = `regression-design:${outcome}:${baseline ?? "default"}`;
  const designQuery = useAsync<RegressionDesignInfo>(
    () => api.regressionDesign(outcome, baseline),
    [designRequestKey],
    { requestKey: designRequestKey },
  );
  const design = designQuery.status === "success" ? designQuery.data : null;

  // Before the run: the taxed vs untaxed comparison that the regression then quantifies.
  const groupsQuery = useAsync<TeachingGroupsResponse>(() => api.teachingGroups(), ["teaching-groups"]);
  const groups = groupsQuery.status === "success" ? groupsQuery.data : null;
  const baselineOptions = groups?.baselines?.[outcome] ?? [];
  const defaultBaseline = baselineOptions.find((option) => option.default)?.key ?? null;
  const lesson = lessonFor(outcome, baseline, baselineOptions.find((option) => option.key === baseline)?.label);
  const usesDefault = baseline == null || baseline === defaultBaseline;
  // A saved baseline the current release does not offer falls back to the fixed Y, with a note.
  const baselineOffered = baseline == null || baselineOptions.length === 0 || baselineOptions.some((option) => option.key === baseline);
  useEffect(() => {
    if (baselineOffered) return;
    setBaselineNotice(`上次算的 Y（${displayBaselineLabel(savedRun?.design?.baseline_label) || lesson.shortMetric}）在当前课程数据里没有，已换回本步默认指标，请重新计算。`);
    setBaseline(null);
    setResult(null);
  }, [baselineOffered]);
  const groupSeries = usesDefault ? groups?.outcomes[outcome] : groups?.series?.[outcome]?.[baseline];

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

  // 会话异步到达：刷新或换设备后恢复本步上次算出的结果，而不是空白面板。
  const savedRun = state.data?.run;
  const savedRunIdentity = savedRun ? regressionRunSnapshotIdentity(savedRun) : null;
  const savedBaseline = savedRun?.design?.baseline ?? null;
  useEffect(() => {
    if (baselineChosen.current || savedRun?.model_snapshot?.version !== TEACHING_MODEL_VERSION || !savedBaseline) return;
    setBaseline((current) => current ?? savedBaseline);
  }, [savedBaseline, savedRunIdentity]);
  // Without a saved run, Y starts as the indicator the student recorded in the matching step 6-9, when
  // this family offers it; so steps 11-14 follow steps 6-9 one to one.
  const priorData = getStep?.<{ metric?: string; indicator_selection?: { metric?: string } }>(VIZ_STEPS[outcome]);
  const priorKey = baselineKeyOf(priorData?.indicator_selection?.metric ?? priorData?.metric);
  useEffect(() => {
    if (baselineChosen.current || savedRun || !priorKey || !baselineOptions.length) return;
    if (baselineOptions.some((option) => option.key === priorKey)) setBaseline((current) => current ?? (priorKey === defaultBaseline ? null : priorKey));
  }, [priorKey, baselineOptions.length, defaultBaseline, savedRunIdentity]);
  useEffect(() => {
    if (
      running || runningRef.current || result
      || savedRun?.model_snapshot?.version !== TEACHING_MODEL_VERSION
      || !savedRun.variable_catalog
      || (savedBaseline ?? defaultBaseline) !== (baseline ?? defaultBaseline)
    ) return;
    setResult(savedRegressionResponse(savedRun));
  }, [result, running, savedRunIdentity, baseline, defaultBaseline]);

  // The Y of the run the report uses, so switching Y without running again says so (the card would just vanish).
  const savedRunY = savedRun?.model_snapshot?.version === TEACHING_MODEL_VERSION
    ? (() => {
      const key = savedBaseline ?? defaultBaseline;
      const label = savedRun.design?.baseline_label ?? baselineOptions.find((option) => option.key === key)?.label ?? lessonFor(outcome, null).shortMetric;
      return { key, label };
    })()
    : null;

  const run = async () => {
    if (runningRef.current || !design) return;
    runningRef.current = true;
    const controller = new AbortController();
    runController.current = controller;
    setRunning(true);
    setError(null);
    try {
      const response = await api.runRegression(outcome, controller.signal, baseline);
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
      scrollToVerdictAfterRun.current = true;
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

  // 只在学生点运行之后滚到结论；会话恢复不滚动。
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

  return (
    <div className="reg-workbench">
      <section className="reg-run-card">
        <span className="reg-section-step">本步回归（模型固定，只换 Y）</span>
        <h3>{lessonQuestion(outcome, baseline)}</h3>
        {/* The step title names the default Y; a student who switched Y sees that here, with a way back. */}
        {!usesDefault && baselineOptions.length > 1 && (
          <p className="reg-y-pill" role="status">
            <span>当前 Y：{displayBaselineLabel(baselineOptions.find((option) => option.key === baseline)?.label) || lesson.shortMetric}（不是本步默认）</span>
            <button type="button" className="link-button" disabled={running} onClick={() => {
              baselineChosen.current = true;
              setBaselineNotice(null);
              setBaseline(null);
              setResult(null);
              setError(null);
            }}>恢复默认（{displayBaselineLabel(baselineOptions.find((option) => option.default)?.label) || lessonFor(outcome, null).shortMetric}）</button>
          </p>
        )}
        {outcome !== "trade" && <p className="muted">方法与步骤 11 相同，这次 Y 换成{/^[A-Za-z]/.test(lesson.shortMetric) ? " " : ""}{lesson.shortMetric}。</p>}
        <p className="reg-step-focus"><b>本步重点</b> · {lesson.learnThis}</p>
        {/* Said before the run as well (the result card repeats it), so the Y is never read as OECD data first. */}
        {!result && <p className="muted reg-data-note reg-data-note-before" role="note">{GENERATED_DATA_NOTE}</p>}
        {depvarKind(outcome, design) === "network" && (
          <p className="muted" role="note">这里的 Y 是按真实网络指标的排名校准生成的教学数据，单位是“中心性原始单位”，不是步骤 5、9 的百万美元，不能和那两步的数值直接比较。</p>
        )}
        {baselineNotice && <p className="reg-boundary" role="status">{baselineNotice}</p>}
        {baselineOptions.length > 1 && (
          <div className="reg-baseline-select">
            <label className="model-control"><span className="model-control-label">结果指标 Y</span>
              <select
                aria-label="结果指标 Y"
                value={baseline ?? defaultBaseline ?? ""}
                disabled={running}
                onChange={(event) => {
                  baselineChosen.current = true;
                  setBaselineNotice(null);
                  const next = event.target.value;
                  setBaseline(next === defaultBaseline ? null : next);
                  setResult(null);
                  setError(null);
                }}
              >
                {baselineOptions.map((option) => (
                  <option key={option.key} value={option.key}>{displayBaselineLabel(option.label)}{option.default ? "（本步默认）" : ""}</option>
                ))}
              </select>
            </label>
            <span className="muted">只能换成同一类的另一个指标；X、样本和模型都不变。</span>
          </div>
        )}
        {groups && groupSeries && (() => {
          const display = chartDisplayScale(outcome, design);
          // display.scale converts β to "per 1 percentage point of X"; the chart and the cards show Y levels,
          // which need ×100 for shares (percentage points) and ×1 for lengths and centrality.
          const levelScale = display.scale * 100;
          const change = (series: { year: number; change: number }[], year: number) => series.find((point) => point.year === year)?.change ?? null;
          const preYears = groups.years.filter((year) => year < groups.policy_year);
          const lastYear = groups.years.at(-1)!;
          const gapAt = (year: number) => {
            const a = change(groupSeries.taxed, year), b = change(groupSeries.untaxed, year);
            return a == null || b == null ? null : (a - b) * levelScale;
          };
          const preGaps = preYears.map(gapAt).filter((value): value is number => value != null);
          const preGap = preGaps.length ? preGaps.reduce((sum, value) => sum + value, 0) / preGaps.length : null;
          const postGap = gapAt(lastYear);
          const coefficient = result?.result.coefs[0]?.coef;
          const estimate0 = coefficient != null && groups.mean_exposure_taxed != null ? coefficient * groups.mean_exposure_taxed : null;
          const kind = depvarKind(outcome, design);
          // Network Y ranges from closeness (~0.01) to weighted degree (thousands), so its decimals follow
          // the largest gap shown; a fixed 0 decimals printed closeness gaps as "0".
          const shown = [preGap, postGap, estimate0 == null ? null : estimate0 * levelScale].filter((value): value is number => value != null && Number.isFinite(value));
          const digits = kind === "network" ? networkDigits(Math.max(0, ...shown.map(Math.abs))) : kind === "position" ? 4 : kind === "length" ? 3 : 2;
          const tiny = 0.5 * 10 ** -digits;
          const fmt = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(digits)} ${countUnit(kind)}`;
          const estimate = result && coefficient != null && groups.mean_exposure_taxed != null && !globalInferenceIsSuppressed(result.result.status, result.result.support)
            ? { gap: coefficient * groups.mean_exposure_taxed, label: `回归估计的差距 ${fmt(coefficient * groups.mean_exposure_taxed * levelScale)}` }
            : null;
          // The weak Y's interval includes 0: the gap's sign is not settled, as the verdict above says.
          const coefStat = result?.result.coefs[0];
          const estimateUncertain = coefStat?.ci_low != null && coefStat.ci_high != null && coefStat.ci_low <= 0 && coefStat.ci_high >= 0;
          return <div className="reg-group-figure">
            <GroupChangeChart
              years={groups.years}
              policyYear={groups.policy_year}
              taxed={groupSeries.taxed}
              untaxed={groupSeries.untaxed}
              scale={levelScale}
              unit={display.unit ?? lesson.unit}
              title={`加税前后：两组${/^[A-Za-z]/.test(lesson.shortMetric) ? " " : ""}${lesson.shortMetric}的平均变化`}
              estimate={estimate}
            />
            <ReadingCards label="两组读图" cards={[
              { eyebrow: `加税前（${groups.years[0]}–${groups.policy_year - 1}）`, big: preGap == null ? "缺失" : Math.abs(preGap) < tiny ? "两组差不多" : `两组相差 ${fmt(preGap)}`, small: "每条线都减去了本组加税前的平均水平，所以起点都接近 0" },
              { eyebrow: `加税后（${lastYear}）`, big: postGap == null ? "缺失" : Math.abs(postGap) < tiny ? "两组差不多" : `加税组比未加税组${postGap < 0 ? "低" : "高"} ${fmt(Math.abs(postGap)).replace(/^\+/, "")}`, small: `${groups.sample.taxed_countries} 国加税、${groups.sample.untaxed_countries} 国未加税的平均值` },
              {
                eyebrow: "回归要算的",
                big: estimate ? `估计的差距 ${fmt(estimate.gap * levelScale)}${estimateUncertain ? "（方向不确定）" : ""}` : "两条线分开多远",
                small: estimate
                  ? "= 估计值 × 加税组的平均 X（图上虚线标出的那段）。左边是两组平均值直接相减；这里按每个国家×行业自己的 X 算，还扣掉了各自的平均水平和每年的共同变化，所以两个数接近但不相同。"
                  : "回归把这段距离换算成“X 每增加 1 个百分点，Y 平均变多少”",
              },
            ]} />
            {design && <div className="reg-equation"><span className="reg-section-step">公式</span><DesignEquation design={design} /></div>}
          </div>;
        })()}
        {groupsQuery.status === "error" && groupsQuery.error && (
          <RegressionRequestError label="分组对比图" error={groupsQuery.error} onRetry={groupsQuery.retry} />
        )}
        <RegressionRequestLoading designLoading={designQuery.status === "loading"} />
        {designQuery.status === "error" && designQuery.error && (
          <RegressionRequestError label="公式" error={designQuery.error} onRetry={designQuery.retry} />
        )}
        {/* Once a result exists, recalculating is a secondary action; it replaces saved material. */}
        <button
          ref={runButtonRef}
          className={result && !error ? "run-btn secondary" : "run-btn"}
          onClick={() => { if (!running && retryWait === 0) void run(); }}
          // aria-disabled while running keeps keyboard focus on the button instead of dropping it to the page.
          aria-disabled={running || retryWait > 0}
          disabled={designQuery.status !== "success" || !design}
        >
          {running ? "正在计算…"
            : retryWait > 0 ? `重试（${retryWait} 秒后）`
              : error ? `重试：计算${runName}`
                : result ? `重新计算${runName}`
                  : groups ? `计算${runName}（用全部 ${groups.sample.rows.toLocaleString("zh-CN")} 条记录）` : `计算${runName}`}
        </button>
        {/* Mounted before it has text, so screen readers announce the change. */}
        <span className={running ? "muted reg-inline-status" : "sr-only"} role="status" aria-live="polite">{running ? "正在计算…" : ""}</span>
        {!running && !baselineNotice && savedRunY && savedRunY.key !== (baseline ?? defaultBaseline) && (
          <p className="reg-boundary" role="status">
            报告材料里保存的仍是上次算出的 Y（{displayBaselineLabel(savedRunY.label)}）；点上面的“计算{runName}”后，才会换成{/^[A-Za-z]/.test(lesson.shortMetric) ? " " : ""}{lesson.shortMetric}。
          </p>
        )}
        {!running && savedRun && state.materialLocked && (
          <p className="reg-rerun-warning" role="note">
            <b>报告已提交</b>{replacedAfterSubmit
              ? "报告材料里保存的结果已换成这次算出的结果；请到步骤 15 更新报告，并重新提交给老师。"
              : "重新计算会替换报告材料里保存的结果；之后要到步骤 15 更新报告，并重新提交给老师。"}
          </p>
        )}
      </section>

      {/* One action: the run button above doubles as the retry (it shows the wait after "too many requests"). */}
      {error && <div className="error-box async-error" role="alert"><span>{error}</span></div>}

      {result && (
        <div className={error ? "reg-results reg-results-stale" : "reg-results"}>
          {error && <p className="reg-stale-note" role="note">这次计算没有成功；下面仍是上次保存的结果。</p>}
          <div ref={verdictAnchorRef} className="verdict-anchor">
            <RegressionResultCard outcome={outcome} response={result} examples={examples} exampleSaved={exampleSaved} exampleYear={lastYear} />
          </div>
          <details className="technical-details">
            <summary>详细数字（可选）</summary>
            <RegressionCoefficientTable response={result} />
            <p className="muted">很小的 p 值显示为 &lt;0.0001，不是说概率为零。</p>
            <p className="muted">表里的“系数”是 X 从 0 增加到 1（即 100 个百分点）时 Y 的变化。{depvarKind(outcome, result.design) === "share"
              ? "这一步的 Y 是份额，页面也按百分点读，X 和 Y 都换成百分点后倍数正好抵消，所以两列数字相同。"
              : "除以 100，就是页面上“X 每高 1 个百分点”时的数。"}</p>
            <p className="muted">共 {result.result.n_obs.toLocaleString("zh-CN")} 条记录 = {result.result.n_entities.toLocaleString("zh-CN")} 个国家×行业 × {result.result.n_times} 年；95% 区间按 {result.result.n_clusters} 个国家计算；{result.result.r2_within == null ? "这次结果没有组内 R²" : `组内 R² = ${result.result.r2_within.toFixed(3)}（扣掉各国家×行业的平均水平和每年共同变化后，模型能解释的那部分变动所占比例）`}。</p>
          </details>
        </div>
      )}
    </div>
  );
}
