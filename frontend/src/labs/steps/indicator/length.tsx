import { CalculationStep, type CalculationStepProps } from "./calculation-step";

export function LengthIndicatorStep(props: CalculationStepProps) {
  return <CalculationStep {...props} topic="length" />;
}
