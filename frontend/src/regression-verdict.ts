import type {
  CoefStat, DepvarKind, RegressionOutcome, RegressionResponse, RegressionStatus, TreatmentSupport,
} from "./types";

export type EvidenceState = "negative" | "positive" | "insufficient" | "suppressed";

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
  const { scale, unit } = chartDisplayScale(outcome, design);
  return `${signed(beta * scale, kind === "position" ? 4 : kind === "length" ? 3 : 2)} ${scale === 1 ? unit : `个${unit}`}`;
}

function naturalScale(
  outcome: RegressionOutcome,
  coefficient: CoefStat,
  response: RegressionResponse,
): { effect: string; interval: string } {
  const effect = coefficient.coef * 0.01;
  const hasCi = hasValidInterval(coefficient);
  const ciLow = (coefficient.ci_low ?? 0) * 0.01;
  const ciHigh = (coefficient.ci_high ?? 0) * 0.01;
  const kind = depvarKind(outcome, response.design);
  if (kind === "share") {
    return {
      effect: `${signed(effect * 100, 2)} 个百分点`,
      interval: hasCi ? `[${signed(ciLow * 100, 2)}, ${signed(ciHigh * 100, 2)}] 个百分点` : "—",
    };
  }
  if (kind === "network") {
    const sd = response.result.depvar_std;
    const standardized = typeof sd === "number" && Number.isFinite(sd) && sd > 0 ? effect / sd : null;
    // A narrow interval whose ends round to the same two decimals is shown with three, so it is not read as a point.
    const sdDigits = typeof sd === "number" && sd > 0 && signed(ciLow / sd, 2) === signed(ciHigh / sd, 2) ? 3 : 2;
    const standardizedInterval = typeof sd === "number" && Number.isFinite(sd) && sd > 0
      ? `；约 [${signed(ciLow / sd, sdDigits)}, ${signed(ciHigh / sd, sdDigits)}] 个样本标准差`
      : "";
    return {
      effect: `${signed(effect, 2)} 个中心性原始单位${standardized == null ? "" : `（约 ${signed(standardized, 2)} 个样本标准差）`}`,
      interval: hasCi ? `[${signed(ciLow, 2)}, ${signed(ciHigh, 2)}] 个原始单位${standardizedInterval}` : "—",
    };
  }
  const mean = response.result.depvar_mean;
  // A position index is centred near zero, so "relative to the sample mean" would mislead; lengths keep it.
  const relative = kind === "length" && typeof mean === "number" && Number.isFinite(mean) && Math.abs(mean) > 1e-12
    ? (effect / Math.abs(mean)) * 100 : null;
  const unit = KIND_UNITS[kind];
  const digits = kind === "position" ? 4 : 3;
  return {
    effect: `${signed(effect, digits)} 个${unit}${relative == null ? "" : `（约为样本均值的 ${signed(relative, 2)}%）`}`,
    interval: hasCi ? `[${signed(ciLow, digits)}, ${signed(ciHigh, digits)}] 个${unit}` : "—",
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
      title: "当前设定没有可解读的政策系数",
      effect: "—",
      interval: "—",
      evidence: "可保存并报告该诊断；请说明缺少支持的原因，不能用不存在的系数判断方向。",
      coefficient: null,
    };
  }
  const scaled = naturalScale(outcome, coefficient, response);
  if (globalInferenceIsSuppressed(response.result.status, support)) {
    const invalid = response.result.status === "invalid_design" || support?.status === "invalid_design";
    const diagnostic = reasons.length
      ? `无法推断：${reasons.join("；")}`
      : "无法进行统计推断，且未提供具体原因；请核对完整诊断。";
    return {
      ...base,
      state: "suppressed",
      title: invalid ? "这个设计不能用于统计推断"
        : response.result.status === "insufficient" ? "样本支持度不足，无法给出显著性"
          : "设计有效性未知或状态不一致，无法给出显著性",
      effect: scaled.effect,
      interval: "—",
      evidence: `${diagnostic} 点估计仅供描述，不提供置信区间，不能据此判断上升或下降。`,
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
    title: state === "negative" ? "本次样本支持负向关联"
      : state === "positive" ? "本次样本支持正向关联" : "本次样本不足以判断方向",
    effect: scaled.effect,
    interval: scaled.interval,
    evidence: !validInterval
      ? "置信区间缺失或不合法，不能判断关联方向；请重新运行回归，不能将其解释为区间包含 0。"
      : state === "insufficient"
      ? "95% 置信区间包含 0（跨过或触及）；这不等于“没有效应”，而是当前证据不足以确定方向。"
      : "95% 置信区间完全位于 0 的一侧，支持本次样本中的关联方向。",
    coefficient,
  };
}
