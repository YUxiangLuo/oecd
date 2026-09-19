import type { RegressionOutcome } from "./types";

export type ReadingDirection = "negative" | "positive" | "insufficient" | "suppressed" | "pretrend";

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
  focus: string;
  /** 本步要学会的一件事，比 focus 更像老师开场。 */
  learnThis: string;
  definition: string;
  downMeaning: string;
  upMeaning: string;
  caution: string;
  howToRead: string;
  writeDown: string;
  dontClaim: string;
  guidedExperiment: string;
}

export const FAMILY_STEPS: Record<RegressionOutcome, number> = {
  trade: 11,
  production: 12,
  length: 13,
  network: 14,
};

export const REGRESSION_QUESTION =
  "固定使用步骤 10 的教学关税暴露 X，以国家×行业和年份固定效应描述 X 与 Y 的关联。";

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
    focus: "观察出口分解中的外国增加值这一项，看它所占的比例如何变化",
    learnThis: "运行固定模型，读出 X 增加 1 个百分点时外国增加值占比改变多少个百分点。",
    definition: "真实指标中，它是 WWZ 分解的 FVA（不含外国重复计算 FDC）占 VA+TLS 总出口的比重；这一定义只说明模拟 Y 所对应的概念，不表示本步 Y 是 OECD 观测值。",
    downMeaning: "负向变化表示外国增加值这一项的占比相对下降，但不能单独证明生产已经回流。",
    upMeaning: "正向变化表示外国增加值这一项的占比相对上升，但仍需结合不确定性和比较条件。",
    caution: "份额按百分点读。全球投入链会把政策传给未直接处理对象，no-interference/SUTVA 不能自动成立；2018–2020 又与 COVID-19 重叠，年份效应不能吸收国家×行业异质疫情冲击。不要和长度、网络系数比大小。",
    howToRead: "先看结果状态；允许推断时，再读估计与 95% 区间。区间跨 0 是「看不出方向」，不是零效应；停止推断则记「无法评估」。区间未跨 0 也不能跳过因果解释所需的假设。",
    writeDown: "记下结果状态、估计与单位（百分点）；停止推断时写明原因，留到第 15 步和另外三类并读。",
    dontClaim: "不要写成「已经证明生产回流」。这一项占比下降，不能告诉我们企业是否把生产搬回国内。",
    guidedExperiment: "固定教学模型不要求调整设定。",
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
    focus: "本步看贸易壁垒有没有改变多次跨境活动在 SVA 中的构成",
    learnThis: "X 不变，只把 Y 换成复杂 GVC 份额；构成变化不等于生产规模变化。",
    definition: "真实指标衡量增加值经过多次跨境生产后被最终吸收的比例；本步 Y 只是对应这一概念的模拟值。",
    downMeaning: "SVA 中复杂 GVC 增加值份额降低；这是构成占比变化，不能单凭该比例判断生产规模扩张/收缩。",
    upMeaning: "SVA 中复杂 GVC 增加值份额提高；这是构成占比变化，不能单凭该比例判断生产规模扩张/收缩。",
    caution: "区间跨过 0 是「看不出方向」，不是零效应。投入链外溢和贸易转移会污染对照；cohort-aware 主结果当前不发布交互估计。",
    howToRead: "「看不出」是合法结论，不是这步失败。不要拿步骤 11 的 FVA 系数代替本步。",
    writeDown: "与步骤 11 并读方向和区间；同为百分点，仍不能把构成变化解释为产量变化。",
    dontClaim: "不要把区间过 0 写成「冲击没有影响」。",
    guidedExperiment: "固定教学模型不要求调整设定。",
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
    focus: "本步看贸易壁垒有没有改变跨境生产链条的长短",
    learnThis: "X 不变，只把 Y 换成生产长度；长度不是百分点，也不能与份额系数比大小。",
    definition: "真实指标以 GVC 活动诱发的累计总产出除以关联增加值；本步 Y 是对应这一概念的模拟值，不是机械计算出的真实生产长度。",
    downMeaning: "负向变化与链条缩短一致，可能来自回流、近岸化或其他生产调整。",
    upMeaning: "正向变化与链条延长一致，但不能单靠一个系数判断企业策略。",
    caution: "长度单位不能和份额百分点相减。冲击前检验不显著不能证明趋势可比；投入链外溢、COVID-19 异质冲击仍可能破坏识别。",
    howToRead: "先核对是否允许推断，再判断变短、变长还是看不出。链条变短有多种机制，一个数字指不出是回流还是近岸。",
    writeDown: "单独记长度的方向。写报告时明确这是长度单位，不是百分点。",
    dontClaim: "不要写成「比贸易流效应更大 / 更小」。",
    guidedExperiment: "固定教学模型不要求调整设定。",
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
    focus: "本步探索贸易壁垒出现后，这套全正边二值编码中的拓扑位置是否变化",
    learnThis: "本步是探索性拓扑证据：微小边与大额边等长，未做边阈值敏感性检验；不能据此认定经济瓶颈或脱钩。",
    definition: "真实指标在全球国家×行业图上计算最短路径介数；本步 Y 只是对应这一概念的模拟值，不是由现实网络机械计算出的中心性。",
    downMeaning: "负向变化与拓扑中介位置下降一致，但不能单独证明发生了脱钩。",
    upMeaning: "正向变化与拓扑中介位置增强一致，但可能同时受到网络重组影响。",
    caution: "冲击会沿全球投入链外溢到未直接处理节点，网络中心性还会机械联动，因此对照未必干净。全正边口径对微小流量边敏感；实体置换尾部占比不是 p 值。",
    howToRead: "先看结果状态，允许推断时才判断这套拓扑编码中的方向。无论结果如何，都要披露未做边阈值敏感性；不能据此证明经济枢纽、瓶颈或脱钩。",
    writeDown: "把前三类主结果与本步探索性网络结果分栏记录；四个结果构成预先指定的结果族，不只挑显著项。",
    dontClaim: "不要挑绝对值最大的系数当「政策总效应」，也不要写成已经脱钩。",
    guidedExperiment: "固定教学模型不要求调整设定。",
  },
};

export const REGRESSION_FAMILIES = (["trade", "production", "length", "network"] as const).map((outcome) => ({
  outcome,
  step: FAMILY_STEPS[outcome],
  family: REGRESSION_LESSONS[outcome].family,
  measure: REGRESSION_LESSONS[outcome].measure,
}));

export function lessonQuestion(outcome: RegressionOutcome, shockType: string, method: string): string {
  const lesson = REGRESSION_LESSONS[outcome];
  void shockType;
  void method;
  return `教学关税暴露 X 增加 1 个百分点时，${lesson.shortMetric}如何变化？`;
}

export function comparisonExplanation(method: string): string {
  if (method === "did") {
    return "四格只建立统一处理时点的直觉：相对变化 =（处理后−处理前）−（对照后−对照前）。实际主结果按首次受冲击批次逐时期计算，只用从未或截至比较期尚未处理对象作对照，再按可用处理对象数聚合。";
  }
  if (method === "event_study") {
    return "以每批对象首次受冲击的前一年为参照，逐事件时间汇总各批次的 ATT；不让已处理批次充当对照。冲击前看不出差别不能证明趋势可比。";
  }
  return "不再把对象分成处理/对照两格，而是看冲击强度变大时，指标如何随之变化。";
}

export function familyDirectionLabel(direction: ReadingDirection): string {
  if (direction === "negative") return "下降";
  if (direction === "positive") return "上升";
  if (direction === "suppressed") return "无法评估";
  if (direction === "pretrend") return "冲击前已有差异";
  return "看不出";
}
