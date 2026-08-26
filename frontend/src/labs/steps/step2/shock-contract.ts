import type { ShockContract } from "../../../types";

export const SHOCK_ARTIFACT_CONTRACT_VERSION = 9;
export const SHOCK_CONTRACT_VERSION = 2;
export const SHOCK_TREATED_THRESHOLD = 0.001;
export const SHOCK_CONTRACT_TYPES = {
  tariff: {
    shock_field: "tariff_shock",
    treated_field: "treated",
    announced_date_field: "announced_date",
    effective_date_field: "effective_date",
    note_field: "note",
  },
  sanctions: {
    shock_field: "sanction_shock",
    treated_field: "sanction_treated",
    announced_date_field: "sanction_announced_date",
    effective_date_field: "sanction_effective_date",
    note_field: "sanction_note",
  },
  export_control: {
    shock_field: "export_control_shock",
    treated_field: "export_control_treated",
    announced_date_field: "export_control_announced_date",
    effective_date_field: "export_control_effective_date",
    note_field: "export_control_note",
  },
} as const;
export const SHOCK_EXPOSURE_CONTRACT = {
  source_field: "tariff_exposure_source",
  mode_field: "tariff_exposure_mode",
  disclosure_field: "tariff_exposure_disclosure",
  allowed_sources: ["oecd_icio_bilateral_flow", "stylized_teaching_fallback"],
  allowed_modes: ["fixed_pretreatment", "contemporaneous"],
} as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export interface ShockContractState {
  valid: boolean;
  reason: string | null;
  exposureSource: string | null;
  officialExposure: boolean;
}

export function inspectShockContract(
  contract: ShockContract | undefined,
  artifactContractVersion: number | undefined,
): ShockContractState {
  if (artifactContractVersion !== SHOCK_ARTIFACT_CONTRACT_VERSION) {
    return {
      valid: false,
      reason: `不支持冲击产物版本 ${artifactContractVersion ?? "缺失"}；当前必须是 v${SHOCK_ARTIFACT_CONTRACT_VERSION}。`,
      exposureSource: null,
      officialExposure: false,
    };
  }
  if (!contract) {
    return { valid: false, reason: "发布数据缺少 shock contract，不能读取或解释冲击面板。", exposureSource: null, officialExposure: false };
  }
  const expected = canonical({
    version: SHOCK_CONTRACT_VERSION,
    treated_threshold: SHOCK_TREATED_THRESHOLD,
    treated_operator: ">",
    types: SHOCK_CONTRACT_TYPES,
    tariff_exposure: SHOCK_EXPOSURE_CONTRACT,
  });
  if (canonical(contract) !== expected) {
    return {
      valid: false,
      reason: `不支持或不完整的 shock contract；当前仅支持版本 ${SHOCK_CONTRACT_VERSION} 的精确字段/来源集合。`,
      exposureSource: null,
      officialExposure: false,
    };
  }
  return { valid: true, reason: null, exposureSource: null, officialExposure: false };
}

export function exposureSourceTeaching(source: unknown): { label: string; official: boolean; valid: boolean; disclosure: string } {
  if (source === "oecd_icio_bilateral_flow") {
    return {
      label: "OECD ICIO 双边流向",
      official: true,
      valid: true,
      disclosure: "国家–行业出口暴露度来自经发布校验的 OECD ICIO 双边流向；目的地净流量因有符号存货项为负时按 0 进入权重，分母为非负跨境目的地流量之和；政策映射与冲击数值仍是教学口径。",
    };
  }
  if (source === "stylized_teaching_fallback") {
    return {
      label: "风格化教学 fallback",
      official: false,
      valid: true,
      disclosure: "风格化出口暴露度仅供教学测试，不是 OECD ICIO 观测值，不得表述为官方数据。",
    };
  }
  return {
    label: "来源无效（停止解释）",
    official: false,
    valid: false,
    disclosure: "来源未知或混合，不能解释为已验证数据；服务端应已拒绝该响应。",
  };
}
