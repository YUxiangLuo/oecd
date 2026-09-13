import { CalculationStep, type CalculationStepProps } from "./calculation-step";

export function TradeIndicatorStep(props: CalculationStepProps) {
  return <CalculationStep {...props} topic="trade" />;
}
