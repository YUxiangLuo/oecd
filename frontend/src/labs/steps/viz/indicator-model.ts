import type { Row, VizObservation } from "./scaffold";

export interface IndicatorTopic {
  key: "trade" | "production" | "length";
  defaultMetric: string;
  defaultView?: IndicatorView;
  question: string;
  metrics: {
    key: string;
    label: string;
    unit: string;
    denominator?: string;
    numerator?: string;
  }[];
  composition?: {
    total: string;
    segments: { key: string; name: string; color: string }[];
    note: string;
  };
  axes: {
    x: string;
    y: string;
    labels: [string, string, string, string];
    equality?: boolean;
  };
}
export type IndicatorView =
  | "trend"
  | "comparison"
  | "composition"
  | "evolution"
  | "directions"
  | "industry"
  | "explore";
export interface IndicatorSelection {
  first: string;
  second: string;
  industry: string;
  metric: string;
  start: number;
  end: number;
  year: number;
  view: IndicatorView;
  limit: number;
}

export function defaultComparison(
  countries: string[],
  compared: string[] = [],
): [string, string] {
  const carried = compared.filter(
    (country, index) =>
      countries.includes(country) && compared.indexOf(country) === index,
  );
  const first =
    carried[0] ?? (countries.includes("CHN") ? "CHN" : countries[0] ?? "");
  const second =
    carried.find((country) => country !== first) ??
    (first !== "USA" && countries.includes("USA")
      ? "USA"
      : countries.find((country) => country !== first) ?? "");
  return [first, second];
}
export const finiteValue = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Derived shares use the authoritative total, never a mean of industry shares. */
export function indicatorRows(rows: Row[], topic: IndicatorTopic): Row[] {
  return rows.map((row) => {
    const result = { ...row };
    for (const field of topic.metrics) {
      if (!field.denominator || !field.numerator) continue;
      const denominator = row[field.denominator],
        numerator = row[field.numerator];
      result[field.key] =
        finiteValue(denominator) && denominator > 0 && finiteValue(numerator)
          ? numerator / denominator
          : null;
    }
    return result;
  });
}

/** Save exactly the finite readings displayed; incomplete paired views cannot be saved. */
export function indicatorMaterial(
  rows: Row[],
  countries: string[],
  years: number[],
  metrics: string[],
  topic: IndicatorTopic,
  industry: string,
  source: VizObservation["source"],
  release: string,
): VizObservation[] {
  return countries.flatMap((country) =>
    years.flatMap((year) =>
      metrics.flatMap((metric) => {
        const row = rows.find(
          (item) =>
            item.country === country &&
            item.year === year &&
            String(item.industry ?? "") === industry,
        );
        const value = row?.[metric];
        if (!finiteValue(value)) return [];
        return [
          {
            entity: industry ? `${country}·${industry}` : country,
            country,
            ...(industry ? { industry } : {}),
            year,
            value,
            metric,
            unit:
              topic.metrics.find((field) => field.key === metric)?.unit ??
              "百万美元",
            release,
            scope: industry
              ? ("country-industry" as const)
              : ("country" as const),
            source,
          },
        ];
      }),
    ),
  );
}

export function materialComplete(
  observations: VizObservation[],
  countries: string[],
  metrics: string[],
  trend: boolean,
): boolean {
  if (
    countries.length !== 2 ||
    countries[0] === countries[1] ||
    !observations.length
  )
    return false;
  const identities = countries.map((country) =>
    observations
      .filter((item) => item.country === country)
      .map((item) => `${item.industry ?? ""}:${item.metric}:${item.year}`)
      .sort(),
  );
  if (JSON.stringify(identities[0]) !== JSON.stringify(identities[1]))
    return false;
  return metrics.every((metric) =>
    countries.every(
      (country) =>
        new Set(
          observations
            .filter(
              (item) => item.country === country && item.metric === metric,
            )
            .map((item) => item.year),
        ).size >= (trend ? 2 : 1),
    ),
  );
}

export const materialKey = (rows: VizObservation[]) =>
  JSON.stringify(
    rows.map(
      ({ country, industry, year, metric, unit, value, release, source }) => [
        country,
        industry,
        year,
        metric,
        unit,
        value,
        release,
        source,
      ],
    ),
  );

export function changeReading(
  start: number,
  end: number,
  unit: string,
): string {
  const difference = (end - start) * (unit === "%" ? 100 : 1);
  return `${difference > 0 ? "+" : ""}${difference.toLocaleString("zh-CN", { maximumFractionDigits: 3 })} ${unit === "%" ? "个百分点" : unit}`;
}

/** One year's spread of a country-level metric across all economies (ROW excluded). */
export interface YearDistribution {
  year: number;
  n: number;
  p25: number;
  median: number;
  p75: number;
  /** Rank from highest to lowest (1 = highest); ties share the better rank. */
  ranks: Record<string, number>;
}

/** Linear-interpolated quantile, the same rule pandas uses, so the page and the report agree. */
export function quantile(sorted: number[], p: number): number {
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/** Global reference for the trend and distribution views: every economy's country-level reading per year. */
export function countryDistribution(rows: Row[], metric: string, years: number[]): YearDistribution[] {
  return years.flatMap((year) => {
    const readings = rows
      .filter((row) => row.year === year && !row.industry && row.country !== "ROW" && finiteValue(row[metric]))
      .map((row) => ({ country: String(row.country), value: row[metric] as number }));
    if (readings.length < 2) return [];
    const sorted = readings.map((item) => item.value).sort((a, b) => a - b);
    const ranks: Record<string, number> = {};
    for (const item of readings) ranks[item.country] = 1 + readings.filter((other) => other.value > item.value).length;
    return [{
      year,
      n: readings.length,
      p25: quantile(sorted, 0.25),
      median: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      ranks,
    }];
  });
}
