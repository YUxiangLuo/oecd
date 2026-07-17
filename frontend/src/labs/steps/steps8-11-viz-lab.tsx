/**
 * 步骤 8–11 路由。
 *
 * 历史上这里是一个共用的 VizLab,靠配置换默认指标驱动全部四页,导致四页高度雷同、
 * 教学稀薄、图表用途不明。现已按步拆成四个独立定制组件(viz/step8..step11),
 * 各自决定布局、主图与「看什么 / 怎么读 / 该发现」读图讲解;这里只按步号分发。
 * 共享的仅是底层图表原语(viz/explore/charts)与读图脚手架(viz/scaffold)。
 */
import type { Meta, Step, StepEvidenceApi } from "../../types";
import type { VizEvidence } from "./viz/scaffold";
import { Step8Trade } from "./viz/step8";
import { Step9Production } from "./viz/step9";
import { Step10Length } from "./viz/step10";
import { Step11Network } from "./viz/step11";

export function VizLab({ meta, step, evidence }: {
  meta: Meta;
  step: Step;
  evidence: StepEvidenceApi<VizEvidence>;
}) {
  if (step.n === 9) return <Step9Production meta={meta} step={step} evidence={evidence} />;
  if (step.n === 10) return <Step10Length meta={meta} step={step} evidence={evidence} />;
  if (step.n === 11) return <Step11Network meta={meta} step={step} evidence={evidence} />;
  return <Step8Trade meta={meta} step={step} evidence={evidence} />;
}
