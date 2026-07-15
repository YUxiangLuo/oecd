import type { CoefStat, RegressionOutcome, RegressionResponse } from "./types";

type EvidenceState = "negative" | "positive" | "insufficient";

export interface RegressionVerdict {
  state: EvidenceState;
  title: string;
  effectLabel: string;
  effect: string;
  interval: string;
  evidence: string;
  interpretation: string;
  boundary: string;
  coefficient: CoefStat | null;
}

function mainPolicyCoefficient(response: RegressionResponse): CoefStat | null {
  const controls = new Set(response.design.controls);
  const main = response.result.coefs.filter((coef) =>
    !controls.has(coef.name) && !coef.name.includes("×base_gvc"),
  );
  if (response.design.method === "事件研究") {
    return main.find((coef) => coef.name === "k=0")
      ?? main.find((coef) => coef.name.startsWith("k=+"))
      ?? null;
  }
  return main[0] ?? null;
}

const signed = (value: number, digits = 3) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;

function naturalScale(
  outcome: RegressionOutcome,
  coefficient: CoefStat,
  response: RegressionResponse,
): { effect: string; interval: string } {
  // 强度法解释变量以 0–1 比例记录；页面统一报告“冲击强度增加 1 个百分点”
  // （即 X 增加 0.01）对应的结果变化。DID/事件研究系数不做这一步缩放。
  const increment = response.design.method === "双向固定效应" ? 0.01 : 1;
  const effect = coefficient.coef * increment;
  const ciLow = coefficient.ci_low * increment;
  const ciHigh = coefficient.ci_high * increment;
  if (outcome === "trade" || outcome === "production") {
    return {
      effect: `${signed(effect * 100, 2)} 个百分点`,
      interval: `[${signed(ciLow * 100, 2)}, ${signed(ciHigh * 100, 2)}] 个百分点`,
    };
  }
  if (outcome === "network") {
    const sd = response.result.depvar_std;
    const standardized = Number.isFinite(sd) && sd > 0 ? effect / sd : null;
    const standardizedInterval = Number.isFinite(sd) && sd > 0
      ? `；约 [${signed(ciLow / sd, 2)}, ${signed(ciHigh / sd, 2)}] 个样本标准差`
      : "";
    return {
      effect: `${signed(effect, 2)} 个中心性原始单位${standardized == null ? "" : `（约 ${signed(standardized, 2)} 个样本标准差）`}`,
      interval: `[${signed(ciLow, 2)}, ${signed(ciHigh, 2)}] 个原始单位${standardizedInterval}`,
    };
  }
  const mean = response.result.depvar_mean;
  const relative = Number.isFinite(mean) && Math.abs(mean) > 1e-12 ? (effect / Math.abs(mean)) * 100 : null;
  return {
    effect: `${signed(effect, 3)} 个长度单位${relative == null ? "" : `（约为样本均值的 ${signed(relative, 2)}%）`}`,
    interval: `[${signed(ciLow, 3)}, ${signed(ciHigh, 3)}] 个长度单位`,
  };
}

function effectLabel(response: RegressionResponse, coefficient: CoefStat | null): string {
  const method = response.design.method;
  const base = method === "双向固定效应"
    ? "冲击强度每增加 1 个百分点"
    : method === "事件研究"
      ? coefficient?.name === "k=0" ? "冲击当期变化（k=0）" : `冲击后变化（${coefficient?.name ?? "无可估计时期"}）`
      : "处理后相对变化";
  return response.design.interaction ? `${base}（基期 GVC 样本均值处）` : base;
}

const INTERPRETATION: Record<RegressionOutcome, { negative: string; positive: string }> = {
  trade: {
    negative: "结果与外国增加值依赖下降一致，但不能单独证明供应链已经回流。",
    positive: "结果与外国增加值依赖上升一致，但仍需检查识别假设和其他共同变化。",
  },
  production: {
    negative: "结果与复杂跨境分工收缩一致，但不能单靠该估计确定机制。",
    positive: "结果与复杂跨境分工扩张一致，但不能据此排除其他解释。",
  },
  length: {
    negative: "结果与跨境生产链缩短一致，可能对应回流、近岸化或其他调整。",
    positive: "结果与跨境生产链延长一致，但不能单靠该估计判断企业策略。",
  },
  network: {
    negative: "结果与网络枢纽地位下降一致，但不能单独证明发生脱钩。",
    positive: "结果与网络枢纽地位增强一致，但可能同时受到网络重组影响。",
  },
};

export function buildRegressionVerdict(
  outcome: RegressionOutcome,
  response: RegressionResponse,
): RegressionVerdict {
  const coefficient = mainPolicyCoefficient(response);
  const boundary = "真实 OECD ICIO 指标 + 拟真政策冲击；本结果用于教学，不构成现实政策结论。";
  if (!coefficient) {
    return {
      state: "insufficient",
      title: "当前设定没有可解读的处理后政策系数",
      effectLabel: effectLabel(response, null),
      effect: "—",
      interval: "—",
      evidence: "请查看技术细节中的共线性或样本说明。",
      interpretation: "无法判断变化方向。",
      boundary,
      coefficient: null,
    };
  }

  const state: EvidenceState = coefficient.ci_high < 0
    ? "negative"
    : coefficient.ci_low > 0
      ? "positive"
      : "insufficient";
  const scaled = naturalScale(outcome, coefficient, response);
  return {
    state,
    title: state === "negative"
      ? "发现负向变化证据"
      : state === "positive"
        ? "发现正向变化证据"
        : "证据不足，无法判断变化方向",
    effectLabel: effectLabel(response, coefficient),
    effect: scaled.effect,
    interval: scaled.interval,
    evidence: state === "insufficient"
      ? "95% 置信区间跨过 0；这不等于“没有效应”，而是当前样本不足以确定方向。"
      : "95% 置信区间未跨过 0；是否作因果解释仍取决于冲击外生性、趋势可比性等假设。",
    interpretation: state === "insufficient"
      ? "当前结果不能支持明确的上升或下降结论。"
      : INTERPRETATION[outcome][state],
    boundary,
    coefficient,
  };
}

export function placeboInterpretation(empiricalP: number): string {
  if (empiricalP < 0.05) return "原始分组估计值位于随机伪处理分布的尾部，随机分组较难产生同等极端结果；这仍不是因果证明。";
  if (empiricalP < 0.1) return "原始分组估计值较少由随机伪处理产生，但证据较弱，需要结合其他检查。";
  return "随机伪处理经常产生同等极端的估计值，安慰剂结果未提供额外的稳健性支持。";
}
