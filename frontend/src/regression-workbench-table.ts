/**
 * The workbench of steps 11–14 (自己设计模型, optional): its model wording, the result and comparison tables, and the
 * CSV export. Pure functions; the labels come from GET /api/regression/options, so the page, the CSV and the report
 * name every term the same way.
 */
import { groupedFixed } from "./format";
import {
  chartDisplayScale, depvarKind, estimateDigits, globalInferenceIsSuppressed, signed, withCountUnit,
} from "./regression-verdict";
import { formatPValue } from "./regression-statistics";
import type {
  CoefStat,
  CustomResultSnapshot,
  ModelSpec,
  RegressionOutcome,
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
  // Every control is a country-level yearly value, so country × year effects absorb them all (the form's note says
  // so): the preview leaves them out of the model and names them, rather than showing terms that will not be estimated.
  const absorbed = canonical.fixed_effects.includes("country_year") ? canonical.controls : [];
  const controls = canonical.controls.filter((item) => !absorbed.includes(item));
  const terms = [
    ...canonical.x_lags.map((lag, index) => `β${subscript(index + 1)}·${xTermLabel(lag)}`),
    ...controls.map((item, index) => `γ${subscript(index + 1)}·${controlLabel(options, item.name, item.lag)}`),
    ...(canonical.fixed_effects.length
      ? canonical.fixed_effects.map((key) => options.fixed_effects.find((item) => item.key === key)?.label ?? key)
      : ["常数项"]),
  ];
  const note = absorbed.length
    ? `（${absorbed.map((item) => controlLabel(options, item.name, item.lag)).join("、")}会被国家×年份 FE 吸收，不会估计）`
    : "";
  return `Y = ${terms.join(" + ")} + ε${note}`;
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

export const fixed4 = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? "—" : groupedFixed(value, 4));

/** What a saved model keeps of a run, to show its table again without recomputing (the report recomputes). */
export function snapshotOf(response: Pick<RegressionResponse, "design" | "result">): CustomResultSnapshot {
  const { result } = response;
  // The same rule as the step's own result: no p, stars or interval unless the run's statuses allow inference.
  const suppressed = globalInferenceIsSuppressed(result.status, result.support);
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
      root_mse: result.root_mse ?? null,
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
    se: suppressed ? "—" : `(${fixed4(coefficient.se)})`,
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

/** What a column's X-terms sum covers: "两年累计" for X + L1.X, "仅当年" for X alone, "三年累计" with L2.X; other
 *  sets name their terms ("仅 L1.X", "X + L2.X 之和"), so one coefficient is never called a sum. */
export function xSpanLabel(spec: Pick<ModelSpec, "x_lags">): string {
  const lags = [...spec.x_lags].sort((a, b) => a - b);
  const named = ({ "0": "仅当年", "0,1": "两年累计", "0,1,2": "三年累计" } as Record<string, string>)[lags.join(",")];
  if (named) return named;
  const terms = lags.map((lag) => (lag === 0 ? "X" : `L${lag}.X`));
  return terms.length === 1 ? `仅 ${terms[0]}` : `${terms.join(" + ")} 之和`;
}

/** What a per-point reading needs of a result: its Y's kind and whether its interval is shown (a saved model's
 *  snapshot, or a default model from the course overview). */
export type PerPointSource = Pick<CustomResultSnapshot, "depvar_kind"> & { result: Pick<CustomResultSnapshot["result"], "suppressed"> };

/** A coefficient per percentage point of X in the step's unit: β × 0.01 (× 100 for a share, read in points). */
function perPointValue(outcome: RegressionOutcome, stat: Pick<CoefStat, "coef" | "ci_low" | "ci_high">, snapshot: PerPointSource) {
  const design = { depvar_kind: snapshot.depvar_kind };
  const { scale } = chartDisplayScale(outcome, design);
  const bounds: [number, number] | null = !snapshot.result.suppressed && stat.ci_low != null && stat.ci_high != null
    ? [stat.ci_low * scale, stat.ci_high * scale]
    : null;
  return { kind: depvarKind(outcome, design), value: stat.coef * scale, bounds };
}

/** Decimals the step's headline gives this coefficient (its interval sets them, as on the result card). */
export function perPointDigits(outcome: RegressionOutcome, stat: Pick<CoefStat, "coef" | "ci_low" | "ci_high">, snapshot: PerPointSource): number {
  const { kind, value, bounds } = perPointValue(outcome, stat, snapshot);
  return estimateDigits(kind, value, bounds);
}

/** "-0.55 个百分点", "-0.0182 个长度单位": the page's reading of a coefficient, at the given decimals or its own. */
export function perPointReading(
  outcome: RegressionOutcome, stat: Pick<CoefStat, "coef" | "ci_low" | "ci_high">, snapshot: PerPointSource, digits?: number,
): string {
  const { kind, value, bounds } = perPointValue(outcome, stat, snapshot);
  return withCountUnit(signed(value, digits ?? estimateDigits(kind, value, bounds)), kind);
}

/** A column's X-terms sum: the single X term of a one-term model, else the estimated sum. Null when a term of a
 * several-term model was dropped (the server then gives no sum), so one coefficient is never called a sum. */
export function xSum(snapshot: CustomResultSnapshot, spec: Pick<ModelSpec, "x_lags">): CoefStat | null {
  if (spec.x_lags.length === 1) return snapshot.result.coefs.find((item) => Object.values(X_COLUMNS).includes(item.name)) ?? null;
  return snapshot.result.cumulative ?? null;
}

/**
 * "合计：X 每高 1 个百分点": each column's X-terms sum read per percentage point, all at the first column's decimals
 * so the row compares like with like, each saying which years it covers ("（两年累计）", "（仅当年）").
 */
export function perPointRow(columns: TableColumn[], outcome: RegressionOutcome): SummaryRow | null {
  const first = columns.find(({ snapshot, spec }) => xSum(snapshot, spec));
  if (!first) return null;
  const digits = perPointDigits(outcome, xSum(first.snapshot, first.spec)!, first.snapshot);
  return {
    key: "per_point",
    label: "合计：X 每高 1 个百分点",
    cells: columns.map(({ spec, snapshot }) => {
      const sum = xSum(snapshot, spec);
      return sum ? `${perPointReading(outcome, sum, snapshot, digits)}（${xSpanLabel(spec)}）` : "";
    }),
  };
}

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
    statistic("f_p", "Prob > F", (snapshot) => (snapshot.result.suppressed ? "—" : formatPValue(snapshot.result.f_p))),
    statistic("root_mse", "Root MSE", (snapshot) => fixed4(snapshot.result.root_mse)),
  ];
}

