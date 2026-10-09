import type { Meta, Step, StepStateApi } from "../../../types";
import { CAT } from "../../../viz/shared";
import { IndicatorExplorer } from "./indicator-explorer";
import type { IndicatorTopic } from "./indicator-model";
import type { VizStepState } from "./scaffold";
import { cjkJoin } from "../../../format";

export const PRODUCTION_TOPIC: IndicatorTopic = {
  key: "production",
  defaultMetric: "3b_VA_GVC_C_share",
  defaultView: "composition",
  question: "生产活动参与跨境分工的程度怎样变化？在全部经济体中处于什么位置？",
  themeLabel: "四类生产活动",
  themeHint: "四类份额加起来是 100%（有负值时除外）：先看复杂 GVC 的占比，以及与对比国家差异最大的类别，再切换到“历年变化”和“国家对比”看变化与全球位置。",
  metrics: [
    {
      key: "3b_VA_GVC_C_share",
      label: "复杂 GVC 生产份额",
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
      ["3a_VA_GVC_S", "简单 GVC"],
    ].map(([key, name]) => ({
      key: `${key}_share`,
      label: cjkJoin(name, "生产份额"),
      unit: "%",
      numerator: key,
      denominator: "SVA",
    })),
    ...[
      ["SVA", "总增加值"],
      ["1_VA_D", "纯国内增加值"],
      ["2_VA_RT", "传统贸易增加值"],
      ["3_VA_GVC", "GVC 增加值"],
      ["3a_VA_GVC_S", "简单 GVC 增加值"],
      ["3b_VA_GVC_C", "复杂 GVC 增加值"],
      ["FGY", "最终品生产（后向总量）"],
      ["1_FGY_D", "纯国内（后向）"],
      ["2_FGY_RT", "传统贸易（后向）"],
      ["3_FGY_GVC", "全部 GVC（后向）"],
      ["3a_FGY_GVC_S", "简单 GVC（后向）"],
      ["3b_FGY_GVC_C", "复杂 GVC（后向）"],
    ].map(([key, label]) => ({ key, label, unit: "百万美元" })),
  ],
  composition: {
    total: "SVA",
    segments: [
      { key: "1_VA_D", name: "纯国内", color: CAT[0] },
      { key: "2_VA_RT", name: "传统贸易", color: CAT[1] },
      { key: "3a_VA_GVC_S", name: "简单 GVC", color: CAT[2] },
      { key: "3b_VA_GVC_C", name: "复杂 GVC", color: CAT[4] },
    ],
    focus: "3b_VA_GVC_C",
    focusLabel: "复杂 GVC 生产份额",
    note: "四类生产活动各占本国总增加值的份额：纯国内不跨境，传统贸易随最终品跨境一次，简单 GVC 随中间品跨境一次，复杂 GVC 至少跨境两次。负分项画成红色，放在 0 的左边。",
    // The same four activities read from the final-goods side (step 7 四类生产活动 · 后向).
    alternate: {
      key: "backward",
      label: "后向（按最终品）",
      primaryLabel: "前向（按增加值来源）",
      total: "FGY",
      segments: [
        { key: "1_FGY_D", name: "纯国内", color: CAT[0] },
        { key: "2_FGY_RT", name: "传统贸易", color: CAT[1] },
        { key: "3a_FGY_GVC_S", name: "简单 GVC", color: CAT[2] },
        { key: "3b_FGY_GVC_C", name: "复杂 GVC", color: CAT[4] },
      ],
      focus: "3b_FGY_GVC_C",
      focusLabel: "后向复杂 GVC 生产份额",
      note: "从本国生产的最终品向上游回溯，判断其中的增加值属于哪一类。分母是最终品总值，与前向不同，因此前向、后向份额不能直接比较。",
    },
  },
  axes: {
    key: "mode",
    label: "简单 GVC 与复杂 GVC 生产份额",
    x: "3a_VA_GVC_S_share",
    y: "3b_VA_GVC_C_share",
    labels: ["简单与复杂均较高", "复杂份额较高", "两项均较低", "简单份额较高"],
  },
  axesOptions: [
    {
      key: "mode",
      label: "简单 GVC 与复杂 GVC 生产份额",
      x: "3a_VA_GVC_S_share",
      y: "3b_VA_GVC_C_share",
      labels: ["简单与复杂均较高", "复杂份额较高", "两项均较低", "简单份额较高"],
    },
    {
      key: "side",
      label: "前向与后向 GVC 生产总份额",
      x: "3_VA_GVC_share",
      y: "3_FGY_GVC_share",
      labels: ["两向均较高", "后向较高", "两向均较低", "前向较高"],
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
