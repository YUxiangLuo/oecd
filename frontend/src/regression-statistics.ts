/** Shared display conventions for the fixed teaching model and its report. */
export const CLUSTER_INTERVAL_NOTE = "标准误（估计值的不确定程度）按国家聚类计算（同一国家的记录允许一起波动），95% 区间据此计算，是近似值；结果主要由少数国家决定时，区间可能偏窄。";

/** Match report_common._number(..., p_value=True); zero may be numerical underflow. */
export function formatPValue(value: number | null | undefined, missing = "—"): string {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 1) return missing;
  if (value < 0.0001) return "<0.0001";
  // Four fixed decimals, as the report prints it ("0.0010", not "0.0009587").
  return value.toFixed(4);
}
