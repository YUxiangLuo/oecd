/**
 * 改模型、对比 (the workbench of steps 11–14): open under the step's result. The student changes one setting of the
 * course default model at a time (X terms, controls, fixed effects), computes it, and reads it in one regression table
 * next to the default model; saves it as "结果N", exports the comparison and marks up to three for the report (whose
 * appendix recomputes them from the saved model).
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
  fixed4,
  includedBy,
  nameProblem,
  nextResultName,
  omittedSummary,
  perPointReading,
  perPointRow,
  sameSpec,
  samplesDiffer,
  significanceStars,
  snapshotOf,
  specSummary,
  summaryRows,
  termLabel,
  type TableColumn,
  X_COLUMNS,
  xSum,
  xSpanLabel,
} from "./regression-workbench-table";
import { DivergingBarChart, type DivergingBarRow } from "./viz/regression/diverging-bars";
import { formatPValue } from "./regression-statistics";
import { ConfirmModal } from "./teacher/ui";
import type {
  CoefStat,
  CustomResult,
  CustomResultSnapshot,
  ModelSpec,
  RegressionOutcome,
  RegressionResponse,
  ReportedCustomResult,
  StepStateApi,
  WorkbenchOptions,
} from "./types";
import { displayBaselineLabel } from "./regression-lessons";
import { sameJsonValue } from "./session-store";
import { userFacingRequestError } from "./user-facing-error";

export interface WorkbenchDraft {
  spec?: ModelSpec;
  /** Ids of the saved models shown next to the default model in the regression table. */
  compare?: string[];
}

export interface WorkbenchStepState extends Record<string, unknown> {
  custom_results?: CustomResult[];
  custom_draft?: WorkbenchDraft;
}

const DEFAULT_COLUMN = "默认模型";
const UNSAVED_COLUMN = "本次计算（未保存）";

/** Whether the models marked 放入报告 differ from the ones the report printed (name, Y and model). Compared as JSON
 *  values, not strings: the report's copy comes back from the database with each control's keys in another order. */
