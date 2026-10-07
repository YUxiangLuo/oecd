import type { RegressionOutcome } from "./types";

export type ReadingDirection = "negative" | "positive" | "insufficient" | "suppressed";

interface RegressionLesson {
  outcome: RegressionOutcome;
  step: number;
  shortMetric: string;
  /** 家族图上的类别名。 */
  family: string;
  /** 家族图上“这一类在量什么”。 */
  measure: string;
  unit: string;
  priorStep: number;
  priorLabel: string;
  /** 本步要学会的一件事，用于老师开场。 */
  learnThis: string;
  definition: string;
  downMeaning: string;
  upMeaning: string;
  dontClaim: string;
}

export const FAMILY_STEPS: Record<RegressionOutcome, number> = {
  trade: 11,
  production: 12,
  length: 13,
  network: 14,
};

export const REGRESSION_QUESTION =
  "固定使用步骤 10 的关税暴露（X），观察不同结果指标（Y）怎样随它一起变化。";

export const REGRESSION_LESSONS: Record<RegressionOutcome, RegressionLesson> = {
  trade: {
    outcome: "trade",
    step: 11,
    shortMetric: "外国增加值项占比",
    family: "贸易流",
    measure: "出口价值构成变了吗？",
    unit: "百分点",
    priorStep: 2,
    priorLabel: "GVC 总贸易流分解指标",
    learnThis: "读数：用一句话说出 X 增加 1 个百分点时，Y 平均变化多少个百分点。",
    definition: "WWZ 分解的 FVA（不含外国重复计算 FDC）占 VA+TLS 总出口的比重。",
    downMeaning: "外国增加值项占比下降：出口价值中来自国外投入的部分变小。",
    upMeaning: "外国增加值项占比上升：出口价值中来自国外投入的部分变大。",
    dontClaim: "不要写成「已经证明生产回流」。这一项占比下降，不能告诉我们企业是否把生产搬回国内。",
  },
  production: {
    outcome: "production",
    step: 12,
    shortMetric: "复杂 GVC 生产份额",
    family: "生产",
    measure: "多次跨境生产的占比变了吗？",
    unit: "百分点",
    priorStep: 3,
    priorLabel: "GVC 生产分解指标",
    learnThis: "读区间：估计值有正有负，单看正负不一定有足够证据判断上升或下降；还要看区间是否包含 0。",
    definition: "增加值经过多次跨境生产后被最终吸收的比例。",
    downMeaning: "复杂 GVC 生产份额下降：SVA 中经多次跨境生产的部分占比变小。",
    upMeaning: "复杂 GVC 生产份额上升：SVA 中经多次跨境生产的部分占比变大。",
    dontClaim: "不要写成「复杂 GVC 生产规模缩小」。这一项是占总增加值的份额，份额下降不代表复杂 GVC 生产的绝对量减少。",
  },
  length: {
    outcome: "length",
    step: 13,
    shortMetric: "前向 GVC 段长度",
    family: "长度",
    measure: "生产链变长还是变短了？",
    unit: "长度单位",
    priorStep: 4,
    priorLabel: "GVC 长度分解指标",
    learnThis: "读单位：长度单位不是百分点，不能与前两步的份额系数直接比大小。",
    definition: "GVC 活动诱发的累计总产出除以关联增加值。",
    downMeaning: "前向 GVC 段长度缩短：增加值到最终吸收经过的生产环节减少。",
    upMeaning: "前向 GVC 段长度延长：增加值到最终吸收经过的生产环节增加。",
    dontClaim: "不要写成「比贸易流效应更大 / 更小」。",
  },
  network: {
    outcome: "network",
    step: 14,
    shortMetric: "加权总度",
    family: "网络",
    measure: "网络中的流量规模变了吗？",
    unit: "中心性原始单位（另附标准差换算）",
    priorStep: 5,
    priorLabel: "全球生产网络指标",
    learnThis: "读网络 Y：按步骤 9 所看指标（默认加权总度）的原始单位读方向和区间，不与前三步的系数比大小。",
    definition: "全球国家×行业图上一个节点的加权入度加出度（自环双计）。",
    downMeaning: "加权总度下降：节点买入与卖出的总流量规模变小。",
    upMeaning: "加权总度上升：节点买入与卖出的总流量规模变大。",
    dontClaim: "不要写成连接已经减少或脱钩，也不要拿它当「政策总效应」。",
  },
};

