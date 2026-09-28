import { useEffect, useRef, useState } from "react";
import { ScrollableRegion } from "./a11y";
import { api } from "./api";
import { useAsync } from "./labs";
import { lessonQuestion, REGRESSION_LESSONS } from "./regression-lessons";
import { nextRegressionSave } from "./regression-save";
import { CLUSTER_INTERVAL_LABEL, CLUSTER_INTERVAL_NOTE, formatPValue } from "./regression-statistics";
import { IntervalReadingExercise, RegressionEvidenceMatrix } from "./regression-teach";
import {
  buildRegressionVerdict,
  chartDisplayScale,
  globalInferenceIsSuppressed,
  teachingEffect,
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
  TeachingPanelResponse,
  TeachingSourceFilter,
} from "./types";
import { userFacingRequestError } from "./user-facing-error";
import { CoefForestChart, countryLabel, sectorLabel } from "./viz";
import { IndicatorTrendChart } from "./labs/steps/viz/indicator-charts";

const ENTITY_LABEL: Record<string, string> = { entity_id: "国家×行业", country: "国家" };
export const TEACHING_MODEL_VERSION = "step10-tariff-teaching-v2";

/**
 * Keep the fixed application shell anchored to the viewport while revealing a
 * freshly calculated verdict inside the course's own scroll container.
 * `Element.scrollIntoView()` also scrolls the document in this nested layout,
 * which can move the entire 100vh application off screen.
 */
export function scrollRegressionVerdict(target: HTMLElement | null, behavior: ScrollBehavior): void {
  if (!target) return;
  const scroller = target.closest<HTMLElement>(".content");
  if (!scroller) {
    target.scrollIntoView({ behavior, block: "start" });
    return;
  }
  const top = scroller.scrollTop
    + target.getBoundingClientRect().top
    - scroller.getBoundingClientRect().top;
  scroller.scrollTo({ top, left: 0, behavior });
}

function DesignMeta({ design }: { design: RegressionDesignInfo }) {
  return (
    <div className="design-meta">
      <span>结果指标：{design.depvar_label}</span>
      <span>解释变量：模拟关税暴露强度</span>
      <span>面板：{design.panel_file}</span>
      <span>观察个体：{ENTITY_LABEL[design.entity] ?? design.entity}</span>
      <span>标准误按{ENTITY_LABEL[design.cluster] ?? design.cluster}聚类</span>
      <span>模型：国家×行业与年份双向固定效应</span>
      <span>样本：{design.sample_filter}</span>
      <span>暴露权重：首次处理前固定结构</span>
    </div>
  );
}

function DesignEquation({ design }: { design: RegressionDesignInfo }) {
  const [description, setDescription] = useState<string | null>(null);
  const parts = design.equation_parts?.length ? design.equation_parts : [{ text: design.equation }];
  return (
    <div>
      <div className="model-eq" role="group" aria-label="当前实际运行方程">
        {parts.map((part, index) => {
          const interactive = Boolean(part.description);
          return (
            <span
              key={`${part.text}-${index}`}
              tabIndex={interactive ? 0 : undefined}
              title={part.description}
              onMouseEnter={() => setDescription(part.description ?? null)}
              onMouseLeave={() => setDescription(null)}
              onFocus={() => setDescription(part.description ?? null)}
              onBlur={() => setDescription(null)}
              style={interactive ? { cursor: "help", borderBottom: "1px dotted #8b88df" } : undefined}
            >
              {part.text}
            </span>
          );
        })}
      </div>
      {description && <p className="muted" role="status">{description}</p>}
      <DesignMeta design={design} />
    </div>
  );
}

interface RunSnapshot {
  id: number;
  response: RegressionResponse;
}

export type RegressionHistory = Partial<Record<RegressionOutcome, RunSnapshot[]>>;

