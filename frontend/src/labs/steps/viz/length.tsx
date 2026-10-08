import type { Meta, Step, StepStateApi } from "../../../types";
import { IndicatorExplorer } from "./indicator-explorer";
import type { IndicatorTopic } from "./indicator-model";
import type { VizStepState } from "./scaffold";

/* Each length is null exactly where its segment's weight is 0 (checked on the 2016–2020 processed data): the
 * forward side weighs by value added, the backward side by the final goods' content. A position index is the
 * ratio of two lengths, so either one missing its activity leaves it undefined. */
const NO_ACTIVITY = {
  PLv_GVC: { column: "3_VA_GVC", reason: "没有 GVC 生产（GVC 增加值为 0）" },
  PLy_GVC: { column: "3_FGY_GVC", reason: "没有后向 GVC 生产（最终品中的 GVC 增加值为 0）" },
  PLv: { column: "SVA", reason: "没有增加值（总增加值为 0）" },
  PLy: { column: "FGY", reason: "没有最终品生产（最终品生产为 0）" },
  PLv_D: { column: "1_VA_D", reason: "没有纯国内生产（纯国内增加值为 0）" },
  PLv_RT: { column: "2_VA_RT", reason: "没有传统贸易生产（传统贸易增加值为 0）" },
  PLy_D: { column: "1_FGY_D", reason: "没有后向纯国内生产（最终品中的纯国内增加值为 0）" },
  PLy_RT: { column: "2_FGY_RT", reason: "没有后向传统贸易生产（最终品中的传统贸易增加值为 0）" },
};

export const LENGTH_TOPIC: IndicatorTopic = {
  key: "length",
  defaultMetric: "PLv_GVC",
  defaultView: "directions",
  question: "生产链长度与相对位置怎样变化？在全部经济体中处于什么位置？",
  themeLabel: "前后向位置",
  themeHint: "先看轨迹图：等长线（前向 = 后向）上方前向段更长（更偏上游）；下面两张图分别是前向、后向的走势。想看位置指数，切到“历年变化”，在“指标”里选“GVC 位置指数”。",
  metrics: [
    ...[
      ["PLv_GVC", "前向 GVC 段长度"],
      ["PLy_GVC", "后向 GVC 段长度"],
      ["PLv", "前向总生产长度"],
      ["PLy", "后向总生产长度"],
      ["PLv_D", "前向纯国内段长度"],
      ["PLv_RT", "前向传统贸易段长度"],
      ["PLy_D", "后向纯国内段长度"],
      ["PLy_RT", "后向传统贸易段长度"],
    ].map(([key, label]) => ({ key, label, unit: "长度单位", zeroOf: [NO_ACTIVITY[key as keyof typeof NO_ACTIVITY]] })),
    { key: "GVCPs", label: "GVC 位置指数（前向 GVC 段／后向 GVC 段）", unit: "无量纲", zeroOf: [NO_ACTIVITY.PLv_GVC, NO_ACTIVITY.PLy_GVC] },
    {
      key: "Pos_TPL",
      label: "总长度位置指数（前向总长／后向总长）",
      unit: "无量纲",
      zeroOf: [NO_ACTIVITY.PLv, NO_ACTIVITY.PLy],
    },
  ],
  axes: {
    key: "position",
    label: "后向（横）与前向（纵）GVC 段长度",
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