/** Same-family alternatives a step may use as Y (keys match teaching.BASELINES on the server). */
export interface BaselineLesson {
  shortMetric: string;
  unit: string;
  /** Overrides the family focus line when the alternative reads differently (e.g. a position index). */
  learnThis?: string;
  definition: string;
  downMeaning: string;
  upMeaning: string;
  dontClaim: string;
}

export const BASELINE_LESSONS: Record<string, BaselineLesson> = {
  DVAex_share: {
    shortMetric: "国内增加值出口占比",
    unit: "百分点",
    definition: "被国外最终吸收的国内增加值占 VA+TLS 账户闭合总出口的比重。",
    downMeaning: "国内增加值出口占比下降：出口价值中由本国创造的部分变小。",
    upMeaning: "国内增加值出口占比上升：出口价值中由本国创造的部分变大。",
    dontClaim: "不要写成「已经证明生产回流」。国内增加值出口占比上升，不能告诉我们企业是否把生产搬回国内。",
  },
  "3_VA_GVC_share": {
    shortMetric: "前向 GVC 生产总份额",
    unit: "百分点",
    definition: "增加值经过至少一次跨境后被最终吸收的比例（简单加复杂）。",
    downMeaning: "前向 GVC 生产总份额下降：SVA 中与跨境生产相关的部分占比变小。",
    upMeaning: "前向 GVC 生产总份额上升：SVA 中与跨境生产相关的部分占比变大。",
    dontClaim: "不要写成「GVC 生产规模缩小」。这一项是占总增加值的份额，份额下降不代表 GVC 相关生产的绝对量减少。",
  },
  "3a_VA_GVC_S_share": {
    shortMetric: "简单 GVC 生产份额",
    unit: "百分点",
    definition: "增加值只跨境一次就被吸收的比例。",
    downMeaning: "简单 GVC 生产份额下降：只跨境一次就被吸收的增加值占比变小。",
    upMeaning: "简单 GVC 生产份额上升：只跨境一次就被吸收的增加值占比变大。",
    dontClaim: "不要写成「简单 GVC 生产规模缩小」。这一项是占总增加值的份额，份额下降不代表绝对量减少。",
  },
  "3_FGY_GVC_share": {
    shortMetric: "后向 GVC 生产总份额",
    unit: "百分点",
    definition: "从最终产品端衡量 GVC 相关生产占最终品生产的比例。",
    downMeaning: "后向 GVC 生产总份额下降：最终品生产中与跨境生产相关的部分占比变小。",
    upMeaning: "后向 GVC 生产总份额上升：最终品生产中与跨境生产相关的部分占比变大。",
    dontClaim: "不要写成「GVC 生产规模缩小」。这一项是占最终品生产的份额，份额下降不代表绝对量减少。",
  },
  "2_VA_RT_share": {
    shortMetric: "传统贸易生产份额",
    unit: "百分点",
    definition: "增加值经一次出口直接被进口国吸收的比例。",
    downMeaning: "传统贸易生产份额下降：经一次出口直接被进口国吸收的增加值占比变小。",
    upMeaning: "传统贸易生产份额上升：经一次出口直接被进口国吸收的增加值占比变大。",
    dontClaim: "不要写成「传统贸易萎缩」。这一项是占总增加值的份额，份额下降不代表绝对量减少。",
  },
  "1_VA_D_share": {
    shortMetric: "纯国内生产份额",
    unit: "百分点",
    definition: "增加值不经出口、在国内被最终吸收的比例。",
    downMeaning: "纯国内生产份额下降：不经出口、在国内被吸收的增加值占比变小。",
    upMeaning: "纯国内生产份额上升：不经出口、在国内被吸收的增加值占比变大。",
    dontClaim: "不要写成「生产已经回流国内」。纯国内生产份额上升，不代表国内生产的绝对量增加。",
  },
  PLy_GVC: {
    shortMetric: "后向 GVC 段长度",
    unit: "长度单位",
    definition: "从最终产品端回溯 GVC 活动的初始增加值所经过的生产长度。",
    downMeaning: "后向 GVC 段长度缩短：从最终品回溯的 GVC 生产环节减少。",
    upMeaning: "后向 GVC 段长度延长：从最终品回溯的 GVC 生产环节增加。",
    dontClaim: "不要写成「比贸易流效应更大 / 更小」，也不要把后向长度与前向长度的系数相减。",
  },
  GVCPs: {
    shortMetric: "GVC 位置指数",
    learnThis: "读单位：位置指数单位不是百分点，也不是长度；回归读的是指数的变化，上升表示相对更偏上游，不与长度或份额的系数比大小。",
    unit: "位置指数单位",
    definition: "前向与后向 GVC 长度之比的位置指数，>1 表示在该口径下相对更上游。",
    downMeaning: "位置指数下降：在该口径下相对更靠下游。",
    upMeaning: "位置指数上升：在该口径下相对更上游。",
    dontClaim: "不要写成「已经变得更上游 / 更下游」。位置指数不能与长度系数比大小。",
  },
  weighted_indegree: {
    shortMetric: "加权入度",
    unit: "中心性原始单位（另附标准差换算）",
    definition: "全球国家×行业图上一个节点的加权入度，即买入侧的流量规模。",
    downMeaning: "加权入度下降：买入侧的流量规模变小。",
    upMeaning: "加权入度上升：买入侧的流量规模变大。",
    dontClaim: "不要写成买入已经减少或脱钩，也不要拿它当「政策总效应」。",
  },
  weighted_outdegree: {
    shortMetric: "加权出度",
    unit: "中心性原始单位（另附标准差换算）",
    definition: "全球国家×行业图上一个节点的加权出度，即卖出侧的流量规模。",
    downMeaning: "加权出度下降：卖出侧的流量规模变小。",
    upMeaning: "加权出度上升：卖出侧的流量规模变大。",
    dontClaim: "不要写成卖出已经减少或脱钩，也不要拿它当「政策总效应」。",
  },
  betweenesscentrality: {
    shortMetric: "网络介数",
    unit: "中心性原始单位（另附标准差换算）",
    definition: "全球国家×行业图上的最短路径介数（全正边、二值、未归一化）。",
    downMeaning: "介数下降：在二值拓扑最短路径上的中介位置减弱。",
    upMeaning: "介数上升：在二值拓扑最短路径上的中介位置增强。",
    dontClaim: "不要挑绝对值最大的系数当「政策总效应」，也不要写成已经脱钩。",
  },
  closnesscentrality: {
    shortMetric: "接近中心性",
    unit: "中心性原始单位（另附标准差换算）",
    definition: "全球国家×行业图上到其他节点最短路径距离的倒数。",
    downMeaning: "接近中心性下降：到其他节点的网络距离变远。",
    upMeaning: "接近中心性上升：到其他节点的网络距离变近。",
    dontClaim: "不要挑绝对值最大的系数当「政策总效应」，也不要写成网络位置已经边缘化。",
  },
};

