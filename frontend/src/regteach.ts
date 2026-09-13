/** 回归工作台共用的政策系数分类工具。教学文案集中在 regression-lessons.ts。 */
import type { CoefStat, RegressionResponse } from "./types";

interface PolicyCoefficientGroups {
  policy: CoefStat[];
  main: CoefStat[];
  interactions: CoefStat[];
  eventMain: CoefStat[];
  eventInteraction: CoefStat[];
}

/** 控制变量不进入核心政策图；事件主效应与 BaseGVC 交互效应保持分离。 */
export function classifyPolicyCoefficients(coefs: CoefStat[], controls: string[]): PolicyCoefficientGroups {
  const policy = coefs.filter((coef) => !controls.includes(coef.name));
  const interactions = policy.filter((coef) => coef.name.includes("×base_gvc"));
  const main = policy.filter((coef) => !coef.name.includes("×base_gvc"));
  return {
    policy,
    main,
    interactions,
    eventMain: main.filter((coef) => coef.name.startsWith("k=")),
    eventInteraction: interactions.filter((coef) => coef.name.startsWith("k=")),
  };
}

export function splitPolicyCoefficients(resp: RegressionResponse): PolicyCoefficientGroups {
  const groups = classifyPolicyCoefficients(resp.result.coefs, resp.design.controls);
  const xColumns = resp.model_snapshot?.x_columns ?? [];
  if (!xColumns.length) return groups;
  const policy = resp.result.coefs.filter((coef) => xColumns.includes(coef.name));
  return { policy, main: policy, interactions: [], eventMain: [], eventInteraction: [] };
}
