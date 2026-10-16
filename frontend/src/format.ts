/** 负零与"四舍五入后为零的极小负数"(如 -1e-13)会渲染成 "-0"/"-0.00%",统一去掉负号 */
export function stripNegativeZero(formatted: string): string {
  return /^-0([.,]0+)?%?$/.test(formatted) ? formatted.slice(1) : formatted;
}

/**
 * A number with fixed decimals and thousands separators: 1382.4 → "1,382" (0 digits), -12.5 → "-12.50" (2); a value
 * that rounds to zero reads "0.00", never "-0.00".
 */
export function groupedFixed(value: number, digits: number): string {
  return stripNegativeZero(value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
}

/** 指标表格与图表共用的数值格式（与步骤 6–9 的读数和报告同一规则），避免同一指标在不同页面精度不一致：
 *  份额三位小数；百万美元金额 ≥1 取整、<1 三位小数；整数计数不带小数；其余无量纲指标三位小数（≥100 取整）。 */
export function formatMetric(value: number, format?: string): string {
  if (!Number.isFinite(value)) return "—";
  // An exact zero (e.g. a node with no edges) is a count of nothing, not "0.000".
  if (value === 0) return format === "pct" ? "0%" : "0";
  if (format === "pct") return stripNegativeZero(`${(value * 100).toFixed(3)}%`);
  if (format === "amount") {
    // Rounding noise reads 0; a real but tiny flow is not shown as an exact zero next to a non-zero share.
    if (Math.abs(value) < 1e-9) return "0";
    if (Math.abs(value) < 0.0005) return value > 0 ? "<0.001" : ">-0.001";
    const digits = Math.abs(value) >= 1 ? 0 : 3;
    return stripNegativeZero(value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  }
  // Degrees and eccentricity count edges or steps; unnormalised betweenness (a sum of shares over node pairs) is
  // rounded to the same whole numbers, as in the report. A betweenness above 0 but below 0.5 is real (a node on a
  // few of the shortest routes) and reads "<1", not the "0" of a node on none.
  if (format === "count") {
    // Rounding noise still reads 0, as for amounts.
    if (Math.abs(value) < 1e-9) return "0";
    if (Math.abs(value) < 0.5) return value > 0 ? "<1" : ">-1";
    return stripNegativeZero(value.toLocaleString("zh-CN", { maximumFractionDigits: 0 }));
  }
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

/** A share (0.2330) in percentage points to two decimals ("23.30"), and the same for shares in percent ("w").
 * A positive value too small for two decimals keeps two significant digits ("0.0033"), so "w × τ = X" can
 * still be checked by hand (a "不到 0.01" chain could not). */
export function percentagePoints(share: number): string {
  const points = share * 100;
  if (points > 0 && points < 0.005) return points.toFixed(Math.min(10, Math.ceil(-Math.log10(points)) + 1));
  return stripNegativeZero(points.toFixed(2));
}
