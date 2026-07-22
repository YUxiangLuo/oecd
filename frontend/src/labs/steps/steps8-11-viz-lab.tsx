/**
 * 步骤 7–10 路由。
 *
 * 历史上这里是一个共用的 VizLab,靠配置换默认指标驱动全部四页,导致四页高度雷同、
 * 教学稀薄、图表用途不明。现已按步拆成四个独立定制组件(viz/step8..step11),
 * 各自决定布局、主图与「看什么 / 怎么读 / 该发现」读图讲解;这里按主题(topic)分发。
 * 共享的仅是底层图表原语(viz/explore/charts)与读图脚手架(viz/scaffold)。
 */
import type { Meta, Step, StepStateApi } from "../../types";
import type { VizStepState } from "./viz/scaffold";
import { Step8Trade } from "./viz/step8";
import { Step9Production } from "./viz/step9";
import { Step10Length } from "./viz/step10";
import { Step11Network } from "./viz/step11";

export function VizLab({ meta, step, state }: {
  meta: Meta;
  step: Step;
  state: StepStateApi<VizStepState>;
}) {
  // 按主题路由,不依赖步号(步号可能因课程重排而变)。
  if (step.topic === "production") return <Step9Production meta={meta} step={step} state={state} />;
  if (step.topic === "length") return <Step10Length meta={meta} step={step} state={state} />;
  if (step.topic === "network") return <Step11Network meta={meta} step={step} state={state} />;
  return <Step8Trade meta={meta} step={step} state={state} />;
}
