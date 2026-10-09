import type {
  CoefStat, DepvarKind, RegressionOutcome, RegressionResponse, RegressionStatus, TreatmentSupport,
} from "./types";

export type EvidenceState = "negative" | "positive" | "insufficient" | "suppressed";

/** The interval named with its meaning, where a result first mentions it (not "where the estimate may fall"). */
export const INTERVAL_FIRST_MENTION = "95% 区间（真实系数的合理取值范围）";

/** What a standard deviation of Y is, said once where a size in standard deviations first appears. */
export const SD_DEFINITION = "标准差即 Y 的典型差距";

/** How a gap in Y is said: lengths are 长/短, everything else 高/低. */
export function differenceWords(kind: DepvarKind): { higher: string; lower: string } {
  return kind === "length" ? { higher: "长", lower: "短" } : { higher: "高", lower: "低" };
}

export const REGRESSION_STATUS_LABELS: Record<RegressionStatus, string> = {
  ok: "可以解释结果",
  warning: "可以解释，但须说明设计问题",
  insufficient: "样本支持不足，无法推断",
  invalid_design: "设计无效，无法推断",
};

export function regressionStatusLabel(status: string | null | undefined): string {
  if (!status) return "设计有效性未知";
  return REGRESSION_STATUS_LABELS[status as RegressionStatus] ?? "设计有效性未知";
}

export function globalInferenceIsSuppressed(
  resultStatus: RegressionStatus | string | null | undefined,
  support: Pick<TreatmentSupport, "status" | "suppress_inference"> | null | undefined,
): boolean {
  return support?.suppress_inference === true
    || (resultStatus !== "ok" && resultStatus !== "warning")
    || (support != null && support.status !== resultStatus);
}

function hasValidInterval(coefficient: CoefStat): boolean {
  const { coef, ci_low: low, ci_high: high } = coefficient;
  return Number.isFinite(coef) && low != null && high != null
    && Number.isFinite(low) && Number.isFinite(high) && low <= coef && coef <= high;
}

interface RegressionVerdict {
  state: EvidenceState;
  title: string;
  effectLabel: string;
  effect: string;
  /** The effect without the standard-deviation definition, for tables that say it once (step 15). */
  effectBrief: string;
  interval: string;
  /** The interval in the step's own unit only (no standard-deviation conversion), for the headline. */
  intervalShort: string;
  evidence: string;
  coefficient: CoefStat | null;
  warnings: string[];
}

/**
 * A signed number as the headline prints it; a nonzero value that rounds to 0 keeps 2 significant digits. Thousands
 * are grouped ("-1,140.25"), as the report's `_signed` does.
 */
export const signed = (value: number, digits = 3) => {
  const fixed = value.toFixed(digits);
  const text = value !== 0 && Number(fixed) === 0 ? value.toPrecision(2) : fixed.replace(/^-?\d{4,}/, (whole) => whole.replace(/\B(?=(\d{3})+$)/g, ","));
  return `${value >= 0 ? "+" : ""}${text}`;
};

const DEFAULT_KINDS: Record<RegressionOutcome, DepvarKind> = { trade: "share", production: "share", length: "length", network: "network" };
/** The unit as named beside a chart, a column or a bar ("长度单位"); the position index is a ratio: "无量纲", as on step 7. */
const KIND_UNITS: Record<DepvarKind, string> = { share: "个百分点", length: "长度单位", position: "无量纲", network: "中心性原始单位" };

/** The unit name under a bar's Y in 个标准差 charts ("长度单位", "无量纲"), as the report's chart. */
export function unitName(kind: DepvarKind): string {
  return KIND_UNITS[kind].replace(/^个/, "");
}

/**
 * The unit as a counted quantity ("个百分点", "个长度单位"), used wherever an amount of it is stated; the position
 * index has none, so its amounts are bare numbers ("平均低 0.0021"), as step 7 prints the index itself.
 */
export function countUnit(kind: DepvarKind): string {
  return kind === "share" ? KIND_UNITS.share : kind === "position" ? "" : `个${KIND_UNITS[kind]}`;
}

/** An amount with its counted unit: "-0.018 个长度单位"; the position index's bare "-0.0021". */
export function withCountUnit(amount: string, kind: DepvarKind): string {
  const unit = countUnit(kind);
  return unit ? `${amount} ${unit}` : amount;
}