export function RegressionResultCard({ outcome, response, sourceFilter }: {
  outcome: RegressionOutcome;
  response: RegressionResponse;
  sourceFilter?: TeachingSourceFilter;
}) {
  const verdict = buildRegressionVerdict(outcome, response);
  const lesson = REGRESSION_LESSONS[outcome];
  const suppressed = verdict.state === "suppressed";
  const unsignedEffect = verdict.effect.replace(/^[+−-]/, "");
  const plainResult = verdict.state === "negative"
    ? `平均下降 ${unsignedEffect}`
    : verdict.state === "positive"
      ? `平均上升 ${unsignedEffect}`
      : `平均变化为 ${verdict.effect}`;
  return (
    <section className={`verdict-card verdict-${verdict.state}`} aria-labelledby="reg-result-title" aria-live="polite">
      <div className="verdict-kicker">教学模拟结果 · 预设模拟关系的估计</div>
      <h3 id="reg-result-title">两者在模拟数据中怎样一起变化？</h3>
      <dl className="reg-evidence-support">
        <div><dt>拿来比较的因素（X）</dt><dd>模拟关税暴露强度</dd></div>
        <div><dt>想观察的结果（Y）</dt><dd>教学模拟：{lesson.shortMetric}</dd></div>
      </dl>
      <p className="reg-plain-verdict"><strong>方向判断：{verdict.title}</strong></p>
      <p>{verdict.evidence}</p>
      {verdict.warnings.length > 0 && (!suppressed || !verdict.coefficient) && (
        <ul aria-label="本次计算的限制">{verdict.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      )}
      {verdict.coefficient && (suppressed ? (
        <details className="lesson-details">
          <summary>描述性数值（不能据此判断方向）</summary>
          <p>X 每增加 1 个百分点时的点估计：{verdict.effect}。当前不提供置信区间，也不能把这个数字当作可靠的上升或下降证据。</p>
        </details>
      ) : <>
        <p>当模拟关税暴露增加 1 个百分点时，模拟 Y（{lesson.shortMetric}）<b>{plainResult}</b>。</p>
        <div className="verdict-metrics">
          <div><span>平均变化（点估计）</span><b>{verdict.effect}</b></div>
          <div><span>估计的不确定性（{CLUSTER_INTERVAL_LABEL}）</span><b>{verdict.interval}</b></div>
        </div>
        <p className="muted">区间表达平均关系估计的不确定性，不是各个国家结果的分布范围；包含 0 时，暂不能确定方向，不等于证明没有变化。</p>
        {verdict.coefficient.ci_low != null && verdict.coefficient.ci_high != null && <p className="muted reg-inference-note">{CLUSTER_INTERVAL_NOTE}</p>}
      </>)}
      {!suppressed && verdict.coefficient && response.model_snapshot && <div className="reg-simulation-comparison">
        <p><b>与生成时的预设关系比较</b>（同按 X 增加 1 个百分点换算）</p>
        <p>预设：{teachingEffect(outcome, response.model_snapshot.beta)}；估计：{teachingEffect(outcome, verdict.coefficient.coef)}；差值（估计 − 预设）：{teachingEffect(outcome, verdict.coefficient.coef - response.model_snapshot.beta)}。</p>
        <p className="muted">扰动使估计与预设不必相同；单次 95% 区间也不保证包含预设值。</p>
      </div>}
      <p className="reg-writing-hint"><b>不能推出什么：</b>{lesson.dontClaim}</p>
      <p className="muted">使用的年度记录：{response.result.n_obs.toLocaleString("zh-CN")}，来自 {response.result.n_entities.toLocaleString("zh-CN")} 个国家×行业单元、{response.result.n_clusters} 个国家聚类。模型扣除了各单元的固定差异和各年份的共同变化。</p>
      {sourceFilter && <div className="reg-source-filter">
        <p><b>教学样本的来源：</b>首年排除 ROW 后有 {sourceFilter.source_baseline_rows.toLocaleString("zh-CN")} 个候选单元，生成面板时剔除 {sourceFilter.excluded_source_baseline_rows.toLocaleString("zh-CN")} 个，保留 {sourceFilter.published_entities.toLocaleString("zh-CN")} 个供四项回归共同使用。</p>
        <p className="muted">共同规则：首年四类指标及销往美国的出口份额均有效；两类份额和出口份额在 0–1 内，长度大于 0，介数不小于 0。这些单元用于构造模拟样本，不能据此概括全部国家—行业的现实变化。</p>
      </div>}
      {response.result.sample_flow && <p className="muted">回归阶段：输入 {response.result.sample_flow.input_rows.toLocaleString("zh-CN")} 行模拟年度记录，另剔除 {response.result.sample_flow.dropped_rows_total.toLocaleString("zh-CN")} 行；上述生成阶段的剔除以单元计。</p>}
      <p className="verdict-boundary"><b>模拟免责声明：</b>X 与 Y 都由课程生成，仅用于练习读数；不是现实关税、OECD 观测结果或政策因果效应。</p>
      <p className="muted">本实验没有生成冲击后的投入产出表或网络，模拟 Y 的方向不表示实际生产结构、链长或拓扑位置已经改变。</p>
    </section>
  );
}

export function RegressionCoefficientTable({ response }: { response: RegressionResponse }) {
  return (
    <ScrollableRegion className="table-wrap" label="完整回归系数表，可横向滚动">
      <table className="data-table">
        <thead><tr><th>变量</th><th>系数</th><th>标称 95% CI</th><th>聚类SE</th><th>t</th><th>p</th></tr></thead>
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
              <td>{coef.name}</td>
              <td>{coef.coef.toFixed(4)}</td>
              <td>{ciLow != null && ciHigh != null ? `[${ciLow.toFixed(4)}, ${ciHigh.toFixed(4)}]` : "—"}</td>
              <td>{coef.se != null ? coef.se.toFixed(4) : "—"}</td><td>{coef.t != null ? coef.t.toFixed(2) : "—"}</td><td>{formatPValue(p)}</td>
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
  comparison_outcome?: RegressionOutcome | "";
}

const TEACHING_Y_COLUMN: Record<RegressionOutcome, string> = {
  trade: "teaching_y_trade",
  production: "teaching_y_production",
  length: "teaching_y_length",
  network: "teaching_y_network",
};

const TEACHING_TREND_UNIT: Record<RegressionOutcome, string> = {
  trade: "%",
  production: "%",
  length: "长度单位",
  network: "中心性单位",
};

interface TeachingSelectionState {
  compared?: string[];
  teaching_industry?: string;
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

type BoundRequestError = { requestKey: string; message: string };

export function RegressionRequestLoading({ designLoading }: {
  designLoading: boolean;
}) {
  if (!designLoading) return null;
  return <div className="reg-request-state muted" role="status" aria-live="polite" aria-busy="true">正在生成当前模型设计…</div>;
}

export function RegressionRequestError({ label, error, onRetry }: {
  label: string;
  error: string;
  onRetry: () => void;
}) {
  return (
    <div className="error-box async-error" role="alert">
      <span>{userFacingRequestError(error, `${label}失败`)}</span>
      <button type="button" className="secondary" onClick={onRetry}>重试{label}</button>
    </div>
  );
}

export function RegressionRunLab({
  step, meta, history, onHistoryChange, state, getStep, getConfirmedStep,
}: {
  step: Step;
  meta: Meta;
  history: RegressionHistory;
  onHistoryChange: React.Dispatch<React.SetStateAction<RegressionHistory>>;
  state: StepStateApi<RegressionStepState>;
  getStep?: <T>(step: number) => T | undefined;
  getConfirmedStep?: <T>(step: number) => T | undefined;
}) {
  const outcome = step.regression_outcome;
  if (!outcome) return <div className="error-box">当前回归步骤缺少 regression_outcome 配置。</div>;
  const lesson = REGRESSION_LESSONS[outcome];
  const [result, setResult] = useState<RegressionResponse | null>(null);
  const [error, setError] = useState<BoundRequestError | null>(null);
  const [running, setRunning] = useState(false);
  const [runningRequestKey, setRunningRequestKey] = useState<string | null>(null);
  const storedComparison = state.data?.comparison_outcome;
  const [comparisonOutcome, setComparisonOutcome] = useState<RegressionOutcome | "">(
    storedComparison && storedComparison !== outcome ? storedComparison : "",
  );
  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const runController = useRef<{ key: string; controller: AbortController } | null>(null);
  const verdictAnchorRef = useRef<HTMLDivElement>(null);
  const scrollToVerdictAfterRun = useRef(false);
  const latestRequest = useRef(outcome);

  const step10 = getStep?.<TeachingSelectionState>(10);
  const availableCountries = meta.countries.filter((country) => country !== "ROW");
  const carriedCountries = step10?.compared?.filter((country) => availableCountries.includes(country)) ?? [];
  const firstCountry = carriedCountries[0] ?? (availableCountries.includes("CAN") ? "CAN" : availableCountries[0] ?? "");
  const secondCountry = carriedCountries.find((country) => country !== firstCountry)
    ?? (firstCountry !== "KOR" && availableCountries.includes("KOR") ? "KOR" : availableCountries.find((country) => country !== firstCountry) ?? "");
  const teachingCountries = [firstCountry, secondCountry].filter(Boolean);
  const teachingIndustry = step10?.teaching_industry && meta.sectors.includes(step10.teaching_industry)
    ? step10.teaching_industry
    : meta.sectors.includes("C29") ? "C29" : meta.sectors[0] ?? "";
  const teachingYears = [...meta.years].sort((a, b) => a - b);
  const teachingSeriesKey = `${teachingCountries.join(",")}:${teachingIndustry}`;
  const teachingSeries = useAsync<TeachingPanelResponse>(
    () => api.teachingSeries(teachingCountries, teachingIndustry),
    [teachingSeriesKey],
    { requestKey: teachingSeriesKey, enabled: teachingCountries.length === 2 && Boolean(teachingIndustry) },
  );

  const currentRequestKey = outcome;
  latestRequest.current = currentRequestKey;

  const designRequestKey = `regression-design:${outcome}`;
  const designQuery = useAsync<RegressionDesignInfo>(
    () => api.regressionDesign(outcome),
    [designRequestKey],
    { requestKey: designRequestKey },
  );
  const design = designQuery.status === "success" ? designQuery.data : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runController.current?.controller.abort();
    };
  }, []);

  useEffect(() => {
    for (const request of [runController.current]) {
      if (request && request.key !== currentRequestKey) request.controller.abort();
    }
  }, [currentRequestKey]);

  useEffect(() => {
    scrollToVerdictAfterRun.current = false;
    setResult(null);
    setError(null);
  }, [outcome]);

  // 从实验会话恢复最近一次运行:会话是异步到达的,所以只能用 effect 而不是
  // useState 惰性初始化。刷新或换设备后,学生看到的是自己上次算出的结果,
  // 而不是一个空白的“请运行”面板。
  const savedRun = state.data?.run;
  const savedRunIdentity = savedRun ? regressionRunSnapshotIdentity(savedRun) : null;
  useEffect(() => {
    if (
      running || runningRef.current || result
      || savedRun?.model_snapshot?.version !== TEACHING_MODEL_VERSION
      || !savedRun.variable_catalog
    ) return;
    // Resolving a save conflict remounts the workbench with the chosen server
    // session. In-memory comparison history can still contain discarded runs;
    // it must never override (or invent a fallback for) that session's run.
    const matchingSnapshot = (history[outcome] ?? []).find(({ response }) => (
      regressionRunSnapshotIdentity({
        design: response.design, result: response.result,
        disclaimer: response.disclaimer,
        model_snapshot: response.model_snapshot, variable_catalog: response.variable_catalog,
      }) === savedRunIdentity
    ));
    // Keep the full arithmetic check only when history exactly matches the
    // session's run; benchmark details are intentionally not persisted.
    setResult(matchingSnapshot?.response ?? savedRegressionResponse(savedRun));
  }, [history, outcome, result, running, savedRunIdentity]);

  const run = async () => {
    if (runningRef.current || !design) return;
    runningRef.current = true;
    const requestKey = outcome;
    const controller = new AbortController();
    runController.current = { key: requestKey, controller };
    setRunning(true);
    setRunningRequestKey(requestKey);
    setError(null);
    try {
      const response = await api.runRegression(
        outcome, controller.signal,
      );
      if (!mountedRef.current) return;
      onHistoryChange((current) => {
        const prior = current[outcome] ?? [];
        const snapshot: RunSnapshot = {
          id: Math.max(0, ...prior.map((item) => item.id)) + 1,
          response,
        };
        return { ...current, [outcome]: [snapshot, ...prior].slice(0, 3) };
      });
      // 最新完整 run（含不可推断诊断）进入主表；先前可推断快照另存供对照。
      if (response.model_snapshot?.version !== TEACHING_MODEL_VERSION || !response.variable_catalog) {
        throw new Error("教学模型版本不匹配，结果未保存");
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
      if (latestRequest.current === requestKey) {
        scrollToVerdictAfterRun.current = true;
        setResult(response);
      }
    } catch (cause) {
      if (mountedRef.current && latestRequest.current === requestKey) {
        setError({ requestKey, message: userFacingRequestError(cause, "回归运行失败") });
      }
    } finally {
      if (runController.current?.controller === controller) runController.current = null;
      runningRef.current = false;
      if (mountedRef.current) {
        setRunning(false);
        setRunningRequestKey(null);
      }
    }
  };

  // 只在学生点运行之后滚到结论。会话恢复也会 setResult，若一并滚动会把页顶的教学卷走。
  useEffect(() => {
    if (!result || !scrollToVerdictAfterRun.current) return;
    scrollToVerdictAfterRun.current = false;
    const frame = window.requestAnimationFrame(() => {
      scrollRegressionVerdict(
        verdictAnchorRef.current,
        window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [result]);

  const currentRunError = error?.requestKey === currentRequestKey ? error.message : null;
  const runningCurrentRequest = running && runningRequestKey === currentRequestKey;
  const split = result ? splitPolicyCoefficients(result) : null;
  const display = result ? chartDisplayScale(outcome) : { scale: 1 as number, unit: undefined as string | undefined };
  // Keep the dynamic path visible when selected; the static forest duplicates
  // the main reading and is available in the existing technical disclosure.
  const graphReview = result && (
    <section className="reg-section-card">
      <h3>图表复核（仍按本次推断条件展示）</h3>
      <p className="muted">图与结果卡均展示冲击强度增加 1 个百分点时的结果变化。</p>
      <CoefForestChart coefs={split?.policy ?? []} globalStatus={result.result.status} globalSupport={result.result.support} scale={display.scale} unit={display.unit} labels={{ teaching_tariff_exposure: "模拟关税暴露强度" }} title="X 每增加 1 个百分点时 Y 的关联变化" />
    </section>
  );

  return (
    <div className="reg-workbench">
      <section className="reg-section-card reg-variable-story">
        <span className="reg-section-step">先用普通语言看变量</span>
        <h3>{lessonQuestion(outcome)}</h3>
        <p className="reg-learning-focus"><b>本步学会一件事：</b>{lesson.learnThis}</p>
        <div className="reg-variable-plain-grid">
          <div><b>拿来比较的因素（X）</b><span>模拟关税暴露，数值越大表示模拟暴露越强。</span></div>
          <div><b>想观察的结果（Y）</b><span>教学模拟：{lesson.shortMetric}。</span></div>
        </div>
        <p className="muted">沿用步骤 10 选出的 {countryLabel(firstCountry)}、{countryLabel(secondCountry)} 和 {sectorLabel(teachingIndustry)}，先看五年示例。它帮助理解数据，但正式计算使用完整国家×行业面板。</p>
        {teachingSeries.status === "loading" && <p className="muted" role="status">正在读取两国五年示例…</p>}
        {teachingSeries.status === "error" && teachingSeries.error && (
          <RegressionRequestError label="两国五年示例" error={teachingSeries.error} onRetry={teachingSeries.retry} />
        )}
        {teachingSeries.status === "success" && teachingSeries.data && (
          <IndicatorTrendChart
            rows={teachingSeries.data.rows}
            countries={teachingCountries}
            years={teachingYears}
            metric={TEACHING_Y_COLUMN[outcome]}
            label={`教学模拟：${lesson.shortMetric}`}
            unit={TEACHING_TREND_UNIT[outcome]}
          />
        )}
        <label className="reg-optional-variable">
          <span><b>可选趋势对照</b><small>只增加一张帮助理解的趋势图，不改变本步回归或报告主结果。</small></span>
          <select
            value={comparisonOutcome}
            onChange={(event) => {
              const value = event.target.value as RegressionOutcome | "";
              setComparisonOutcome(value);
              state.save({ comparison_outcome: value });
            }}
          >
            <option value="">不添加对照指标</option>
            {(Object.keys(REGRESSION_LESSONS) as RegressionOutcome[])
              .filter((candidate) => candidate !== outcome)
              .map((candidate) => (
                <option key={candidate} value={candidate}>{REGRESSION_LESSONS[candidate].shortMetric}</option>
              ))}
          </select>
        </label>
        {comparisonOutcome && teachingSeries.status === "success" && teachingSeries.data && (
          <IndicatorTrendChart
            rows={teachingSeries.data.rows}
            countries={teachingCountries}
            years={teachingYears}
            metric={TEACHING_Y_COLUMN[comparisonOutcome]}
            label={`可选对照：${REGRESSION_LESSONS[comparisonOutcome].shortMetric}`}
            unit={TEACHING_TREND_UNIT[comparisonOutcome]}
          />
        )}
      </section>
      <section className="reg-run-card">
        <span className="reg-section-step">固定计算 · 无需调整复杂参数</span>
        <h3>计算 X 与 Y 的关系</h3>
        <div className="metric-facts">
          <span><b>拿来比较的因素（X）</b>模拟关税暴露强度</span>
          <span><b>想观察的结果（Y）</b>教学模拟：{lesson.shortMetric}</span>
          <span><b>读数单位</b>{lesson.unit}</span>
          <span><b>怎样比较</b>X 每增加 1 个百分点时，观察 Y 平均怎样变化</span>
          <span><b>系统固定</b>使用完整国家×行业年度面板；学生无需选择计算方法</span>
        </div>
        <div className="reg-boundary">X 与 Y 都是教学模拟数据，不代表现实政策或 OECD 观测结果。</div>
        <RegressionRequestLoading designLoading={designQuery.status === "loading"} />
        {designQuery.status === "error" && designQuery.error && (
          <RegressionRequestError label="当前模型设计" error={designQuery.error} onRetry={designQuery.retry} />
        )}
        <button
          className="run-btn"
          onClick={run}
          disabled={running || designQuery.status !== "success" || !design}
        >
          {runningCurrentRequest
            ? "估计中…"
            : running
              ? "等待上一项估计结束…"
              : result ? "重新计算" : "计算两者的关系"}
        </button>
        {runningCurrentRequest && (
          <span className="muted reg-inline-status" role="status" aria-live="polite" aria-busy="true">正在估计当前设定…</span>
        )}
      </section>

      {currentRunError && (
        <div className="error-box async-error" role="alert">
          <span>{currentRunError}</span>
          <button type="button" className="secondary" disabled={running || !design} onClick={run}>按当前设定重试</button>
        </div>
      )}

      {result && (
        <div className="reg-results">
          <div ref={verdictAnchorRef} className="verdict-anchor">
            <RegressionResultCard outcome={outcome} response={result} sourceFilter={meta.dataset?.simulation_contract?.source_filter_disclosure} />
          </div>
        </div>
      )}
      {outcome === "network" && result && (
        <RegressionEvidenceMatrix history={history} getStep={getConfirmedStep} current={outcome} />
      )}
      {outcome === "production" && result && <section aria-label="补充区间读数练习">
        <p className="muted">四项生成关系都预设为负。用下面的可选练习比较区间跨零与不跨零的读法，避免仅凭点估计的负号下结论。</p>
        <IntervalReadingExercise />
      </section>}
      <details className="technical-details">
        <summary>计算方法说明（可选）</summary>
        <div className="reg-question-main">
          <h3>当前设定：{lessonQuestion(outcome)}</h3>
          <p><b>真实指标定义（仅用于说明概念）：</b>{lesson.definition}</p>
          <p><b>本步 Y：</b>按首年真实指标排名校准后重新生成的模拟值，不保留真实水平，也不是投入产出网络机械计算出的现实结果。</p>
          <p><b>下降：</b>{lesson.downMeaning}</p>
          <p><b>上升：</b>{lesson.upMeaning}</p>
          <p><b>不要写成：</b>{lesson.dontClaim}</p>
          {result?.model_snapshot && <details className="lesson-details"><summary>查看模拟生成设定</summary>
            <p>版本 {result.model_snapshot.version} · seed={result.model_snapshot.seed} · 原始 β={result.model_snapshot.beta}。X 增加 1 个百分点时，技术 β 为 {(result.model_snapshot.beta * 0.01).toFixed(4)} 个 Y 原始单位{outcome === "trade" || outcome === "production" ? `，即 ${result.model_snapshot.beta.toFixed(4)} 个百分点` : ""}。</p>
          </details>}
        </div>
        {result?.design ? (
          <DesignEquation design={result.design} />
        ) : designQuery.status === "success" && design ? (
          <DesignEquation design={design} />
        ) : designQuery.status === "error" ? (
          <p className="muted">当前方程不可用；请在上方重试当前模型设计。</p>
        ) : designQuery.status === "loading" ? (
          <p className="muted">正在生成当前方程…</p>
        ) : null}
        {result && (
          <>
            {graphReview}
            <h3>原始列与系数</h3>
            <p className="muted">X 原始列：{result.model_snapshot?.x_columns.join("、")}；Y 原始列：{result.model_snapshot?.y_column}。表内保留计算键与模型原始单位。</p>
            <RegressionCoefficientTable response={result} />
            <p className="muted">极小 p 值以 &lt;0.0001 展示，不能读作概率为零。</p>
            <p className="muted">N={result.result.n_obs.toLocaleString("zh-CN")} · {result.result.n_entities.toLocaleString("zh-CN")} 个体 × {result.result.n_times} 年 · {result.result.n_clusters} 个聚类 · {result.result.r2_within == null ? "本次 TWFE 结果未提供组内 R²" : `组内 R²=${result.result.r2_within.toFixed(4)}`}</p>
          </>
        )}
      </details>
    </div>
  );
}
