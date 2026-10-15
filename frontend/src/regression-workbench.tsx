/**
 * 改模型、对比 (the workbench of steps 11–14): folded under the step's quiz. The student runs one preset experiment
 * (each changes one setting of the course default model) or a custom setting, reads it in one regression table next
 * to the default model, and may put one model a step into the report (whose appendix recomputes it from the model).
 */
import { useEffect, useRef, useState } from "react";
import { ScrollableRegion } from "./a11y";
import { groupedFixed } from "./format";
import { api, ApiError } from "./api";
import { useAsync } from "./labs";
import {
  canonicalSpec,
  coefficientRows,
  comparisonCsv,
  equationPreview,
  experimentLabel,
  fixed4,
  includedBy,
  omittedSummary,
  perPointReading,
  perPointRow,
  sameSpec,
  samplesDiffer,
  significanceStars,
  designValueRow,
  snapshotOf,
  specSummary,
  specKey,
  summaryRows,
  termLabel,
  type TableColumn,
  X_COLUMNS,
  xSum,
  xSpanLabel,
} from "./regression-workbench-table";
import { DivergingBarChart, type DivergingBarRow } from "./viz/regression/diverging-bars";
import { formatPValue } from "./regression-statistics";
import type {
  CoefStat,
  CustomResultSnapshot,
  Experiment,
  ModelSpec,
  RegressionOutcome,
  RegressionResponse,
  ReportedCustomResult,
  StepStateApi,
  TeachingBaselineOption,
  WorkbenchOptions,
} from "./types";
import { displayBaselineLabel } from "./regression-lessons";
import { userFacingRequestError } from "./user-facing-error";

export interface WorkbenchDraft {
  spec?: ModelSpec;
  /** The Y chosen in the workbench when not the step's default Y. */
  baseline?: string;
}

export interface WorkbenchStepState extends Record<string, unknown> {
  /** The one model this step put into the report; null once removed (the key then says "none" to the server). */
  experiment?: Experiment | null;
  custom_draft?: WorkbenchDraft;
}

const DEFAULT_COLUMN = "默认模型";

/** Whether the model put into the report differs from the one the report printed for this step (compared as
 *  models, not strings: the report's copy comes back from the database with each control's keys in another order). */
export function experimentReportChanged(
  stepNumber: number, experiment: Experiment | null | undefined, reported: readonly ReportedCustomResult[] | undefined, options: WorkbenchOptions,
  stepBaseline: string,
): boolean {
  const mine = experiment ? [`${experiment.baseline ?? stepBaseline}:${specKey(canonicalSpec(experiment.spec, options))}`] : [];
  const theirs = (reported ?? []).filter((item) => item.step === stepNumber).map((item) => `${item.baseline}:${specKey(canonicalSpec(item.spec, options))}`);
  return mine.join("|") !== theirs.join("|");
}

