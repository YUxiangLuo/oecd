/**
 * 步骤 2–5 路由。
 *
 * 步骤2–4：计算方法（含课程说明与文献）→ 真实数据动手拆解 → 完整数据与记录。
 * 步骤5：小网络建直觉 → 真实中心性表。
 * 报告材料来自真实指标表。
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