/** How the saved Y is read: its family default, or the kind the design carries for a chosen baseline. */
export function depvarKind(outcome: RegressionOutcome, design?: { depvar_kind?: string } | null): DepvarKind {
  const kind = design?.depvar_kind;
  return kind === "share" || kind === "length" || kind === "position" || kind === "network" ? kind : DEFAULT_KINDS[outcome];
}

/** Multiplier and unit that turn β into "per 1 percentage point of X" in the shown unit (shares: ×1, pp). */
export function chartDisplayScale(outcome: RegressionOutcome, design?: { depvar_kind?: string } | null): { scale: number; unit?: string } {
  const kind = depvarKind(outcome, design);
  if (kind === "share") return { scale: 1, unit: KIND_UNITS.share };
  return { scale: 0.01, unit: KIND_UNITS[kind] };
}

/**
 * β per 1 percentage point of X with its unit, in the headline's digits: with the 95% interval (`bounds`, per 1.00 of
 * X as the coefficient), more where an end would read as the estimate ("-0.0184", not "-0.018"), as the report's
 * appendix prints it.
 */
export function teachingEffect(
  outcome: RegressionOutcome,
  beta: number,
  design?: { depvar_kind?: string } | null,
  bounds: [number, number] | null = null,
): string {
  const kind = depvarKind(outcome, design);
  const { scale } = chartDisplayScale(outcome, design);
  return withCountUnit(signedEffect(beta * scale, kind, bounds ? [bounds[0] * scale, bounds[1] * scale] : null), kind);
}

/**
 * Shares print with 2 decimals; an estimate between 0.005 and 0.1 point gets 3, so "+0.0075" is not shown as
 * "+0.01". Smaller ones already fall back to 2 significant digits in signed().
 */
export const shareDigits = (pointsEstimate: number) => (Math.abs(pointsEstimate) >= 0.005 && Math.abs(pointsEstimate) < 0.1 ? 3 : 2);

/** Network units span closeness (~0.01) to weighted degree (thousands): keep about three significant figures. */
export function networkDigits(size: number): number {
  return size >= 100 ? 0 : size >= 10 ? 1 : size >= 1 ? 2 : size >= 0.1 ? 3 : size >= 0.01 ? 4 : 5;
}

/** Decimals that give a nonzero value two significant digits (0.0047 → 4), as signed() falls back to. */
const twoSignificantDigits = (value: number) => Math.max(0, 1 - Math.floor(Math.log10(Math.abs(value))));

/**
 * Decimals of a network estimate and its 95% interval, one count for all three (report `network_interval_digits`):
 * 2 ("-40.80"); more when a nonzero value would round to 0 at 2, so it keeps two significant digits; more again
 * until the interval's ends print differently. Closeness used to read "[-0.01, -0.0047]": one end at 2 decimals,
 * the other at two significant digits, and the estimate -0.0049 outside it.
 */
export function networkIntervalDigits(point: number, bounds: [number, number] | null): number {
  const tiny = [point, ...(bounds ?? [])].filter((value) => Number.isFinite(value) && value !== 0 && Number(value.toFixed(2)) === 0);
  let digits = Math.max(2, ...tiny.map(twoSignificantDigits));
  if (bounds) while (digits < 8 && signed(bounds[0], digits) === signed(bounds[1], digits)) digits += 1;
  return digits;
}

/**
 * One more decimal (up to three more) while an interval end prints the same as the estimate: "-0.018" with
 * "[-0.019, -0.018]" reads "-0.0184" with "[-0.0192, -0.0176]" (report `distinct_digits`).
 */
export function distinctDigits(digits: number, point: number, bounds: [number, number] | null): number {
  if (!bounds) return digits;
  let shown = digits;
  while (shown < digits + 3 && (signed(point, shown) === signed(bounds[0], shown) || signed(point, shown) === signed(bounds[1], shown))) shown += 1;
  return shown;
}

/**
 * Decimals of an estimate per 1 percentage point of X and its 95% interval, in the Y's own unit (shares in points):
 * shares 2–3, lengths 3, position 4, network 2 or more (networkIntervalDigits); more where an interval end would
 * read the same as the estimate (report `estimate_digits`).
 */
export function estimateDigits(kind: DepvarKind, value: number, bounds: [number, number] | null): number {
  const base = kind === "network" ? networkIntervalDigits(value, bounds) : kind === "position" ? 4 : kind === "length" ? 3 : shareDigits(value);
  return distinctDigits(base, value, bounds);
}

