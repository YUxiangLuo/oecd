import type { Meta, Step, StepStateApi } from "../../../types";
import { CAT } from "../../../viz/shared";
import { IndicatorExplorer } from "./indicator-explorer";
import type { IndicatorTopic } from "./indicator-model";
import type { VizStepState } from "./scaffold";

export const TRADE_TOPIC: IndicatorTopic = {
  key: "trade",
  defaultMetric: "FVA_share",
  defaultView: "composition",
  question: "出口的价值来源怎样随时间变化？在全部经济体中处于什么位置？",
  themeLabel: "出口构成",
  themeHint: "出口额由六项构成：先看哪一项占比最大、产品税减补贴是否为负，再看对比国家的构成是否不同；切换到“历年变化”查看占比的变化。",
  metrics: [
    {
      key: "FVA_share",
      label: "外国增加值项占比",
      unit: "%",
      numerator: "FVA",
      denominator: "gross_exports",
    },
    {
      key: "DVAex_share",
      label: "国内增加值出口占比",
      unit: "%",
      numerator: "DVAex",
      denominator: "gross_exports",
    },
    { key: "gross_exports", label: "总出口（含产品税减补贴）", unit: "百万美元" },
    { key: "DVAex", label: "国内增加值出口", unit: "百万美元" },
    { key: "DVArt", label: "返回国内的增加值", unit: "百万美元" },
    { key: "DDC", label: "国内重复计算", unit: "百万美元" },
    { key: "FVA", label: "外国增加值", unit: "百万美元" },
    { key: "FDC", label: "外国重复计算", unit: "百万美元" },
    { key: "taxsub", label: "产品税减补贴", unit: "百万美元" },
    { key: "EXDVA", label: "出口国内增加值合计", unit: "百万美元" },
    // The second positioning axis (step 7's measure): a share, not an amount.
    {
      key: "3_VA_GVC_share",
      label: "前向 GVC 生产总份额",
      unit: "%",
      numerator: "3_VA_GVC",
      denominator: "SVA",
      axisOnly: true,
    },
  ],
  composition: {
    total: "gross_exports",
    segments: [
      { key: "DVAex", name: "国内增加值出口", color: CAT[0] },
      { key: "DVArt", name: "返回国内的增加值", color: CAT[1] },
      { key: "DDC", name: "国内重复计算", color: CAT[2] },
      { key: "FVA", name: "外国增加值", color: CAT[3] },
      { key: "FDC", name: "外国重复计算", color: CAT[4] },
      // Grey as in step 2; red is reserved for negative parts (left of zero).
      { key: "taxsub", name: "产品税减补贴", color: "#98a0b3" },
    ],
    focus: "FVA",
    focusLabel: "外国增加值项占比",
    note: "每条是一国总出口的六项构成，加起来等于总出口。产品税减补贴为负时画成红色，放在 0 的左边；此时各项份额之和不能按常规 100% 堆积条解读。",
    evolutionNote: "每个色带是总出口的一项，六项加起来等于总出口。产品税减补贴为负时画成红色，放在 0 的下方；此时各项份额之和不能按常规 100% 解读。",
  },
  axes: {
    key: "source",
    label: "出口规模与外国增加值项占比",
    x: "gross_exports",
    y: "FVA_share",
    xScale: "log",
    labels: ["出口大 · 外国增加值项占比高", "出口小 · 外国增加值项占比高", "出口小 · 外国增加值项占比低", "出口大 · 外国增加值项占比低"],
  },
  axesOptions: [
    {
      key: "source",
      label: "出口规模与外国增加值项占比",
      x: "gross_exports",
      y: "FVA_share",
      xScale: "log",
      labels: ["出口大 · 外国增加值项占比高", "出口小 · 外国增加值项占比高", "出口小 · 外国增加值项占比低", "出口大 · 外国增加值项占比低"],
    },
    {
      key: "gvc",
      label: "外国增加值项占比与前向 GVC 生产总份额",
      x: "FVA_share",
      y: "3_VA_GVC_share",
      labels: ["两项份额均较高", "前向 GVC 份额较高", "两项份额均较低", "外国增加值项占比较高"],
    },
  ],
};

export function TradeVizStep(props: {
  meta: Meta;
  step: Step;
  state: StepStateApi<VizStepState>;
}) {
  return <IndicatorExplorer {...props} topic={TRADE_TOPIC} />;
}
