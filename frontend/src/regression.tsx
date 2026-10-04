import { useEffect, useRef, useState } from "react";
import { ScrollableRegion } from "./a11y";
import { api } from "./api";
import { useAsync } from "./labs";
import { lessonQuestion, REGRESSION_LESSONS } from "./regression-lessons";
import { nextRegressionSave } from "./regression-save";
import { CLUSTER_INTERVAL_LABEL, formatPValue } from "./regression-statistics";
import {
  buildRegressionVerdict,
  chartDisplayScale,
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
import { teachingExample, type TeachingExampleSelection } from "./teaching-example";
import { userFacingRequestError } from "./user-facing-error";
import { CoefForestChart, countryLabel, GroupChangeChart, sectorLabel } from "./viz";

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

/** One step-10 example unit: its label and its final-year exposure X (a proportion). */
export interface RegressionExample { label: string; x: number }

/** Y change implied by the estimate for an example's X, in the step's display units. */
export function exampleEffect(outcome: RegressionOutcome, coef: number, x: number): string {
  const change = coef * x;
  if (outcome === "trade" || outcome === "production") return `${Math.abs(change * 100).toFixed(2)} 个百分点`;
  if (outcome === "length") return `${Math.abs(change).toFixed(3)} 个长度单位`;
  return `${Math.abs(change).toFixed(1)} 个中心性原始单位`;
}

/** The result is a coefficient plot plus short sentences: what changed, for the student's example, how sure, what not to claim. */
export function RegressionResultCard({ outcome, response, examples = [] }: {
  outcome: RegressionOutcome;
  response: RegressionResponse;
  examples?: RegressionExample[];
}) {
  const verdict = buildRegressionVerdict(outcome, response);
  const lesson = REGRESSION_LESSONS[outcome];
  const suppressed = verdict.state === "suppressed";
  const display = chartDisplayScale(outcome);
  const unsignedEffect = verdict.effect.replace(/^[+−-]/, "");
  const plainResult = verdict.state === "negative"
    ? `平均下降 ${unsignedEffect}`
    : verdict.state === "positive"
      ? `平均上升 ${unsignedEffect}`
      : `平均变化为 ${verdict.effect}`;
  return (
    <section className={`verdict-card verdict-${verdict.state}`} aria-labelledby="reg-result-title" aria-live="polite">
      <div className="verdict-kicker">教学模拟 · 回归结果</div>
      <h3 id="reg-result-title" className="reg-plain-verdict">方向判断：{verdict.title}</h3>
      {verdict.coefficient && (
        <CoefForestChart
          coefs={splitPolicyCoefficients(response).policy}
          globalStatus={response.result.status}
          globalSupport={response.result.support}
          scale={display.scale}
          unit={display.unit}
          labels={{ teaching_tariff_exposure: lesson.shortMetric }}
          title="X 每增加 1 个百分点时 Y 的平均变化"
        />
      )}
      <ul className="reg-result-points">
        {!suppressed && verdict.coefficient && (
          <li>模拟关税暴露（X）每增加 1 个百分点，模拟{lesson.shortMetric}（Y）<b>{plainResult}</b>；{CLUSTER_INTERVAL_LABEL}为 {verdict.interval}。</li>
        )}
        {!suppressed && verdict.coefficient && examples.length > 0 && (
          <li className="reg-example-effect">换算到你在步骤 10 选的例子：{examples.map((example, index) => {
            const coef = verdict.coefficient!.coef;
            const text = example.x > 0
              ? <>{example.label}（X = {(example.x * 100).toFixed(2)} 个百分点）Y 约{coef * example.x < 0 ? "下降" : "上升"} <b>{exampleEffect(outcome, coef, example.x)}</b></>
              : <>{example.label}未被模拟加税（X = 0），按估计不变</>;
            return <span key={example.label}>{index ? "；" : ""}{text}</span>;
          })}{verdict.state === "insufficient" ? "；但区间跨过 0，这个方向本身并不确定" : ""}。</li>
        )}
        <li>{verdict.evidence}</li>
        <li><b>解释限制：</b>{lesson.dontClaim}</li>
      </ul>
      {verdict.warnings.length > 0 && (!suppressed || !verdict.coefficient) && (
        <ul aria-label="本次计算的限制">{verdict.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      )}
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
  if (!outcome) return <div className="error-box">当前回归步骤缺少 regression_outcome 配置。</div>;
  const lesson = REGRESSION_LESSONS[outcome];
  const [result, setResult] = useState<RegressionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const runController = useRef<AbortController | null>(null);
  const verdictAnchorRef = useRef<HTMLDivElement>(null);
  const scrollToVerdictAfterRun = useRef(false);

  const designRequestKey = `regression-design:${outcome}`;
  const designQuery = useAsync<RegressionDesignInfo>(
    () => api.regressionDesign(outcome),
    [designRequestKey],
    { requestKey: designRequestKey },
  );
  const design = designQuery.status === "success" ? designQuery.data : null;

  // Before the run: the taxed vs untaxed comparison that the regression then quantifies.
  const groupsQuery = useAsync<TeachingGroupsResponse>(() => api.teachingGroups(), ["teaching-groups"]);
  const groups = groupsQuery.status === "success" ? groupsQuery.data : null;
  const groupSeries = groups?.outcomes[outcome];

  // After the run: the estimate converted to the two examples followed from step 10.
  const example = teachingExample(meta, getStep?.<TeachingExampleSelection>(10));
  const exampleCountries = [example.first, example.second].filter(Boolean);
  const exampleKey = `teaching-example:${exampleCountries.join(",")}:${example.industry}`;
  const exampleQuery = useAsync<TeachingPanelResponse>(
    () => api.teachingSeries(exampleCountries, example.industry),
    [exampleKey],
    { requestKey: exampleKey, enabled: exampleCountries.length === 2 && Boolean(example.industry) },
  );
  const lastYear = exampleQuery.data?.years.at(-1);
  const examples: RegressionExample[] = exampleQuery.status === "success" && exampleQuery.data
    ? exampleCountries.flatMap((country) => {
      const row = exampleQuery.data!.rows.find((item) => item.country === country && item.year === lastYear);
      return row ? [{ label: `${countryLabel(country)}·${sectorLabel(example.industry)}`, x: row.teaching_tariff_exposure }] : [];
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
  useEffect(() => {
    if (
      running || runningRef.current || result
      || savedRun?.model_snapshot?.version !== TEACHING_MODEL_VERSION
      || !savedRun.variable_catalog
    ) return;
    setResult(savedRegressionResponse(savedRun));
  }, [result, running, savedRunIdentity]);

  const run = async () => {
    if (runningRef.current || !design) return;
    runningRef.current = true;
    const controller = new AbortController();
    runController.current = controller;
    setRunning(true);
    setError(null);
    try {
      const response = await api.runRegression(outcome, controller.signal);
      if (!mountedRef.current) return;
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
      scrollToVerdictAfterRun.current = true;
      setResult(response);
    } catch (cause) {
      if (mountedRef.current) setError(userFacingRequestError(cause, "回归运行失败"));
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
    });
    return () => window.cancelAnimationFrame(frame);
  }, [result]);

  return (
    <div className="reg-workbench">
      <section className="reg-run-card">
        <span className="reg-section-step">本步回归 · 固定计算</span>
        <h3>{lessonQuestion(outcome)}</h3>
        {outcome !== "trade" && <p className="muted">方法与步骤 11 相同，这次 Y 换成{lesson.shortMetric}。</p>}
        <p className="reg-step-focus"><b>本步重点</b>{lesson.learnThis}</p>
        <div className="metric-facts">
          <span><b>解释变量（X）</b>模拟关税暴露强度</span>
          <span><b>结果变量（Y）</b>教学模拟：{lesson.shortMetric}</span>
          <span><b>读数单位</b>{lesson.unit}</span>
        </div>
        <div className="reg-boundary">X 与 Y 都是教学模拟数据，不代表现实政策或 OECD 观测结果。</div>
        {groups && groupSeries && <div className="reg-group-figure">
          <GroupChangeChart
            years={groups.years}
            policyYear={groups.policy_year}
            taxed={groupSeries.taxed}
            untaxed={groupSeries.untaxed}
            scale={outcome === "trade" || outcome === "production" ? 100 : 1}
            unit={outcome === "trade" || outcome === "production" ? "百分点" : outcome === "length" ? "长度单位" : "中心性原始单位"}
            title={`加税前后：两组${lesson.shortMetric}的平均变化`}
          />
          <p className="muted">每条线是该组全部国家×行业的平均值，减去自身 {groups.years[0]}–{groups.policy_year - 1} 年的平均水平。{groups.policy_year} 年后两条线之间的距离，就是回归要量化的差距；回归还会考虑每个单元暴露强度 X 的大小，并给出不确定性区间。</p>
        </div>}
        {groupsQuery.status === "error" && groupsQuery.error && (
          <RegressionRequestError label="分组对比图" error={groupsQuery.error} onRetry={groupsQuery.retry} />
        )}
        <RegressionRequestLoading designLoading={designQuery.status === "loading"} />
        {designQuery.status === "error" && designQuery.error && (
          <RegressionRequestError label="当前模型设计" error={designQuery.error} onRetry={designQuery.retry} />
        )}
        <button
          className="run-btn"
          onClick={run}
          disabled={running || designQuery.status !== "success" || !design}
        >
          {running ? "估计中…" : result ? "重新计算" : groups ? `用全部 ${groups.sample.rows.toLocaleString("zh-CN")} 条记录估计这个差距` : "计算两者的关系"}
        </button>
        {running && (
          <span className="muted reg-inline-status" role="status" aria-live="polite" aria-busy="true">正在估计…</span>
        )}
      </section>

      {error && (
        <div className="error-box async-error" role="alert">
          <span>{error}</span>
          <button type="button" className="secondary" disabled={running || !design} onClick={run}>重试</button>
        </div>
      )}

      {result && (
        <div className="reg-results">
          <div ref={verdictAnchorRef} className="verdict-anchor">
            <RegressionResultCard outcome={outcome} response={result} examples={examples} />
          </div>
          <details className="technical-details">
            <summary>回归方程与系数表（可选）</summary>
            <DesignEquation design={result.design} />
            <RegressionCoefficientTable response={result} />
            <p className="muted">极小 p 值以 &lt;0.0001 展示，不能读作概率为零。</p>
            <p className="muted">N={result.result.n_obs.toLocaleString("zh-CN")} · {result.result.n_entities.toLocaleString("zh-CN")} 个体 × {result.result.n_times} 年 · {result.result.n_clusters} 个聚类 · {result.result.r2_within == null ? "本次 TWFE 结果未提供组内 R²" : `组内 R²=${result.result.r2_within.toFixed(4)}`}</p>
          </details>
        </div>
      )}
    </div>
  );
}
