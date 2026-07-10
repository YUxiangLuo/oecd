export interface LinearFit {
  n: number;
  slope: number | null;
  intercept: number | null;
  correlation: number | null;
}
/** Ordinary least squares y = intercept + slope*x and Pearson r. */
export function linearFit(points: { x: number; y: number }[]): LinearFit {
  const valid = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const n = valid.length;
  if (n < 2) return { n, slope: null, intercept: null, correlation: null };
  const meanX = valid.reduce((sum, point) => sum + point.x, 0) / n;
  const meanY = valid.reduce((sum, point) => sum + point.y, 0) / n;
  let ssX = 0;
  let ssY = 0;
  let cross = 0;
  for (const point of valid) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    ssX += dx * dx;
    ssY += dy * dy;
    cross += dx * dy;
  }
  const slope = ssX > 0 ? cross / ssX : null;
  const intercept = slope == null ? null : meanY - slope * meanX;
  const correlation = ssX > 0 && ssY > 0 ? cross / Math.sqrt(ssX * ssY) : null;
  return { n, slope, intercept, correlation };
}