/** How far an estimate's size is from the design value: + larger, − smaller; a sign flip reads beyond −100%. */
export function designDeviation(estimate: number, design: number): number {
  if (design === 0) return Number.NaN;
  return Math.sign(estimate) === Math.sign(design)
    ? (Math.abs(estimate) - Math.abs(design)) / Math.abs(design)
    : -(Math.abs(estimate) + Math.abs(design)) / Math.abs(design);
}

/**
 * Whether a model's X terms add up to what the design value is: the two-year total needs both X and L1.X (L2.X is
 * set to 0 by design, so adding it keeps the comparison). Another span is not the same estimand (the server's
 * report_workbench._covers_design_span).
 */
export function coversDesignSpan(spec: Pick<ModelSpec, "x_lags">): boolean {
  return spec.x_lags.includes(0) && spec.x_lags.includes(1);
}

/**
 * "课程设定值": the two-year total the course data were built around, read per percentage point like the row above,
 * and how far each column's X-terms sum is from it; a column whose X terms span other years is not compared.
 * Null when the server sent no design value for this Y.
 */
export function designValueRow(columns: TableColumn[], outcome: RegressionOutcome, baseline: string, options: WorkbenchOptions): SummaryRow | null {
  const design = options.design_values?.[outcome]?.[baseline];
  if (design === undefined) return null;
  const first = columns.find(({ snapshot, spec }) => xSum(snapshot, spec));
  if (!first) return null;
  if (design === null) return { key: "design", label: "课程设定值", cells: columns.map(() => "无单一设定值（比值 Y）") };
  if (design === 0) return { key: "design", label: "课程设定值", cells: columns.map(() => "设定为 0（与 X 无关）") };
  const digits = perPointDigits(outcome, xSum(first.snapshot, first.spec)!, first.snapshot);
  const target = perPointReading(outcome, { coef: design, ci_low: null, ci_high: null }, { depvar_kind: first.snapshot.depvar_kind, result: { suppressed: true } }, digits);
  return {
    key: "design",
    label: "课程设定值（X 每高 1 个百分点）",
    cells: columns.map(({ spec, snapshot }) => {
      const sum = xSum(snapshot, spec);
      if (!sum) return "";
      if (!coversDesignSpan(spec)) return `${target}（两年累计）；本列跨度不同，不计偏差`;
      const deviation = designDeviation(sum.coef, design);
      return `${target}；估计偏差 ${deviation > 0 ? "+" : ""}${Math.round(deviation * 100)}%`;
    }),
  };
}

