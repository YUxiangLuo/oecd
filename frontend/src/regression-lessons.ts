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

export const REGRESSION_QUESTION =
  "关税与非关税壁垒出现后，这一组指标相对未受冲击的对象发生了怎样的变化？";

export const REGRESSION_LESSONS: Record<RegressionOutcome, RegressionLesson> = {
  trade: {
    outcome: "trade",
    metric: "出口中外国增加值份额（FVA / 含 TLS 毛出口）",
    shortMetric: "FVA 份额",
    unit: "百分点",
    priorStep: 3,
    priorLabel: "GVC 总贸易流分解指标",
    focus: "本步看贸易壁垒有没有改变出口对外国投入的依赖",
    definition: "它表示一单位出口中有多少价值由外国投入创造。步骤 12–15 问的是同一句话，本步看的是贸易流这一类指标。",
    downMeaning: "负向变化与外国增加值依赖下降一致，但不能单独证明生产已经回流。",
    upMeaning: "正向变化与外国增加值依赖上升一致，但仍需结合不确定性和识别假设。",
    caution: "份额按百分点读：从 1% 到 2% 是上升 1 个百分点，不是上升 1%。不要和长度、网络系数比大小。",
    guidedExperiment: "若要检查结论对遗漏变量是否敏感，在「换一种读法」里加入控制变量后再跑一次。",
  },
  production: {
    outcome: "production",
    metric: "复杂 GVC 生产份额（增加值至少多次跨境）",
    shortMetric: "复杂 GVC 份额",
    unit: "百分点",
    priorStep: 4,
    priorLabel: "GVC 生产分解指标",
    focus: "本步看贸易壁垒有没有改变跨境分工的复杂程度",
    definition: "它衡量增加值经过多次跨境生产后被最终吸收的比例。默认比较方式和上一步相同，本步看的是生产分解这一类指标。",
    downMeaning: "负向变化与复杂跨境分工收缩一致，但不能据此确定收缩机制。",
    upMeaning: "正向变化与复杂跨境生产扩张一致，但不能据此排除其他共同变化。",
    caution: "区间跨过 0 是「看不出方向」，不是零效应。若要看参与度不同的个体是否反应不同，再到选做里打开交互。",
    guidedExperiment: "选做：打开“冲击 × 处理前 GVC”，比较平均变化和条件边际效应。",
  },
  length: {
    outcome: "length",
    metric: "前向 GVC 生产长度（PLv_GVC）",
    shortMetric: "跨境生产长度",
    unit: "生产环节长度单位",
    priorStep: 5,
    priorLabel: "GVC 长度分解指标",
    focus: "本步看贸易壁垒有没有改变跨境生产链条的长短",
    definition: "它描述增加值到最终吸收经历的跨境环节。默认仍是处理组相对对照组；按年看路径是选做，不是本步必须换的方法。",
    downMeaning: "负向变化与链条缩短一致，可能来自回流、近岸化或其他生产调整。",
    upMeaning: "正向变化与链条延长一致，但不能单靠一个系数判断企业策略。",
    caution: "长度单位不能和份额的百分点相减。选做里的冲击前检验即使不显著，也不能证明趋势可比。",
    guidedExperiment: "选做：改到按冲击前后各年观察，分别记下一项冲击前诊断和一项冲击后动态。",
  },
  network: {
    outcome: "network",
    metric: "生产网络介数中心性",
    shortMetric: "介数中心性",
    unit: "中心性原始单位，并补充标准差单位",
    priorStep: 6,
    priorLabel: "全球生产网络指标",
    focus: "本步看贸易壁垒有没有改变节点在生产网络里的拓扑位置",
    definition: "它衡量全球国家×行业图中节点出现在多少条有向无权最短路径上。高介数不是规模，也不自动等于经济瓶颈。",
    downMeaning: "负向变化与拓扑中介位置下降一致，但不能单独证明发生了脱钩。",
    upMeaning: "正向变化与拓扑中介位置增强一致，但可能同时受到网络重组影响。",
    caution: "贸易网络上的冲击可能外溢到未直接处理的节点。选做里的实体置换尾部占比不是 p 值。",
    guidedExperiment: "跑完基准后，到「若要进一步检查稳健性」里运行实体置换，看原始估计在这套人为改派规则下是否靠尾部。",
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
    return `${shock}变强时，${lesson.shortMetric}如何随之变化？`;
  }
  return `受到${shock}后，处理组的${lesson.shortMetric}相对对照组发生了怎样的变化？`;
}

export function comparisonExplanation(method: string): string {
  if (method === "did") {
    return "先用四格建立直觉：相对变化 =（处理后−处理前）−（对照后−对照前）。不同对象首次受冲击的年份可以不同，所以实际比较不止一个四格。";
  }
  if (method === "event_study") {
    return "按每个对象首次冲击前一年为参照，看冲击前后各年的相对变化。冲击前看不出差别，不能当成已经证明趋势可比。";
  }
  return "不再把对象分成处理/对照两格，而是看冲击强度变大时，指标如何随之变化。";
}
