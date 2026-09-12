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
  "按首次正暴露年份（G_i）划分处理批次（cohort），低强度也算暴露。与从未或截至比较期尚未暴露的对象比较变化；这些对照仍可能受到投入链外溢影响，不能自动视为可比。";

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
    learnThis: "先用统一处理时点的四格理解 DID，再看实际分批处理：系统逐批次、逐时期比较，只用从未处理或截至比较期尚未处理的对象作对照。",
    definition: "它是 WWZ 分解的 FVA（不含外国重复计算 FDC）占 VA+TLS 毛出口的比重。毛出口全部外国纯 VA 含量为 FVA+FDC；OECD 还采用包含相关 TLS 的 VA 口径，因此本指标不是 EXGR_FVASH。",
    downMeaning: "负向变化表示外国增加值这一项的占比相对下降，但不能单独证明生产已经回流。",
    upMeaning: "正向变化表示外国增加值这一项的占比相对上升，但仍需结合不确定性和比较条件。",
    caution: "份额按百分点读。全球投入链会把政策传给未直接处理对象，no-interference/SUTVA 不能自动成立；2018–2020 又与 COVID-19 重叠，年份效应不能吸收国家×行业异质疫情冲击。不要和长度、网络系数比大小。",
    howToRead: "先看结果状态；允许推断时，再读估计与 95% 区间。区间跨 0 是「看不出方向」，不是零效应；停止推断则记「无法评估」。区间未跨 0 也不能跳过因果解释所需的假设。",
    writeDown: "记下结果状态、估计与单位（百分点）；停止推断时写明原因，留到第 15 步和另外三类并读。",
    dontClaim: "不要写成「已经证明生产回流」。这一项占比下降，不能告诉我们企业是否把生产搬回国内。",
    guidedExperiment: "检查首次受冲击批次数、对照组构成，以及对照是否也受外溢影响；同期出口、增加值和产业份额可能已受政策影响，不能当作普通控制变量。",
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
    learnThis: "比较方式和步骤 11 相同，换的是指标。本步看多次跨境实现的增加值构成是否变化；它不是规模、韧性或嵌入深度的通用标尺。",
    definition: "它衡量增加值经过多次跨境生产后被最终吸收的比例。默认比较方式和上一步相同，本步看的是生产分解这一类指标。",
    downMeaning: "SVA 中复杂 GVC 增加值份额降低；这是构成占比变化，不能单凭该比例判断生产规模扩张/收缩。",
    upMeaning: "SVA 中复杂 GVC 增加值份额提高；这是构成占比变化，不能单凭该比例判断生产规模扩张/收缩。",
    caution: "区间跨过 0 是「看不出方向」，不是零效应。投入链外溢和贸易转移会污染对照；cohort-aware 主结果当前不发布交互估计。",
    howToRead: "「看不出」是合法结论，不是这步失败。不要拿步骤 11 的 FVA 系数代替本步。",
    writeDown: "和步骤 11 并排记录：有方向证据、看不出方向，还是无法评估？两步单位都是百分点，仍不要比谁的数字更大。",
    dontClaim: "不要把区间过 0 写成「冲击没有影响」。",
    guidedExperiment: "选做：先把比较方式切换为“连续强度 TWFE（描述性）”，再勾选“冲击 × 基期GVC”比较条件关联；该交互不是 cohort-aware ATT 异质性估计。",
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
    learnThis: "本步的单位不是百分点。先核对是否允许推断，再并读方向与区间；不能和份额的系数相减或比大小。",
    definition: "它以 GVC 活动诱发的累计总产出除以关联增加值；VA 为正时可理解为增加值加权阶段数，存在负 VA 时是有符号账户比值。它不是跨境次数、国家数或网络边数。默认使用 cohort-time ATT；按年动态路径是选做。",
    downMeaning: "负向变化与链条缩短一致，可能来自回流、近岸化或其他生产调整。",
    upMeaning: "正向变化与链条延长一致，但不能单靠一个系数判断企业策略。",
    caution: "长度单位不能和份额百分点相减。冲击前检验不显著不能证明趋势可比；投入链外溢、COVID-19 异质冲击仍可能破坏识别。",
    howToRead: "先核对是否允许推断，再判断变短、变长还是看不出。链条变短有多种机制，一个数字指不出是回流还是近岸。",
    writeDown: "单独记长度的方向。写报告时明确这是长度单位，不是百分点。",
    dontClaim: "不要写成「比贸易流效应更大 / 更小」。",
    guidedExperiment: "选做：改到按冲击前后各年观察，分别记下一项冲击前诊断和一项冲击后动态。",
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
    learnThis: "介数把微小正边与大额边视为等长，且当前没有边阈值敏感性检验。它描述一套拓扑位置，不是出口规模、经济瓶颈，也不是与前三类主指标等价的政策终点。",
    definition: "它在全球国家×行业图中保留每条正流量边，再加总各有序节点对最短路径经过该节点的份额 σ_st(v)/σ_st；等长路径会分摊，结果未按节点对数归一化。",
    downMeaning: "负向变化与拓扑中介位置下降一致，但不能单独证明发生了脱钩。",
    upMeaning: "正向变化与拓扑中介位置增强一致，但可能同时受到网络重组影响。",
    caution: "冲击会沿全球投入链外溢到未直接处理节点，网络中心性还会机械联动，因此对照未必干净。全正边口径对微小流量边敏感；实体置换尾部占比不是 p 值。",
    howToRead: "先看结果状态，允许推断时才判断这套拓扑编码中的方向。无论结果如何，都要披露未做边阈值敏感性；不能据此证明经济枢纽、瓶颈或脱钩。",
    writeDown: "把前三类主结果与本步探索性网络结果分栏记录；四个结果构成预先指定的结果族，不只挑显著项。",
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
  return `受到${shock}后，${lesson.shortMetric}相对从未或尚未受冲击的对象如何变化？`;
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

export function nextRegressionFamily(outcome: RegressionOutcome) {
  const index = REGRESSION_FAMILIES.findIndex((item) => item.outcome === outcome);
  return index >= 0 ? REGRESSION_FAMILIES[index + 1] ?? null : null;
}

/** 给学生可抄进第 15 步的一句话；不把点估计说成因果证明。 */
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