function download(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ModelForm({ options, spec, onChange }: {
  options: WorkbenchOptions; spec: ModelSpec; onChange: (spec: ModelSpec) => void;
}) {
  const toggleLag = (lag: number) => onChange({
    ...spec, x_lags: spec.x_lags.includes(lag) ? spec.x_lags.filter((item) => item !== lag) : [...spec.x_lags, lag],
  });
  const control = (name: string) => spec.controls.find((item) => item.name === name);
  const toggleControl = (name: string) => onChange({
    ...spec,
    controls: control(name) ? spec.controls.filter((item) => item.name !== name) : [...spec.controls, { name, lag: 0 }],
  });
  const setControlLag = (name: string, lag: number) => onChange({
    ...spec, controls: spec.controls.map((item) => (item.name === name ? { name, lag } : item)),
  });
  const toggleEffect = (key: string) => onChange({
    ...spec,
    fixed_effects: spec.fixed_effects.includes(key) ? spec.fixed_effects.filter((item) => item !== key) : [...spec.fixed_effects, key],
  });
  return (
    <div className="reg-custom-form">
      <fieldset>
        <legend>关税暴露 X（至少选一项）</legend>
        {options.x_lags.map((item) => (
          <label key={item.lag} className="reg-custom-choice">
            <input type="checkbox" checked={spec.x_lags.includes(item.lag)} onChange={() => toggleLag(item.lag)} />
            <span><b>{item.label}</b><small>{item.description}</small></span>
          </label>
        ))}
        <p className="muted reg-custom-note">{options.x_lag_note}</p>
      </fieldset>
      <fieldset>
        <legend>控制变量</legend>
        {options.controls.map((item) => {
          const chosen = control(item.name);
          return (
            <div key={item.name} className="reg-custom-control">
              <label className="reg-custom-choice">
                <input type="checkbox" checked={Boolean(chosen)} onChange={() => toggleControl(item.name)} />
                <span><b>{item.label}</b><small>{item.definition}（{item.source}）</small></span>
              </label>
              {chosen && (
                <select aria-label={`${item.label}的期数`} value={chosen.lag} onChange={(event) => setControlLag(item.name, Number(event.target.value))}>
                  {options.control_lags.map((lag) => <option key={lag.lag} value={lag.lag}>{lag.label}</option>)}
                </select>
              )}
            </div>
          );
        })}
        <p className="muted reg-custom-note">{options.control_lag_note}</p>
      </fieldset>
      <fieldset>
        <legend>固定效应</legend>
        {options.fixed_effects.map((item) => {
          const parent = includedBy(item.key, spec.fixed_effects, options);
          return (
            <label key={item.key} className={parent ? "reg-custom-choice reg-custom-included" : "reg-custom-choice"} title={item.description}>
              <input
                type="checkbox"
                checked={parent != null || spec.fixed_effects.includes(item.key)}
                disabled={parent != null}
                onChange={() => toggleEffect(item.key)}
              />
              <span><b>{item.label}</b><small>{parent ? `已包含在${parent}中` : item.description}</small></span>
            </label>
          );
        })}
        <p className="muted reg-custom-note">{options.no_fixed_effects_note}</p>
        {spec.fixed_effects.includes("country_year") && <p className="reg-custom-note">吸收不等于没有控制：国家年度变化由固定效应扣除，因此不再单独估计这些控制变量的系数。</p>}
      </fieldset>
    </div>
  );
}

/** One column's every number: coefficient, SE, t, p and the 95% interval of each term, the sum included. */
export function ColumnDetails({ column, options, perPoint }: {
  column: TableColumn; options: WorkbenchOptions; perPoint: (stat: CoefStat, snapshot: CustomResultSnapshot) => string;
}) {
  const { result } = column.snapshot;
  const xTerms = result.coefs.filter((item) => Object.values(X_COLUMNS).includes(item.name)).length;
  const rows = [
    ...result.coefs,
    ...(xTerms > 1 && result.cumulative ? [{ ...result.cumulative, name: "cumulative" }] : []),
    ...(result.constant ? [result.constant] : []),
  ];
  return (
    <ScrollableRegion className="table-wrap" label={`${column.name}的完整数字，可横向滚动`}>
      <table className="data-table reg-custom-table">
        <thead><tr><th>变量</th><th>系数</th><th>标准误</th><th>t 值</th><th>p 值</th><th>显著性</th><th>95% 区间</th><th>X 每高 1 个百分点</th></tr></thead>
        <tbody>
          {rows.map((coef) => (
            <tr key={coef.name}>
              <td>{termLabel(coef.name, options)}</td>
              <td>{fixed4(coef.coef)}</td>
              <td>{result.suppressed ? "—" : `(${fixed4(coef.se)})`}</td>
              <td>{result.suppressed || coef.t == null ? "—" : groupedFixed(coef.t, 2)}</td>
              <td>{result.suppressed ? "—" : formatPValue(coef.p)}</td>
              <td>{result.suppressed ? "—" : significanceStars(coef.p) || "—"}</td>
              <td>{result.suppressed || coef.ci_low == null || coef.ci_high == null ? "—" : `[${fixed4(coef.ci_low)}, ${fixed4(coef.ci_high)}]`}</td>
              {/* The page's reading, for the X terms' sum (or the single X term) only. */}
              <td>{coef.name === "cumulative" || (xTerms === 1 && Object.values(X_COLUMNS).includes(coef.name)) ? perPoint(coef, column.snapshot) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollableRegion>
  );
}

export function ModelComparisonChart({ columns, outcome }: { columns: TableColumn[]; outcome: RegressionOutcome }) {
  const rows: DivergingBarRow[] = [];
  const notes: string[] = [];
  for (const [index, column] of columns.entries()) {
    const stat = xSum(column.snapshot, column.spec);
    const result = column.snapshot.result;
    if (result.suppressed || !stat || !Number.isFinite(stat.coef) || stat.ci_low == null || stat.ci_high == null
      || !Number.isFinite(stat.ci_low) || !Number.isFinite(stat.ci_high)) {
      notes.push(`${column.name}：${result.suppressed ? "停止推断" : "未取得完整的 X 效应与区间"}，不绘制对应模型；请查看结果表和省略原因。`);
      continue;
    }
    const scale = column.snapshot.depvar_kind === "share" ? 1 : 0.01;
    const interval = `${perPointReading(outcome, { ...stat, coef: stat.ci_low }, column.snapshot)} 至 ${perPointReading(outcome, { ...stat, coef: stat.ci_high }, column.snapshot)}`;
    rows.push({
      key: String(index), label: column.name,
      sublabel: `${xSpanLabel(column.spec)} · N=${result.n_obs} · ${result.years?.join("–") ?? "年份未提供"}`,
      value: stat.coef * scale, low: stat.ci_low * scale, high: stat.ci_high * scale,
      uncertain: stat.ci_low <= 0 && stat.ci_high >= 0,
      valueLabel: perPointReading(outcome, stat, column.snapshot),
      intervalLabel: `95% 区间：${interval}`,
      spokenLabel: `${perPointReading(outcome, stat, column.snapshot)}，95% 区间：${interval}，${xSpanLabel(column.spec)}`,
    });
  }
  return <section aria-label="同一因变量的模型比较">
    <h4>同一个 Y，换模型后怎样变？</h4>
    <p className="muted">比较 X 各项的合计及 95% 区间；各行注明所含期数。不同跨度不是同一个估计量，样本变化也可能影响结果。此图不替换默认教学结果。</p>
    {samplesDiffer(columns) && <p className="reg-stale-note">这几列的样本不同，差异有一部分来自样本，而不只是设定。</p>}
    {rows.length > 0 && <DivergingBarChart rows={rows} title="同一 Y 的模型比较" unitTitle="X 每高 1 个百分点，Y 平均相差（各行标注原始单位）" />}
    {notes.map((note, index) => <p className="muted" key={index}>{note}</p>)}
  </section>;
}

export function RegressionModelWorkbench({ stepNumber, outcome, defaultResponse, baselines, state, reportCustomResults, reportOutdated = false }: {
  stepNumber: number;
  outcome: RegressionOutcome;
  /** The course default model on this step's Y: the first column of the regression table. */
  defaultResponse: RegressionResponse;
  /** The Ys of the step's family the student may run a model on (the step's default Y among them). */
  baselines?: TeachingBaselineOption[];
  state: StepStateApi<WorkbenchStepState>;
  /** The model experiments the current report printed (its provenance). */
  reportCustomResults?: ReportedCustomResult[];
  reportOutdated?: boolean;
}) {
  const optionsQuery = useAsync<WorkbenchOptions>(() => api.regressionOptions(), ["regression-options"]);
  const options = optionsQuery.status === "success" ? optionsQuery.data ?? null : null;
  const experiment = state.data?.experiment ?? null;
  const draft = state.data?.custom_draft ?? {};
  const stepBaseline = defaultResponse.design.baseline ?? "";
  // The Y the models are run on: the step's Y unless the student chose another of the family. The first column is
  // then that Y's default model (computed once, cached by the server as the overview already computed it).
  const [yKey, setYKey] = useState<string>(draft.baseline ?? stepBaseline);
  const [defaultRuns, setDefaultRuns] = useState<Record<string, RegressionResponse>>({});
  const [yError, setYError] = useState<string | null>(null);
  const [loadingY, setLoadingY] = useState(false);
  const defaultForY: RegressionResponse | null = yKey === stepBaseline ? defaultResponse : defaultRuns[yKey] ?? null;
  const yOptions: Pick<TeachingBaselineOption, "key" | "label" | "default">[] = baselines?.length
    ? baselines
    : [{ key: stepBaseline, label: defaultResponse.design.depvar_label, default: true }];
  const yLabel = (key: string) => displayBaselineLabel(yOptions.find((item) => item.key === key)?.label ?? defaultRuns[key]?.design.depvar_label ?? key);
  // As the bars and the headline name it ("加权总度", not the schema's "加权总度（入+出）").
  const depvarLabel = displayBaselineLabel(defaultForY?.design.depvar_label ?? yLabel(yKey));
  const experimentY = experiment?.baseline ?? stepBaseline;
  useEffect(() => {
    setYError(null);
    if (yKey === stepBaseline || defaultRuns[yKey]) {
      setLoadingY(false);
      return;
    }
    const request = new AbortController();
    setLoadingY(true);
    api.runRegression(outcome, request.signal, yKey, null)
      .then((response) => {
        if (!request.signal.aborted) setDefaultRuns((current) => ({ ...current, [yKey]: response }));
      })
      .catch((cause) => {
        if (!request.signal.aborted && !(cause instanceof DOMException && cause.name === "AbortError")) setYError(userFacingRequestError(cause, "这个 Y 的默认模型没有算出结果"));
      })
      .finally(() => { if (!request.signal.aborted) setLoadingY(false); });
    return () => request.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- defaultRuns is read, not watched: a fetched Y stays.
  }, [yKey, stepBaseline, outcome]);
  const [localSpec, setLocalSpec] = useState<ModelSpec | null>(null);
  const spec = localSpec ?? draft.spec ?? options?.default_spec ?? null;
  const [computed, setComputed] = useState<RegressionResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rateLimitMessage = useRef<string | null>(null);
  // Read out once a calculation or a report change is done (the table changes without moving focus there).
  const [announcement, setAnnouncement] = useState("");
  const [detailColumn, setDetailColumn] = useState(0);
  // The custom form is folded: the presets are the first thing offered.
  const [customOpen, setCustomOpen] = useState(false);
  // The single-model table (coefficient, SE, t, p, significance, interval) is open: the course asked for it first.
  const [detailsOpen, setDetailsOpen] = useState(true);
  // A refused calculation (429) shows how long new models must wait. The button stays usable: a model computed before
  // (by anyone) is answered from the server's cache and not counted, and a new one is simply refused again.
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt == null) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= retryAt) {
        setRetryAt(null);
        setError((message) => message === rateLimitMessage.current ? null : message);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  const retryWait = retryAt == null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
  const controller = useRef<AbortController | null>(null);
  // Leaving the step (or the page) stops a calculation still running; its answer would land nowhere.
  useEffect(() => () => controller.current?.abort(), []);

  if (optionsQuery.status === "error") {
    return <div className="error-box" role="alert">可选的设定没有加载成功：{optionsQuery.error}<button type="button" className="secondary" onClick={optionsQuery.retry}>重试</button></div>;
  }
  if (!options || !spec) return <div className="reg-request-state muted" role="status" aria-busy="true">正在载入可选的设定…</div>;

  const perPoint = (stat: CoefStat, snapshot: CustomResultSnapshot) => perPointReading(outcome, stat, snapshot);
  const label = (model: ModelSpec) => experimentLabel(model, options);
  const changeSpec = (next: ModelSpec) => {
    setLocalSpec(next);
    // A refused calculation's message stays until its wait is over (the button counts down beside it).
    if (retryWait === 0) setError(null);
    state.saveView?.({ custom_draft: { ...draft, spec: next } });
  };
  /** Another Y of the family: the table starts again from that Y's default model (a computed model is on one Y). */
  const changeY = (key: string) => {
    if (key === yKey) return;
    controller.current?.abort();
    setYKey(key);
    setComputed(null);
    setDetailColumn(0);
    if (retryWait === 0) setError(null);
    state.saveView?.({ custom_draft: { ...draft, baseline: key === stepBaseline ? undefined : key } });
    setAnnouncement(`因变量改为“${yLabel(key)}”；表中第一列是它的默认模型。`);
  };
  // The computed model belongs to this form; otherwise it is kept but marked out of date.
  const current = Boolean(computed && sameSpec(computed.design.spec!, spec, options));
  const noX = spec.x_lags.length === 0;
  const staleMessage = computed && !current
    ? noX
      ? "下面保留最近计算的结果；请先选择至少一项关税暴露 X，再计算当前设定。"
      : "设定已更改，下面保留最近计算的结果；点“计算这个模型”查看新结果。"
    : "";
  const run = async (model: ModelSpec) => {
    if (!defaultForY || running || model.x_lags.length === 0) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setRunning(true);
    setError(null);
    try {
      const response = await api.runRegression(outcome, request.signal, yKey, canonicalSpec(model, options));
      if (response.model_snapshot?.version !== options.version || !response.design.spec) {
        throw new Error("页面版本已更新，请刷新页面后再计算");
      }
      setComputed(response);
      setDetailColumn(0);
      setAnnouncement(`已算出“${label(response.design.spec)}”，结果在下面的回归结果表中。`);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 429 && cause.retryAfter) {
        // Not a problem with the model: the student's calculations of the minute are used up.
        setNow(Date.now());
        setRetryAt(Date.now() + cause.retryAfter * 1000);
        rateLimitMessage.current = `计算太频繁：每分钟最多算 ${options.limits.runs_per_minute} 个新模型，新的设定请等倒计时结束；仍在服务器缓存中的设定不计次，现在就能算。`;
        setError(rateLimitMessage.current);
      } else if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(userFacingRequestError(cause, "这个模型没有算出结果"));
        if (cause instanceof ApiError && cause.status === 400) setComputed(null);
      }
    } finally {
      if (controller.current === request) controller.current = null;
      setRunning(false);
    }
  };
  /** A preset: its model goes into the form and is computed at once. */
  const runPreset = (model: ModelSpec) => {
    changeSpec(model);
    void run(model);
  };

  const computedSpec = current && computed ? computed.design.spec ?? null : null;
  const isDefault = Boolean(computedSpec && sameSpec(computedSpec, options.default_spec, options));
  const latest = computedSpec && !isDefault ? computed : null;
  const latestIsReported = Boolean(latest && experiment && experimentY === yKey && sameSpec(experiment.spec, latest.design.spec!, options));
  // Table columns: the chosen Y's default model, the model just computed, and the one in the report when it is
  // another model on this Y (on another Y it is only named below: two Ys cannot share a table).
  const columns: TableColumn[] = defaultForY ? [
    { name: DEFAULT_COLUMN, spec: options.default_spec, snapshot: snapshotOf(defaultForY) },
    ...(latest ? [{ name: `${latestIsReported ? "已记入报告" : "本次"}：${label(latest.design.spec!)}`, spec: latest.design.spec!, snapshot: snapshotOf(latest) }] : []),
    ...(experiment && experimentY === yKey && !latestIsReported ? [{ name: `已记入报告：${label(experiment.spec)}`, spec: experiment.spec, snapshot: experiment.snapshot }] : []),
  ] : [];
  const highlighted = latest ? 1 : isDefault ? 0 : -1;
  const coefficients = coefficientRows(columns, options);
  const pointRow = perPointRow(columns, outcome);
  const designRow = designValueRow(columns, outcome, yKey, options);
  const summary = summaryRows(columns, options);
  const latestColumn: TableColumn | null = computed && computed.design.spec
    ? { name: !current ? "上次计算（设定已更改）" : columns[highlighted]?.name ?? DEFAULT_COLUMN, spec: computed.design.spec, snapshot: snapshotOf(computed) }
    : null;
  const detailColumns = latestColumn ? [latestColumn, ...columns.filter((column) => !sameSpec(column.spec, latestColumn.spec, options))] : columns;
  const shownDetail = Math.min(detailColumn, detailColumns.length - 1);
  const reportChanged = Boolean(state.materialLocked && reportOutdated && experimentReportChanged(stepNumber, experiment, reportCustomResults, options, stepBaseline));
  const cellClass = (index: number) => (index === highlighted ? "reg-custom-current" : undefined);
  const putInReport = () => {
    if (!latest || latestIsReported) return;
    state.save({ experiment: {
      spec: latest.design.spec!, ...(yKey !== stepBaseline ? { baseline: yKey } : {}),
      saved_at: new Date().toISOString(), snapshot: snapshotOf(latest),
    } });
    setAnnouncement(`已把“${label(latest.design.spec!)}”记入报告${yKey !== stepBaseline ? `（Y：${depvarLabel}）` : ""}。`);
  };
  const removeFromReport = () => {
    if (!experiment) return;
    const name = label(experiment.spec);
    state.save({ experiment: null });
    setAnnouncement(`已把“${name}”从报告移除。`);
  };
  const activePreset = options.presets.find((item) => sameSpec(item.spec, spec, options))?.key ?? null;

  return (
    <div className="reg-custom">
      <p className="reg-custom-y">
        <label>因变量：
          {yOptions.length > 1
            ? (
              <select aria-label="因变量" value={yKey} disabled={running} onChange={(event) => changeY(event.target.value)}>
                {yOptions.map((item) => <option key={item.key} value={item.key}>{displayBaselineLabel(item.label)}{item.key === stepBaseline ? "（本步的 Y）" : ""}</option>)}
              </select>
            )
            : <b>{depvarLabel}</b>}
        </label>
        {yOptions.length > 1 && yKey === stepBaseline ? "" : yKey === stepBaseline ? "（本步的 Y）" : "（本步家族的另一个指标：表中第一列是它的默认模型；记入报告时一起记录）"}
        。每次只改一处设定，算出后和表中第一列的默认模型比较；只改一项也可能改变样本。
      </p>
      {loadingY && <p className="reg-request-state muted" role="status" aria-busy="true">正在取“{depvarLabel}”的默认模型…</p>}
      {yError && <div className="error-box async-error" role="alert">{yError}<button type="button" className="secondary" onClick={() => changeY(stepBaseline)}>改回本步的 Y</button></div>}
      <div className="reg-custom-presets" role="group" aria-label="预设实验">
        {(["core", "advanced"] as const).map((tier) => {
          const items = options.presets.filter((item) => (item.tier ?? "core") === tier);
          if (!items.length) return null;
          return (
            <div key={tier} className={`reg-preset-tier reg-preset-tier-${tier}`}>
              <h5 className="reg-preset-tier-title">{items[0].tier_label ?? (tier === "core" ? "必看" : "进阶")}</h5>
              <ul>
                {items.map((item) => (
                  <li key={item.key}>
                    <button type="button" className="reg-preset" aria-pressed={activePreset === item.key} aria-disabled={!defaultForY || running || undefined}
                      onClick={() => { if (defaultForY && !running) runPreset(item.spec); }}>
                      <b>{item.label}</b><small>{item.question}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {options.design_value_note && <p className="muted reg-design-note">{options.design_value_note}</p>}
      </div>
      <details className="reg-custom-details reg-custom-form-details" open={customOpen} onToggle={(event) => setCustomOpen(event.currentTarget.open)}>
        <summary>自定义设定（X 的滞后、8 个控制变量、固定效应）</summary>
        <ModelForm options={options} spec={spec} onChange={changeSpec} />
        <p className="reg-custom-equation" aria-live="polite">{noX ? "至少选一项关税暴露 X。" : equationPreview(spec, options)}</p>
        <div className="reg-custom-actions">
          <button type="button" className="run-btn" aria-disabled={!defaultForY || running || noX || undefined} onClick={() => void run(spec)}>
            {running ? "正在计算…" : "计算这个模型"}
          </button>
          <button type="button" className="secondary" onClick={() => changeSpec(options.default_spec)}>恢复默认设定</button>
        </div>
      </details>
      <div className="reg-custom-status">
        {running && <span className="muted reg-inline-status">正在计算…</span>}
        {retryWait > 0 && <span className="muted reg-custom-wait">新的设定 {retryWait} 秒后可以计算</span>}
        <span className="sr-only" role="status" aria-live="polite">{running ? "正在计算…" : staleMessage || announcement}</span>
      </div>
      {error && <div className="error-box async-error" role="alert">{error}</div>}
      {staleMessage && <p className="reg-stale-note" role="note">{staleMessage}</p>}
      {isDefault && <p className="muted reg-custom-default-note">这就是本步的默认模型（表中第一列）。</p>}

      {defaultForY && <>
      <ModelComparisonChart columns={columns} outcome={outcome} />

      <div className="reg-custom-compare">
        <h4>回归结果表（因变量：{depvarLabel}）</h4>
        <ScrollableRegion className="table-wrap" label="回归结果表，可横向滚动">
          <table className="data-table reg-custom-table reg-custom-compare-table">
            <thead><tr><th>变量</th>{columns.map((column, index) => <th key={index} scope="col" className={cellClass(index)}>{column.name}</th>)}</tr></thead>
            <tbody>
              {coefficients.filter((row) => row.key !== "_constant").map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  {row.cells.map((item, index) => (
                    <td key={index} className={cellClass(index)}>
                      {item === "omitted" ? <span className="muted">（省略）</span>
                        : item ? <><span>{item.coef}</span><br /><span className="muted">{item.se}</span></> : null}
                    </td>
                  ))}
                </tr>
              ))}
              {pointRow && (
                <tr className="reg-custom-point-row">
                  <th scope="row">{pointRow.label}</th>
                  {pointRow.cells.map((value, index) => <td key={index} className={cellClass(index)}>{value}</td>)}
                </tr>
              )}
              {designRow && (
                <tr className="reg-custom-design-row">
                  <th scope="row">{designRow.label}</th>
                  {designRow.cells.map((value, index) => <td key={index} className={cellClass(index)}>{value}</td>)}
                </tr>
              )}
              {coefficients.filter((row) => row.key === "_constant").map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  {row.cells.map((item, index) => (
                    <td key={index} className={cellClass(index)}>
                      {item && item !== "omitted" ? <><span>{item.coef}</span><br /><span className="muted">{item.se}</span></> : null}
                    </td>
                  ))}
                </tr>
              ))}
              {summary.map((row, index) => (
                <tr key={row.key} className={index === 0 ? "reg-custom-summary-start" : undefined}>
                  <th scope="row">{row.label}</th>
                  {row.cells.map((value, cell) => <td key={cell} className={cellClass(cell)}>{value}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollableRegion>
        <ul className="muted reg-custom-legend">
          {columns.map((column, index) => {
            const omitted = omittedSummary(column.snapshot, options);
            return <li key={index}><b>{column.name}</b>：{specSummary(column.spec, options)}{omitted.length ? `；已省略（${omitted.join("；")}）` : ""}{column.snapshot.result.suppressed ? `。${options.suppressed_note}` : ""}</li>;
          })}
        </ul>
        {samplesDiffer(columns) && <p className="reg-boundary" role="note">{options.sample_differs_note}</p>}
      </div>
      </>}

      {/* One model a step goes into the report: the one just computed replaces the one there. */}
      <div className="reg-custom-report">
        {latest && !latestIsReported && (
          <button type="button" className="secondary" onClick={putInReport}>
            {experiment ? `用“${label(latest.design.spec!)}”替换记入报告的模型` : `把“${label(latest.design.spec!)}”也记入报告（选做）`}
          </button>
        )}
        {experiment
          ? (
            <p className="reg-custom-report-chip" role="note">
              <span>已记入报告：<b>{label(experiment.spec)}</b>（{specSummary(experiment.spec, options)}{experimentY !== stepBaseline ? `；Y：${yLabel(experimentY)}` : ""}）</span>
              <span aria-hidden="true"> · </span>
              <button type="button" className="link-button danger" onClick={removeFromReport}>从报告移除</button>
            </p>
          )
          : <p className="muted reg-custom-report-none">还没有记入报告的模型实验（选做）：算出一个模型后点“也记入报告”，报告附录“模型实验”会把它和默认模型并列。</p>}
        {state.materialLocked && (
          <p className="reg-rerun-warning" role="note"><b>报告已提交</b>记入、替换或移除报告里的模型都会改变报告；之后要到步骤 15 更新报告，并重新提交给老师。</p>
        )}
        {reportChanged && <p className="reg-rerun-warning reg-replaced-notice" role="status">记入报告的模型与已提交报告里的不同；请到步骤 15 更新报告并重新提交给老师。</p>}
      </div>

      {defaultForY && <details className="reg-custom-details" aria-label="单模型详细数字" open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
        <summary>单模型详细数字（系数、标准误、t 值、p 值、显著性、区间）与导出 CSV{staleMessage ? " · 当前设定待重算" : ""}</summary>
        <label className="reg-custom-detail-pick">查看
          <select value={shownDetail} onChange={(event) => setDetailColumn(Number(event.target.value))}>
            {detailColumns.map((column, index) => <option key={index} value={index}>{column.name}</option>)}
          </select>
        </label>
        <p><b>{detailColumns[shownDetail].name}</b>：{specSummary(detailColumns[shownDetail].spec, options)}</p>
        {staleMessage && <p className="reg-stale-note">当前设定待重算；以下数字仅对应上方选中的结果及其设定。</p>}
        <ColumnDetails column={detailColumns[shownDetail]} options={options} perPoint={perPoint} />
        {detailColumns[shownDetail].snapshot.result.suppressed && <p className="reg-stale-note">{options.suppressed_note}</p>}
        {omittedSummary(detailColumns[shownDetail].snapshot, options).map((note) => <p className="muted" key={note}>{note}</p>)}
        <p className="muted">系数按 X 以份额计（1 = 100 个百分点）；最后一列换算为 X 每高 1 个百分点。{xSpanLabel(detailColumns[shownDetail].spec)}；括号内为标准误，星号含义见表下注释。{detailColumns[shownDetail].spec.fixed_effects.length ? "带固定效应的模型没有常数项：各单位和各年的截距已被固定效应吸收。" : ""}</p>
        <button type="button" className="secondary" onClick={() => download(comparisonCsv(columns, options, depvarLabel, pointRow, designRow), `步骤${stepNumber}-回归对比.csv`)}>
          导出 CSV（上面的回归结果表）
        </button>
      </details>}

      <p className="muted reg-custom-footnote">{options.footnote}{options.hints[1] ? ` ${options.hints[1]}` : ""}</p>
    </div>
  );
}
