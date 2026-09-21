/** Select the signed regressor from the fixed teaching regression response. */
import type { CoefStat, RegressionResponse } from "./types";

interface PolicyCoefficientGroups {
  policy: CoefStat[];
}

export function splitPolicyCoefficients(resp: RegressionResponse): PolicyCoefficientGroups {
  const xColumns = resp.model_snapshot?.x_columns ?? [resp.design.shock_col];
  return { policy: resp.result.coefs.filter((coefficient) => xColumns.includes(coefficient.name)) };
}
