import type { Row, VizObservation } from "./scaffold";

export interface IndicatorTopic {
  key: "trade" | "production" | "length";
  defaultMetric: string;
  defaultView?: IndicatorView;
  question: string;
  /** Name of the step's theme view (first in the view bar, the default entry). */
  themeLabel: string;
  /** One line under the view bar while the theme view is open: what to look at. */
  themeHint: string;
  metrics: {
    key: string;
    label: string;
    unit: string;
    denominator?: string;
    numerator?: string;
  }[];
  composition?: CompositionSpec & {
    /** A second way to read the same step (step 7: the final-goods / backward side). */
    alternate?: CompositionSpec & { key: string; label: string; primaryLabel: string };
  };
  /** The default positioning axes; `axesOptions` lists every pair the 定位图 can switch between. */
  axes: AxesOption;
  axesOptions?: AxesOption[];
}

export interface CompositionSpec {
  total: string;
  segments: { key: string; name: string; color: string }[];
    /** The part the step reads first (reading cards, report); defaults to the last segment. */
    focus?: string;
    note: string;
}

export interface AxesOption {
  key: string;
  label: string;
  x: string;
  y: string;
  labels: [string, string, string, string];
  equality?: boolean;
  /** Log scale for size-like x metrics (amounts). */
  xScale?: "linear" | "log";
}
export type IndicatorView =
  | "trend"
  | "comparison"
  | "positioning"
  | "composition"
  | "evolution"
  | "directions"
  | "industry"
  /** 行业结构 (steps 7–8): one economy's industries, exploration only. */
  | "structure"
  | "explore";
/** Material is one chart of 1–5 economies (design doc 4.1). */
export const MAX_ENTITIES = 5;
export const COMPARISON_LETTERS = ["B", "C", "D", "E"] as const;

export interface IndicatorSelection {
  first: string;
  /** The first comparison country (kept for saved selections); `others` holds all of them. */
  second: string;
  /** Comparison countries in order (0–4); when absent, derived from `second`. */
  others?: string[];
  industry: string;
  metric: string;
  start: number;
  end: number;
  year: number;
  view: IndicatorView;
  limit: number;
  /** Step 7: read the composition from the forward (SVA) or backward (FGY) side. */
  composition_side?: "primary" | "alternate";
  /** 定位图: which axes pair, and whether the 2016→2020 trail is drawn. */
  axes?: string;
  trail?: boolean;
}

/** The entities a selection shows: the observed country first, then its comparison countries. */
export function selectionEntities(selection: Pick<IndicatorSelection, "first" | "second" | "others">): string[] {
  const others = selection.others ?? (selection.second ? [selection.second] : []);
  return [selection.first, ...others].filter((country, index, all) => country && all.indexOf(country) === index).slice(0, MAX_ENTITIES);
}

/** Normalise a saved selection: `others` always present and consistent with `second`. */
export function normalizeSelection(selection: IndicatorSelection): IndicatorSelection {
  const [, ...others] = selectionEntities(selection);
  return { ...selection, second: others[0] ?? "", others };
}

/** Carry a saved entity list over (first + up to four comparisons), defaulting to CHN vs USA. */
export function defaultEntities(countries: string[], compared: string[] = []): string[] {
  const carried = compared.filter((country, index) => countries.includes(country) && compared.indexOf(country) === index);
  if (carried.length) return carried.slice(0, MAX_ENTITIES);
  const [first, second] = defaultComparison(countries, []);
  return second ? [first, second] : [first];
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

/**
 * One reproducible chart: 1–5 distinct economies with identical (industry, metric, year) keys. A single
 * economy is only material when it is read against the global reference (`singleAllowed`: country scope).
 */
export function materialComplete(
  observations: VizObservation[],
  countries: string[],
  metrics: string[],
  trend: boolean,
  singleAllowed = false,
): boolean {
  if (
    countries.length < 1 ||
    countries.length > MAX_ENTITIES ||
    new Set(countries).size !== countries.length ||
    (countries.length === 1 && !singleAllowed) ||
    !observations.length
  )
    return false;
  const identities = countries.map((country) =>
    JSON.stringify(
      observations
        .filter((item) => item.country === country)
        .map((item) => `${item.industry ?? ""}:${item.metric}:${item.year}`)
        .sort(),
    ),
  );
  if (identities.some((identity) => identity !== identities[0])) return false;
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

/** Amounts are millions of USD: whole millions read better than three decimals, as in the report. */
export const readingDigits = (value: number, unit: string) =>
  unit === "百万美元" && Math.abs(value) >= 1 ? 0 : 3;

export function changeReading(
  start: number,
  end: number,
  unit: string,
): string {
  const difference = (end - start) * (unit === "%" ? 100 : 1);
  return `${difference > 0 ? "+" : ""}${difference.toLocaleString("zh-CN", { maximumFractionDigits: readingDigits(difference, unit) })}${unit === "%" ? " 个百分点" : unit === "无量纲" ? "" : ` ${unit}`}`;
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
  /** How many economies share each reading (1 = no tie). */
  ties?: Record<string, number>;
}

/** Shown for a year in which every economy has the same reading; the report uses the same words. */
export const NO_RANK = "不分名次";
export const NO_RANK_NOTE = "不分名次：该年全部经济体数值相同";

/**
 * “第 3 位”, or “并列第 3 位” when other economies have the same reading; null when every economy has
 * the same reading (e.g. an industry with no flows anywhere), where a rank says nothing (show NO_RANK).
 */
export function rankText(rank: number, tie: number | undefined, n: number): string | null {
  const shared = tie ?? 1;
  if (shared >= n) return null;
  return `${shared > 1 ? "并列" : ""}第 ${rank} 位`;
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
    const ties: Record<string, number> = {};
    for (const item of readings) {
      ranks[item.country] = 1 + readings.filter((other) => other.value > item.value).length;
      ties[item.country] = readings.filter((other) => other.value === item.value).length;
    }
    return [{
      year,
      n: readings.length,
      p25: quantile(sorted, 0.25),
      median: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      ranks,
      ties,
    }];
  });
}
