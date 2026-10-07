import { useEffect, useRef, useState } from "react";
import { ScrollableRegion } from "./a11y";
import { api } from "./api";
import { useAsync } from "./labs";
import { ReadingCards } from "./labs/steps/viz/reading-cards";
import { baselineKeyOf, lessonFor, lessonQuestion, VIZ_STEPS } from "./regression-lessons";
import { nextRegressionSave } from "./regression-save";
import { formatPValue } from "./regression-statistics";
import {
  buildRegressionVerdict,
  chartDisplayScale,
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
import { teachingExample, type TeachingExampleSelection } from "./teaching-example";
import { userFacingRequestError } from "./user-facing-error";
import { BinScatterChart, CoefForestChart, countryLabel, GroupChangeChart, sectorLabel } from "./viz";

const ENTITY_LABEL: Record<string, string> = { entity_id: "国家×行业", country: "国家" };
export const TEACHING_MODEL_VERSION = "step10-tariff-teaching-v5";

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
      <span>解释变量：关税暴露强度</span>
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

/** Network units span closeness (~0.01) to weighted degree (thousands): keep about three significant figures. */
export function networkDigits(size: number): number {
  return size >= 100 ? 0 : size >= 10 ? 1 : size >= 1 ? 2 : size >= 0.1 ? 3 : size >= 0.01 ? 4 : 5;
}

/** Y change implied by the estimate for an example's X, in the step's display units. */
export function exampleEffect(outcome: RegressionOutcome, coef: number, x: number, design?: { depvar_kind?: string } | null): string {
  const change = coef * x;
  const kind = depvarKind(outcome, design);
  if (kind === "share") return `${Math.abs(change * 100).toFixed(2)} 个百分点`;
  if (kind === "length") return `${Math.abs(change).toFixed(3)} 个长度单位`;
  if (kind === "position") return `${Math.abs(change).toFixed(4)} 个位置指数单位`;
  const size = Math.abs(change);
  return `${size.toFixed(networkDigits(size))} 个中心性原始单位`;
}

/** The result is a coefficient plot plus short sentences: what changed, for the student's example, how sure, what not to claim. */
export function RegressionResultCard({ outcome, response, examples = [] }: {
  outcome: RegressionOutcome;
  response: RegressionResponse;
  examples?: RegressionExample[];
}) {
  const verdict = buildRegressionVerdict(outcome, response);
  const lesson = lessonFor(outcome, response.design.baseline, response.design.baseline_label);
  const suppressed = verdict.state === "suppressed";
  const display = chartDisplayScale(outcome, response.design);
  const unsignedEffect = verdict.effect.replace(/^[+−-]/, "");
  const plainResult = verdict.state === "negative"
    ? `平均下降 ${unsignedEffect}`
    : verdict.state === "positive"
      ? `平均上升 ${unsignedEffect}`
      : `平均变化为 ${verdict.effect}`;
  return (
    <section className={`verdict-card verdict-${verdict.state}`} aria-labelledby="reg-result-title" aria-live="polite">
      <div className="verdict-kicker">回归结果</div>
      <h3 id="reg-result-title" className="reg-plain-verdict">方向判断：{verdict.title}</h3>
      {verdict.coefficient && response.result.binscatter && response.result.binscatter.bins.length >= 2 && (
        <BinScatterChart
          bins={response.result.binscatter.bins}
          slope={response.result.binscatter.slope * display.scale}
          xLabel="关税暴露 X（个百分点）"
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
          title="X 每增加 1 个百分点时 Y 的平均变化"
        />
      )}
      <ul className="reg-result-points">
        {!suppressed && verdict.coefficient && (
          <li>关税暴露（X）每增加 1 个百分点，{lesson.shortMetric}（Y）<b>{plainResult}</b>；95% 区间为 {verdict.interval}。</li>
        )}
        {!suppressed && verdict.coefficient && examples.length > 0 && (
          <li className="reg-example-effect">换算到你在步骤 10 选的例子：{examples.map((example, index) => {
            const coef = verdict.coefficient!.coef;
            const text = example.x > 0
              ? <>{example.label}（X = {(example.x * 100).toFixed(2)} 个百分点）Y 约{coef * example.x < 0 ? "下降" : "上升"} <b>{exampleEffect(outcome, coef, example.x, response.design)}</b></>
              : <>{example.label}未被加税（X = 0），按估计不变</>;
            return <span key={example.label}>{index ? "；" : ""}{text}</span>;
          })}{verdict.state === "insufficient" ? "；但区间跨过 0，这个方向本身并不确定" : ""}。
            {examples.every((example) => example.x <= 0) && (examples.length === 1
              ? "你选的例子未被加税，所以换算结果是不变；回步骤 10 换成加税的国家（如加拿大），或再选一个加税的对比国家，就能看到换算。"
              : "两个例子都未被加税，所以换算结果都是不变；回步骤 10 把其中一个换成加税的国家（如加拿大），就能看到换算。")}</li>
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
  // Which same-family indicator calibrates Y: null is the step's fixed default. It starts from the saved
  // run (so a refresh shows the Y the student last ran) until the student picks another one.
  const [baseline, setBaseline] = useState<string | null>(null);
  const baselineChosen = useRef(false);
  const [baselineNotice, setBaselineNotice] = useState<string | null>(null);
  const [result, setResult] = useState<RegressionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
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
    setBaselineNotice(`上次算的 Y（${savedRun?.design?.baseline_label ?? lesson.shortMetric}）在当前数据发布里没有，已换回本步默认指标，请重新计算。`);
    setBaseline(null);
    setResult(null);
  }, [baselineOffered]);
  const groupSeries = usesDefault ? groups?.outcomes[outcome] : groups?.series?.[outcome]?.[baseline];

  // After the run: the estimate converted to the example(s) followed from step 10 (one country or two).
  const example = teachingExample(meta, getStep?.<TeachingExampleSelection>(10));
  const exampleCountries = [example.first, example.second].filter(Boolean);
  const exampleKey = `teaching-example:${exampleCountries.join(",")}:${example.industry}`;
  const exampleQuery = useAsync<TeachingPanelResponse>(
    () => api.teachingSeries(exampleCountries, example.industry),
    [exampleKey],
    { requestKey: exampleKey, enabled: exampleCountries.length >= 1 && Boolean(example.industry) },
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
        <h3>{lessonQuestion(outcome, baseline)}</h3>
        {outcome !== "trade" && <p className="muted">方法与步骤 11 相同，这次 Y 换成{lesson.shortMetric}。</p>}
        <p className="reg-step-focus"><b>本步重点</b>{lesson.learnThis}</p>
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
                  <option key={option.key} value={option.key}>{option.label}{option.default ? "（本步默认）" : ""}</option>
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
          const fmt = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(digits)} ${display.unit}`;
          const estimate = result && coefficient != null && groups.mean_exposure_taxed != null && !globalInferenceIsSuppressed(result.result.status, result.result.support)
            ? { gap: coefficient * groups.mean_exposure_taxed, label: `回归估计的差距 ${fmt(coefficient * groups.mean_exposure_taxed * levelScale)}` }
            : null;
          return <div className="reg-group-figure">
            <GroupChangeChart
              years={groups.years}
              policyYear={groups.policy_year}
              taxed={groupSeries.taxed}
              untaxed={groupSeries.untaxed}
              scale={levelScale}
              unit={display.unit ?? lesson.unit}
              title={`加税前后：两组${lesson.shortMetric}的平均变化`}
              estimate={estimate}
            />
            <ReadingCards label="两组读图" cards={[
              { eyebrow: `加税前（${groups.years[0]}–${groups.policy_year - 1}）`, big: preGap == null ? "缺失" : Math.abs(preGap) < tiny ? "两组差不多" : `两组相差 ${fmt(preGap)}`, small: "每条线都减去了本组加税前的平均水平，所以起点都接近 0" },
              { eyebrow: `加税后（${lastYear}）`, big: postGap == null ? "缺失" : `加税组比未加税组${postGap < 0 ? "低" : "高"} ${fmt(Math.abs(postGap)).replace(/^\+/, "")}`, small: `${groups.sample.taxed_countries} 国加税、${groups.sample.untaxed_countries} 国未加税的平均值` },
              { eyebrow: "回归要算的", big: estimate ? `估计的差距 ${fmt(estimate.gap * levelScale)}` : "两条线分开的距离", small: estimate ? "= β × 加税组的平均暴露 X；图上虚线括号" : "β 按每个单元的暴露 X 把这段距离换算成每 1 个百分点的变化" },
            ]} />
            {design && <div className="reg-equation"><span className="reg-section-step">公式</span><DesignEquation design={design} /></div>}
          </div>;
        })()}
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
          {running ? "正在计算…" : result ? "重新算一次" : groups ? `算出这个差距（用全部 ${groups.sample.rows.toLocaleString("zh-CN")} 条记录）` : "算出这个差距"}
        </button>
        {running && (
          <span className="muted reg-inline-status" role="status" aria-live="polite" aria-busy="true">正在估计…</span>
        )}
        {!running && !baselineNotice && savedRunY && savedRunY.key !== (baseline ?? defaultBaseline) && (
          <p className="reg-boundary" role="status">
            报告材料里保存的仍是上次算出的 Y（{savedRunY.label}）；按上面的按钮算一次，才会换成{lesson.shortMetric}。
          </p>
        )}
        {!running && savedRun && state.materialLocked && (
          <p className="muted">报告已提交：重新计算会替换报告材料里保存的结果，之后需在步骤 15 更新报告并重新提交。</p>
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
            <summary>系数表与样本（可选）</summary>
            <RegressionCoefficientTable response={result} />
            <p className="muted">极小 p 值以 &lt;0.0001 展示，不能读作概率为零。</p>
            <p className="muted">表中系数按 X 的原始单位计（X 是份额，0.01 即 1 个百分点）：上方“X 每增加 1 个百分点”的读数 = 系数 × 0.01{outcome === "trade" || outcome === "production" ? "，Y 也是份额，再乘 100 换成百分点，所以数值与系数相同" : ""}。</p>
            <p className="muted">N={result.result.n_obs.toLocaleString("zh-CN")} · {result.result.n_entities.toLocaleString("zh-CN")} 个体 × {result.result.n_times} 年 · {result.result.n_clusters} 个聚类 · {result.result.r2_within == null ? "本次 TWFE 结果未提供组内 R²" : `组内 R²=${result.result.r2_within.toFixed(4)}`}</p>
          </details>
        </div>
      )}
    </div>
  );
}