/** Columns with a different sample (observations or years): part of a difference is the sample, not the model. */
export function samplesDiffer(columns: TableColumn[]): boolean {
  return new Set(columns.map(({ snapshot }) => `${snapshot.result.n_obs}|${yearsText(snapshot)}`)).size > 1;
}

/** Omitted terms grouped by why: "被国家×年份 FE 吸收：汇率变动、GDP（取对数）". */
export function omittedSummary(snapshot: CustomResultSnapshot, options: WorkbenchOptions): string[] {
  const groups = new Map<string, string[]>();
  for (const item of snapshot.result.omitted ?? []) {
    const reason = item.reason === "absorbed"
      ? (item.by && item.by !== "常数项" ? `被${item.by} FE 吸收` : "在样本里不变，与常数项重合")
      : item.reason === "zero" ? "样本里全为 0" : "与其他变量完全共线";
    groups.set(reason, [...(groups.get(reason) ?? []), termLabel(item.name, options)]);
  }
  return [...groups].map(([reason, terms]) => `${reason}：${terms.join("、")}`);
}

/** How the page and the report name a model experiment: its preset's label, else "自定义设定" (the model itself is
 *  always shown beside the name; the server's workbench.experiment_label). */
export function experimentLabel(spec: ModelSpec, options: WorkbenchOptions): string {
  const preset = options.presets.find((item) => sameSpec(item.spec, spec, options));
  // The name is the server's; an options payload from before it was sent (a deploy in progress) still gets a name.
  return preset ? preset.label : options.custom_label ?? "自定义设定";
}

function csvField(value: string): string {
  // The table's cells ("+0.55 个百分点（两年累计）", "-0.3298***") are never formulas, so they keep their sign and
  // get no visible quote; no cell holds text a student typed.
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The comparison table as CSV (UTF-8 with BOM, so Excel reads the Chinese): a coefficient row with its stars and a
 *  标准误 row for each term, then the fixed effects and statistics, the footnote last. The SE are plain numbers, not
 *  bracketed as on the page: a spreadsheet reads "(0.0330)" as −0.033. */
export function comparisonCsv(
  columns: TableColumn[], options: WorkbenchOptions, depvarLabel: string, perPoint?: SummaryRow | null, design?: SummaryRow | null,
): string {
  const lines: string[][] = [[`因变量：${depvarLabel}`, ...columns.map((column) => column.name)]];
  // As on the page: the per-point row and the course's design value right under the X-terms sum, before a constant.
  const rows = coefficientRows(columns, options);
  for (const row of [...rows.filter((item) => item.key !== "_constant"), "per_point" as const, ...rows.filter((item) => item.key === "_constant")]) {
    if (row === "per_point") {
      if (perPoint) lines.push([perPoint.label, ...perPoint.cells]);
      if (design) lines.push([design.label, ...design.cells]);
      continue;
    }
    lines.push([row.label, ...row.cells.map((item) => (item === "omitted" ? "（省略）" : item?.coef ?? ""))]);
    lines.push(["标准误", ...row.cells.map((item) => (item && item !== "omitted" ? item.se.replace(/^\((.*)\)$/, "$1") : ""))]);
  }
  for (const row of summaryRows(columns, options)) lines.push([row.label, ...row.cells]);
  lines.push(["设定", ...columns.map((column) => specSummary(column.spec, options))]);
  lines.push([options.footnote.replace("括号内为按国家聚类的标准误", "“标准误”一行为按国家聚类的标准误")]);
  return `\ufeff${lines.map((line) => line.map(csvField).join(",")).join("\r\n")}\r\n`;
}
