/** 负零与"四舍五入后为零的极小负数"(如 -1e-13)会渲染成 "-0"/"-0.00%",统一去掉负号 */
export function stripNegativeZero(formatted: string): string {
  return /^-0([.,]0+)?%?$/.test(formatted) ? formatted.slice(1) : formatted;
}

/** 指标表格与图表共用的数值格式，避免同一指标在不同页面精度不一致。 */
export function formatMetric(value: number, format?: string): string {
  if (!Number.isFinite(value)) return "—";
  if (format === "pct") return stripNegativeZero(`${(value * 100).toFixed(2)}%`);
  // An exact zero (e.g. a node with no edges) is a count of nothing, not "0.000".
  if (value === 0) return "0";
  if (format === "amount") {
    // Million-USD amounts: whole numbers from 1,000 up (as the report prints them), two fixed decimals below,
    // so a column never mixes "62,876.4" with "312,083.83".
    if (Math.abs(value) < 0.005) return "0";
    const digits = Math.abs(value) >= 1000 || Number.isInteger(value) ? 0 : 2;
    return stripNegativeZero(value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  }
  // 无量纲大数(如介数中心性可达数万)保留三位小数只会拉宽表格,改用千分位整数。
  if (Math.abs(value) >= 100) return stripNegativeZero(value.toLocaleString("zh-CN", { maximumFractionDigits: 0 }));
  return stripNegativeZero(value.toFixed(3));
}

/** Join a label and a Chinese suffix with a space when the label ends in Latin text ("中间投入 Z 数据表"). */
export function cjkJoin(head: string, tail: string): string {
  return /[A-Za-z0-9)]$/.test(head) && /^[⺀-鿿]/.test(tail) ? `${head} ${tail}` : `${head}${tail}`;
}
