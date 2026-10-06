import type { Meta, Step, StepStateApi } from "../../../types";
import { IndicatorExplorer } from "./indicator-explorer";
import type { IndicatorTopic } from "./indicator-model";
import type { VizStepState } from "./scaffold";

export const LENGTH_TOPIC: IndicatorTopic = {
  key: "length",
  defaultMetric: "PLv_GVC",
  defaultView: "directions",
  question: "生产链长度与相对位置怎样变化？在全部经济体中处于什么位置？",
  themeLabel: "前后向位置",
  themeHint: "前向与后向 GVC 段长度分别看走势，再看轨迹图：等长线上方前向段更长（更偏上游）；切到“历年变化”看位置指数。",
  metrics: [
    ...[
      ["PLv_GVC", "前向GVC段长度"],
      ["PLy_GVC", "后向GVC段长度"],
      ["PLv", "前向总生产长度"],
      ["PLy", "后向总生产长度"],
      ["PLv_D", "前向纯国内段长度"],
      ["PLv_RT", "前向传统贸易段长度"],
      ["PLy_D", "后向纯国内段长度"],
      ["PLy_RT", "后向传统贸易段长度"],
    ].map(([key, label]) => ({ key, label, unit: "长度单位" })),
    { key: "GVCPs", label: "GVC位置指数（前向GVC／后向GVC）", unit: "无量纲" },
    {
      key: "Pos_TPL",
      label: "总长度位置指数（前向总长／后向总长）",
      unit: "无量纲",
    },
  ],
  axes: {
    key: "position",
    label: "前后向位置：后向 GVC 段长度 × 前向 GVC 段长度",
    x: "PLy_GVC",
    y: "PLv_GVC",
    equality: true,
    labels: [
      "前后向均较高",
      "前向较高·后向较低",
      "前后向均较低",
      "前向较低·后向较高",
    ],
  },
};

export function LengthVizStep(props: {
  meta: Meta;
  step: Step;
  state: StepStateApi<VizStepState>;
}) {
  return <IndicatorExplorer {...props} topic={LENGTH_TOPIC} />;
}
