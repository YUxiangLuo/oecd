/**
 * 步骤 3–6 路由。
 *
 * 这四步是“把原始数据算成指标”的计算阶段。原先共用一个 IndicatorLab(演示 + 数据表),
 * 现按步拆成四个定制组件,统一为计算阶段三段式(讲清 → 分解数据表 → 动手拆解/验证);
 * 网络步无加总恒等式,改为“先小网络建直觉 → 再看真实中心性表”。
 * 共享的只有受控的 IndicatorTable 与讲解脚手架(viz/scaffold)。
 */
import type { Meta, Step, StepStateApi } from "../../types";
import type { IndicatorStepState } from "./indicator/indicator-table";
import { LengthIndicatorStep } from "./indicator/length";
import { NetworkIndicatorStep } from "./indicator/network";
import { ProductionIndicatorStep } from "./indicator/production";
import { TradeIndicatorStep } from "./indicator/trade";

export function IndicatorLab({ meta, step, state }: {
  meta: Meta;
  step: Step;
  state: StepStateApi<IndicatorStepState>;
}) {
  // 按主题路由,不依赖步号(步号可能因课程重排而变)。
  if (step.topic === "production") return <ProductionIndicatorStep meta={meta} step={step} state={state} />;
  if (step.topic === "length") return <LengthIndicatorStep meta={meta} step={step} state={state} />;
  if (step.topic === "network") return <NetworkIndicatorStep meta={meta} step={step} state={state} />;
  return <TradeIndicatorStep meta={meta} step={step} state={state} />;
}
