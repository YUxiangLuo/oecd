import type { RegressionOutcome } from "./types";

export type ReadingDirection = "negative" | "positive" | "insufficient" | "suppressed" | "pretrend";

interface RegressionLesson {
  outcome: RegressionOutcome;
  step: number;
  metric: string;
  shortMetric: string;
  /** 家族图上的两个字。 */
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
  trade: 12,
  production: 13,
  length: 14,
  network: 15,
};

export const REGRESSION_QUESTION =
  "在显式识别假设下，壁垒出现后各 cohort 的指标相对从未或尚未受冲击对象如何变化？全球投入链外溢可能使对照组也受影响。";

export const REGRESSION_LESSONS: Record<RegressionOutcome, RegressionLesson> = {
  trade: {
    outcome: "trade",
    step: 12,
    metric: "出口中外国增加值份额（FVA / VA+TLS 账户闭合毛出口）",
    shortMetric: "FVA 份额",
    family: "贸易流",
    measure: "出口对外国投入的依赖",
    unit: "百分点",
    priorStep: 3,
    priorLabel: "GVC 总贸易流分解指标",
    focus: "本步看贸易壁垒有没有改变出口对外国投入的依赖",
    learnThis: "先用统一处理时点的四格建立 DID 直觉，再看实际分批处理：系统逐 cohort、逐时期比较，并只让从未处理或截至比较期尚未处理的对象进入对照。",
    definition: "它表示一单位出口中有多少价值由外国投入创造。步骤 12–15 问的是同一句话，本步看的是贸易流这一类指标。",
    downMeaning: "负向变化与外国增加值依赖下降一致，但不能单独证明生产已经回流。",
    upMeaning: "正向变化与外国增加值依赖上升一致，但仍需结合不确定性和识别假设。",
    caution: "份额按百分点读。全球投入链会把政策传给未直接处理对象，no-interference/SUTVA 不能自动成立；2018–2020 又与 COVID-19 重叠，年份效应不能吸收国家×行业异质疫情冲击。不要和长度、网络系数比大小。",
    howToRead: "先看 95% 置信区间过不过 0。不过 0，才能说看得出升或降；过 0，就记「看不出」。",
    writeDown: "记下本步方向（升 / 降 / 看不出）和单位（百分点），留到第 16 步和另外三类并读。",
    dontClaim: "不要写成「已经证明生产回流」。FVA 下降只说明出口里外国投入占比相对下降。",
    guidedExperiment: "检查 cohort 数量、对照组构成与 no-interference 假设；同期出口、增加值和产业份额可能是处理后变量，不能当作普通遗漏变量控制。",
  },
  production: {
    outcome: "production",
    step: 13,
    metric: "复杂 GVC 生产份额（增加值至少多次跨境）",
    shortMetric: "复杂 GVC 份额",
    family: "生产",
    measure: "跨境分工有多绕",
    unit: "百分点",
    priorStep: 4,
    priorLabel: "GVC 生产分解指标",
    focus: "本步看贸易壁垒有没有改变跨境分工的复杂程度",
    learnThis: "比较方式和步骤 12 相同，换的是指标。本步看增加值在最终吸收前有没有少绕几次跨境。",
    definition: "它衡量增加值经过多次跨境生产后被最终吸收的比例。默认比较方式和上一步相同，本步看的是生产分解这一类指标。",
    downMeaning: "SVA 中复杂 GVC 增加值份额降低；这是构成占比变化，不能单凭该比例判断生产规模扩张/收缩。",
    upMeaning: "SVA 中复杂 GVC 增加值份额提高；这是构成占比变化，不能单凭该比例判断生产规模扩张/收缩。",
    caution: "区间跨过 0 是「看不出方向」，不是零效应。投入链外溢和贸易转移会污染对照；cohort-aware 主结果当前不发布交互估计。",
    howToRead: "「看不出」是合法结论，不是这步失败。不要拿步骤 12 的 FVA 系数代替本步。",
    writeDown: "和步骤 12 并排记：谁动了、谁看不出。两步单位都是百分点，仍不要比谁的数字更大。",
    dontClaim: "不要把区间过 0 写成「冲击没有影响」。",
    guidedExperiment: "选做：打开“冲击 × 处理前 GVC”，比较平均变化和条件边际效应。",
  },
  length: {
    outcome: "length",
    step: 14,
    metric: "前向 GVC 生产长度（PLv_GVC）",
    shortMetric: "跨境生产长度",
    family: "长度",
    measure: "生产链条有多长",
    unit: "生产环节长度单位",
    priorStep: 5,
    priorLabel: "GVC 长度分解指标",
    focus: "本步看贸易壁垒有没有改变跨境生产链条的长短",
    learnThis: "本步的单位不是百分点。并读只看方向和区间是否过 0，不能和份额的系数相减或比大小。",
    definition: "它以 GVC 活动诱发的累计总产出除以关联增加值；VA 为正时可理解为增加值加权阶段数，存在负 VA 时是有符号账户比值。它不是跨境次数、国家数或网络边数。默认使用 cohort-time ATT；按年动态路径是选做。",
    downMeaning: "负向变化与链条缩短一致，可能来自回流、近岸化或其他生产调整。",
    upMeaning: "正向变化与链条延长一致，但不能单靠一个系数判断企业策略。",
    caution: "长度单位不能和份额百分点相减。冲击前检验不显著不能证明趋势可比；投入链外溢、COVID-19 异质冲击仍可能破坏识别。",
    howToRead: "先判断变短、变长还是看不出。链条变短有多种机制，一个数字指不出是回流还是近岸。",
    writeDown: "单独记长度的方向。写报告时明确这是长度单位，不是百分点。",
    dontClaim: "不要写成「比贸易流效应更大 / 更小」。",
    guidedExperiment: "选做：改到按冲击前后各年观察，分别记下一项冲击前诊断和一项冲击后动态。",
  },
  network: {
    outcome: "network",
    step: 15,
    metric: "生产网络介数中心性",
    shortMetric: "介数中心性",
    family: "网络",
    measure: "节点的拓扑位置",
    unit: "中心性原始单位，并补充标准差单位",
    priorStep: 6,
    priorLabel: "全球生产网络指标",
    focus: "本步看贸易壁垒有没有改变节点在生产网络里的拓扑位置",
    learnThis: "介数描述拓扑位置，不是出口规模，也不自动等于经济瓶颈。四步凑齐后，并读方向和谁看不出。",
    definition: "它加总全球国家×行业图中各有序节点对最短路径经过该节点的份额 σ_st(v)/σ_st；等长路径会分摊贡献，结果未按节点对数归一化。高介数不是规模，也不自动等于经济瓶颈。",
    downMeaning: "负向变化与拓扑中介位置下降一致，但不能单独证明发生了脱钩。",
    upMeaning: "正向变化与拓扑中介位置增强一致，但可能同时受到网络重组影响。",
    caution: "冲击会沿全球投入链外溢到未直接处理节点，网络中心性还会机械联动，因此对照未必干净。实体置换尾部占比不是 p 值。",
    howToRead: "先看方向，再提醒自己：高介数不是枢纽证明。网络冲击可能外溢，对照未必干净。",
    writeDown: "把四步方向排成一排：同向、有的动有的看不出，都要写进第 16 步。",
    dontClaim: "不要挑绝对值最大的系数当「政策总效应」，也不要写成已经脱钩。",
    guidedExperiment: "跑完基准后，到「若要进一步检查稳健性」里运行实体置换，看原始估计在这套人为改派规则下是否靠尾部。",
  },
};

