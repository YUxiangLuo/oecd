/** Shared display conventions for the fixed teaching model and its report. */
export const CLUSTER_INTERVAL_LABEL = "标称 95% 的近似聚类区间";
export const CLUSTER_INTERVAL_NOTE = "按国家聚类的区间使用有限样本近似；当信息集中在少数国家时，实际覆盖率可能低于 95%，国家数量多也不保证达到标称覆盖率。";

/** Match report_common._number(..., p_value=True); zero may be numerical underflow. */
export function formatPValue(value: number | null | undefined, missing = "—"): string {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 1) return missing;
  if (value < 0.0001) return "<0.0001";
  return Number(value.toPrecision(4)).toString();
}
