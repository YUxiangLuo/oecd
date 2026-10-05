import type { Meta, Step, StepStateApi } from "../../../types";
import { CAT } from "../../../viz/shared";
import { IndicatorExplorer } from "./indicator-explorer";
import type { IndicatorTopic } from "./indicator-model";
import type { VizStepState } from "./scaffold";

export const PRODUCTION_TOPIC: IndicatorTopic = {
  key: "production",
  defaultMetric: "3b_VA_GVC_C_share",
  question: "生产活动参与跨境分工的程度怎样变化？在全部经济体中处于什么位置？",
  metrics: [
    {
      key: "3b_VA_GVC_C_share",
      label: "复杂GVC生产份额（前向）",
      unit: "%",
      numerator: "3b_VA_GVC_C",
      denominator: "SVA",
    },
    {
      key: "3_VA_GVC_share",
      label: "全部GVC生产份额（前向）",
      unit: "%",
      numerator: "3_VA_GVC",
      denominator: "SVA",
    },
    ...[
      ["1_VA_D", "纯国内"],
      ["2_VA_RT", "传统贸易"],
      ["3a_VA_GVC_S", "简单GVC"],
    ].map(([key, name]) => ({
      key: `${key}_share`,
      label: `${name}份额（前向）`,
      unit: "%",
      numerator: key,
      denominator: "SVA",
    })),
    ...[
      ["SVA", "总增加值"],
      ["1_VA_D", "纯国内增加值"],
      ["2_VA_RT", "传统贸易增加值"],
      ["3_VA_GVC", "GVC增加值"],
      ["3a_VA_GVC_S", "简单GVC增加值"],
      ["3b_VA_GVC_C", "复杂GVC增加值"],
      ["FGY", "最终品生产（后向总量）"],
      ["1_FGY_D", "纯国内（后向）"],
      ["2_FGY_RT", "传统贸易（后向）"],
      ["3_FGY_GVC", "全部GVC（后向）"],
      ["3a_FGY_GVC_S", "简单GVC（后向）"],
      ["3b_FGY_GVC_C", "复杂GVC（后向）"],
    ].map(([key, label]) => ({ key, label, unit: "百万美元" })),
  ],
  composition: {
    total: "SVA",
    segments: [
      { key: "1_VA_D", name: "纯国内", color: CAT[0] },
      { key: "2_VA_RT", name: "传统贸易", color: CAT[1] },
      { key: "3a_VA_GVC_S", name: "简单GVC", color: CAT[2] },
      { key: "3b_VA_GVC_C", name: "复杂GVC", color: CAT[3] },
    ],
    note: "四类前向生产活动占总增加值SVA的份额：纯国内不跨境，传统贸易随最终品跨境，简单GVC经历一次中间品跨境，复杂GVC累计至少两次跨境。负分项以红色显示在零轴左侧。",
  },
  axes: {
    x: "3_VA_GVC_share",
    y: "3b_VA_GVC_C_share",
    labels: [
      "参与及复杂份额均较高",
      "复杂份额较高",
      "两项均较低",
      "参与份额较高",
    ],
  },
};

export function ProductionVizStep(props: {
  meta: Meta;
  step: Step;
  state: StepStateApi<VizStepState>;
}) {
  return <IndicatorExplorer {...props} topic={PRODUCTION_TOPIC} />;
}
