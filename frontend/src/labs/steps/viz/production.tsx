import type { Meta, Step, StepStateApi } from "../../../types";
import { CAT } from "../../../viz/shared";
import { IndicatorExplorer } from "./indicator-explorer";
import type { IndicatorTopic } from "./indicator-model";
import type { VizStepState } from "./scaffold";

export const PRODUCTION_TOPIC: IndicatorTopic = {
  key: "production",
  defaultMetric: "3b_VA_GVC_C_share",
  defaultView: "composition",
  question: "生产活动参与跨境分工的程度怎样变化？在全部经济体中处于什么位置？",
  themeLabel: "四类生产活动",
  themeHint: "四类前向生产活动的份额加总为 100%：先看复杂 GVC 占多少、与对比国家差在哪一类，再切到“历年变化”和“国家对比”看变化与全球位置。",
  metrics: [
    {
      key: "3b_VA_GVC_C_share",
      label: "复杂 GVC 生产份额（前向）",
      unit: "%",
      numerator: "3b_VA_GVC_C",
      denominator: "SVA",
    },
    {
      key: "3_VA_GVC_share",
      label: "前向 GVC 生产总份额",
      unit: "%",
      numerator: "3_VA_GVC",
      denominator: "SVA",
    },
    {
      key: "3_FGY_GVC_share",
      label: "后向 GVC 生产总份额",
      unit: "%",
      numerator: "3_FGY_GVC",
      denominator: "FGY",
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
    focus: "3b_VA_GVC_C",
    note: "四类前向生产活动占总增加值SVA的份额：纯国内不跨境，传统贸易随最终品跨境，简单GVC经历一次中间品跨境，复杂GVC累计至少两次跨境。负分项以红色显示在零轴左侧。",
    // The same four activities read from the final-goods side (step 7 四类生产活动 · 后向).
    alternate: {
      key: "backward",
      label: "后向（FGY）",
      primaryLabel: "前向（SVA）",
      total: "FGY",
      segments: [
        { key: "1_FGY_D", name: "纯国内", color: CAT[0] },
        { key: "2_FGY_RT", name: "传统贸易", color: CAT[1] },
        { key: "3a_FGY_GVC_S", name: "简单GVC", color: CAT[2] },
        { key: "3b_FGY_GVC_C", name: "复杂GVC", color: CAT[3] },
      ],
      focus: "3b_FGY_GVC_C",
      note: "四类后向生产活动占最终品生产FGY的份额：从最终品回溯其增加值经历的跨境次数。前向与后向的分母不同，两侧份额不能相互比较。",
    },
  },
  axes: {
    key: "mode",
    label: "参与方式：简单 GVC 份额 × 复杂 GVC 份额",
    x: "3a_VA_GVC_S_share",
    y: "3b_VA_GVC_C_share",
    labels: ["简单与复杂均较高", "复杂份额较高", "两项均较低", "简单份额较高"],
  },
  axesOptions: [
    {
      key: "mode",
      label: "参与方式：简单 GVC 份额 × 复杂 GVC 份额",
      x: "3a_VA_GVC_S_share",
      y: "3b_VA_GVC_C_share",
      labels: ["简单与复杂均较高", "复杂份额较高", "两项均较低", "简单份额较高"],
    },
    {
      key: "side",
      label: "供给侧与需求侧：前向 GVC 份额 × 后向 GVC 份额",
      x: "3_VA_GVC_share",
      y: "3_FGY_GVC_share",
      labels: ["两侧参与均较高", "需求侧参与较高", "两侧均较低", "供给侧参与较高"],
    },
  ],
};

export function ProductionVizStep(props: {
  meta: Meta;
  step: Step;
  state: StepStateApi<VizStepState>;
}) {
  return <IndicatorExplorer {...props} topic={PRODUCTION_TOPIC} />;
}
