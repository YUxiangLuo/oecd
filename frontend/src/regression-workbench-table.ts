/**
 * The workbench of steps 11–14 (自己设计模型, optional): its model wording, the result and comparison tables, and the
 * CSV export. Pure functions; the labels come from GET /api/regression/options, so the page, the CSV and the report
 * name every term the same way.
 */
import { groupedFixed } from "./format";
import type {
  CoefStat,
  CustomResult,
  CustomResultSnapshot,
  ModelSpec,
  RegressionResponse,
  WorkbenchOptions,
} from "./types";

export const X_COLUMNS: Record<number, string> = {
  0: "teaching_tariff_exposure",
  1: "teaching_tariff_exposure_lag1",
  2: "teaching_tariff_exposure_lag2",
};
const CONSTANT = "_constant";

export const xTermLabel = (lag: number) => (lag === 0 ? "X" : `L${lag}.X`);
export const controlColumn = (name: string, lag: number) => (lag === 0 ? name : `${name}__lag${lag}`);

function controlLabel(options: WorkbenchOptions, name: string, lag: number): string {
  const label = options.controls.find((item) => item.name === name)?.label ?? name;
  return lag === 0 ? label : `L${lag}.${label}`;
}

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";
const subscript = (n: number) => String(n).split("").map((digit) => SUBSCRIPTS[Number(digit)]).join("");

/** The effects a spec estimates once a combined one is checked ("国家×行业" makes "国家" and "行业" redundant). */
export function effectiveEffects(chosen: readonly string[], options: WorkbenchOptions): string[] {
  const implied = new Set(options.fixed_effects.filter((item) => chosen.includes(item.key)).flatMap((item) => item.includes));
  return options.fixed_effects.map((item) => item.key).filter((key) => chosen.includes(key) && !implied.has(key));
}

/** Which combined effect already contains this one, if it is checked ("国家×行业 FE"), else null. */
export function includedBy(key: string, chosen: readonly string[], options: WorkbenchOptions): string | null {
  const parent = options.fixed_effects.find((item) => chosen.includes(item.key) && item.includes.includes(key));
  return parent?.label ?? null;
}

/** A spec in the server's canonical form: X lags sorted, controls in page order, contained effects dropped. */
export function canonicalSpec(spec: ModelSpec, options: WorkbenchOptions): ModelSpec {
  const order = options.controls.map((item) => item.name);
  return {
    x_lags: [...new Set(spec.x_lags)].sort((a, b) => a - b),
    controls: [...spec.controls].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)),
    fixed_effects: effectiveEffects(spec.fixed_effects, options),
  };
}

export const specKey = (spec: ModelSpec) => JSON.stringify([spec.x_lags, spec.controls.map((item) => [item.name, item.lag]), spec.fixed_effects]);

export function sameSpec(first: ModelSpec, second: ModelSpec, options: WorkbenchOptions): boolean {
  return specKey(canonicalSpec(first, options)) === specKey(canonicalSpec(second, options));
}

const effectName = (options: WorkbenchOptions, key: string) =>
  (options.fixed_effects.find((item) => item.key === key)?.label ?? key).replace(/ FE$/, "");

/** "X + L1.X；汇率变动；国家×行业 + 年份 FE" (the server's ModelSpec.summary, which the report prints). */
export function specSummary(spec: ModelSpec, options: WorkbenchOptions): string {
  const canonical = canonicalSpec(spec, options);
  const x = canonical.x_lags.map(xTermLabel).join(" + ");
  const controls = canonical.controls.map((item) => controlLabel(options, item.name, item.lag)).join("、") || "无控制变量";
  const effects = canonical.fixed_effects.length
    ? `${canonical.fixed_effects.map((key) => effectName(options, key)).join(" + ")} FE`
    : "无固定效应";
  return `${x}；${controls}；${effects}`;
}

/** "Y = β₁·X + β₂·L1.X + γ₁·汇率变动 + 国家×行业 FE + 年份 FE + ε" (the server's ModelSpec.equation). */
export function equationPreview(spec: ModelSpec, options: WorkbenchOptions): string {
  const canonical = canonicalSpec(spec, options);
  const terms = [
    ...canonical.x_lags.map((lag, index) => `β${subscript(index + 1)}·${xTermLabel(lag)}`),
    ...canonical.controls.map((item, index) => `γ${subscript(index + 1)}·${controlLabel(options, item.name, item.lag)}`),
    ...(canonical.fixed_effects.length
      ? canonical.fixed_effects.map((key) => options.fixed_effects.find((item) => item.key === key)?.label ?? key)
      : ["常数项"]),
  ];
  return `Y = ${terms.join(" + ")} + ε`;
}

