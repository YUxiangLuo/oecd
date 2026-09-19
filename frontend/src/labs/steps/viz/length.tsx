import type { Meta, Step, StepStateApi } from "../../../types";
import { IndicatorExplorer } from "./indicator-explorer";
import type { IndicatorTopic } from "./indicator-model";
import type { VizStepState } from "./scaffold";

export const LENGTH_TOPIC: IndicatorTopic = {
  key: "length",
  defaultMetric: "PLv_GVC",
  defaultView: "directions",
  question: "生产链长度与相对位置怎样变化？",
  note: "长度是累计总产出／关联增加值，VA为正时表示增加值加权平均生产阶段数；不是跨境次数、经过国家数或网络边数。存在负VA时是有符号账户比值，不裁剪异常值。国家结果按分子分母汇总计算，不能平均行业长度。",
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
    ].map(([key, label]) => ({ key, label, unit: "生产阶段（账户比值）" })),
    { key: "GVCPs", label: "GVC位置指数（前向GVC／后向GVC）", unit: "无量纲" },
    {
      key: "Pos_TPL",
      label: "总长度位置指数（前向总长／后向总长）",
      unit: "无量纲",
    },
  ],
  axes: {
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
