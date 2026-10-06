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
  themeHint: "出口额由六项构成：先看哪一项占大头、税收减补贴是否为负，再看对比国家的构成是否不同；切到“历年变化”看占比怎样变。",
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
      label: "国内增加值出口份额",
      unit: "%",
      numerator: "DVAex",
      denominator: "gross_exports",
    },
    { key: "gross_exports", label: "总出口（VA+TLS）", unit: "百万美元" },
    { key: "DVAex", label: "国内增加值出口", unit: "百万美元" },
    { key: "DVArt", label: "返回国内的增加值", unit: "百万美元" },
    { key: "DDC", label: "国内重复计算", unit: "百万美元" },
    { key: "FVA", label: "外国增加值", unit: "百万美元" },
    { key: "FDC", label: "外国重复计算", unit: "百万美元" },
    { key: "taxsub", label: "税收减补贴（TLS扩展）", unit: "百万美元" },
    { key: "EXDVA", label: "出口国内增加值合计", unit: "百万美元" },
  ],
  composition: {
    total: "gross_exports",
    segments: [
      { key: "DVAex", name: "国内增加值出口", color: CAT[0] },
      { key: "DVArt", name: "返回国内", color: CAT[1] },
      { key: "DDC", name: "国内重复计算", color: CAT[2] },
      { key: "FVA", name: "外国增加值", color: CAT[3] },
      { key: "FDC", name: "外国重复计算", color: CAT[4] },
      // Grey as in step 2; red is reserved for negative parts (left of zero).
      { key: "taxsub", name: "税收减补贴", color: "#98a0b3" },
    ],
    focus: "FVA",
    note: "每条为六项之和的构成，分母为 VA+TLS 账户闭合总出口。负分项以红色放在零轴左侧，不改变其国内、外国或TLS来源归类；负值不能按普通100%条形图解释。",
  },
  axes: {
    key: "source",
    label: "来源定位：总出口 × 外国增加值项占比",
    x: "gross_exports",
    y: "FVA_share",
    xScale: "log",
    labels: ["出口大 · 外国含量高", "出口小 · 外国含量高", "出口小 · 外国含量低", "出口大 · 外国含量低"],
  },
  axesOptions: [
    {
      key: "source",
      label: "来源定位：总出口 × 外国增加值项占比",
      x: "gross_exports",
      y: "FVA_share",
      xScale: "log",
      labels: ["出口大 · 外国含量高", "出口小 · 外国含量高", "出口小 · 外国含量低", "出口大 · 外国含量低"],
    },
    {
      key: "gvc",
      label: "跨境生产：外国增加值项占比 × GVC 生产份额",
      x: "FVA_share",
      y: "3_VA_GVC_share",
      labels: ["两项份额均较高", "跨境生产较高", "两项份额均较低", "外国增加值项较高"],
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