/** A term's name in the tables: "X", "L1.X", "汇率变动", "L1.GDP（取对数）", "X 各项合计（累计效应）", "常数项". */
export function termLabel(name: string, options: WorkbenchOptions): string {
  const lag = Object.entries(X_COLUMNS).find(([, column]) => column === name)?.[0];
  if (lag != null) return xTermLabel(Number(lag));
  if (name === "cumulative") return "X 各项合计（累计效应）";
  if (name === CONSTANT) return "常数项";
  const match = /^(.+?)(?:__lag(\d))?$/.exec(name);
  return match ? controlLabel(options, match[1], Number(match[2] ?? 0)) : name;
}

export const significanceStars = (p: number | null | undefined) =>
  p == null ? "" : p < 0.01 ? "***" : p < 0.05 ? "**" : p < 0.1 ? "*" : "";

/** p at three decimals; below 0.001 reads "< 0.001". */
export function formatP3(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return p < 0.001 ? "< 0.001" : p.toFixed(3);
}

export const fixed4 = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? "—" : groupedFixed(value, 4));

/** What a saved model keeps of a run, to show its table again without recomputing (the report recomputes). */
export function snapshotOf(response: Pick<RegressionResponse, "design" | "result">): CustomResultSnapshot {
  const { result } = response;
  const suppressed = result.status === "invalid_design" || Boolean(result.support?.suppress_inference);
  return {
    depvar_label: response.design.depvar_label,
    depvar_kind: response.design.depvar_kind ?? "",
    result: {
      coefs: result.coefs,
      cumulative: result.cumulative ?? null,
      constant: result.constant ?? null,
      omitted: result.omitted ?? [],
      r2: result.r2 ?? null,
      r2_adj: result.r2_adj ?? null,
      r2_within: result.r2_within,
      f_stat: result.f_stat ?? null,
      f_df: result.f_df ?? null,
      f_p: result.f_p ?? null,
      n_obs: result.n_obs,
      n_entities: result.n_entities,
      n_times: result.n_times,
      n_clusters: result.n_clusters,
      status: result.status,
      years: result.sample_flow?.years ?? null,
      suppressed,
    },
  };
}

/** One column of a comparison table: the default model or a saved one. */
export interface TableColumn {
  name: string;
  spec: ModelSpec;
  snapshot: CustomResultSnapshot;
}

export interface CoefCell { coef: string; se: string }
export interface CoefRow { key: string; label: string; cells: (CoefCell | "omitted" | null)[] }
export interface SummaryRow { key: string; label: string; cells: string[] }

const xTerms = (snapshot: CustomResultSnapshot) =>
  snapshot.result.coefs.filter((item) => Object.values(X_COLUMNS).includes(item.name)).length;

function cell(coefficient: CoefStat | null | undefined, suppressed: boolean): CoefCell | null {
  if (!coefficient) return null;
  return {
    coef: fixed4(coefficient.coef) + (suppressed ? "" : significanceStars(coefficient.p)),
    se: `(${fixed4(coefficient.se)})`,
  };
}

/** Coefficient rows over every column (the union of their terms, in page order): X terms, controls, the X terms'
 *  sum (when a column has two or more), the constant (a column without fixed effects). */
export function coefficientRows(columns: TableColumn[], options: WorkbenchOptions): CoefRow[] {
  const order = [
    ...Object.values(X_COLUMNS),
    ...options.controls.flatMap((item) => options.control_lags.map((lag) => controlColumn(item.name, lag.lag))),
  ];
  const used = new Set(columns.flatMap((column) => [
    ...column.snapshot.result.coefs.map((item) => item.name),
    ...(column.snapshot.result.omitted ?? []).map((item) => item.name),
  ]));
  const rows: CoefRow[] = order.filter((name) => used.has(name)).map((name) => ({
    key: name,
    label: termLabel(name, options),
    cells: columns.map(({ snapshot }) => {
      const found = snapshot.result.coefs.find((item) => item.name === name);
      if (found) return cell(found, snapshot.result.suppressed);
      return (snapshot.result.omitted ?? []).some((item) => item.name === name) ? "omitted" : null;
    }),
  }));
  if (columns.some(({ snapshot }) => xTerms(snapshot) > 1)) {
    rows.push({
      key: "cumulative",
      label: termLabel("cumulative", options),
      cells: columns.map(({ snapshot }) => (xTerms(snapshot) > 1 ? cell(snapshot.result.cumulative, snapshot.result.suppressed) : null)),
    });
  }
  if (columns.some(({ snapshot }) => snapshot.result.constant)) {
    rows.push({
      key: CONSTANT,
      label: "常数项",
      cells: columns.map(({ snapshot }) => cell(snapshot.result.constant, snapshot.result.suppressed)),
    });
  }
  return rows;
}

const effectIncluded = (spec: ModelSpec, key: string, options: WorkbenchOptions) =>
  spec.fixed_effects.includes(key) || includedBy(key, spec.fixed_effects, options) != null;

