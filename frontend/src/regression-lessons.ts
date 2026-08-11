import type { RegressionOutcome } from "./types";

interface RegressionLesson {
  outcome: RegressionOutcome;
  metric: string;
  shortMetric: string;
  unit: string;
  priorStep: number;
  priorLabel: string;
  focus: string;
  definition: string;
  downMeaning: string;
  upMeaning: string;
  caution: string;
  guidedExperiment: string;
}

export const REGRESSION_LESSONS: Record<RegressionOutcome, RegressionLesson> = {
  trade: {
    outcome: "trade",
    metric: "出口中外国增加值份额（FVA / 毛出口）",
    shortMetric: "FVA 份额",
    unit: "百分点",
    priorStep: 3,
    priorLabel: "GVC 总贸易流分解指标",
    focus: "用 DID 四格比较理解“处理组相对对照组的处理后变化”",
    definition: "它表示一单位出口中有多少价值由外国投入创造，反映出口对跨境中间投入的依赖程度。",
    downMeaning: "负向变化与外国增加值依赖下降一致，但不能单独证明生产已经回流。",
    upMeaning: "正向变化与外国增加值依赖上升一致，但仍需结合不确定性和识别假设。",
    caution: "份额结果按百分点解释；1% 到 2% 是上升 1 个百分点，而不是上升 1%。",
    guidedExperiment: "保持其他设定不变，加入控制变量，观察结论是否稳定。",
  },
  production: {
    outcome: "production",
    metric: "复杂 GVC 生产份额（增加值至少多次跨境）",
    shortMetric: "复杂 GVC 份额",
    unit: "百分点",
    priorStep: 4,
    priorLabel: "GVC 生产分解指标",
    focus: "区分平均变化与“冲击 × 处理前 GVC”异质性",
    definition: "它衡量增加值经过多次跨境生产后被最终吸收的比例，反映全球分工的复杂程度。",
    downMeaning: "负向变化与复杂跨境分工收缩一致，但不能据此确定收缩机制。",
    upMeaning: "正向变化与复杂跨境生产扩张一致，但不能据此排除其他共同变化。",
    caution: "交互项回答的是不同处理前 GVC 参与度个体是否反应不同，不是新的平均效应；处理个体的基期只使用首次处理前观测。",
    guidedExperiment: "先运行无交互基准，再打开“冲击 × 处理前 GVC”运行第二次，比较平均变化和异质性附加变化。",
  },
  length: {
    outcome: "length",
    metric: "前向 GVC 生产长度（PLv_GVC）",
    shortMetric: "跨境生产长度",
    unit: "生产环节长度单位",
    priorStep: 5,
    priorLabel: "GVC 长度分解指标",
    focus: "用事件研究观察动态路径，并谨慎检查冲击前差异",
    definition: "它描述增加值到最终吸收之间经历的跨境生产环节长度，数值越大通常表示链条越长。",
    downMeaning: "负向变化与链条缩短一致，可能来自回流、近岸化或其他生产调整。",
    upMeaning: "正向变化与链条延长一致，但不能单靠一个系数判断企业策略。",
    caution: "冲击前系数未显著只能说明未发现明显前趋势，不能据此确认趋势可比假设。",
    guidedExperiment: "保持事件研究设定，分别记录一项冲击前诊断和一项冲击后动态系数。",
  },
  network: {
    outcome: "network",
    metric: "生产网络介数中心性",
    shortMetric: "介数中心性",
    unit: "中心性原始单位，并补充标准差单位",
    priorStep: 6,
    priorLabel: "全球生产网络指标",
    focus: "用安慰剂和多项证据判断网络位置变化是否稳健",
    definition: "它衡量全球国家×行业图中的节点位于多少条有向无权最短路径上，反映拓扑中介位置；路径计算不按流量赋权。",
    downMeaning: "负向变化与拓扑中介位置下降一致，但不能单独证明发生了脱钩。",
    upMeaning: "正向变化与拓扑中介位置增强一致，但可能同时受到网络重组影响。",
    caution: "网络指标来自完整的全球国家×行业图且原始量纲不直观，应同时参考相对于样本标准差的变化；高介数不自动代表经济瓶颈，国家级完全图不用于回归。",
    guidedExperiment: "在 DID 基准结果后运行安慰剂检验，判断原始分组估计值是否位于随机分布尾部。",
  },
};

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
    return `${shock}强度增加时，${lesson.shortMetric}如何随之变化？`;
  }
  return `受到${shock}后，处理组的${lesson.shortMetric}相对对照组发生了怎样的变化？`;
}

export function comparisonExplanation(method: string): string {
  if (method === "did") {
    return "四格差分可帮助理解 DID：DID =（处理后−处理前）−（对照后−对照前）。本系统实际估计含个体与年份固定效应的分期处理 TWFE；不同个体首次处理年不同，比较不止一个四格，处理效应异质时传统 TWFE 可能有偏。";
  }
  if (method === "event_study") {
    return "以各个体首次冲击前一年为参照，在分期处理 TWFE 中估计相对时期系数；比较可能隐含尚未处理或已处理个体，处理效应异质时需谨慎。冲击前系数只能用于发现明显预先差异，不能证明平行趋势。";
  }
  return "利用同一个体随时间变化的连续冲击强度，在吸收个体和年份共同差异后比较结果变量的相对变化。";
}
