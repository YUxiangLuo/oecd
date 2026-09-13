import { CalculationStep, type CalculationStepProps } from "./calculation-step";

export function ProductionIndicatorStep(props: CalculationStepProps) {
  return <CalculationStep {...props} topic="production" />;
}
