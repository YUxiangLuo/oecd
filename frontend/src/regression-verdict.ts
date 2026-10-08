import type {
  CoefStat, DepvarKind, RegressionOutcome, RegressionResponse, RegressionStatus, TreatmentSupport,
} from "./types";

export type EvidenceState = "negative" | "positive" | "insufficient" | "suppressed";

/** The interval named with its meaning, where a result first mentions it (not "where the estimate may fall"). */
export const INTERVAL_FIRST_MENTION = "95% 区间（真实系数的合理取值范围）";

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
  interval: string;
  /** The interval in the step's own unit only (no standard-deviation conversion), for the headline. */
  intervalShort: string;
  evidence: string;
  coefficient: CoefStat | null;
  warnings: string[];
}

const signed = (value: number, digits = 3) => {
  const fixed = value.toFixed(digits);
  const text = value !== 0 && Number(fixed) === 0 ? value.toPrecision(2) : fixed;
  return `${value >= 0 ? "+" : ""}${text}`;
};

const DEFAULT_KINDS: Record<RegressionOutcome, DepvarKind> = { trade: "share", production: "share", length: "length", network: "network" };
const KIND_UNITS: Record<DepvarKind, string> = { share: "个百分点", length: "长度单位", position: "位置指数单位", network: "中心性原始单位" };

/** The unit as a counted quantity ("个百分点", "个长度单位"), used wherever an amount of it is stated. */
export function countUnit(kind: DepvarKind): string {
  return kind === "share" ? KIND_UNITS.share : `个${KIND_UNITS[kind]}`;
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

export function teachingEffect(outcome: RegressionOutcome, beta: number, design?: { depvar_kind?: string } | null): string {
  const kind = depvarKind(outcome, design);
  const { scale } = chartDisplayScale(outcome, design);
  return `${signed(beta * scale, kind === "position" ? 4 : kind === "length" ? 3 : shareDigits(beta * scale))} ${countUnit(kind)}`;
}

/**
 * Shares print with 2 decimals; an estimate between 0.005 and 0.1 point gets 3, so "+0.0075" is not shown as
 * "+0.01". Smaller ones already fall back to 2 significant digits in signed().
 */
export const shareDigits = (pointsEstimate: number) => (Math.abs(pointsEstimate) >= 0.005 && Math.abs(pointsEstimate) < 0.1 ? 3 : 2);

function naturalScale(
  outcome: RegressionOutcome,
  coefficient: CoefStat,
  response: RegressionResponse,
): { effect: string; interval: string; intervalShort: string } {
  const effect = coefficient.coef * 0.01;
  const hasCi = hasValidInterval(coefficient);
  const ciLow = (coefficient.ci_low ?? 0) * 0.01;
  const ciHigh = (coefficient.ci_high ?? 0) * 0.01;
  const kind = depvarKind(outcome, response.design);
  if (kind === "share") {
    const digits = shareDigits(effect * 100);
    const interval = hasCi ? `[${signed(ciLow * 100, digits)}, ${signed(ciHigh * 100, digits)}] 个百分点` : "—";
    return { effect: `${signed(effect * 100, digits)} 个百分点`, interval, intervalShort: interval };
  }
  if (kind === "network") {
    const sd = response.result.depvar_std;
    const standardized = typeof sd === "number" && Number.isFinite(sd) && sd > 0 ? effect / sd : null;
    // A narrow interval whose ends round to the same two decimals is shown with three, so it is not read as a point.
    const sdDigits = typeof sd === "number" && sd > 0 && signed(ciLow / sd, 2) === signed(ciHigh / sd, 2) ? 3 : 2;
    const standardizedInterval = typeof sd === "number" && Number.isFinite(sd) && sd > 0
      ? `；约 [${signed(ciLow / sd, sdDigits)}, ${signed(ciHigh / sd, sdDigits)}] 个标准差`
      : "";
    const intervalShort = hasCi ? `[${signed(ciLow, 2)}, ${signed(ciHigh, 2)}] ${countUnit("network")}` : "—";
    return {
      // Point and interval in standard deviations use the same decimals (the interval may need three).
      // A standard deviation is the typical gap in Y between country×industry records.
      // Unsigned, as in the report ("幅度约 0.05 个标准差"): the number before it carries the sign.
      effect: `${signed(effect, 2)} 个中心性原始单位${standardized == null ? "" : `（幅度约 ${signed(standardized, sdDigits).replace(/^[+−-]/, "")} 个标准差，标准差即 Y 的典型差距）`}`,
      interval: hasCi ? `${intervalShort}${standardizedInterval}` : "—",
      intervalShort,
    };
  }
  const mean = response.result.depvar_mean;
  // A position index is a ratio around 1; its change is read in its own units, not "relative to the sample mean".
  const relative = kind === "length" && typeof mean === "number" && Number.isFinite(mean) && Math.abs(mean) > 1e-12
    ? (effect / Math.abs(mean)) * 100 : null;
  const unit = KIND_UNITS[kind];
  const digits = kind === "position" ? 4 : 3;
  const interval = hasCi ? `[${signed(ciLow, digits)}, ${signed(ciHigh, digits)}] 个${unit}` : "—";
  return {
    // The size against the mean is unsigned, as in the report: the number before it carries the sign.
    effect: `${signed(effect, digits)} 个${unit}${relative == null ? "" : `（幅度约为样本均值的 ${signed(relative, 2).replace(/^[+−-]/, "")}%）`}`,
    interval,
    intervalShort: interval,
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
    effectLabel: "关税暴露 X 每增加 1 个百分点",
    warnings: reasons,
  };
  if (!coefficient) {
    return {
      ...base,
      state: globalInferenceIsSuppressed(response.result.status, support) ? "suppressed" : "insufficient",
      title: "没算出估计值",
      effect: "—",
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