/** A value per 1 percentage point of X, signed, in the headline's digits for its kind (see estimateDigits). */
export function signedEffect(value: number, kind: DepvarKind, bounds: [number, number] | null = null): string {
  return signed(value, estimateDigits(kind, value, bounds));
}

/**
 * Decimals of a size in standard deviations (report `standardized_digits`): 3 when the point or an interval end is
 * below 0.1 (2 decimals put 0.0459 on the edge of "[-0.05, -0.04]"), otherwise 2; more until the interval's ends
 * differ, at most 4.
 */
export function standardizedDigits(point: number | null, bounds: [number, number] | null): number {
  const values = [point, ...(bounds ?? [])].filter((value): value is number => value != null && Number.isFinite(value));
  const start = values.some((value) => Math.abs(value) < 0.1) ? 3 : 2;
  if (!bounds) return start;
  for (let digits = start; digits <= 4; digits++) if (signed(bounds[0], digits) !== signed(bounds[1], digits)) return digits;
  return 4;
}

/** A Y's estimate as a bar is drawn from it: a saved run's coefficient or a teaching-overview row. */
export interface BarEstimate {
  /** Per unit of X (a fraction), as /api/regression/run returns it. */
  coef: number | null;
  ci_low: number | null;
  ci_high: number | null;
  /** The global suppression rule (globalInferenceIsSuppressed): no interval is read or drawn. */
  suppressed: boolean;
  depvar_std: number | null;
}

/** One bar of a step 11–15 chart, in the axis unit, with its end label and tooltip interval. */
export interface BarFigures {
  value: number;
  low: number | null;
  high: number | null;
  /** The 95% interval includes 0, is missing, or is suppressed: drawn grey, "方向不确定". */
  uncertain: boolean;
  valueLabel: string;
  intervalLabel: string;
  /** Read aloud for the bar: the value with its unit and the 95% interval ("-0.55 个百分点，95% 区间 [-0.57, -0.53]"). */
  spokenLabel: string;
}

/** Bars of one chart are in 个百分点 only when every Y is a share; otherwise in 个标准差 (step 13, 14, 15). */
export type BarUnit = "points" | "sd";

export const BAR_UNIT_TITLES: Record<BarUnit, string> = {
  points: "X 每高 1 个百分点，Y 平均相差（个百分点）",
  sd: "X 每高 1 个百分点，Y 平均相差（个标准差）",
};

export function barUnitFor(kinds: readonly string[]): BarUnit {
  return kinds.length > 0 && kinds.every((kind) => kind === "share") ? "points" : "sd";
}

/** β per 1 percentage point of X in standard deviations of Y: (β × 0.01) / sd(Y); the same for every kind. */
export function standardizedEffect(coef: number, depvarStd: number | null | undefined): number | null {
  return typeof depvarStd === "number" && Number.isFinite(depvarStd) && depvarStd > 0 ? (coef * 0.01) / depvarStd : null;
}

/** One estimate's numbers as a bar reads them: per 1 percentage point of X in Y's own unit, and in standard deviations. */
function barParts(estimate: BarEstimate, kind: DepvarKind) {
  const { coef } = estimate;
  if (coef == null || !Number.isFinite(coef)) return null;
  const low = estimate.suppressed ? null : estimate.ci_low;
  const high = estimate.suppressed ? null : estimate.ci_high;
  const hasCi = low != null && high != null && Number.isFinite(low) && Number.isFinite(high);
  // The value per 1 percentage point of X in the Y's own display unit (shares ×1 in points, others ×0.01).
  const toNative = kind === "share" ? 1 : 0.01;
  const sd = standardizedEffect(coef, estimate.depvar_std);
  return {
    coef, low, high, hasCi,
    uncertain: estimate.suppressed || !hasCi || (low! <= 0 && high! >= 0),
    native: coef * toNative,
    nativeBounds: hasCi ? [low! * toNative, high! * toNative] as [number, number] : null,
    sd,
    sdBounds: sd != null && hasCi ? [standardizedEffect(low!, estimate.depvar_std)!, standardizedEffect(high!, estimate.depvar_std)!] as [number, number] : null,
  };
}

