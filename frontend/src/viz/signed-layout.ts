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
export function signedDomain(rows: number[][], normalize = false): SignedDomain {
  let negative = 0;
  let positive = 0;
  for (const raw of rows) {
    const values = raw.map(finite);
    const total = values.reduce((sum, value) => sum + value, 0);
    const denominator = normalize ? Math.abs(total) || 1 : 1;
    const rowPositive = values.reduce((sum, value) => sum + Math.max(0, value / denominator), 0);
    const rowNegative = values.reduce((sum, value) => sum + Math.max(0, -value / denominator), 0);
    positive = Math.max(positive, rowPositive);
    negative = Math.max(negative, rowNegative);
  }
  if (positive + negative === 0) positive = 1;
  return { negative, positive };
}

export function signedStack(
  rawValues: number[],
  domain: SignedDomain,
  normalize = false,
): { zeroPct: number; segments: SignedSegment[] } {
  const values = rawValues.map(finite);
  const total = values.reduce((sum, value) => sum + value, 0);
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
