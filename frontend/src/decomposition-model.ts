export type DecompositionRow = Record<string, string | number | null | undefined>;

export interface DecompositionPartSpec {
  key: string;
  weightKey?: string;
}

export interface DecompositionSpec {
  total: string;
  parts: readonly DecompositionPartSpec[];
  weightTotal?: string;
}

export type DecompositionStatus = "valid" | "nonpositive-total" | "unavailable";
export type DecompositionReason =
  | "missing-fields"
  | "nonfinite-calculation"
  | "zero-weight-denominator"
  | "negative-weight-denominator"
  | "zero-total"
  | "negative-total"
  | null;

export interface DecompositionModel {
  status: DecompositionStatus;
  reason: DecompositionReason;
  total: number | null;
  /** All-or-nothing finite values eligible for chart/domain/sum/closure use. */
  values: number[] | null;
  /** Per-part display values; complete finite contributions remain visible in an incomplete row. */
  contributions: Array<number | null>;
  shares: number[] | null;
  sum: number | null;
  error: number | null;
  /** Only a positive-domain, complete decomposition receives a closure verdict. */
  closure: boolean | null;
  /** Neutral arithmetic identity for complete direct-amount rows outside the share domain. */
  amountCloses: boolean | null;
  missingFields: string[];
}

export interface DecompositionDomainRow {
  values: number[];
  total: number;
}

export type DirectZeroTotalKind = "all-zero" | "signed-offset" | "nonclosing";

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function explicitDemoCountry(countries: readonly string[], value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && countries.includes(value) ? value : null;
}

export function decompositionRequestKey(year: number, country: string): string {
  return JSON.stringify([year, country]);
}

export function matchingDecompositionResponse<T>(
  response: { requestKey: string; payload: T } | null | undefined,
  requestKey: string,
): T | null {
  return response?.requestKey === requestKey ? response.payload : null;
}

function closureResult(total: number, values: number[]) {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isFinite(sum)) return null;
  }
  const error = Math.abs(sum - total);
  if (!Number.isFinite(error)) return null;
  const scaledError = total !== 0 ? error / Math.abs(total) : error;
  if (!Number.isFinite(scaledError)) return null;
  return { sum, error, closes: scaledError < 1e-6 };
}

function finiteShares(total: number, values: number[]): number[] | null {
  const shares = values.map((value) => (value / total) * 100);
  return shares.every(Number.isFinite) ? shares : null;
}

function unavailable(
  reason: Exclude<DecompositionReason, null>,
  total: number | null,
  missingFields: string[],
  contributions: Array<number | null>,
): DecompositionModel {
  return {
    status: "unavailable",
    reason,
    total,
    values: null,
    contributions,
    shares: null,
    sum: null,
    error: null,
    closure: null,
    amountCloses: null,
    missingFields,
  };
}

/**
 * Complete finite nonzero-total rows plus their authoritative totals for shared normalized geometry.
 * A zero-total signed row must use a local raw-amount domain instead of mixing units with ratios.
 */
export function decompositionDomainRows(
  rows: Array<DecompositionRow | null | undefined>,
  spec: DecompositionSpec,
): DecompositionDomainRow[] {
  return rows.flatMap((row) => {
    if (!row) return [];
    const model = buildDecompositionModel(row, spec);
    return model.values && model.total != null && model.total !== 0
      ? [{ values: model.values, total: model.total }]
      : [];
  });
}

/** Classify only complete direct-amount zero-total rows; weighted/incomplete rows return null. */
export function directZeroTotalKind(model: DecompositionModel): DirectZeroTotalKind | null {
  if (
    model.status !== "nonpositive-total"
    || model.reason !== "zero-total"
    || model.total !== 0
    || model.values == null
    || model.amountCloses == null
  ) return null;
  if (model.values.every((value) => value === 0)) return "all-zero";
  return model.sum === 0 ? "signed-offset" : "nonclosing";
}

