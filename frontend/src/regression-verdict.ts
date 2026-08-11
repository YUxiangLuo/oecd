import type { CoefStat, RegressionOutcome, RegressionResponse, RegressionStatus } from "./types";

// suppressed:设计无效或处理支持度不足,服务端已抽掉 p 值与置信区间。
// 它与 insufficient 必须分开:前者是“不可评估”,后者是“区间跨过 0”。
type EvidenceState = "negative" | "positive" | "insufficient" | "suppressed";

/** 设计有效性 → 摘要处的短文案。与 gvcsim/teaching_report.py 的 _STATUS_LABELS 同键同义:
 * 那份写进报告正文,这份用于列表/摘要行。二者都以 RegressionStatus 为准,
 * regression-verdict.test.ts 断言本表覆盖它的每个取值。 */
export const REGRESSION_STATUS_LABELS: Record<RegressionStatus, string> = {
  ok: "可按课程口径解释",
  warning: "可展示，但须说明设计问题",
  insufficient: "处理支持度不足，已抑制推断",
  invalid_design: "设计与处理路径不相容，已停止推断",
};

/** 安全取文案:状态缺失或未知时说“未知”,而不是默认成 ok——
 * 把没核实过的设计显示为“可解释”,是这里能犯的最坏的错。 */
export function regressionStatusLabel(status: string | null | undefined): string {
  if (!status) return "设计有效性未知";
  return REGRESSION_STATUS_LABELS[status as RegressionStatus] ?? "设计有效性未知";
}

interface RegressionVerdict {
  state: EvidenceState;
  title: string;
  effectLabel: string;
  effect: string;
  interval: string;
  evidence: string;
  interpretation: string;
  boundary: string;
  coefficient: CoefStat | null;
  /** 需要在结论旁明示的设计问题(suppressed 的原因,或 warning 的披露)。 */
  warnings: string[];
}

function mainPolicyCoefficient(response: RegressionResponse): CoefStat | null {
  const controls = new Set(response.design.controls);
  const main = response.result.coefs.filter((coef) =>
    !controls.has(coef.name) && !coef.name.includes("×base_gvc"),
  );
  if (response.design.method === "event_study") {
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
  const increment = response.design.method === "twfe_intensity" ? 0.01 : 1;
  const effect = coefficient.coef * increment;
  // 推断被抑制时没有置信区间可缩放;区间一律显示为“—”,不得回落成 0 或 NaN。
  const hasCi = coefficient.ci_low != null && coefficient.ci_high != null;
  const ciLow = (coefficient.ci_low ?? 0) * increment;
  const ciHigh = (coefficient.ci_high ?? 0) * increment;
  const NO_CI = "—";
  if (outcome === "trade" || outcome === "production") {
    return {
      effect: `${signed(effect * 100, 2)} 个百分点`,
      interval: hasCi ? `[${signed(ciLow * 100, 2)}, ${signed(ciHigh * 100, 2)}] 个百分点` : NO_CI,
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
      interval: hasCi ? `[${signed(ciLow, 2)}, ${signed(ciHigh, 2)}] 个原始单位${standardizedInterval}` : NO_CI,
    };
  }
  const mean = response.result.depvar_mean;
  const relative = Number.isFinite(mean) && Math.abs(mean) > 1e-12 ? (effect / Math.abs(mean)) * 100 : null;
  return {
    effect: `${signed(effect, 3)} 个长度单位${relative == null ? "" : `（约为样本均值的 ${signed(relative, 2)}%）`}`,
    interval: hasCi ? `[${signed(ciLow, 3)}, ${signed(ciHigh, 3)}] 个长度单位` : NO_CI,
  };
}

function effectLabel(response: RegressionResponse, coefficient: CoefStat | null): string {
  const method = response.design.method;
  const base = method === "twfe_intensity"
    ? "冲击强度每增加 1 个百分点"
    : method === "event_study"
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
  const support = response.result.support;
  const reasons = response.result.status_reasons ?? [];
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
      warnings: reasons,
    };
  }

  const scaled = naturalScale(outcome, coefficient, response);

  // 设计无效或处理支持度不足:必须先于任何区间比较返回,
  // 否则 null 区间会被静默当成“区间跨过 0”,把不可评估说成证据不足。
  if (support?.suppress_inference) {
    const invalid = support.status === "invalid_design";
    return {
      state: "suppressed",
      title: invalid ? "这个设计不能用于统计推断" : "处理支持度不足，无法给出显著性",
      effectLabel: effectLabel(response, coefficient),
      effect: scaled.effect,
      interval: "—",
      evidence: invalid
        ? "估计量与面板中的处理路径不相容，点估计仍会算出，但它已不是原本想估计的对象；p 值、置信区间与星号均已抑制。"
        : `只有 ${support.treated_clusters} 个处理聚类（下限 ${support.min_treated_clusters}），`
          + `聚类稳健推断在此失效；p 值、置信区间与星号均已抑制。`,
      interpretation: "不能据此判断变化方向——这不是“没有效应”，而是当前设计无法评估。",
      boundary,
      coefficient,
      warnings: reasons,
    };
  }

  const state: EvidenceState = coefficient.ci_high != null && coefficient.ci_high < 0
    ? "negative"
    : coefficient.ci_low != null && coefficient.ci_low > 0
      ? "positive"
      : "insufficient";
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
    // warning 级问题(如少量撤销、无对照聚类)不抑制推断,但必须与结论并列展示。
    warnings: reasons,
  };
}

export function placeboInterpretation(empiricalP: number): string {
  if (empiricalP < 0.05) return "原始分组估计值位于随机伪处理分布的尾部，随机分组较难产生同等极端结果；这仍不是因果证明。";
  if (empiricalP < 0.1) return "原始分组估计值较少由随机伪处理产生，但证据较弱，需要结合其他检查。";
  return "随机伪处理经常产生同等极端的估计值，安慰剂结果未提供额外的稳健性支持。";
}