const yearsText = (snapshot: CustomResultSnapshot) =>
  snapshot.result.years ? `${snapshot.result.years[0]}–${snapshot.result.years[1]}` : "—";

/** Under the coefficients: each fixed effect 是/否, then the sample and the fit, as the report prints them. */
export function summaryRows(columns: TableColumn[], options: WorkbenchOptions): SummaryRow[] {
  const statistic = (key: string, label: string, read: (snapshot: CustomResultSnapshot) => string): SummaryRow => ({
    key, label, cells: columns.map(({ snapshot }) => read(snapshot)),
  });
  return [
    ...options.fixed_effects.map((item) => ({
      key: item.key,
      label: item.label,
      cells: columns.map(({ spec }) => (effectIncluded(spec, item.key, options) ? "是" : "否")),
    })),
    statistic("n_obs", "观测值", (snapshot) => snapshot.result.n_obs.toLocaleString("en-US")),
    statistic("years", "年份", yearsText),
    statistic("clusters", "聚类数（国家）", (snapshot) => String(snapshot.result.n_clusters)),
    statistic("r2", "R²", (snapshot) => fixed4(snapshot.result.r2)),
    statistic("r2_adj", "调整 R²", (snapshot) => fixed4(snapshot.result.r2_adj)),
    // Without fixed effects nothing is "within": the row would repeat R².
    { key: "r2_within", label: "组内 R²", cells: columns.map(({ spec, snapshot }) => (spec.fixed_effects.length ? fixed4(snapshot.result.r2_within) : "—")) },
    statistic("f", "F（自由度）", (snapshot) => {
      const df = snapshot.result.f_df;
      return snapshot.result.suppressed || !df || df.length !== 2 || snapshot.result.f_stat == null
        ? "—"
        : `${groupedFixed(snapshot.result.f_stat, 2)}（${df[0]}, ${df[1]}）`;
    }),
  ];
}

/** Columns with a different sample (observations or years): part of a difference is the sample, not the model. */
export function samplesDiffer(columns: TableColumn[]): boolean {
  return new Set(columns.map(({ snapshot }) => `${snapshot.result.n_obs}|${yearsText(snapshot)}`)).size > 1;
}

/** "汇率变动：被国家×年份 FE 吸收" for each omitted term of a run. */
export function omittedLines(snapshot: CustomResultSnapshot, options: WorkbenchOptions): string[] {
  return (snapshot.result.omitted ?? []).map((item) => {
    const label = termLabel(item.name, options);
    if (item.reason === "absorbed") {
      return item.by && item.by !== "常数项" ? `${label}：被${item.by} FE 吸收` : `${label}：在样本里不变，与常数项重合`;
    }
    return `${label}：${item.reason === "zero" ? "样本里全为 0" : "与其他变量完全共线"}`;
  });
}

/** "结果N", N one more than the largest number among this step's "结果…" names (the count when none). */
export function nextResultName(saved: readonly Pick<CustomResult, "name">[]): string {
  const numbers = saved.map((item) => /^结果(\d+)$/.exec(item.name)).filter(Boolean).map((match) => Number(match![1]));
  let next = Math.max(saved.length, ...numbers, 0) + 1;
  while (saved.some((item) => item.name === `结果${next}`)) next += 1;
  return `结果${next}`;
}

/** Why a name cannot be used (empty, too long, taken in this step), or null. */
export function nameProblem(
  name: string, saved: readonly Pick<CustomResult, "id" | "name">[], limit: number, selfId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "请输入名称";
  if ([...trimmed].length > limit) return `名称最多 ${limit} 个字符`;
  if (saved.some((item) => item.name === trimmed && item.id !== selfId)) return `本步已有名为“${trimmed}”的模型`;
  return null;
}

function csvField(value: string): string {
  // A typed name that starts like a formula is kept as text when a spreadsheet opens the file.
  const safe = /^[=+@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The comparison table as CSV (UTF-8 with BOM, so Excel reads the Chinese): a coefficient row with its stars and a
 *  row of bracketed SE for each term, then the fixed effects and statistics, the footnote last. */
export function comparisonCsv(columns: TableColumn[], options: WorkbenchOptions, depvarLabel: string): string {
  const lines: string[][] = [[`因变量：${depvarLabel}`, ...columns.map((column) => column.name)]];
  for (const row of coefficientRows(columns, options)) {
    lines.push([row.label, ...row.cells.map((item) => (item === "omitted" ? "（省略）" : item?.coef ?? ""))]);
    lines.push(["", ...row.cells.map((item) => (item && item !== "omitted" ? item.se : ""))]);
  }
  for (const row of summaryRows(columns, options)) lines.push([row.label, ...row.cells]);
  lines.push(["设定", ...columns.map((column) => specSummary(column.spec, options))]);
  lines.push([options.footnote]);
  return `﻿${lines.map((line) => line.map(csvField).join(",")).join("\r\n")}\r\n`;
}