/**
 * Convert one API row into a domain-aware render model before chart layout.
 * Missing/nonfinite values and nonfinite calculated results never enter chart arithmetic.
 */
export function buildDecompositionModel(row: DecompositionRow, spec: DecompositionSpec): DecompositionModel {
  const total = finiteNumber(row[spec.total]);
  const missingFields: string[] = [];
  if (total == null) missingFields.push(spec.total);

  if (spec.weightTotal) {
    const denominator = finiteNumber(row[spec.weightTotal]);
    if (denominator == null) {
      return unavailable("missing-fields", total, [...missingFields, spec.weightTotal], spec.parts.map(() => null));
    }
    if (denominator === 0) {
      return unavailable("zero-weight-denominator", total, missingFields, spec.parts.map(() => null));
    }
    if (denominator < 0) {
      return unavailable("negative-weight-denominator", total, missingFields, spec.parts.map(() => null));
    }

    let calculationFailed = false;
    const contributions = spec.parts.map((part) => {
      const length = finiteNumber(row[part.key]);
      const weight = part.weightKey ? finiteNumber(row[part.weightKey]) : null;
      // No activity of this kind (e.g. a purely domestic industry has no trade or GVC value added): its
      // segment length is undefined, but a zero weight contributes exactly zero to the average length.
      if (length == null && weight === 0) return 0;
      if (length == null) missingFields.push(part.key);
      if (!part.weightKey || weight == null) missingFields.push(part.weightKey ?? `${part.key}:weight`);
      if (length == null || weight == null) return null;
      const product = weight * length;
      const contribution = product / denominator;
      if (!Number.isFinite(product) || !Number.isFinite(contribution)) {
        calculationFailed = true;
        missingFields.push(`${part.key}:calculation`);
        return null;
      }
      return contribution;
    });
    if (calculationFailed) {
      return unavailable("nonfinite-calculation", total, [...new Set(missingFields)], contributions);
    }
    if (total == null || missingFields.length > 0 || contributions.some((value) => value == null)) {
      return unavailable("missing-fields", total, [...new Set(missingFields)], contributions);
    }
    if (total <= 0) {
      return unavailable(total === 0 ? "zero-total" : "negative-total", total, [], contributions);
    }
    const finiteValues = contributions as number[];
    const result = closureResult(total, finiteValues);
    const shares = finiteShares(total, finiteValues);
    if (!result || !shares) {
      return unavailable("nonfinite-calculation", total, ["decomposition:calculation"], contributions);
    }
    return {
      status: "valid",
      reason: null,
      total,
      values: finiteValues,
      contributions,
      shares,
      sum: result.sum,
      error: result.error,
      closure: result.closes,
      amountCloses: null,
      missingFields: [],
    };
  }

  const contributions = spec.parts.map((part) => {
    const value = finiteNumber(row[part.key]);
    if (value == null) missingFields.push(part.key);
    return value;
  });
  if (total == null || missingFields.length > 0 || contributions.some((value) => value == null)) {
    return unavailable("missing-fields", total, [...new Set(missingFields)], contributions);
  }
  const finiteValues = contributions as number[];
  const result = closureResult(total, finiteValues);
  if (!result) {
    return unavailable("nonfinite-calculation", total, ["decomposition:calculation"], contributions);
  }
  if (total <= 0) {
    return {
      status: "nonpositive-total",
      reason: total === 0 ? "zero-total" : "negative-total",
      total,
      values: finiteValues,
      contributions,
      shares: null,
      sum: result.sum,
      error: result.error,
      closure: null,
      amountCloses: result.closes,
      missingFields: [],
    };
  }
  const shares = finiteShares(total, finiteValues);
  if (!shares) {
    return unavailable("nonfinite-calculation", total, ["decomposition:shares"], contributions);
  }
  return {
    status: "valid",
    reason: null,
    total,
    values: finiteValues,
    contributions,
    shares,
    sum: result.sum,
    error: result.error,
    closure: result.closes,
    amountCloses: null,
    missingFields: [],
  };
}
