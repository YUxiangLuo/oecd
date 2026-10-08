/** 负零与"四舍五入后为零的极小负数"(如 -1e-13)会渲染成 "-0"/"-0.00%",统一去掉负号 */
export function stripNegativeZero(formatted: string): string {
  return /^-0([.,]0+)?%?$/.test(formatted) ? formatted.slice(1) : formatted;
}

/** 指标表格与图表共用的数值格式（与步骤 6–9 的读数和报告同一规则），避免同一指标在不同页面精度不一致：
 *  份额三位小数；百万美元金额 ≥1 取整、<1 三位小数；整数计数不带小数；其余无量纲指标三位小数（≥100 取整）。 */
export function formatMetric(value: number, format?: string): string {
  if (!Number.isFinite(value)) return "—";
  // An exact zero (e.g. a node with no edges) is a count of nothing, not "0.000".
  if (value === 0) return format === "pct" ? "0%" : "0";
  if (format === "pct") return stripNegativeZero(`${(value * 100).toFixed(3)}%`);
  if (format === "amount") {
    if (Math.abs(value) < 0.0005) return "0";
    const digits = Math.abs(value) >= 1 ? 0 : 3;
    return stripNegativeZero(value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  }
  // Degrees, eccentricity and (unnormalised) betweenness count paths or edges: whole numbers, as in the report.
  if (format === "count") return stripNegativeZero(value.toLocaleString("zh-CN", { maximumFractionDigits: 0 }));
  // Counts (degree, eccentricity) are whole numbers: "43", not "43.000". Large dimensionless values (betweenness
  // reaches tens of thousands) read as grouped integers rather than widening the table with three decimals.
  if (Number.isInteger(value) || Math.abs(value) >= 100) {
    return stripNegativeZero(value.toLocaleString("zh-CN", { maximumFractionDigits: 0 }));
  }
  return stripNegativeZero(value.toFixed(3));
}

/** Join a label and a Chinese suffix with a space when the label ends in Latin text ("中间投入 Z 数据表"). */
export function cjkJoin(head: string, tail: string): string {
  return /[A-Za-z0-9)]$/.test(head) && /^[⺀-鿿]/.test(tail) ? `${head} ${tail}` : `${head}${tail}`;
}

/** Join two pieces with a space wherever Chinese meets Latin letters or digits ("显示 Top 15", "查看 GVC 位置指数"). */
export function cjkSpace(head: string, tail: string): string {
  const cjkThenLatin = /[⺀-鿿）]$/.test(head) && /^[A-Za-z0-9]/.test(tail);
  const latinThenCjk = /[A-Za-z0-9)]$/.test(head) && /^[⺀-鿿]/.test(tail);
  return cjkThenLatin || latinThenCjk ? `${head} ${tail}` : `${head}${tail}`;
}