/** The step's lesson with the wording of the chosen same-family baseline (the family's own wording by default). */
/** The fixed Y of each step (teaching.BASELINES[outcome][0] on the server). */
export const DEFAULT_BASELINES: Record<RegressionOutcome, string> = {
  trade: "FVA_share",
  production: "3b_VA_GVC_C_share",
  length: "PLv_GVC",
  network: "weighted_degree",
};

/** The visualization step whose recorded indicator each regression step follows. */
export const VIZ_STEPS: Record<RegressionOutcome, number> = { trade: 6, production: 7, length: 8, network: 9 };

/** A step 6-9 metric key as a generation-baseline key (network metrics carry spaces). */
export function baselineKeyOf(metric: string | null | undefined): string | null {
  return metric ? metric.replace(/ /g, "_") : null;
}

export function lessonFor(outcome: RegressionOutcome, baseline?: string | null, label?: string | null): RegressionLesson {
  const base = REGRESSION_LESSONS[outcome];
  if (!baseline || baseline === DEFAULT_BASELINES[outcome]) return base;
  const alternative = BASELINE_LESSONS[baseline];
  if (alternative) return { ...base, ...alternative };
  // A baseline the lexicon does not know yet: at least name it the way the server does.
  return label ? { ...base, shortMetric: label } : base;
}

export const REGRESSION_FAMILIES = (["trade", "production", "length", "network"] as const).map((outcome) => ({
  outcome,
  step: FAMILY_STEPS[outcome],
  family: REGRESSION_LESSONS[outcome].family,
  measure: REGRESSION_LESSONS[outcome].measure,
}));

export function lessonQuestion(outcome: RegressionOutcome, baseline?: string | null): string {
  const lesson = lessonFor(outcome, baseline);
  return `关税暴露（X）增加 1 个百分点时，${lesson.shortMetric}（Y）如何变化？`;
}

export function familyDirectionLabel(direction: ReadingDirection): string {
  if (direction === "negative") return "下降";
  if (direction === "positive") return "上升";
  if (direction === "suppressed") return "无法评估";
  return "看不出";
}
