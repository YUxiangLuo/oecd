interface SignedDomain {
  negative: number;
  positive: number;
}
interface SignedSegment {
  value: number;
  leftPct: number;
  widthPct: number;
  negative: boolean;
}

const finite = (value: number) => (Number.isFinite(value) ? value : 0);

/**
 * Convert a set of signed component rows to one common zero-centred domain.
 * When normalize=true each row is expressed as a share of its signed total;
 * all-positive rows therefore retain the familiar 0–100% stacked-bar layout.
 */
export function signedDomain(
  rows: number[][],
  normalize = false,
  normalizationTotals?: readonly number[],
): SignedDomain {
  let negative = 0;
  let positive = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const values = rows[index].map(finite);
    const partsTotal = values.reduce((sum, value) => sum + value, 0);
    const requestedTotal = normalizationTotals?.[index];
    const total = requestedTotal != null && Number.isFinite(requestedTotal) ? requestedTotal : partsTotal;
    const denominator = normalize ? Math.abs(total) || 1 : 1;
    const rowPositive = values.reduce((sum, value) => sum + Math.max(0, value / denominator), 0);
    const rowNegative = values.reduce((sum, value) => sum + Math.max(0, -value / denominator), 0);
    positive = Math.max(positive, rowPositive, normalize && total > 0 ? 1 : 0);
    negative = Math.max(negative, rowNegative, normalize && total < 0 ? 1 : 0);
  }
  if (positive + negative === 0) positive = 1;
  return { negative, positive };
}

export function signedStack(
  rawValues: number[],
  domain: SignedDomain,
  normalize = false,
  normalizationTotal?: number,
): { zeroPct: number; segments: SignedSegment[] } {
  const values = rawValues.map(finite);
  const partsTotal = values.reduce((sum, value) => sum + value, 0);
  const total = normalizationTotal != null && Number.isFinite(normalizationTotal)
    ? normalizationTotal
    : partsTotal;
  const denominator = normalize ? Math.abs(total) || 1 : 1;
  const span = domain.negative + domain.positive || 1;
  const zeroPct = (domain.negative / span) * 100;
  let positiveCursor = 0;
  let negativeCursor = 0;
  const segments = values.map((rawValue) => {
    const value = rawValue / denominator;
    if (value < 0) {
      negativeCursor += -value;
      return {
        value: rawValue,
        leftPct: ((domain.negative - negativeCursor) / span) * 100,
        widthPct: (-value / span) * 100,
        negative: true,
      };
    }
    const segment = {
      value: rawValue,
      leftPct: ((domain.negative + positiveCursor) / span) * 100,
      widthPct: (value / span) * 100,
      negative: false,
    };
    positiveCursor += value;
    return segment;
  });
  return { zeroPct, segments };
}