export const REGRESSION_FAMILIES = (["trade", "production", "length", "network"] as const).map((outcome) => ({
  outcome,
  step: FAMILY_STEPS[outcome],
  family: REGRESSION_LESSONS[outcome].family,
  measure: REGRESSION_LESSONS[outcome].measure,
}));

// 按稳定键索引;值是课堂问句里的说法(与后端 SHOCK_LABELS 刻意不同)。
const SHOCK_SUBJECT: Record<string, string> = {
  tariff: "额外关税冲击",
  sanctions: "制裁暴露",
  export_control: "出口管制暴露",
};

export function lessonQuestion(outcome: RegressionOutcome, shockType: string, method: string): string {
  const lesson = REGRESSION_LESSONS[outcome];
  const shock = SHOCK_SUBJECT[shockType] ?? shockType;
  if (method === "twfe_intensity") {
    return `${shock}变强时，${lesson.shortMetric}如何随之变化？`;
  }
  return `受到${shock}后，各处理 cohort 的${lesson.shortMetric}相对从未或尚未处理对象发生了怎样的变化？`;
}

export function comparisonExplanation(method: string): string {
  if (method === "did") {
    return "四格只建立统一处理时点的直觉：相对变化 =（处理后−处理前）−（对照后−对照前）。实际主结果逐 cohort×时期计算，只用从未或截至比较期尚未处理对象作对照，再按可用处理实体数聚合。";
  }
  if (method === "event_study") {
    return "按每个 cohort 首次冲击前一年为参照，逐事件时间聚合 cohort-time ATT；不让已处理 cohort 充当对照。冲击前看不出差别不能证明趋势可比。";
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

export function nextRegressionFamily(outcome: RegressionOutcome) {
  const index = REGRESSION_FAMILIES.findIndex((item) => item.outcome === outcome);
  return index >= 0 ? REGRESSION_FAMILIES[index + 1] ?? null : null;
}

/** 给学生可抄进第 16 步的一句话；不把点估计说成因果证明。 */
export function reportTakeaway(outcome: RegressionOutcome, direction: ReadingDirection, effect: string): string {
  const metric = REGRESSION_LESSONS[outcome].shortMetric;
  if (direction === "negative") {
    return `可记进报告：本步「${metric}」相对下降（${effect}），区间未过 0。`;
  }
  if (direction === "positive") {
    return `可记进报告：本步「${metric}」相对上升（${effect}），区间未过 0。`;
  }
  if (direction === "suppressed") {
    return `可记进报告：本步「${metric}」当前设计无法评估，不要把点估计当成方向。`;
  }
  if (direction === "pretrend") {
    return `可记进报告：本步「${metric}」冲击前已有明显差异，只能描述点估计（${effect}），不能写成相对上升或下降。`;
  }
  return `可记进报告：本步「${metric}」看不出方向，区间跨过 0。这不等于没有效应。`;
}
