/**
 * 改模型、对比 (the workbench of steps 11–14): folded under the step's quiz. The student runs one preset experiment
 * (each changes one setting of the course default model) or a custom setting, reads it in one regression table next
 * to the default model, and may put one model a step into the report (whose appendix recomputes it from the model).
 */
import { useEffect, useId, useRef, useState } from "react";
import { ScrollableRegion } from "./a11y";
import { groupedFixed } from "./format";
import { POSITION_UNIT_WORDS } from "./regression-verdict";
import { api, ApiError } from "./api";
import { useAsync } from "./labs/shared";
import {
  canonicalSpec,
  coefficientRows,
  comparisonCsv,
  equationPreview,
  shownModelLabel,
  chartModelLabel,
  fixed4,
  includedBy,
  omittedSummary,
  perPointDigits,
  sharedPerPointDigits,
  perPointReading,
  perPointRow,
  sameSpec,
  samplesDiffer,
  significanceStars,
  designValueRow,
  snapshotOf,
  specSummary,
  summaryRows,
  termLabel,
  type TableColumn,
  X_COLUMNS,
  xSum,
  xSpanLabel,
  experimentReportChanged,
  comparisonAxisTitle,
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

function ModelForm({ options, spec, onChange, disabled = false }: {
  options: WorkbenchOptions; spec: ModelSpec; onChange: (spec: ModelSpec) => void;
  /** While a model is computed: the settings stay those of the model being computed. */
  disabled?: boolean;
}) {
  // Each choice is named by its label alone; its explanation is read as the description, not as part of the name
  // (the country × year effect's ran to some 180 characters).
  const uid = useId();
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
    // One outer fieldset, so `disabled` locks every choice at once.
    <fieldset className="reg-custom-form" disabled={disabled}>
      <fieldset>
        <legend>关税暴露 X（至少选一项）</legend>
        {options.x_lags.map((item) => (
          <label key={item.lag} className="reg-custom-choice">
            <input type="checkbox" checked={spec.x_lags.includes(item.lag)} onChange={() => toggleLag(item.lag)}
              aria-label={item.label} aria-describedby={`${uid}-x${item.lag}`} />
            <span><b>{item.label}</b><small id={`${uid}-x${item.lag}`}>{item.description}</small></span>
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
                <input type="checkbox" checked={Boolean(chosen)} onChange={() => toggleControl(item.name)}
                  aria-label={item.label} aria-describedby={`${uid}-c-${item.name}`} />
                <span><b>{item.label}</b><small id={`${uid}-c-${item.name}`}>{item.definition} · {item.source}</small></span>
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
        <p className="reg-custom-note">控制变量不是越多越好：本身会受关税影响的变量（如按 ICIO 计算的制造业增加值占比、出口强度）放进模型，可能把 X 的一部分关联“控制掉”。课程数据里这些变量与 Y 无关，加上后结果几乎不变；真实研究中要先想清楚因果顺序。</p>
      </fieldset>
      <fieldset>
        <legend>固定效应（FE）</legend>
        {options.fixed_effects.map((item) => {
          const parent = includedBy(item.key, spec.fixed_effects, options);
          return (
            <label key={item.key} className={parent ? "reg-custom-choice reg-custom-included" : "reg-custom-choice"} title={item.description}>
              <input
                type="checkbox"
                checked={parent != null || spec.fixed_effects.includes(item.key)}
                disabled={parent != null}
                onChange={() => toggleEffect(item.key)}
                aria-label={item.label}
                aria-describedby={`${uid}-fe-${item.key}`}
              />
              <span><b>{item.label}</b><small id={`${uid}-fe-${item.key}`}>{parent ? `已包含在${parent}${/[A-Za-z]$/.test(parent) ? " " : ""}中` : item.description}</small></span>
            </label>
          );
        })}
        <p className="muted reg-custom-note">{options.no_fixed_effects_note}</p>
        {spec.fixed_effects.includes("country_year") && <p className="reg-custom-note">吸收不等于没有控制：国家年度变化由固定效应扣除，因此不再单独估计这些控制变量的系数。</p>}
        {/* Country × year effects match the default only on top of country × industry ones: alone, each unit's own
            level is left in, and on the course data the total can even change sign (step 11: +0.08 against -0.55). */}
        {spec.fixed_effects.includes("country_year") && !spec.fixed_effects.includes("country_industry") && (
          <p className="reg-custom-note">没有勾国家×行业 FE：各国家×行业自身的水平差异没有扣除，X 合计可能和默认模型差很多。</p>
        )}
      </fieldset>
    </fieldset>
  );
}

/** One column's every number: coefficient, SE, t, p and the 95% interval of each term, the sum included. */
export function ColumnDetails({ column, options, perPoint, digits }: {
  column: TableColumn; options: WorkbenchOptions; perPoint: (stat: CoefStat, snapshot: CustomResultSnapshot, digits?: number) => string;
  /** One set of decimals for the column's per-point readings (-0.180 and -0.099, not -0.18 beside -0.099). */
  digits?: number;
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
        <thead><tr><th scope="col">变量</th><th scope="col">系数</th><th scope="col">标准误</th><th scope="col">t 值</th><th scope="col">p 值</th><th scope="col">显著性</th><th scope="col">95% 区间</th><th scope="col">X 每高 1 个百分点</th></tr></thead>
        <tbody>
          {rows.map((coef) => (
            <tr key={coef.name}>
              <th scope="row">{termLabel(coef.name, options)}</th>
              <td>{fixed4(coef.coef)}</td>
              <td>{result.suppressed ? "—" : `(${fixed4(coef.se)})`}</td>
              <td>{result.suppressed || coef.t == null ? "—" : groupedFixed(coef.t, 2)}</td>
              <td>{result.suppressed ? "—" : formatPValue(coef.p)}</td>
              <td>{result.suppressed ? "—" : significanceStars(coef.p) || "—"}</td>
              <td>{result.suppressed || coef.ci_low == null || coef.ci_high == null ? "—" : `[${fixed4(coef.ci_low)}, ${fixed4(coef.ci_high)}]`}</td>
              {/* The page's reading for each X term and their sum (the result card's 当年 / 次年 split); a control
                  is not "per point of X". */}
              <td>{coef.name === "cumulative" || Object.values(X_COLUMNS).includes(coef.name) ? perPoint(coef, column.snapshot, digits) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollableRegion>
  );
}

/** Said when a change to the report cannot be saved: another tab saved a newer record first. */
const CONFLICT_SAVE_NOTE = "这次改动没有保存：你的账号在别处保存了更新的记录，请按页面顶部的说明处理。";

export function ModelComparisonChart({ columns, outcome }: { columns: TableColumn[]; outcome: RegressionOutcome }) {
  const rows: DivergingBarRow[] = [];
  const notes: string[] = [];
  // Every row at the first column's decimals, as the table's "合计" row (+0.08 there was +0.084 here).
  const first = columns.find((column) => xSum(column.snapshot, column.spec));
  const sharedDigits = first ? sharedPerPointDigits(columns, outcome) : undefined;
  for (const [index, column] of columns.entries()) {
    const stat = xSum(column.snapshot, column.spec);
    const result = column.snapshot.result;
    if (result.suppressed || !stat || !Number.isFinite(stat.coef) || stat.ci_low == null || stat.ci_high == null
      || !Number.isFinite(stat.ci_low) || !Number.isFinite(stat.ci_high)) {
      notes.push(`${column.name}：${result.suppressed ? "停止推断" : "未取得完整的 X 效应与区间"}，不绘制对应模型；请查看结果表和省略原因。`);
      continue;
    }
    const scale = column.snapshot.depvar_kind === "share" ? 1 : 0.01;
    // The interval ends at the estimate's own decimals (not each end's own, which printed 5–7 digits).
    const digits = sharedDigits ?? perPointDigits(outcome, stat, column.snapshot);
    const end = (coef: number) => perPointReading(outcome, { ...stat, coef }, column.snapshot, digits);
    const interval = `${end(stat.ci_low)} 至 ${end(stat.ci_high)}`;
    const reading = perPointReading(outcome, stat, column.snapshot, digits);
    rows.push({
      key: String(index), label: column.chartName ?? column.name,
      sublabel: `${xSpanLabel(column.spec)}${column.snapshot.depvar_kind === "position" ? ` · ${POSITION_UNIT_WORDS}` : ""} · N=${result.n_obs.toLocaleString("zh-CN")} · ${result.years?.join("–") ?? "年份未提供"}`,
      value: stat.coef * scale, low: stat.ci_low * scale, high: stat.ci_high * scale,
      uncertain: stat.ci_low <= 0 && stat.ci_high >= 0,
      valueLabel: reading,
      // The tooltip names the row "95% 区间" itself.
      intervalLabel: interval,
      // A shortened row name ("自定义（9 处改动）"): the model in full in the tooltip and when read aloud.
      ...(column.chartName && column.chartName !== column.name ? { note: `完整设定：${column.name}` } : {}),
      spokenLabel: `${reading}，95% 区间：${interval}，${xSpanLabel(column.spec)}${column.chartName && column.chartName !== column.name ? `；完整设定：${column.name}` : ""}`,
    });
  }
  return <section aria-label="同一因变量的模型比较">
    <h4>同一个 Y，换模型后怎样变？</h4>
    <p className="muted">每行一个模型：X 各项合计及 95% 区间，行下注明所含期数和样本。</p>
    {samplesDiffer(columns) && <p className="reg-stale-note">这几列的样本不同，差异有一部分来自样本，而不只是设定。</p>}
    {rows.length > 0 && <DivergingBarChart rows={rows} title="同一 Y 的模型比较" unitTitle={comparisonAxisTitle(columns.some((column) => column.snapshot.depvar_kind === "position"))} />}
    {columns.some((column) => column.chartName && column.chartName !== column.name) && (
      <p className="muted">图中较长的自定义模型只写改动处数，完整设定见下方结果表的列名（行的顺序与列相同）。</p>
    )}
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
  // This step's material did not reach the server (another tab saved first, or the network failed): the model in the
  // box is this page's choice, not yet the report's, so it is not called "已记入报告".
  const reportUnsaved = Boolean(state.materialSyncError);
  // Another save of this page (a draft) met a newer record: the model shown may not be the report's any more.
  const reportStale = !reportUnsaved && Boolean(state.syncConflict);
  const reportedWord = reportUnsaved ? "记入报告（未保存）" : reportStale ? "已记入报告（可能已过期）" : "已记入报告";
  const unsavedNote = reportStale
    ? "你的账号在别处保存了更新的记录，这里显示的可能不是报告里现在的模型；请按页面顶部的说明处理。"
    : state.syncConflict ? CONFLICT_SAVE_NOTE : "这次改动还没有保存成功，请稍后重试同步。";
  const draft = state.data?.custom_draft ?? {};
  const stepBaseline = defaultResponse.design.baseline;
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
  // The model being computed, named by the status line (the form is locked meanwhile, but a preset sets it too).
  const [runningSpec, setRunningSpec] = useState<ModelSpec | null>(null);
  // Each preset's total as computed in this visit, by Y: the next preset's question compares with an earlier one
  // ("和去掉汇率变动偏向同一边吗？"), whose column has left the table by then.
  const [presetTotals, setPresetTotals] = useState<Record<string, string>>({});
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
  // Every hook stays above the early returns below (the options load after the first render).
  const reportBoxRef = useRef<HTMLElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  // Leaving the step (or the page) stops a calculation still running; its answer would land nowhere.
  useEffect(() => () => controller.current?.abort(), []);

  if (optionsQuery.status === "error") {
    return <div className="error-box" role="alert">可选的设定没有加载成功：{optionsQuery.error}<button type="button" className="secondary" onClick={optionsQuery.retry}>重试</button></div>;
  }
  if (!options || !spec) return <div className="reg-request-state muted" role="status" aria-busy="true">正在载入可选的设定…</div>;

  const perPoint = (stat: CoefStat, snapshot: CustomResultSnapshot, digits?: number) => perPointReading(outcome, stat, snapshot, digits);
  const label = (model: ModelSpec) => shownModelLabel(model, options);
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
    // As the note by the select says: the comparison starts again from this Y's default model, form included.
    setLocalSpec(options.default_spec);
    setDetailColumn(0);
    if (retryWait === 0) setError(null);
    state.saveView?.({ custom_draft: { baseline: key === stepBaseline ? undefined : key } });
    setAnnouncement(`因变量改为“${yLabel(key)}”；表中第一列是它的默认模型。`);
  };
  // The computed model belongs to this form; otherwise it is kept but marked out of date.
  const current = Boolean(computed && sameSpec(computed.design.spec!, spec, options));
  const noX = spec.x_lags.length === 0;
  // The computed model no longer matches the form (the details table says so).
  // The form's settings differ from the last computed model; whether they are shown anyway (the default model, the
  // reported one) is settled below (inStep), and only then are the details "待重算".
  const computedDiffers = Boolean(computed && !current);
  const run = async (model: ModelSpec) => {
    if (!defaultForY || running || model.x_lags.length === 0) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setRunning(true);
    setRunningSpec(model);
    setError(null);
    try {
      const response = await api.runRegression(outcome, request.signal, yKey, canonicalSpec(model, options));
      if (response.model_snapshot?.version !== options.version || !response.design.spec) {
        throw new Error("页面版本已更新，请刷新页面后再计算");
      }
      setComputed(response);
      setDetailColumn(0);
      const preset = options.presets.find((item) => sameSpec(item.spec, response.design.spec!, options));
      const snapshot = snapshotOf(response);
      const total = preset ? xSum(snapshot, response.design.spec!) : null;
      if (preset && total) setPresetTotals((all) => ({ ...all, [`${yKey}:${preset.key}`]: perPoint(total, snapshot) }));
      // The status line (a live region) says what was computed; no second announcement.
      setAnnouncement("");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 429 && cause.retryAfter) {
        // Not a problem with the model: the student's calculations of the minute are used up.
        setNow(Date.now());
        setRetryAt(Date.now() + cause.retryAfter * 1000);
        rateLimitMessage.current = `计算太频繁：每分钟最多算 ${options.limits.runs_per_minute} 个新模型，新的设定请等倒计时结束；仍在服务器缓存中的设定不计次，现在就能算。`;
        setError(rateLimitMessage.current);
      } else if (!request.signal.aborted) {
        // A request this page cancelled (a newer one replaced it) is not an error, whatever the client threw for it.
        setError(userFacingRequestError(cause, "这个模型没有算出结果"));
        if (cause instanceof ApiError && cause.status === 400) setComputed(null);
      }
    } finally {
      // Only the latest request ends the computing state: a cancelled earlier one must not clear a newer one's.
      if (controller.current === request) {
        controller.current = null;
        setRunning(false);
        setRunningSpec(null);
      }
    }
  };
  /** A preset: its model goes into the form and is computed at once. */
  const runPreset = (model: ModelSpec) => {
    changeSpec(model);
    void run(model);
  };

  // The model computed last, in its own column unless the default column already shows it; after the form changed
  // it stays there (as the stale message says), named as computed before the change.
  const computedSpec = computed?.design.spec ?? null;
  const shown = computedSpec && !sameSpec(computedSpec, options.default_spec, options) ? computed : null;
  const isDefault = Boolean(current && computedSpec && !shown);
  const latest = current ? shown : null;
  const shownIsReported = Boolean(shown && experiment && experimentY === yKey && sameSpec(experiment.spec, shown.design.spec!, options));
  const latestIsReported = Boolean(latest) && shownIsReported;
  // Table columns: the chosen Y's default model, the model computed last, and the one in the report when it is
  // another model on this Y (on another Y it is only named below: two Ys cannot share a table).
  const columns: TableColumn[] = defaultForY ? [
    { name: DEFAULT_COLUMN, spec: options.default_spec, snapshot: snapshotOf(defaultForY) },
    ...(shown ? [{
      name: `${shownIsReported ? reportedWord : current ? "本次" : "上次计算"}：${label(shown.design.spec!)}`,
      chartName: `${shownIsReported ? reportedWord : current ? "本次" : "上次计算"}：${chartModelLabel(label(shown.design.spec!))}`,
      spec: shown.design.spec!, snapshot: snapshotOf(shown), reported: shownIsReported,
    }] : []),
    ...(experiment && experimentY === yKey && !shownIsReported ? [{
      name: `${reportedWord}：${label(experiment.spec)}`, chartName: `${reportedWord}：${chartModelLabel(label(experiment.spec))}`,
      spec: experiment.spec, snapshot: experiment.snapshot, reported: true,
    }] : []),
  ] : [];
  const highlighted = latest ? 1 : isDefault ? 0 : -1;
  const coefficients = coefficientRows(columns, options);
  const pointRow = perPointRow(columns, outcome);
  const designRow = designValueRow(columns, outcome, yKey, options);
  const summary = summaryRows(columns, options);
  const latestColumn: TableColumn | null = computed && computed.design.spec
    ? { name: !current ? "上次计算" : columns[highlighted]?.name ?? DEFAULT_COLUMN, spec: computed.design.spec, snapshot: snapshotOf(computed) }
    : null;
  const detailColumns = latestColumn ? [latestColumn, ...columns.filter((column) => !sameSpec(column.spec, latestColumn.spec, options))] : columns;
  const shownDetail = Math.min(detailColumn, detailColumns.length - 1);
  const reportChanged = Boolean(state.materialLocked && reportOutdated && experimentReportChanged(stepNumber, experiment, reportCustomResults, options, stepBaseline));
  const cellClass = (index: number) => (index === highlighted ? "reg-custom-current" : undefined);
  // The add/replace/remove button unmounts on click: keep keyboard focus in the report box, not on the page body.
  const focusReportBox = () => window.requestAnimationFrame(() => reportBoxRef.current?.focus({ preventScroll: true }));
  const putInReport = () => {
    if (!latest || latestIsReported) return;
    focusReportBox();
    state.save({ experiment: {
      spec: latest.design.spec!, ...(yKey !== stepBaseline ? { baseline: yKey } : {}),
      saved_at: new Date().toISOString(), snapshot: snapshotOf(latest),
    } });
    // With another tab's newer record on the server this save cannot go through: said, not "已把…记入报告".
    setAnnouncement(state.syncConflict ? CONFLICT_SAVE_NOTE : `已把“${label(latest.design.spec!)}”记入报告${yKey !== stepBaseline ? `（Y：${depvarLabel}）` : ""}。`);
  };
  const removeFromReport = () => {
    if (!experiment) return;
    focusReportBox();
    const name = label(experiment.spec);
    state.save({ experiment: null });
    setAnnouncement(state.syncConflict ? CONFLICT_SAVE_NOTE : `已把“${name}”从报告移除。`);
  };
  const activePreset = options.presets.find((item) => sameSpec(item.spec, spec, options))?.key ?? null;
  const noDesignValue = options.design_values[outcome]?.[yKey] === null;
  // A Y the course data leave unrelated to X (design value 0): "how far from the design value" reads as "is 0 still in".
  const zeroDesignValue = options.design_values[outcome]?.[yKey] === 0;

  // The report's appendix takes one model a step: right under the comparison, where the model was just read; shown
  // also while another Y's default model loads or fails, so the recorded model can still be seen or removed.
  const reportBox = (
      <section className="reg-custom-report" ref={reportBoxRef} tabIndex={-1} aria-label="记入报告（选做）">
        <h4>记入报告（选做）</h4>
        {(reportUnsaved || reportStale) && <p className="reg-rerun-warning" role="alert">{unsavedNote}</p>}
        {experiment
          ? (
            <p className={`reg-custom-report-chip${reportUnsaved || reportStale ? " reg-custom-report-chip-unsaved" : ""}`} role="note">
              <span>{reportedWord}：<b>{label(experiment.spec)}</b>（{specSummary(experiment.spec, options)}{experimentY !== stepBaseline || experimentY !== yKey ? `；Y：${yLabel(experimentY)}` : ""}）</span>
              <span aria-hidden="true"> · </span>
              <button type="button" className="link-button danger" onClick={removeFromReport}>从报告移除</button>
            </p>
          )
          : <p className="muted reg-custom-report-none">{latest ? "报告附录会把它和默认模型并列；每步最多记入一个模型。" : "算出一个模型后，可以把它记入报告附录，和默认模型并列（每步最多一个）。"}</p>}
        {latest && !latestIsReported && (() => {
          // A shortened name on the button: the two models in full on hover and for screen readers.
          const shortened = chartModelLabel(label(latest.design.spec!)) !== label(latest.design.spec!)
            || Boolean(experiment && chartModelLabel(label(experiment.spec)) !== label(experiment.spec));
          const full = `本次的模型：${label(latest.design.spec!)}${experiment ? `；已记入报告的模型：${label(experiment.spec)}` : ""}`;
          return <>
            {shortened && <span id={`reg-report-models-${stepNumber}`} className="sr-only">{full}</span>}
            <button type="button" className="primary" onClick={putInReport} title={shortened ? full : undefined}
              aria-describedby={shortened ? `reg-report-models-${stepNumber}` : undefined}>
              {/* A long custom name is shortened as in the chart; the column above it carries the full name. */}
              {experiment
                ? `用“${chartModelLabel(label(latest.design.spec!))}”${yKey !== experimentY ? `（Y：${depvarLabel}）` : ""}替换记入报告的模型`
                : `把“${chartModelLabel(label(latest.design.spec!))}”记入报告`}
            </button>
          </>;
        })()}
        {state.materialLocked && !reportChanged && (
          <p className="reg-rerun-warning" role="note"><b>报告已提交</b>记入、替换或移除模型都会改变报告；之后要到步骤 15 更新报告并重新提交，如已评分，评分和评语会被清除。</p>
        )}
        {reportChanged && <p className="reg-rerun-warning reg-replaced-notice" role="status">记入报告的模型与已提交报告里的不同；请到步骤 15 更新报告并重新提交给老师（如已评分，评分和评语会被清除）。</p>}
      </section>
  );

  // One line above the results says what they are and whether they follow the settings on screen. The settings are
  // "in step" when the table already shows them: the default model (always the first column) or the model computed last.
  const defaultSettings = sameSpec(spec, options.default_spec, options);
  // The model in the report on this Y is a column too: its settings in the form are shown below, not "uncomputed".
  const reportedSettings = Boolean(experiment && experimentY === yKey && sameSpec(experiment.spec, spec, options));
  const inStep = Boolean(defaultForY) && (defaultSettings || current || reportedSettings);
  // Shown only from what the report saved (not computed in this visit): it can still be computed again, e.g. after
  // the course data were updated.
  const reportedOnly = inStep && !defaultSettings && !current;
  const stale = computedDiffers && !inStep;
  // Back on the page: the form holds the settings left last time (the draft is saved, results are not), so they are
  // not "never computed", only not computed in this visit.
  const restoredDraft = !inStep && !computed && localSpec === null && Boolean(draft.spec);
  // The other columns by their models: "“去掉汇率变动”", "已记入报告的“自定义：加 L2.X”".
  const otherColumns = columns.slice(1).map((column) => `${column.reported ? `${reportedWord}的` : ""}“${chartModelLabel(label(column.spec))}”`);
  const status: { kind: "busy" | "stale" | "done" | "idle"; text: string } = running
    ? { kind: "busy", text: `正在计算“${label(runningSpec ?? spec)}”…` }
    : loadingY ? { kind: "busy", text: `正在取“${depvarLabel}”的默认模型…` }
    : !defaultForY ? { kind: "idle", text: `“${depvarLabel}”的默认模型还没有取到，下面暂时没有结果（见上方提示）。` }
    : !inStep
      ? { kind: "stale", text: `${restoredDraft
        ? `勾选框里是你上次离开时的设定“${chartModelLabel(label(spec))}”；离开页面后结果不保留，点计算可重新算出`
        : "勾选框里的设定还没有计算"}${noX ? "（至少要选一项关税暴露 X）" : ""}。${otherColumns.length
        ? `下面仍是之前的结果：默认模型、${otherColumns.join("、")}。`
        : "下面仍只有默认模型。"}` }
    : latest ? { kind: "done", text: `下面比较：默认模型 和 “${label(latest.design.spec!)}”（已算好）${otherColumns.length > 1 ? `；另有${otherColumns.slice(1).join("、")}` : ""}。` }
    : !defaultSettings ? { kind: "done", text: `勾选框里是${reportedWord}的“${label(spec)}”，结果就在下面它的那一列。` }
    : otherColumns.length ? { kind: "idle", text: `勾选框里是默认模型（第一列）。下面另有${otherColumns.join("、")}；点一个预设实验，或改设定后计算，可再比较一个模型。` }
    : { kind: "idle", text: `下面是“${depvarLabel}”的默认模型。点一个预设实验，或改设定后计算，旁边会多出一列用来比较。` };

  return (
    <div className="reg-custom">
      <p className="reg-custom-y">
        <label>因变量 Y：
          {yOptions.length > 1
            ? (
              <select aria-label="因变量" value={yKey} disabled={running} onChange={(event) => changeY(event.target.value)}>
                {yOptions.map((item) => <option key={item.key} value={item.key}>{displayBaselineLabel(item.label)}{item.key === stepBaseline ? "（本步的 Y）" : ""}</option>)}
              </select>
            )
            : <b>{depvarLabel}</b>}
        </label>
        {yKey !== stepBaseline && <span className="muted">换了 Y 后，下面从这个 Y 的默认模型重新开始比较。</span>}
      </p>
      {yError && <div className="error-box async-error" role="alert">{yError}<button type="button" className="secondary" onClick={() => changeY(stepBaseline)}>改回本步的 Y</button></div>}
      <div className="reg-custom-presets" role="group" aria-label="预设实验">
        <h4 className="reg-custom-way">方式一：点一个预设实验<span className="sr-only">，</span><small>每个只改默认模型的一处，点了就计算</small></h4>
        {(["core", "advanced"] as const).map((tier) => {
          const items = options.presets.filter((item) => (item.tier ?? "core") === tier);
          if (!items.length) return null;
          return (
            <div key={tier} className={`reg-preset-tier reg-preset-tier-${tier}`}>
              <h5 className="reg-preset-tier-title">{items[0].tier_label ?? (tier === "core" ? "必看" : "进阶")}</h5>
              <ul>
                {items.map((item) => (
                  <li key={item.key}>
                    <button type="button" className="reg-preset" aria-pressed={Boolean(latest) && activePreset === item.key} aria-disabled={!defaultForY || running || undefined}
                      onClick={() => { if (defaultForY && !running) runPreset(item.spec); }}>
                      <b>{item.label}</b><span className="sr-only">，</span><small>{(item.key === "no_exchange_rate" || item.key === "separate_effects") && (noDesignValue || zeroDesignValue)
                        ? noDesignValue ? "与同一 Y 的默认模型相比，X 各项合计和区间怎样变化？" : "X 各项合计的区间还包含 0 吗？"
                        : item.question}</small>
                      {presetTotals[`${yKey}:${item.key}`] && <small className="reg-preset-total">本次打开后算过：合计 {presetTotals[`${yKey}:${item.key}`]}</small>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <details className="reg-custom-details reg-custom-form-details" open={customOpen} onToggle={(event) => setCustomOpen(event.currentTarget.open)}>
        <summary>方式二：自己改设定<span className="sr-only">，</span><small>X 的滞后、控制变量、固定效应；改完点“计算这个模型”</small></summary>
        <p className="reg-custom-start">勾选框里是要计算的设定：<b>{label(spec)}</b>（{inStep ? "结果已在下面" : restoredDraft ? "上次离开时的设定，结果不保留，需重新计算" : "还没有计算"}）。在它的基础上改，改完点“计算这个模型”。</p>
        <ModelForm options={options} spec={spec} onChange={changeSpec} disabled={running} />
        {noX ? <p className="reg-custom-note">至少选一项关税暴露 X。</p> : <p className="reg-custom-equation">{equationPreview(spec, options)}</p>}
        <div className="reg-custom-actions">
          <button type="button" className="run-btn" aria-disabled={!defaultForY || running || noX || (inStep && !reportedOnly) || undefined} onClick={() => { if (!inStep || reportedOnly) void run(spec); }}>
            {running ? "正在计算…" : reportedOnly ? "重新计算这个模型" : inStep ? "已算好（结果在下面）" : "计算这个模型"}
          </button>
          <button type="button" className="secondary" aria-disabled={running || undefined} onClick={() => { if (!running) changeSpec(options.default_spec); }}>恢复默认设定</button>
          {retryWait > 0 && <span className="muted reg-custom-wait">新的设定 {retryWait} 秒后可以计算</span>}
        </div>
      </details>
      {/* The countdown sits with the message that asks to wait for it (the form beside it may be folded). */}
      {error && (
        <div className="error-box async-error">
          <span role="alert">{error}</span>
          {/* Outside the alert, so the countdown is not read out again every second. */}
          {error === rateLimitMessage.current && retryWait > 0 && <span className="reg-custom-wait-inline"> 还需等 {retryWait} 秒。</span>}
        </div>
      )}
      <div ref={statusRef} tabIndex={-1} className={`reg-custom-status reg-custom-status-${status.kind}`} role="status" aria-live="polite" aria-busy={status.kind === "busy" || undefined}>
        <span>{status.text}</span>
        {status.kind === "stale" && !noX && !customOpen && (
          <button type="button" className="primary" aria-disabled={!defaultForY || running || undefined} onClick={(event) => {
            // The button leaves with the "uncomputed" state it belongs to: focus goes to the status line, which then
            // says the model is being computed, instead of being lost to the page.
            if (document.activeElement === event.currentTarget) statusRef.current?.focus({ preventScroll: true });
            void run(spec);
          }}>计算当前设定</button>
        )}
      </div>
      <span className="sr-only" role="status">{announcement}</span>
      {noDesignValue
        ? <p className="muted reg-design-note">当前 Y 是比值指标，没有单一的课程设定值：只和同一 Y 的默认模型比较 X 各项合计及区间。</p>
        : <p className="muted reg-design-note">{options.design_value_note}</p>}

      {!defaultForY && reportBox}
      {defaultForY && <>
      <ModelComparisonChart columns={columns} outcome={outcome} />

      {reportBox}

      <div className="reg-custom-compare">
        <h4>回归结果表（因变量：{depvarLabel}）</h4>
        <ScrollableRegion className="table-wrap" label="回归结果表，可横向滚动">
          <table className={`data-table reg-custom-table reg-custom-compare-table${columns.length === 1 ? " reg-custom-table-single" : ""}`}>
            <thead><tr><th scope="col">变量</th>{columns.map((column, index) => <th key={index} scope="col" className={cellClass(index)}>{column.name}</th>)}</tr></thead>
            <tbody>
              {coefficients.filter((row) => row.key !== "_constant").map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  {row.cells.map((item, index) => (
                    <td key={index} className={cellClass(index)}>
                      {item === "omitted" ? <span className="muted">（省略）</span>
                        : item ? <><span>{item.coef}</span><br /><span className="muted">{item.se}</span></> : <span className="muted" title="这个模型没有放入这一项">—</span>}
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
                      {item && item !== "omitted" ? <><span>{item.coef}</span><br /><span className="muted">{item.se}</span></> : <span className="muted" title="这个模型没有报告这一项">—</span>}
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
        {columns.some((column) => canonicalSpec(column.spec, options).x_lags.length === 1) && (
          <p className="reg-boundary" role="note">{options.current_x_only_note}</p>
        )}
      </div>
      </>}

      {defaultForY && <details className="reg-custom-details" aria-label="单模型详细数字" open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
        <summary>单模型详细数字（系数、标准误、t 值、p 值、显著性、区间）与导出 CSV{stale ? " · 当前设定待重算" : ""}</summary>
        <label className="reg-custom-detail-pick">查看
          <select value={shownDetail} onChange={(event) => setDetailColumn(Number(event.target.value))}>
            {detailColumns.map((column, index) => <option key={index} value={index}>{column.name}</option>)}
          </select>
        </label>
        <p><b>{detailColumns[shownDetail].name}</b>：{specSummary(detailColumns[shownDetail].spec, options)}</p>
        {stale && <p className="reg-stale-note">当前设定待重算；以下数字仅对应上方选中的结果及其设定。</p>}
        <ColumnDetails column={detailColumns[shownDetail]} options={options} perPoint={perPoint} digits={(() => {
          const { snapshot } = detailColumns[shownDetail];
          const terms = [...snapshot.result.coefs.filter((item) => Object.values(X_COLUMNS).includes(item.name)), ...(snapshot.result.cumulative ? [snapshot.result.cumulative] : [])];
          return terms.length ? Math.max(...terms.map((term) => perPointDigits(outcome, term, snapshot))) : undefined;
        })()} />
        {detailColumns[shownDetail].snapshot.result.suppressed && <p className="reg-stale-note">{options.suppressed_note}</p>}
        {omittedSummary(detailColumns[shownDetail].snapshot, options).map((note) => <p className="muted" key={note}>{note}</p>)}
        <p className="muted">系数按 X 以份额计（1 = 100 个百分点）；最后一列换算为 X 每高 1 个百分点。X 各项合计覆盖：{xSpanLabel(detailColumns[shownDetail].spec)}；括号内为标准误，星号含义见表下注释。{detailColumns[shownDetail].spec.fixed_effects.length ? "带固定效应的模型没有常数项：各单位和各年的截距已被固定效应吸收。" : ""}</p>
        <button type="button" className="secondary" onClick={() => download(comparisonCsv(columns, options, depvarLabel, pointRow, designRow), `步骤${stepNumber}-回归对比.csv`)}>
          导出 CSV（上面的回归结果表）
        </button>
      </details>}

      <p className="muted reg-custom-footnote">{options.footnote}{options.hints[1] ? ` ${options.hints[1]}` : ""}</p>
      {/* The table's statistics in plain words, folded: the reading of this course needs only X's rows. */}
      <details className="reg-custom-details reg-custom-glossary">
        <summary>表中的缩写和统计量是什么意思</summary>
        <dl className="teaching-definitions">
          <dt>FE</dt><dd>固定效应：每个国家×行业（或国家、行业、年份）一个截距，扣掉它自己的平均水平。</dd>
          <dt>括号里的数、星号</dt><dd>括号里是标准误，表示估计值的不确定程度；星号越多，越难用偶然波动解释（*** p&lt;0.01，** p&lt;0.05，* p&lt;0.1）。</dd>
          <dt>R²、调整 R²、组内 R²</dt><dd>模型能解释 Y 变化的比例；组内 R² 只看扣掉固定效应之后的那部分变化。</dd>
          <dt>F、Prob &gt; F</dt><dd>检验 X 和控制变量的系数（不含固定效应和常数项）是否全部为 0；Prob &gt; F 越小，越不像全为 0。</dd>
          <dt>Root MSE</dt><dd>模型没有解释的部分（残差）的典型大小，按 Y 的原始数值计：份额类 Y 以份额计（0.0049 即 0.49 个百分点）。</dd>
        </dl>
      </details>
    </div>
  );
}
