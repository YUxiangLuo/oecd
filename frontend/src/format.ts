/** 指标表格与图表共用的数值格式，避免同一指标在不同页面精度不一致。 */
export function formatMetric(value: number, format?: string): string {
  if (!Number.isFinite(value)) return "—";
  if (format === "pct") return `${(value * 100).toFixed(2)}%`;
  if (format === "amount") {
    return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  }
  return value.toFixed(3);
}