export function customReportChanged(
  stepNumber: number, saved: readonly CustomResult[], reported: readonly ReportedCustomResult[] | undefined,
): boolean {
  const identity = (item: { name: string; outcome: string; baseline: string; spec: ModelSpec }) =>
    [item.name, item.outcome, item.baseline, item.spec];
  const mine = saved.filter((item) => item.in_report).map(identity);
  const theirs = (reported ?? []).filter((item) => item.step === stepNumber).map(identity);
  return !sameJsonValue(mine, theirs);
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

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
        <thead><tr><th>变量</th><th>系数</th><th>标准误</th><th>t 值</th><th>p 值</th><th>95% 区间</th><th>X 每高 1 个百分点</th></tr></thead>
        <tbody>
          {rows.map((coef) => (
            <tr key={coef.name}>
              <td>{termLabel(coef.name, options)}</td>
              <td>{fixed4(coef.coef)}{result.suppressed ? "" : significanceStars(coef.p)}</td>
              <td>{result.suppressed ? "—" : `(${fixed4(coef.se)})`}</td>
              <td>{result.suppressed || coef.t == null ? "—" : groupedFixed(coef.t, 2)}</td>
              <td>{result.suppressed ? "—" : formatPValue(coef.p)}</td>
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

export function RegressionModelWorkbench({ stepNumber, outcome, defaultResponse, state, reportCustomResults, reportOutdated = false }: {
  stepNumber: number;
  outcome: RegressionOutcome;
  /** The course default model on this step's saved Y: the first column of the regression table. */
  defaultResponse: RegressionResponse;
  state: StepStateApi<WorkbenchStepState>;
  /** The workbench models the current report printed (its provenance). */
  reportCustomResults?: ReportedCustomResult[];
  reportOutdated?: boolean;
}) {
  const optionsQuery = useAsync<WorkbenchOptions>(() => api.regressionOptions(), ["regression-options"]);
  const options = optionsQuery.status === "success" ? optionsQuery.data ?? null : null;
  const saved = state.data?.custom_results ?? [];
  const draft = state.data?.custom_draft ?? {};
  const baseline = defaultResponse.design.baseline ?? "";
  // As the bars and the headline name it ("加权总度", not the schema's "加权总度（入+出）").
  const depvarLabel = displayBaselineLabel(defaultResponse.design.depvar_label);
  const [localSpec, setLocalSpec] = useState<ModelSpec | null>(null);
  const spec = localSpec ?? draft.spec ?? options?.default_spec ?? null;
  const [computed, setComputed] = useState<RegressionResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rateLimitMessage = useRef<string | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<CustomResult | null>(null);
  // Read out once a calculation, a save or a delete is done (the table changes without moving focus there).
  const [announcement, setAnnouncement] = useState("");
  const [detailColumn, setDetailColumn] = useState(0);
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
  // After a rename or a delete the button that had focus is gone: focus moves to what replaced it.
  const root = useRef<HTMLDivElement>(null);
  // The id of the row whose 改名 button takes focus, or "" for the saved-models heading.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  useEffect(() => {
    if (pendingFocus == null || !root.current) return;
    const rename = [...root.current.querySelectorAll<HTMLElement>("[data-rename]")].find((button) => button.dataset.rename === pendingFocus);
    const target = rename
      ?? root.current.querySelector<HTMLElement>(".reg-custom-saved h4")
      ?? root.current.querySelector<HTMLElement>(".reg-custom-actions button");
    target?.focus({ preventScroll: true });
    setPendingFocus(null);
  }, [pendingFocus]);

  if (optionsQuery.status === "error") {
    return <div className="error-box" role="alert">可选的设定没有加载成功：{optionsQuery.error}<button type="button" className="secondary" onClick={optionsQuery.retry}>重试</button></div>;
  }
  if (!options || !spec) return <div className="reg-request-state muted" role="status" aria-busy="true">正在载入可选的设定…</div>;

  const limits = options.limits;
  const perPoint = (stat: CoefStat, snapshot: CustomResultSnapshot) => perPointReading(outcome, stat, snapshot);
  const changeSpec = (next: ModelSpec) => {
    setLocalSpec(next);
    // A refused calculation's message stays until its wait is over (the button counts down beside it).
    if (retryWait === 0) setError(null);
    state.saveView?.({ custom_draft: { ...draft, spec: next } });
  };
  // The computed model belongs to this Y and this form; otherwise it is kept but marked out of date.
  const current = Boolean(computed && computed.design.baseline === baseline && sameSpec(computed.design.spec!, spec, options));
  const noX = spec.x_lags.length === 0;
  const staleMessage = computed && !current
    ? noX
      ? "下面保留最近计算的结果；请先选择至少一项关税暴露 X，再计算当前设定。"
      : computed.design.baseline !== baseline
      ? `因变量已换成“${depvarLabel}”，点“计算这个模型”在新的 Y 上计算。`
      : "设定已更改，下面保留最近计算的结果；点“计算这个模型”查看新结果。"
    : "";
  const run = async () => {
    if (running || noX) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setRunning(true);
    setError(null);
    try {
      const response = await api.runRegression(outcome, request.signal, baseline, canonicalSpec(spec, options));
      if (response.model_snapshot?.version !== options.version || !response.design.spec) {
        throw new Error("页面版本已更新，请刷新页面后再计算");
      }
      setComputed(response);
      setDetailColumn(0);
      setSaveName(null);
      setAnnouncement("已算出这个模型，结果在下面的回归结果表中。");
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

  const computedSpec = computed?.design.spec ?? null;
  const isDefault = Boolean(current && computedSpec && sameSpec(computedSpec, options.default_spec, options));
  const duplicate = current && computedSpec && !isDefault
    ? saved.find((item) => item.baseline === baseline && sameSpec(item.spec, computedSpec, options))
    : undefined;
  const unsaved = current && computed && !isDefault && !duplicate ? computed : null;
  const name = saveName ?? nextResultName(saved);
  const problem = nameProblem(name, saved, limits.name_length);
  const full = saved.length >= limits.saved;
  // Saved models of this Y next to the default (all of them, up to the limit, until the student picks).
  const compare = (draft.compare ?? saved.map((item) => item.id))
    .filter((id) => saved.some((item) => item.id === id && item.baseline === baseline))
    .slice(0, limits.compared);
  // The choices made while another Y was saved stay for when it is back.
  const otherYCompared = (draft.compare ?? saved.map((item) => item.id))
    .filter((id) => saved.some((item) => item.id === id && item.baseline !== baseline));
  const setCompare = (ids: string[]) => state.saveView?.({ custom_draft: { ...draft, spec, compare: [...otherYCompared, ...ids] } });
  const save = () => {
    if (!unsaved || problem || full) return;
    const item: CustomResult = {
      id: newId(),
      name: name.trim(),
      outcome,
      baseline: unsaved.design.baseline ?? baseline,
      spec: unsaved.design.spec!,
      in_report: false,
      saved_at: new Date().toISOString(),
      snapshot: snapshotOf(unsaved),
    };
    state.save({ custom_results: [...saved, item] });
    if (compare.length < limits.compared) setCompare([...compare, item.id]);
    setSaveName(null);
    setAnnouncement(`已保存为“${item.name}”。`);
    // The save row is gone: focus moves to the new model's row (its 改名 button).
    setPendingFocus(item.id);
  };
  const confirmRename = () => {
    if (!renaming || renameProblem) return;
    update(renaming.id, { name: renaming.name.trim() });
    setAnnouncement(`已改名为“${renaming.name.trim()}”。`);
    setPendingFocus(renaming.id);
    setRenaming(null);
  };
  const cancelRename = () => {
    if (!renaming) return;
    setPendingFocus(renaming.id);
    setRenaming(null);
  };
  const update = (id: string, change: Partial<CustomResult>) =>
    state.save({ custom_results: saved.map((item) => (item.id === id ? { ...item, ...change } : item)) });
  const inReport = saved.filter((item) => item.in_report).length;
  const renameProblem = renaming ? nameProblem(renaming.name, saved, limits.name_length, renaming.id) : null;

  // Keep the new result next to the default so it is visible without scrolling past saved models.
  const comparedColumns: (TableColumn & { id?: string })[] = [
    { name: DEFAULT_COLUMN, spec: options.default_spec, snapshot: snapshotOf(defaultResponse) },
    ...saved.filter((item) => compare.includes(item.id)).map((item) => ({ id: item.id, name: item.name, spec: item.spec, snapshot: item.snapshot })),
  ];
  const columns: (TableColumn & { id?: string })[] = unsaved
    ? [comparedColumns[0], { name: UNSAVED_COLUMN, spec: unsaved.design.spec!, snapshot: snapshotOf(unsaved) }, ...comparedColumns.slice(1)]
    : comparedColumns;
  // The column the computed model is: the new one, a saved one it repeats, or the default.
  const highlighted = unsaved ? 1 : isDefault ? 0 : duplicate ? columns.findIndex((column) => column.id === duplicate.id) : -1;
  const coefficients = coefficientRows(columns, options);
  const pointRow = perPointRow(columns, outcome);
  const summary = summaryRows(columns, options);
  const latest: TableColumn | null = computed && computed.design.baseline === baseline && computed.design.spec
    ? { name: !current ? "上次计算（设定已更改）" : unsaved ? UNSAVED_COLUMN : duplicate ? `已保存：${duplicate.name}` : DEFAULT_COLUMN, spec: computed.design.spec, snapshot: snapshotOf(computed) } : null;
  const detailColumns = latest ? [latest, ...columns.filter((column) => !sameSpec(column.spec, latest.spec, options))] : columns;
  const shownDetail = Math.min(detailColumn, detailColumns.length - 1);
  const reportChanged = Boolean(state.materialLocked && reportOutdated && customReportChanged(stepNumber, saved, reportCustomResults));
  const cellClass = (index: number) => (index === highlighted ? "reg-custom-current" : undefined);

  return (
    <div className="reg-custom" ref={root}>
      <p className="reg-custom-y">因变量：<b>{depvarLabel}</b>（本步保存的 Y；在上面的条形图上点另一条可以换 Y）</p>
      <div className="reg-custom-tries">
        <b>试一试：每次只改一处设定，算出后和表中第一列的默认模型比较</b>
        <p className="muted">先核对 Y、累计跨度、观测数和年份，再比较数字；只改一项也可能改变样本。</p>
        <ol>{options.tries.map((item) => <li key={item}>{item}</li>)}</ol>
      </div>
      <ModelForm options={options} spec={spec} onChange={changeSpec} />
      <p className="reg-custom-equation" aria-live="polite">{noX ? "至少选一项关税暴露 X。" : equationPreview(spec, options)}</p>
      <div className="reg-custom-actions">
        <button type="button" className="run-btn" aria-disabled={running || noX || undefined} onClick={() => void run()}>
          {running ? "正在计算…" : "计算这个模型"}
        </button>
        {retryWait > 0 && <span className="muted reg-custom-wait">新的设定 {retryWait} 秒后可以计算</span>}
        <button type="button" className="secondary" onClick={() => changeSpec(options.default_spec)}>恢复默认设定</button>
        <span className="sr-only" role="status" aria-live="polite">{running ? "正在计算…" : staleMessage || announcement}</span>
      </div>
      {error && <div className="error-box async-error" role="alert">{error}</div>}
      {staleMessage && <p className="reg-stale-note" role="note">{staleMessage}</p>}

      <details className="reg-custom-details" aria-label="单模型详细数字">
        <summary>查看单模型详细数字（系数、t 值与区间）{staleMessage ? " · 当前设定待重算" : ""}</summary>
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
        <p className="muted">系数按 X 以份额计（1 = 100 个百分点）；最后一列换算为 X 每高 1 个百分点。{xSpanLabel(detailColumns[shownDetail].spec)}；括号内为标准误，星号含义见表下注释。</p>
      </details>
      <ModelComparisonChart columns={columns} outcome={outcome} />

      <div className="reg-custom-compare">
        <div className="reg-custom-compare-head">
          <h4>回归结果表（因变量：{depvarLabel}）</h4>
          <button type="button" className="secondary" onClick={() => download(comparisonCsv(columns, options, depvarLabel, pointRow), `步骤${stepNumber}-回归对比.csv`)}>
            导出 CSV
          </button>
        </div>
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

      {current && computed && (
        <div className="reg-custom-save">
          {isDefault ? <p className="muted">这就是本步的默认模型（表中第一列），不用另存。</p>
            : duplicate ? <p className="muted">这个设定已保存为“{duplicate.name}”。</p>
              : full ? <p className="muted">每步最多保存 {limits.saved} 个模型，请先删除一个。</p>
                : (
                  <>
                    <label>把“{UNSAVED_COLUMN}”保存为 <input value={name} maxLength={limits.name_length * 4} onChange={(event) => setSaveName(event.target.value)} aria-invalid={problem ? true : undefined}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }} /></label>
                    <button type="button" className="secondary" aria-disabled={problem ? true : undefined} onClick={save}>保存</button>
                    {problem && <span className="field-error" role="alert">{problem}</span>}
                  </>
                )}
        </div>
      )}

      {/* Outside the saved-models block: deleting the last model put in the report still says the report changed. */}
      {reportChanged && <p className="reg-rerun-warning reg-replaced-notice" role="status">放入报告的模型与已提交报告里的不同；请到步骤 15 更新报告并重新提交给老师。</p>}
      {saved.length > 0 && (
        <div className="reg-custom-saved">
          <h4 tabIndex={-1}>已保存的模型（{saved.length}/{limits.saved}）</h4>
          {state.materialLocked && (
            <p className="reg-rerun-warning" role="note"><b>报告已提交</b>勾选或取消“放入报告”、给已放入报告的模型改名或删除它，都会改变报告；之后要到步骤 15 更新报告，并重新提交给老师。</p>
          )}
          <ScrollableRegion className="table-wrap" label="已保存的模型，可横向滚动">
            <table className="data-table reg-custom-saved-table">
              <thead><tr><th>名称</th><th>设定</th><th>在上表对比（最多 {limits.compared} 个）</th><th>放入报告（最多 {limits.in_report} 个）</th><th>操作</th></tr></thead>
              <tbody>
                {saved.map((item) => {
                  const otherY = item.baseline !== baseline;
                  const compared = compare.includes(item.id);
                  return (
                    <tr key={item.id}>
                      <td>
                        {renaming?.id === item.id ? (
                          <span className="reg-custom-rename">
                            {/* Opens focused with the name selected; Enter confirms and Escape cancels, as in a dialog. */}
                            <input aria-label="新名称" value={renaming.name} autoFocus onFocus={(event) => event.target.select()}
                              onChange={(event) => setRenaming({ id: item.id, name: event.target.value })} aria-invalid={renameProblem ? true : undefined}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") { event.preventDefault(); confirmRename(); }
                                if (event.key === "Escape") { event.preventDefault(); cancelRename(); }
                              }} />
                            <button type="button" className="secondary" aria-disabled={renameProblem ? true : undefined} onClick={confirmRename}>确定</button>
                            <button type="button" className="link-button" onClick={cancelRename}>取消</button>
                            {renameProblem && <span className="field-error" role="alert">{renameProblem}</span>}
                          </span>
                        ) : <b>{item.name}</b>}
                      </td>
                      <td>{specSummary(item.spec, options)}{otherY && <><br /><small className="muted">因变量：{displayBaselineLabel(item.snapshot.depvar_label)}</small></>}</td>
                      <td>
                        <input type="checkbox" aria-label={`对比 ${item.name}`} checked={compared && !otherY}
                          disabled={otherY || (!compared && compare.length >= limits.compared)}
                          title={otherY ? "因变量不同，不能和本步的默认模型对比"
                            : !compared && compare.length >= limits.compared ? `最多同时对比 ${limits.compared} 个模型；先取消一个` : undefined}
                          onChange={() => setCompare(compared ? compare.filter((id) => id !== item.id) : [...compare, item.id])} />
                      </td>
                      <td>
                        <input type="checkbox" aria-label={`把 ${item.name} 放入报告`} checked={item.in_report}
                          disabled={!item.in_report && inReport >= limits.in_report}
                          onChange={() => update(item.id, { in_report: !item.in_report })} />
                      </td>
                      <td className="reg-custom-row-actions">
                        <button type="button" className="link-button" data-rename={item.id} onClick={() => setRenaming({ id: item.id, name: item.name })}>改名</button>
                        <button type="button" className="link-button danger" onClick={() => setDeleting(item)}>删除</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollableRegion>
        </div>
      )}

      <p className="muted reg-custom-footnote">{options.footnote}{options.hints[1] ? ` ${options.hints[1]}` : ""}</p>
      {deleting && (
        <ConfirmModal
          title={`删除“${deleting.name}”？`}
          message={deleting.in_report ? "这个模型已放入报告，删除后报告附录里也不再有它。" : "删除后可以重新计算同样的设定再保存。"}
          confirmLabel="删除"
          danger
          onConfirm={() => {
            state.save({ custom_results: saved.filter((item) => item.id !== deleting.id) });
            setCompare(compare.filter((id) => id !== deleting.id));
            setAnnouncement(`已删除“${deleting.name}”。`);
            setDeleting(null);
            setPendingFocus("");
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