/**
 * The bar of one estimate. In 个百分点 (shares) the label is the headline's signed number ("-0.55"); in 个标准差
 * the bar is the standardized size and the label the native value with the signed size ("-40.11（-0.047 个标准差）";
 * with `withUnit`, "-0.55 个百分点（-0.062 个标准差）" for charts that mix units). A bar has its headline's digits,
 * so a number never reads one way on the bar and another in the text (step 12: "-0.39" beside "+0.006").
 */
export function barFigures(estimate: BarEstimate, kind: DepvarKind, unit: BarUnit, withUnit = false): BarFigures {
  const parts = barParts(estimate, kind);
  if (!parts) {
    return { value: 0, low: null, high: null, uncertain: true, valueLabel: "没算出估计值", intervalLabel: "—", spokenLabel: "没算出估计值" };
  }
  const { low, high, hasCi, uncertain, native, nativeBounds } = parts;
  // In the headline's digits (with its interval, so it reads as the headline does).
  const nativeDigits = estimateDigits(kind, native, nativeBounds);
  const nativeValue = signed(native, nativeDigits);
  const nativeText = withUnit ? withCountUnit(nativeValue, kind) : nativeValue;
  // Spoken with its unit even where the drawing leaves it to the axis title or the name's second line.
  const spokenNative = withCountUnit(nativeValue, kind);
  if (unit === "points") {
    // Shares: the native value is the coefficient, so its interval has the same digits.
    const digits = nativeDigits;
    const interval = hasCi ? `[${signed(low!, digits)}, ${signed(high!, digits)}]` : null;
    return {
      value: native, low: hasCi ? low : null, high: hasCi ? high : null, uncertain,
      valueLabel: nativeText,
      intervalLabel: interval ? `${interval} 个百分点` : "—",
      spokenLabel: interval ? `${spokenNative}，95% 区间 ${interval}` : spokenNative,
    };
  }
  const { sd, sdBounds: bounds } = parts;
  if (sd == null) {
    return {
      value: 0, low: null, high: null, uncertain: true, valueLabel: `${nativeText}（没有标准差）`, intervalLabel: "—",
      spokenLabel: `${spokenNative}（没有标准差）`,
    };
  }
  const digits = standardizedDigits(sd, bounds);
  return {
    value: sd, low: bounds?.[0] ?? null, high: bounds?.[1] ?? null, uncertain,
    // Signed, as the bar and its interval are on a signed axis ("-40.11（-0.047 个标准差）"); only the headline's
    // "幅度约 0.047 个标准差" is an unsigned size.
    valueLabel: `${nativeText}（${signed(sd, digits)} 个标准差）`,
    intervalLabel: bounds ? `[${signed(bounds[0], digits)}, ${signed(bounds[1], digits)}] 个标准差` : "—",
    spokenLabel: `${spokenNative}（${signed(sd, digits)} 个标准差）${bounds ? `，95% 区间 [${signed(bounds[0], digits)}, ${signed(bounds[1], digits)}] 个标准差` : ""}`,
  };
}

function naturalScale(
  outcome: RegressionOutcome,
  coefficient: CoefStat,
  response: RegressionResponse,
): { effect: string; effectBrief: string; interval: string; intervalShort: string } {
  const effect = coefficient.coef * 0.01;
  const hasCi = hasValidInterval(coefficient);
  const ciLow = (coefficient.ci_low ?? 0) * 0.01;
  const ciHigh = (coefficient.ci_high ?? 0) * 0.01;
  const kind = depvarKind(outcome, response.design);
  if (kind === "share") {
    const digits = estimateDigits(kind, effect * 100, hasCi ? [ciLow * 100, ciHigh * 100] : null);
    const interval = hasCi ? `[${signed(ciLow * 100, digits)}, ${signed(ciHigh * 100, digits)}] 个百分点` : "—";
    const text = `${signed(effect * 100, digits)} 个百分点`;
    return { effect: text, effectBrief: text, interval, intervalShort: interval };
  }
  // Lengths, the position index and centrality: the value in its own unit, with its size in standard deviations
  // (the unit both bar charts of steps 13 and 14 use), as the report states it.
  const sd = response.result.depvar_std;
  const validSd = typeof sd === "number" && Number.isFinite(sd) && sd > 0;
  const standardized = validSd ? effect / sd : null;
  const sdBounds: [number, number] | null = validSd && hasCi ? [ciLow / sd, ciHigh / sd] : null;
  // Point and interval share their digits: 3 below 0.1, more when the interval's ends would print alike.
  const sdDigits = standardizedDigits(standardized, sdBounds);
  const standardizedInterval = sdBounds ? `；约 [${signed(sdBounds[0], sdDigits)}, ${signed(sdBounds[1], sdDigits)}] 个标准差` : "";
  // The estimate and both interval ends in the same decimals, more where an end would read as the estimate.
  const digits = estimateDigits(kind, effect, hasCi ? [ciLow, ciHigh] : null);
  const intervalShort = hasCi ? withCountUnit(`[${signed(ciLow, digits)}, ${signed(ciHigh, digits)}]`, kind) : "—";
  // Unsigned, as in the report ("幅度约 0.047 个标准差"): the number before it carries the sign.
  const size = standardized == null ? "" : `幅度约 ${signed(standardized, sdDigits).replace(/^[+−-]/, "")} 个标准差`;
  const amount = withCountUnit(signed(effect, digits), kind);
  return {
    // A standard deviation is the typical gap in Y between country×industry records; said once, in the headline.
    effect: `${amount}${size ? `（${size}，${SD_DEFINITION}）` : ""}`,
    effectBrief: `${amount}${size ? `（${size}）` : ""}`,
    interval: hasCi ? `${intervalShort}${standardizedInterval}` : "—",
    intervalShort,
  };
}

