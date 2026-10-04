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
  "固定使用步骤 10 的模拟关税暴露（X），观察不同结果指标（Y）怎样随它一起变化。";

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
    learnThis: "读数：把结果说成一句话——X 增加 1 个百分点时，Y 平均变化多少个百分点。",
    definition: "真实指标中，它是 WWZ 分解的 FVA（不含外国重复计算 FDC）占 VA+TLS 总出口的比重；这一定义只说明模拟 Y 所对应的概念，不表示本步 Y 是 OECD 观测值。",
    downMeaning: "模拟 Y 的数值下降。若真实同定义指标下降，才表示外国增加值项占比降低，仍不能单独证明生产回流。",
    upMeaning: "模拟 Y 的数值上升。若真实同定义指标上升，才表示外国增加值项占比提高；本实验没有重算出口分解。",
    dontClaim: "不要写成「已经证明生产回流」。这一项占比下降，不能告诉我们企业是否把生产搬回国内。",
  },
  production: {
    outcome: "production",
    step: 12,
    shortMetric: "复杂 GVC 份额",
    family: "生产",
    measure: "多次跨境生产的占比变了吗？",
    unit: "百分点",
    priorStep: 3,
    priorLabel: "GVC 生产分解指标",
    learnThis: "读区间：估计值为负，不一定有足够证据判断下降；还要看区间是否包含 0。",
    definition: "真实指标衡量增加值经过多次跨境生产后被最终吸收的比例；本步 Y 只是对应这一概念的模拟值。",
    downMeaning: "模拟 Y 的数值下降。若真实同定义指标下降，才表示 SVA 中复杂 GVC 的构成占比变化，不能单凭该比例判断生产规模扩张/收缩。",
    upMeaning: "模拟 Y 的数值上升。若真实同定义指标上升，才表示复杂 GVC 份额提高；本实验没有重算生产分解。",
    dontClaim: "不要把区间过 0 写成「冲击没有影响」。",
  },
  length: {
    outcome: "length",
    step: 13,
    shortMetric: "跨境生产长度",
    family: "长度",
    measure: "生产链变长还是变短了？",
    unit: "生产环节长度单位",
    priorStep: 4,
    priorLabel: "GVC 长度分解指标",
    learnThis: "读单位：长度单位不是百分点，不能与前两步的份额系数直接比大小。",
    definition: "真实指标以 GVC 活动诱发的累计总产出除以关联增加值；本步 Y 是对应这一概念的模拟值，不是机械计算出的真实生产长度。",
    downMeaning: "模拟 Y 的数值下降。若真实同定义长度下降，才可能与生产链缩短一致；本实验没有生成冲击后的投入产出表。",
    upMeaning: "模拟 Y 的数值上升。若真实同定义长度上升，才可能与生产链延长一致，仍不能单靠一个系数判断企业策略。",
    dontClaim: "不要写成「比贸易流效应更大 / 更小」。",
  },
  network: {
    outcome: "network",
    step: 14,
    shortMetric: "全正边二值介数",
    family: "网络（探索性）",
    measure: "网络中的连接位置变了吗？",
    unit: "中心性原始单位，并补充标准差单位",
    priorStep: 5,
    priorLabel: "全球生产网络指标",
    learnThis: "比单位：四个 Y 的单位不同，不能按系数大小排序；网络 Y 也是模拟值，不能据此认定网络已经改变或脱钩。",
    definition: "真实指标在全球国家×行业图上计算最短路径介数；本步 Y 只是对应这一概念的模拟值，不是由现实网络机械计算出的中心性。",
    downMeaning: "模拟 Y 的数值下降。本实验没有生成对应的新网络，不能称为拓扑位置下降；只有重新计算真实网络的同定义介数后，才能讨论其拓扑变化。",
    upMeaning: "模拟 Y 的数值上升。本实验没有生成对应的新网络，不能称为拓扑位置增强，也不能据此判断经济重要性。",
    dontClaim: "不要挑绝对值最大的系数当「政策总效应」，也不要写成已经脱钩。",
  },
};

export const REGRESSION_FAMILIES = (["trade", "production", "length", "network"] as const).map((outcome) => ({
  outcome,
  step: FAMILY_STEPS[outcome],
  family: REGRESSION_LESSONS[outcome].family,
  measure: REGRESSION_LESSONS[outcome].measure,
}));

export function lessonQuestion(outcome: RegressionOutcome): string {
  const lesson = REGRESSION_LESSONS[outcome];
  return `模拟关税暴露（X）增加 1 个百分点时，模拟 Y（${lesson.shortMetric}）如何变化？`;
}

export function familyDirectionLabel(direction: ReadingDirection): string {
  if (direction === "negative") return "下降";
  if (direction === "positive") return "上升";
  if (direction === "suppressed") return "无法评估";
  return "看不出";
}