export function buildRegressionVerdict(
  outcome: RegressionOutcome,
  response: RegressionResponse,
): RegressionVerdict {
  const expected = response.model_snapshot?.x_columns ?? [response.design.shock_col];
  const coefficient = response.result.coefs.find((item) => expected.includes(item.name)) ?? null;
  const support = response.result.support;
  const reasons = [...new Set([
    ...(response.result.status_reasons ?? []), ...(support?.reasons ?? []),
  ].filter((reason) => typeof reason === "string" && reason.trim()))];
  const base = {
    effectLabel: "关税暴露 X 每高 1 个百分点",
    warnings: reasons,
  };
  if (!coefficient) {
    return {
      ...base,
      state: globalInferenceIsSuppressed(response.result.status, support) ? "suppressed" : "insufficient",
      title: "没算出估计值",
      effect: "—",
      effectBrief: "—",
      interval: "—",
      intervalShort: "—",
      evidence: "这次没有算出 X 的估计值；结果仍会保存，请在报告里写明原因，不要据此判断方向。",
      coefficient: null,
    };
  }
  const scaled = naturalScale(outcome, coefficient, response);
  if (globalInferenceIsSuppressed(response.result.status, support)) {
    const invalid = response.result.status === "invalid_design" || support?.status === "invalid_design";
    const diagnostic = reasons.length
      ? `原因：${reasons.join("；")}。`
      : "系统没有给出具体原因。";
    return {
      ...base,
      state: "suppressed",
      title: invalid ? "方向不确定：这次的计算设定不能用来判断方向"
        : response.result.status === "insufficient" ? "方向不确定：这次的数据不够判断方向"
          : "方向不确定：结果状态没有记录完整",
      effect: scaled.effect,
      effectBrief: scaled.effectBrief,
      interval: "—",
      intervalShort: "—",
      evidence: `${diagnostic}这次只显示估计值、不显示 95% 区间，不能据此判断上升或下降。`,
      coefficient,
    };
  }
  const validInterval = hasValidInterval(coefficient);
  const state: EvidenceState = validInterval && coefficient.ci_high! < 0
    ? "negative"
    : validInterval && coefficient.ci_low! > 0
      ? "positive"
      : "insufficient";
  return {
    ...base,
    state,
    title: state === "negative" ? "方向明确：X 越高，Y 越低"
      : state === "positive" ? "方向明确：X 越高，Y 越高" : "方向不确定",
    effect: scaled.effect,
    effectBrief: scaled.effectBrief,
    interval: scaled.interval,
    intervalShort: scaled.intervalShort,
    evidence: !validInterval
      ? "95% 区间没有记录完整，不能判断方向；请重新计算，也不要把它读成“区间包含 0”。"
      : state === "insufficient"
      ? `${INTERVAL_FIRST_MENTION}为 ${scaled.interval}，包含 0：不能说“没有关联”，只能说方向还不确定。`
      : `${INTERVAL_FIRST_MENTION}为 ${scaled.interval}，整个区间都在 0 的一侧，所以方向是明确的。`,
    coefficient,
  };
}
