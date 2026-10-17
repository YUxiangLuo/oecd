import { useMemo, useState, type KeyboardEvent } from "react";
import { countryLabel, joinCountries, sectorLabel } from "../../../viz";
import { useHoverTip, type TipLine } from "../../../viz/hover";
import { CAT, CAT_TEXT } from "../../../viz/shared";
import { changeReading, finiteValue, NO_OUTPUT, NO_RANK, NO_RANK_NOTE, rankText, readingDigits, type YearDistribution } from "./indicator-model";
import { integerDomain, niceDomain } from "../../../viz/nice-ticks";
import { stripNegativeZero, unitText } from "../../../format";
import type { Row } from "./scaffold";
import { CardGrid } from "./card-grid";

/** Decimals a tick step needs in the shown unit (0.00025 → 5), so neighbouring ticks never read alike. */
const stepDecimals = (ticks: readonly number[] | undefined, unit: string) => {
  if (!ticks || ticks.length < 2) return 0;
  const step = Math.abs(ticks[1] - ticks[0]) * (unit === "%" ? 100 : 1);
  if (!(step > 0)) return 0;
  const text = String(Number(step.toPrecision(6)));
  const exponent = /e-(\d+)$/.exec(text);
  return exponent ? Number(exponent[1]) + (text.split("e")[0].split(".")[1]?.length ?? 0) : text.split(".")[1]?.length ?? 0;
};

/** Axis ticks: round values, trailing zeros trimmed ("10%", "1.5"); given the axis's ticks, at least the decimals
 * their step needs (0, 0.00025, 0.0005, … rather than 0.001 three times). */
export const indicatorTick = (value: number | null, unit: string, ticks?: readonly number[]) => {
  if (value === null) return "缺失";
  const shown = unit === "%" ? value * 100 : value;
  const digits = Math.max(readingDigits(value, unit), stepDecimals(ticks, unit));
  // A tick that is not zero must not read "0" (tiny exposures): keep two significant digits instead.
  const tooSmall = shown !== 0 && Math.abs(shown) < 0.5 * 10 ** -digits;
  const text = tooSmall
    ? String(Number(shown.toPrecision(2)))
    : shown.toLocaleString("zh-CN", { maximumFractionDigits: digits });
  return stripNegativeZero(`${text}${unit === "%" ? "%" : ""}`);
};

/** The observed economy as a reading card opens with it: "JPN 日本 · C26 计算机电子光学" when the scope is one
 * industry, so an industry reading is not taken for the country's own (round 21). */
export const scopeLabel = (country: string, industry?: string | null) =>
  industry ? `${countryLabel(country)} · ${sectorLabel(industry)}` : countryLabel(country);

/** Readings in labels, tables and tooltips keep fixed decimals, so values side by side line up
 * ("11.730%" next to "15.613%", not "11.73%"); an exact zero reads "0". */
export const indicatorNumber = (value: number | null, unit: string, digits?: number) =>
  value === 0 ? `0${unit === "%" ? "%" : ""}` : fixedIndicatorNumber(value, unit, digits);

/** Card readings keep the same decimals on both ends ("11.556% → 11.730%"); hover readouts stay trimmed. */
export const fixedIndicatorNumber = (value: number | null, unit: string, digits?: number) =>
  value === null
    ? "缺失"
    // With a page-specific precision, a positive value too small to show reads "不到 0.01", not "0.00".
    : digits != null && value > 0 && Math.abs(unit === "%" ? value * 100 : value) < 0.5 * 10 ** -digits
      ? `不到 ${(10 ** -digits).toFixed(digits)}${unit === "%" ? "%" : ""}`
    // A tiny negative that rounds to zero reads "0.000", not "-0.000".
    : stripNegativeZero(`${(unit === "%" ? value * 100 : value).toLocaleString("zh-CN", { minimumFractionDigits: digits ?? readingDigits(value, unit), maximumFractionDigits: digits ?? readingDigits(value, unit) })}${unit === "%" ? "%" : ""}`);

/** Sentences and reading cards read an amount from 1 to 10 to three decimals (as steps 1–5 do), where tables and
 * ticks read whole millions; undefined keeps the shared precision. See `textDigits` in indicator-model. */
export const smallAmountDigits = (value: number | null, unit: string) =>
  value !== null && unit === "百万美元" && Math.abs(value) >= 1 && Math.abs(value) < 10 ? 3 : undefined;

/** A reading inside a sentence or a reading card: as {@link indicatorNumber}, except that an amount below 10 keeps
 * three decimals ("3.832", not "4"). */
export const textNumber = (value: number | null, unit: string) =>
  value === 0 ? indicatorNumber(0, unit) : fixedIndicatorNumber(value, unit, smallAmountDigits(value, unit));

/** Size of a gap or its change as displayed, or null when it rounds to zero (so it never reads “差距扩大 0”). */
const magnitudeReading = (value: number, unit: string, digits?: number) => {
  const reading = changeReading(0, Math.abs(value), unit, digits).replace("+", "");
  return /^0(\.0+)?( |$)/.test(reading) ? null : reading;
};

/** A country label's width in em: a CJK character is about 1em, a Latin letter, digit or space about 0.62em. */
export const labelEm = (country: string) =>
  [...countryLabel(country)].reduce((width, char) => width + (/[⺀-鿿]/.test(char) ? 1 : 0.62), 0);

/** Step 9: a comparison where either side has no output in the industry (see {@link NO_OUTPUT}). */
export const NO_OUTPUT_GAP = "无产出，不比较差距";

/** Under the trend cards, as the report says it (report_observed): a change is the unrounded difference, so it can
 *  differ in the last digit from the two readings shown under it (“+0.524” beside “16.743% → 17.266%”). */
export const CHANGE_ROUNDING_NOTE = "变化按未取整的原值计算，可能与两端读数之差相差末位 1。";
const REFERENCE_FILL = "#9aa3b5";
const REFERENCE_LINE = "#6b7385";

interface ComparisonReading {
  country: string;
  year: number;
  value: number | null;
}

/**
 * Reading order for a trend: the observed country's own change, where it sits among all economies,
 * how the global median moved, and only then the gap to the comparison country.
 */
export function TrendSummary({
  readings,
  countries,
  years,
  unit,
  distribution = [],
  sameIndustry = false,
  digits,
  metricLabel,
  industry,
  reasonFor,
}: {
  readings: ComparisonReading[];
  /** The industry the readings belong to, when the scope is one industry; the observed country's card names it. */
  industry?: string;
  countries: string[];
  years: number[];
  unit: string;
  /** Overrides the shared reading precision (step 10: X to two decimals of a percentage point). */
  digits?: number;
  distribution?: YearDistribution[];
  /** Step 9: the reference is the same industry in every economy. */
  sameIndustry?: boolean;
  /** The indicator the cards read, where no chart title names it (历年构成: 外国增加值项占比, 后向复杂 GVC 生产份额). */
  metricLabel?: string;
  /** Why a reading is empty when it is undefined rather than missing, as a whole clause ("该行业总增加值为负，
   *  复杂 GVC 生产份额无法计算（不是缺少数据）"); null when the data is really missing. */
  reasonFor?: (country: string, year: number) => string | null;
}) {
  const value = (country: string, year: number) =>
    readings.find((item) => item.country === country && item.year === year)?.value ?? null;
  const [first, ...others] = countries;
  const own = years.filter((year) => value(first, year) !== null);
  /** "2020 年该行业总增加值为负，…（不是缺少数据）" / "2016、2020 年缺少数据": each empty year with its own reason. */
  const gapText = (country: string, at: number[]) => {
    const parts = [...new Set(at)].map((year) => ({ year, reason: reasonFor?.(country, year) ?? null }));
    const grouped = [...new Set(parts.map((part) => part.reason))].map((reason) => {
      const when = parts.filter((part) => part.reason === reason).map((part) => part.year);
      return `${when.join("、")} 年${reason ?? "缺少数据（缺少的数据留空）"}`;
    });
    const undefinedOnly = parts.every((part) => part.reason);
    return {
      text: grouped.join("；"),
      undefinedOnly,
      word: undefinedOnly && parts.every((part) => part.reason!.includes("无法定义")) ? "无法定义" : "无法计算",
    };
  };
  // 起始 = 结束: one year is a choice, not missing data.
  if (years.length === 1) return <p className="muted">起始年份和结束年份相同，请选两个不同年份。</p>;
  if (own.length < 2) {
    const empty = years.filter((year) => value(first, year) === null);
    const gap = gapText(first, empty);
    if (gap.undefinedOnly && empty.length) {
      const reasons = [...new Set(empty.map((year) => reasonFor!(first, year)))];
      return <p className="muted">{own.length
        ? `${countryLabel(first)}在所选年份只有 ${own[0]} 年有读数（${gap.text}），暂不能读出期间变化。`
        : reasons.length === 1
          ? `${countryLabel(first)}在所选年份${reasons[0]}，暂不能读出期间变化。`
          : `${countryLabel(first)}：${gap.text}，暂不能读出期间变化。`}</p>;
    }
    return <p className="muted">{own.length
      ? `${countryLabel(first)}在所选年份只有 ${own[0]} 年有读数，暂不能读出期间变化。`
      : `${countryLabel(first)}在所选年份没有读数，暂不能读出期间变化。`}</p>;
  }
  const firstYear = own[0];
  const lastYear = own.at(-1)!;
  const start = value(first, firstYear)!;
  const end = value(first, lastYear)!;
  const startRef = distribution.find((item) => item.year === firstYear);
  const endRef = distribution.find((item) => item.year === lastYear);
  const startRank = startRef?.ranks[first];
  const endRank = endRef?.ranks[first];
  /** Step 9: the end years in which the industry has no output in `country` (its 0 is not a reading). */
  const idleYears = (country: string) =>
    [...new Set([startRef, endRef].filter((ref) => ref?.noOutput?.includes(country)).map((ref) => ref!.year))];
  const gapCards = others.map((second) => {
    // A 0 for no output is not compared, as it is not ranked: neither side's gap is a real difference.
    const idle = [first, second].map((country) => ({ country, years: idleYears(country) })).filter((item) => item.years.length);
    if (idle.length) {
      return (
        <div key={second}>
          <span>与对比国家 {scopeLabel(second, industry)}</span>
          <b>{NO_OUTPUT_GAP}</b>
          <small>{`${idle.map((item) => `${item.years.join("、")} 年该行业在 ${countryLabel(item.country)}没有产出`).join("；")}，读数 0 不是真实的 0，暂不比较差距`}</small>
        </div>
      );
    }
    if (value(second, firstYear) === null || value(second, lastYear) === null) {
      // Name the empty year(s) and why: an undefined share is not missing data.
      const gap = gapText(second, [firstYear, lastYear].filter((year) => value(second, year) === null));
      return (
        <div key={second}>
          <span>与对比国家 {scopeLabel(second, industry)}</span>
          <b>{gap.undefinedOnly ? `期间读数${gap.word}` : "期间读数不完整"}</b>
          <small>{gap.text}，暂不比较差距</small>
        </div>
      );
    }
    const startGap = start - value(second, firstYear)!;
    const endGap = end - value(second, lastYear)!;
    const gapChange = Math.abs(endGap) - Math.abs(startGap);
    const gapMagnitude = magnitudeReading(gapChange, unit, digits);
    const endMagnitude = magnitudeReading(endGap, unit, digits);
    const reversed = startGap !== 0 && endGap !== 0 && Math.sign(startGap) !== Math.sign(endGap);
    const gapStory = reversed
      ? "高低位置互换"
      : gapMagnitude === null
        ? "差距基本不变"
        : gapChange > 0
          ? `差距（不计正负）扩大 ${gapMagnitude}`
          : `差距（不计正负）缩小 ${gapMagnitude}`;
    return (
      <div key={second}>
        <span>与对比国家 {scopeLabel(second, industry)}</span>
        <b>{lastYear} 年 {countryLabel(first)} {endGap === 0 ? "与它持平" : endMagnitude === null ? "与它基本持平" : `比它${endGap > 0 ? "高" : "低"} ${endMagnitude}`}</b>
        <small>{firstYear}→{lastYear} {gapStory}；比较的是差距绝对值，不代表因果关系</small>
      </div>
    );
  });
  return (
    <>
    <CardGrid label="趋势读数">
      <div>
        <span>{scopeLabel(first, industry)} · {metricLabel ? `${metricLabel} · ` : ""}{firstYear}→{lastYear}</span>
        {/* The change at the decimals of the two readings under it ("+1 百万美元" beside "10 → 11", not "+0.577"),
            as the median card does. */}
        <b>{changeReading(start, end, unit, digits ?? Math.max(...[start, end].map((value) => smallAmountDigits(value, unit) ?? readingDigits(value, unit))))}</b>
        {/* An exact zero end reads "0" ("0 → 0.00039"), not "0.00000" at a tiny-value precision. */}
        <small>{start === 0 && end === 0 ? indicatorNumber(0, unit) : [start, end].map((value) => (value === 0 ? indicatorNumber(0, unit) : fixedIndicatorNumber(value, unit, digits ?? smallAmountDigits(value, unit)))).join(" → ")}</small>
      </div>
      {startRef && endRef && [startRef, endRef].some((ref) => ref.noOutput?.includes(first)) && (
        <div>
          <span>{sameIndustry ? "在全部经济体的同一行业中" : "在全部经济体中"}（从高到低）</span>
          <b>{NO_OUTPUT}</b>
          <small>{`${[...new Set([startRef, endRef].filter((ref) => ref.noOutput?.includes(first)).map((ref) => ref.year))].join("、")} 年该行业在 ${countryLabel(first)}没有产出，读数 0 不代表排名靠后`}</small>
        </div>
      )}
      {startRank != null && endRank != null && startRef && endRef && (() => {
        const from = rankText(startRank, startRef.ties?.[first], startRef.n);
        const to = rankText(endRank, endRef.ties?.[first], endRef.n);
        // 并列 only when some, not all, economies share the reading; an all-equal year has no rank at all.
        const tied = [from, to].some((text) => text?.startsWith("并列"));
        return (
          <div>
            <span>{sameIndustry ? "在全部经济体的同一行业中" : "在全部经济体中"}（从高到低）</span>
            <b>{!from && !to ? "全部经济体数值相同"
              : from && to && !tied ? `第 ${startRank} → ${endRank} 位`
              : `${from ?? NO_RANK} → ${to ?? NO_RANK}`}</b>
            <small>{from || to
              ? `共 ${endRef.n} 个经济体；排名只表示相对高低${tied ? "；并列表示数值相同" : ""}${from && to ? "" : `；${NO_RANK_NOTE}`}`
              : "所有经济体数值相同，排名没有比较意义"}</small>
          </div>
        );
      })()}
      {startRef && endRef && (
        <div>
          <span>{sameIndustry ? "同行业全球中位数" : "全球中位数"} · {firstYear}→{lastYear}</span>
          {/* The change at the decimals of the two medians under it ("+1" beside "3,528 → 3,529", not "+1.000"). */}
          <b>{changeReading(startRef.median, endRef.median, unit, Math.max(...[startRef.median, endRef.median].map((value) => smallAmountDigits(value, unit) ?? readingDigits(value, unit))))}</b>
          <small>{fixedIndicatorNumber(startRef.median, unit, smallAmountDigits(startRef.median, unit))} → {fixedIndicatorNumber(endRef.median, unit, smallAmountDigits(endRef.median, unit))}</small>
        </div>
      )}
      {gapCards}
    </CardGrid>
    <p className="muted trend-rounding-note" role="note">{CHANGE_ROUNDING_NOTE}</p>
    </>
  );
}

export function ComparisonSummary({
  readings,
  countries,
  years,
  unit,
  gapNote = "比较差距绝对值，不代表因果关系",
  digits,
  countryDigits,
}: {
  readings: ComparisonReading[];
  countries: string[];
  years: number[];
  unit: string;
  /** Caption under the gap card; the tariff chart on step 10 explains the gap instead of hedging it. */
  gapNote?: string;
  /** Overrides the shared reading precision (step 10: X to two decimals of a percentage point). */
  digits?: number;
  /** A country's own cards at its own precision (step 10: as its X = w × τ line reads); the gap keeps `digits`. */
  countryDigits?: Record<string, number>;
}) {
  if (countries.length !== 2) return null;
  const common = years.filter((year) =>
    countries.every((country) =>
      readings.some(
        (item) =>
          item.country === country && item.year === year && item.value !== null,
      ),
    ),
  );
  if (common.length < 2) {
    return <p className="muted">共同有效年份不足，暂不比较两国的期间变化。</p>;
  }
  const firstYear = common[0];
  const lastYear = common.at(-1)!;
  const value = (country: string, year: number) =>
    readings.find((item) => item.country === country && item.year === year)!
      .value!;
  const starts = countries.map((country) => value(country, firstYear));
  const ends = countries.map((country) => value(country, lastYear));
  // Each country's value as its card shows it: the gap cards read from these, so the two gaps agree with each other
  // and with the cards ("−0.00111" twice, not −0.00111 beside 0.00115 from the unrounded values).
  const shown = (values: number[], index: number) => {
    const places = countryDigits?.[countries[index]];
    // Rounded where the card rounds it: a "%" card shows the share × 100.
    const factor = unit === "%" ? 100 : 1;
    return places == null ? values[index] : Number((values[index] * factor).toFixed(places)) / factor;
  };
  const startGap = shown(starts, 0) - shown(starts, 1);
  const endGap = shown(ends, 0) - shown(ends, 1);
  const gapChange = Math.abs(endGap) - Math.abs(startGap);
  const gapMagnitude = magnitudeReading(gapChange, unit, digits);
  const reversed = startGap !== 0 && endGap !== 0 && Math.sign(startGap) !== Math.sign(endGap);
  // Two equal values at both ends (step 10: both X = 0) have no gap at all, not an unchanged one. Equal only as
  // shown (0.347 and 0.353 both read 0.35) is not "no gap": it reads as about unchanged below.
  const gapStory = starts[0] === starts[1] && ends[0] === ends[1]
    ? "差距为 0"
    : reversed
    ? "高低位置互换"
    : gapMagnitude === null
      ? "差距基本不变"
      : gapChange > 0
        ? `差距（不计正负）扩大 ${gapMagnitude}`
        : `差距（不计正负）缩小 ${gapMagnitude}`;
  const shownEnd = (index: number) => shown(ends, index);
  return (
    <div className="comparison-summary" role="group" aria-label="两国趋势结论">
      {countries.map((country, index) => (
        <div key={country}>
          <span>{countryLabel(country)} · {firstYear}→{lastYear}</span>
          <b>{changeReading(starts[index], ends[index], unit, countryDigits?.[country] ?? digits)}</b>
          {/* An exact zero reads "0" (step 10: X before the tariff), so a card's "0.0000" and the other's "0.00" do
              not look like two different zeros. */}
          <small>{starts[index] === 0 ? "0" : fixedIndicatorNumber(starts[index], unit, countryDigits?.[country] ?? digits)} → {ends[index] === 0 ? "0" : fixedIndicatorNumber(ends[index], unit, countryDigits?.[country] ?? digits)}</small>
        </div>
      ))}
      <div>
        <span>{lastYear} 年两国之差</span>
        {/* From the two values as their cards show them, so the difference checks by hand (1.845 − 5.82 = −3.975). */}
        <b>{changeReading(shownEnd(1), shownEnd(0), unit, digits)}</b>
        <small>{countryLabel(countries[0])} 相对 {countryLabel(countries[1])}</small>
      </div>
      <div>
        <span>{firstYear}→{lastYear} 两国差距</span>
        <b>{gapStory}</b>
        <small>{gapNote}</small>
      </div>
    </div>
  );
}

/**
 * One country's trend in global context: the median and middle 50% of all economies sit behind the
 * observed country's line; the comparison country is a thinner dashed line. Zero and negatives included.
 */
export function IndicatorTrendChart({
  rows,
  countries,
  years,
  metric,
  label,
  unit,
  distribution = [],
  mode = "pair",
  sameIndustry = false,
  markYear,
  stepped = false,
  countryDigits,
  gapNote,
  digits,
  emptyReading,
  emptyStatus,
  reasonFor,
  industry,
  cards = true,
}: {
  /** Pair mode: the per-country and gap cards under the chart (step 10's exchange-rate chart has none). */
  cards?: boolean;
  /** Context mode: the industry the rows belong to, named on the observed country's card. */
  industry?: string;
  /** Replaces "缺失" in the readout where a value is undefined rather than missing (step 9: no outgoing links). */
  emptyReading?: (country: string, year: number) => string | null;
  /** The whole clause the trend cards give for an undefined reading (see TrendSummary). */
  reasonFor?: (country: string, year: number) => string | null;
  /** Replaces the "no valid readings" message when every value is undefined rather than missing (and says why). */
  emptyStatus?: string;
  rows: Row[];
  countries: string[];
  years: number[];
  metric: string;
  label: string;
  unit: string;
  /** Country-level spread across all economies; empty for industry-level views. */
  distribution?: YearDistribution[];
  /** "context": observed country first, global reference, comparison country last (steps 6–8).
   *  "pair": two equal partners with the original two-country cards (step 10). */
  mode?: "context" | "pair";
  /** Step 9: the reference is the same industry in every economy. */
  sameIndustry?: boolean;
  /** Step 10: a dashed line just before this year, e.g. the year the simulated tariff starts. */
  /** One marked year, or several (two tariff waves): later labels sit low, clear of the earlier jump. */
  markYear?: { year: number; label: string } | { year: number; label: string }[];
  /** Step 10: annual values that jump in one year are drawn as steps, changing halfway between two years, where
   *  the `markYear` line sits (between the years, as on steps 11–14). */
  stepped?: boolean;
  /** Pair mode only: caption under the gap card. */
  gapNote?: string;
  /** Overrides the shared reading precision for readouts and cards (step 10: X to two decimals). */
  digits?: number;
  /** Per-country precision for that country's readout and card (pair mode); see {@link ComparisonSummary}. */
  countryDigits?: Record<string, number>;
}) {
  const context = mode === "context";
  const { wrapRef, Tip, show, showNear, hide } = useHoverTip();
  const [activeYear, setActiveYear] = useState<number | null>(null);
  const [focusSeries, setFocusSeries] = useState<string | null>(null);
  const series = countries.map((country) =>
    years.map((year) => {
      const value = rows.find(
        (row) => row.country === country && row.year === year,
      )?.[metric];
      return { year, value: finiteValue(value) ? value : null };
    }),
  );
  const band = !context ? [] : years.flatMap((year) => {
    const item = distribution.find((entry) => entry.year === year);
    return item ? [item] : [];
  });
  const values = [
    ...series.flatMap((points) =>
      points.flatMap((point) => (point.value === null ? [] : [point.value])),
    ),
    ...band.flatMap((item) => [item.p25, item.p75]),
  ];
  if (!series.some((points) => points.some((point) => point.value !== null)))
    return <p role="status">{emptyStatus ?? "该指标没有有效读数，请更换国家、行业或年份。"}</p>;
  // Shares and amounts keep a zero baseline; lengths (always ≥ 1) and position ratios fit their range,
  // otherwise a band around 4 production stages collapses into a sliver. Position ratios keep 1 in view.
  const positionRatio = metric === "GVCPs" || metric === "Pos_TPL";
  // Step 10 passes X already in percentage points ("个百分点"): zero-based like a share.
  const zeroBased = unit === "%" || unit === "个百分点" || unit === "百万美元";
  const rawHigh = zeroBased ? Math.max(0, ...values) : Math.max(...values, positionRatio ? 1 : -Infinity);
  const rawLow = zeroBased ? Math.min(0, ...values) : Math.min(...values, positionRatio ? 1 : Infinity);
  // An all-zero share series (e.g. an untaxed country's X) gets a small 0–1% axis, not 0–100%.
  const allZero = rawLow === 0 && rawHigh === 0;
  // Link counts and path lengths (step 9) read as whole numbers, so their ticks sit on integers only.
  const domain = unit === "连接数" || unit === "路径长度" ? integerDomain : niceDomain;
  // Any other all-zero series (step 9 加权总度 of T, an industry with no flows) reads a single 0 tick: quarter ticks
  // (0.25, 0.5…) would suggest amounts the data never take.
  const axis = allZero && unit !== "%" && unit !== "个百分点"
    ? { lo: 0, hi: 1, ticks: [0] }
    : domain(rawLow, allZero && unit === "%" ? 0.01 : allZero && unit === "个百分点" ? 1 : rawHigh);
  const lo = axis.lo;
  const extent = axis.hi - lo || 1;
  const y = (value: number) => 250 - ((value - lo) / extent) * 210;
  // A single year sits in the middle of the plot instead of at its left edge.
  const x = (year: number) => years.length < 2
    ? 110 + 310
    : 110 + ((year - years[0]) / Math.max(1, years.at(-1)! - years[0])) * 620;
  const readings = countries.flatMap((country, index) =>
    series[index].map((point) => ({ country, ...point })),
  );
  // A reference far below the selected countries (step 9 加权总度 of CHN·C26) lies on the 0 line: say so, the
  // readouts below still give the median and the middle 50%.
  const referenceFlat = band.length >= 2 && lo === 0
    && Math.max(...band.map((item) => item.p75)) < 0.02 * extent
    && values.some((value) => value >= 0.5 * extent);
  // Split by the requested year slots, exactly like the country series: absent references are gaps.
  const bandRuns: typeof band[] = [];
  years.forEach((year, index) => {
    const item = band.find((entry) => entry.year === year);
    if (!item) return;
    if (index === 0 || !band.some((entry) => entry.year === years[index - 1])) bandRuns.push([]);
    bandRuns.at(-1)!.push(item);
  });
  // The legend is HTML so five economies plus the reference wrap instead of running off the svg.
  const legend: { key: string; label: string; draw: React.ReactNode; country?: string }[] = [
    ...(band.length > 0 ? [
      { key: "band", label: "中间 50% 经济体", draw: <svg width={24} height={12} aria-hidden="true"><rect x={0} y={0} width={24} height={12} fill={REFERENCE_FILL} fillOpacity={0.3} /></svg> },
      { key: "median", label: `${sameIndustry ? "同行业全球中位数" : "全球中位数"}（${band.at(-1)!.n} 个经济体）`, draw: <svg width={24} height={12} aria-hidden="true"><line x1={0} x2={24} y1={6} y2={6} stroke={REFERENCE_LINE} strokeWidth={1.5} strokeDasharray="4 3" /></svg> },
    ] : []),
    ...countries.map((country, index) => ({
      key: country,
      country,
      label: index && context ? `${countryLabel(country)}（对比）` : countryLabel(country),
      draw: <svg width={24} height={12} aria-hidden="true">
        <line x1={0} x2={24} y1={6} y2={6} stroke={CAT[index]} strokeWidth={context && index ? 2 : context ? 3 : 2.5} strokeDasharray={index ? "7 4" : undefined} />
        <circle cx={12} cy={6} r={context && index ? 3.5 : 4} fill={CAT[index]} />
      </svg>,
    })),
  ];
  const referenceLabel = sameIndustry ? "同行业全球中位数" : "全球中位数";
  /** One readout for every series at a year: values lead, the series name follows. */
  const linesFor = (year: number): TipLine[] => {
    const reference = band.find((entry) => entry.year === year);
    return [
      // The unit once, in the heading ("2020 年 · 百万美元"): shares carry their own "%".
      ["", `${year} 年${unit && unit !== "%" && unit !== "无量纲" ? ` · ${unit}` : ""}`],
      ...countries.map((country, index): TipLine => [
        index && context ? `${countryLabel(country)}（对比）` : countryLabel(country),
        (() => {
          const value = series[index].find((point) => point.year === year)?.value ?? null;
          return value === null ? emptyReading?.(country, year) ?? indicatorNumber(null, unit) : indicatorNumber(value, unit, countryDigits?.[country] ?? digits);
        })(),
        CAT[index],
        // Keys match the drawn lines: comparison countries and the median are dashed.
        index > 0,
      ]),
      ...(reference ? [
        [referenceLabel, indicatorNumber(reference.median, unit), REFERENCE_LINE, true] as TipLine,
        ["中间 50%", `${indicatorNumber(reference.p25, unit)}–${indicatorNumber(reference.p75, unit)}`] as TipLine,
      ] : []),
    ];
  };
  const clearActive = () => { setActiveYear(null); hide(); };
  // The crosshair snaps to the nearest year: each year owns the horizontal band between its neighbours.
  const hitBounds = (index: number): [number, number] => [
    index === 0 ? 110 : (x(years[index - 1]) + x(years[index])) / 2,
    index === years.length - 1 ? 730 : (x(years[index]) + x(years[index + 1])) / 2,
  ];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = activeYear === null ? -1 : years.indexOf(activeYear);
    let next: number | undefined;
    if (event.key === "ArrowRight") next = years[Math.min(years.length - 1, index + 1)];
    else if (event.key === "ArrowLeft") next = years[index < 0 ? years.length - 1 : Math.max(0, index - 1)];
    else if (event.key === "Home") next = years[0];
    else if (event.key === "End") next = years[years.length - 1];
    else if (event.key === "Escape") { clearActive(); return; }
    if (next === undefined) return;
    event.preventDefault();
    setActiveYear(next);
    // Beside the year being read, not under the whole chart (where the fixed step footer could cover it).
    showNear(event.currentTarget.querySelector(`rect[data-year="${next}"]`) ?? event.currentTarget, linesFor(next));
  };
  const dim = (country: string) => (focusSeries && focusSeries !== country ? 0.25 : 1);
  return (
    <section aria-label={`${label}趋势图`}>
      <h4>
        {label} · {unitText(unit)}
      </h4>
      <div className="trend-legend" style={{ justifyContent: context ? "flex-start" : "flex-end" }}>
        {legend.map((item) => (
          <span
            key={`legend-${item.key}`}
            data-legend={item.country}
            style={item.country ? { cursor: "pointer" } : undefined}
            onMouseEnter={item.country ? () => setFocusSeries(item.country!) : undefined}
            onMouseLeave={item.country ? () => setFocusSeries(null) : undefined}
          >
            {item.draw}
            {item.label}
          </span>
        ))}
      </div>
      <div
        ref={wrapRef}
        className="hover-wrap chart-focus"
        role="group"
        tabIndex={0}
        aria-label={`${label}历年变化图；按左右方向键逐年读数，Esc 关闭`}
        onKeyDown={onKeyDown}
        onBlur={clearActive}
        onMouseLeave={clearActive}
      >
      <svg
        viewBox="0 30 780 265"
        role="img"
        aria-label={`${label}历年变化${band.length > 0 ? "，含全部经济体的中位数与中间 50% 范围" : ""}；缺少的数据留空，详细读数见下方`}
        // Capped so the 780-unit viewBox is not blown up on wide screens: past ~880px its 12-unit tick text
        // rendered larger than the page text (about 23px at 1066px wide).
        style={{ width: "100%", maxWidth: 880, display: "block" }}
      >
        {axis.ticks.map((tick) => (
          <g key={tick}>
            <line x1={110} x2={730} y1={y(tick)} y2={y(tick)} stroke="#e2e5ee" />
            <text x={100} y={y(tick) + 4} textAnchor="end" fontSize={12} fill="#596173">
              {indicatorTick(tick, unit, axis.ticks)}
            </text>
          </g>
        ))}
        {bandRuns.map((run) => run.length === 1 ? (
          <g key={run[0].year} data-reference-year={run[0].year}>
            <line x1={x(run[0].year)} x2={x(run[0].year)} y1={y(run[0].p25)} y2={y(run[0].p75)} stroke={REFERENCE_FILL} strokeWidth={8} strokeOpacity={0.22} />
            <circle cx={x(run[0].year)} cy={y(run[0].median)} r={3} fill={REFERENCE_LINE} />
          </g>
        ) : <g key={run[0].year}>
          <path data-reference-band d={`M${run.map((item) => `${x(item.year)},${y(item.p75)}`).join(" L")} L${[...run].reverse().map((item) => `${x(item.year)},${y(item.p25)}`).join(" L")} Z`} fill={REFERENCE_FILL} fillOpacity={0.22} stroke="none" />
          <polyline
            data-series="global-median"
            points={run.map((item) => `${x(item.year)},${y(item.median)}`).join(" ")}
            fill="none"
            stroke={REFERENCE_LINE}
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        </g>)}
        {(metric === "GVCPs" || metric === "Pos_TPL") && (
          <g>
            <line x1={110} x2={730} y1={y(1)} y2={y(1)} stroke="#966500" strokeDasharray="6 4">
              <title>等于 1：前向与后向一样长</title>
            </line>
            {/* Ratios hover around 1, so a label on the line would cover the data; it sits in the right margin. */}
            <text x={737} y={y(1) + 4} fontSize={11} fill="#966500">
              等长
            </text>
          </g>
        )}
        {years.map((year) => (
          <text key={year} x={x(year)} y={278} textAnchor="middle" fontSize={12}>
            {year}
          </text>
        ))}
        {[...series.keys()].reverse().map((index) => (
          <g
            key={countries[index]}
            data-series-group={countries[index]}
            opacity={dim(countries[index])}
            onMouseEnter={() => setFocusSeries(countries[index])}
            onMouseLeave={() => setFocusSeries(null)}
          >
            {series[index].map((point, i) =>
              point.value === null ? null : (
                <g key={point.year}>
                  {i > 0 && series[index][i - 1].value !== null && stepped && (
                    <polyline
                      data-series={countries[index]}
                      // Held until the new year, where the policy line sits (on the tariff's year, as on every chart
                      // of steps 10–14), then the new value. A comparison country's riser sits a few px to the
                      // right, so the first country's riser (same x, drawn on top) does not hide it.
                      points={(() => {
                        const prev = series[index][i - 1];
                        const riser = x(point.year) + index * 5;
                        return `${x(prev.year)},${y(prev.value!)} ${riser},${y(prev.value!)} ${riser},${y(point.value)} ${x(point.year)},${y(point.value)}`;
                      })()}
                      fill="none"
                      stroke={CAT[index]}
                      strokeWidth={context && index ? 2 : context ? 3 : 2.5}
                      strokeDasharray={index ? "7 4" : undefined}
                    />
                  )}
                  {i > 0 && series[index][i - 1].value !== null && !stepped && (
                    <line
                      data-series={countries[index]}
                      x1={x(series[index][i - 1].year)}
                      y1={y(series[index][i - 1].value!)}
                      x2={x(point.year)}
                      y2={y(point.value)}
                      stroke={CAT[index]}
                      strokeWidth={context && index ? 2 : context ? 3 : 2.5}
                      strokeDasharray={index ? "7 4" : undefined}
                    />
                  )}
                  <circle
                    cx={x(point.year)}
                    cy={y(point.value)}
                    r={(context && index ? 3.5 : context ? 4.5 : 4) + (point.year === activeYear ? 2.5 : 0)}
                    fill={CAT[index]}
                    stroke={point.year === activeYear ? "#fff" : undefined}
                    strokeWidth={point.year === activeYear ? 2 : undefined}
                  />
                </g>
              ),
            )}
          </g>
        ))}
        {(Array.isArray(markYear) ? markYear : markYear ? [markYear] : [])
          .filter((mark) => years.includes(mark.year) && mark.year > years[0])
          .map((mark, index) => {
            // A plain line chart (the exchange rate) puts the label at the top, clear of the lines; when a point sits
            // under it there (COL's 2019 high), at the bottom instead.
            const right = x(mark.year) - 10, left = right - mark.label.length * 12;
            const top = 48 + index * 16;
            const covered = series.some((points) => points.some((point) => point.value !== null
              && x(point.year) >= left - 6 && x(point.year) <= right + 16 && Math.abs(y(point.value) - (top - 4)) < 14));
            const labelY = stepped ? (index === 0 ? 149 : 228) : covered ? 240 - index * 16 : top;
            return (
              <g key={mark.year} data-mark-year={mark.year} pointerEvents="none">
                {/* On the tariff's year, as every chart of steps 10–14 marks it (a stepped series rises there). The
                    label is drawn after the series, with a white outline, so it stays readable. */}
                <line x1={x(mark.year)} x2={x(mark.year)} y1={34} y2={250} stroke="#4b5563" strokeDasharray="5 4" />
                <text x={right} y={labelY} textAnchor="end" fontSize={12} fill="#374151"
                  stroke="#fff" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke">{mark.label}</text>
              </g>
            );
          })}
        {activeYear !== null && (
          <line data-crosshair x1={x(activeYear)} x2={x(activeYear)} y1={40} y2={252} stroke="#1b1f2b" strokeDasharray="3 3" pointerEvents="none" />
        )}
        {years.map((year, index) => {
          const [left, right] = hitBounds(index);
          return (
            <rect
              key={`hit-${year}`}
              data-year={year}
              x={left}
              y={40}
              width={Math.max(1, right - left)}
              height={215}
              fill="transparent"
              onMouseMove={(event) => { setActiveYear(year); show(event, linesFor(year)); }}
            />
          );
        })}
      </svg>
      {Tip}
      </div>
      {referenceFlat && (
        <p className="muted" role="note" data-reference-flat>
          {referenceLabel}与中间 50% 远小于所选国家，图中贴近 0；中位数见下方读数，中间 50% 的范围悬停可读。
        </p>
      )}
      {context
        ? <TrendSummary readings={readings} countries={countries} years={years} unit={unit} distribution={band} sameIndustry={sameIndustry} digits={digits} industry={industry} reasonFor={reasonFor} />
        : cards && <ComparisonSummary
          readings={readings}
          countries={countries}
          years={years.filter((_, i) => series.every((points) => points[i].value !== null))}
          unit={unit}
          gapNote={gapNote}
          digits={digits}
          countryDigits={countryDigits}
        />}
    </section>
  );
}

/** Rough width of a 12px bold label: CJK characters are square, Latin digits and letters about half. */
const stripLabelWidth = (text: string) => [...text].reduce((width, ch) => width + (ch.charCodeAt(0) >= 0x2e80 ? 12 : 7), 0);

/**
 * Place each highlighted country's label under its own dot without a leader line landing on the other
 * label: centred when they are apart, otherwise the left label ends at its dot and the right one starts
 * at its dot on the same row; only when even that collides do they go on two rows.
 */
export function layoutStripLabels<T extends { px: number; text: string }>(points: T[]) {
  // 12 units clear of each edge, so a focused label's ring (2px outline + 2px offset) is not cut by the SVG.
  const clamp = (left: number, width: number) => Math.min(788 - width, Math.max(12, left));
  const laid = points.map((point) => {
    const width = stripLabelWidth(point.text);
    return { ...point, width, labelX: clamp(point.px - width / 2, width), row: 0 };
  });
  if (laid.length > 2) return layoutManyStripLabels(laid, clamp);
  if (laid.length !== 2) return laid;
  const [left, right] = [...laid].sort((a, b) => a.px - b.px);
  const gap = 10;
  if (left.labelX + left.width + gap <= right.labelX) return laid;
  left.labelX = clamp(left.px - left.width, left.width);
  right.labelX = clamp(right.px, right.width);
  if (left.labelX + left.width + gap <= right.labelX) return laid;
  // Two rows: the lower label's leader must pass the upper label, so drop whichever one's dot lies outside it.
  const crosses = (dot: number, label: { labelX: number; width: number }) => dot >= label.labelX - 2 && dot <= label.labelX + label.width + 2;
  if (crosses(right.px, left) && !crosses(left.px, right)) left.row = 1;
  else right.row = 1;
  return laid;
}

/**
 * Three or more labels (at most five countries): an exact search for the fewest rows. Each label sits
 * centred under its dot, ending at it or starting at it; on one row labels may not overlap, and no
 * label may lie across another country's leader line (a leader runs from its dot down to its own row,
 * so it passes every row above that). Rows grow as needed; the strip's height follows the last row.
 */
function layoutManyStripLabels<T extends { px: number; width: number; labelX: number; row: number }>(
  laid: T[],
  clamp: (left: number, width: number) => number,
) {
  const gap = 10;
  const covers = (label: { labelX: number; width: number }, dot: number) => dot >= label.labelX - 2 && dot <= label.labelX + label.width + 2;
  const sorted = [...laid].sort((a, b) => a.px - b.px);
  // Outermost first: they constrain the most and anchor the search.
  const order: T[] = [];
  for (let lo = 0, hi = sorted.length - 1; lo <= hi; lo += 1, hi -= 1) {
    order.push(sorted[lo]);
    if (hi !== lo) order.push(sorted[hi]);
  }
  const candidates = order.map((point) => [...new Set([point.px - point.width / 2, point.px - point.width, point.px]
    .map((left) => clamp(left, point.width)))]);
  type Slot = { row: number; labelX: number; width: number; px: number };
  const compatible = (a: Slot, b: Slot) => a.row === b.row
    ? a.labelX + a.width + gap <= b.labelX || b.labelX + b.width + gap <= a.labelX
    : a.row < b.row ? !covers(a, b.px) : !covers(b, a.px);
  const chosen: Slot[] = [];
  const search = (index: number, rows: number): boolean => {
    if (index === order.length) return true;
    const point = order[index];
    for (let row = 0; row < rows; row += 1) {
      for (const labelX of candidates[index]) {
        const slot = { row, labelX, width: point.width, px: point.px };
        if (!chosen.every((other) => compatible(slot, other))) continue;
        chosen.push(slot);
        if (search(index + 1, rows)) return true;
        chosen.pop();
      }
    }
    return false;
  };
  // The exact search is exponential in the number of labels; the steps allow five countries. Beyond that
  // (never in the course) the staircase keeps the layout instant.
  if (order.length > 5) return staircaseStripLabels(laid, sorted, clamp);
  for (let rows = 1; rows <= order.length; rows += 1) {
    chosen.length = 0;
    if (search(0, rows)) {
      order.forEach((point, index) => { point.row = chosen[index].row; point.labelX = chosen[index].labelX; });
      return laid;
    }
  }
  // Only dots a few pixels apart can make every layout touch a leader; a staircase keeps it readable.
  return staircaseStripLabels(laid, sorted, clamp);
}

/**
 * Fallback when crowded dots leave no free slot: one label per row. A leader runs from its dot down to its
 * own row, so a label must lie below every label whose dot it covers; the rows follow that order (labels
 * stay centred under their dot where they fit). Only two labels that each cover the other's dot (dots a
 * few pixels apart) can still touch a leader, and then the one further left goes lower.
 */
function staircaseStripLabels<T extends { px: number; width: number; labelX: number; row: number }>(
  laid: T[],
  sorted: T[],
  clamp: (left: number, width: number) => number,
) {
  const covers = (labelX: number, width: number, dot: number) => dot >= labelX - 2 && dot <= labelX + width + 2;
  const remaining = [...sorted];
  let row = 0;
  while (remaining.length) {
    // Next row: a label (centred, starting or ending at its dot) that covers no other remaining dot, whose
    // leaders all end above it; failing that, the leftmost label centred.
    let next: { point: T; labelX: number } | null = null;
    for (const point of remaining) {
      const spots = [point.px - point.width / 2, point.px, point.px - point.width].map((left) => clamp(left, point.width));
      const free = spots.find((labelX) => !remaining.some((other) => other !== point && covers(labelX, point.width, other.px)));
      if (free !== undefined) { next = { point, labelX: free }; break; }
    }
    next ??= { point: remaining[0], labelX: clamp(remaining[0].px - remaining[0].width / 2, remaining[0].width) };
    next.point.row = row;
    next.point.labelX = next.labelX;
    row += 1;
    remaining.splice(remaining.indexOf(next.point), 1);
  }
  return laid;
}

/**
 * Every economy as a dot for one year, so the observed and comparison countries are read against the
 * whole sample: the shaded band is the middle 50%, the dashed line the median. Overlapping dots stack.
 */
export function DistributionStrip({
  rows,
  metric,
  unit,
  label,
  year,
  highlight,
  distribution,
}: {
  rows: Row[];
  metric: string;
  unit: string;
  label: string;
  year: number;
  highlight: string[];
  distribution: YearDistribution;
}) {
  const { wrapRef, Tip, show, showFor, hide } = useHoverTip();
  const [hovered, setHovered] = useState<string | null>(null);
  const points = rows
    .filter((row) => row.year === year && !row.industry && row.country !== "ROW" && finiteValue(row[metric]))
    .map((row) => ({ country: String(row.country), value: row[metric] as number }))
    .sort((a, b) => a.value - b.value);
  // Amounts carry their unit in every reading (shares show "%"; dimensionless values need none).
  const reading = (value: number) => `${indicatorNumber(value, unit)}${unit === "百万美元" ? " 百万美元" : ""}`;
  const zeroBased = unit === "%" || unit === "百万美元";
  const valuesOnAxis = points.map((point) => point.value);
  const low = zeroBased ? Math.min(0, ...valuesOnAxis) : Math.min(...valuesOnAxis);
  const high = zeroBased ? Math.max(0, ...valuesOnAxis) : Math.max(...valuesOnAxis);
  // A negative value within 2% of the range (e.g. −0.8 against millions) would otherwise cost a whole tick
  // step below zero; it is drawn at the zero edge instead (its reading still shows the true value).
  const tinyNegative = zeroBased && low < 0 && high > 0 && -low < 0.02 * high;
  const axis = niceDomain(tinyNegative ? 0 : low, high);
  const extent = axis.hi - axis.lo || 1;
  const x = (value: number) => 60 + ((Math.min(axis.hi, Math.max(axis.lo, value)) - axis.lo) / extent) * 680;
  // Stack dots that would overlap into lanes above the axis. Skewed amounts (most economies near zero)
  // would otherwise grow a column dozens of dots tall, so lanes are capped and extra dots overlap.
  const MAX_LANES = 8;
  const laneEnds: number[] = [];
  const placed = points.map((point) => {
    const px = x(point.value);
    let lane = laneEnds.findIndex((end) => end < px - 9);
    if (lane < 0 && laneEnds.length < MAX_LANES) lane = laneEnds.push(px) - 1;
    else if (lane < 0) lane = laneEnds.indexOf(Math.min(...laneEnds));
    laneEnds[lane] = px;
    return { ...point, px, lane };
  });
  const lanes = Math.max(1, laneEnds.length);
  const base = 70 + lanes * 9;
  const cy = (lane: number) => base - 8 - lane * 9;
  // Laid out once per data change, not on every hover (the label search re-ran on each mouse move).
  const marked = useMemo(() => layoutStripLabels(highlight.flatMap((country, index) => {
    const point = placed.find((item) => item.country === country);
    return point ? [{ ...point, index, text: `${countryLabel(country)} ${reading(point.value)} · ${rankText(distribution.ranks[country], distribution.ties?.[country], distribution.n) ?? NO_RANK}` }] : [];
  })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, metric, year, unit, highlight.join(","), distribution]);
  // Room for two label rows as before; more rows (three or more countries) extend the strip.
  const height = base + 60 + Math.max(0, Math.max(0, ...marked.map((point) => point.row)) - 1) * 14;
  const linesFor = (country: string, value: number): TipLine[] => [
    ["", countryLabel(country)],
    [label, reading(value)],
    ["名次（从高到低）", rankText(distribution.ranks[country], distribution.ties?.[country], distribution.n) ?? NO_RANK],
  ];
  return (
    <section aria-label={`${year} 年${label}全球分布`}>
      <h4>{year} 年 · {label}在全部经济体中的位置</h4>
      <div ref={wrapRef} className="hover-wrap" onMouseLeave={() => { setHovered(null); hide(); }}>
      <svg
        viewBox={`0 0 800 ${height}`}
        role="img"
        aria-label={`${year} 年${label}的全部 ${distribution.n} 个经济体分布；${marked.map((item) => `${countryLabel(item.country)} ${reading(item.value)}，${rankText(distribution.ranks[item.country], distribution.ties?.[item.country], distribution.n) ?? `${NO_RANK}（全部经济体数值相同）`}`).join("；")}；全球中位数 ${reading(distribution.median)}`}
        style={{ width: "100%", display: "block" }}
      >
        <rect x={x(distribution.p25)} y={30} width={Math.max(1, x(distribution.p75) - x(distribution.p25))} height={base - 30} fill={REFERENCE_FILL} fillOpacity={0.2} />
        <line x1={x(distribution.median)} x2={x(distribution.median)} y1={24} y2={base} stroke={REFERENCE_LINE} strokeWidth={1.5} strokeDasharray="4 3" />
        <text x={x(distribution.median)} y={18} textAnchor="middle" fontSize={11} fill={REFERENCE_LINE}>
          中位数 {reading(distribution.median)}
        </text>
        <line x1={60} x2={740} y1={base} y2={base} stroke="#c7ccd8" />
        {axis.ticks.map((tick) => (
          <text key={tick} x={x(tick)} y={base + 18} textAnchor="middle" fontSize={11} fill="#596173">{indicatorTick(tick, unit, axis.ticks)}</text>
        ))}
        {placed.map((point) => highlight.includes(point.country) ? null : (
          <g
            key={point.country}
            data-hit={point.country}
            onMouseMove={(event) => { setHovered(point.country); show(event, linesFor(point.country, point.value)); }}
          >
            {/* The hit area is larger than the dot, so a reader only has to be close. */}
            <circle cx={point.px} cy={cy(point.lane)} r={9} fill="transparent" />
            <circle
              cx={point.px}
              cy={cy(point.lane)}
              r={hovered === point.country ? 5.5 : 3.6}
              fill={hovered === point.country ? "#4b5263" : "#8b93a6"}
              fillOpacity={hovered === point.country ? 1 : 0.55}
              stroke={hovered === point.country ? "#fff" : "none"}
              strokeWidth={1.5}
              pointerEvents="none"
            />
          </g>
        ))}
        {/* Left to right in the DOM, so Tab reads the marked economies in the order they are drawn. */}
        {[...marked].sort((a, b) => a.px - b.px).map((point) => (
          <g
            key={point.country}
            data-hit={point.country}
            tabIndex={0}
            role="graphics-symbol"
            aria-label={point.text}
            onMouseMove={(event) => { setHovered(point.country); show(event, linesFor(point.country, point.value)); }}
            onFocus={(event) => showFor(event.currentTarget, linesFor(point.country, point.value))}
            onBlur={hide}
          >
            <circle cx={point.px} cy={cy(point.lane)} r={11} fill="transparent" />
            <line x1={point.px} x2={point.px} y1={cy(point.lane)} y2={base + 26 + point.row * 14} stroke={CAT[point.index]} strokeWidth={1} />
            <circle cx={point.px} cy={cy(point.lane)} r={hovered === point.country ? 7.5 : 6} fill={CAT[point.index]} stroke="#fff" strokeWidth={1.5} />
            <text
              x={point.labelX}
              y={base + 38 + point.row * 14}
              textAnchor="start"
              fontSize={12}
              fontWeight={700}
              fill={CAT_TEXT[point.index]}
              stroke="#fff"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {point.text}
            </text>
          </g>
        ))}
      </svg>
      {Tip}
      </div>
      <p className="muted">
        每个点是一个经济体（共 {distribution.n} 个），灰色带是中间 50% 的经济体，虚线是中位数；排名从高到低，只表示相对高低。
      </p>
    </section>
  );
}

export function LengthPositionTrajectory({
  rows,
  countries,
  years,
  cloud = [],
  cloudYear,
}: {
  rows: Row[];
  countries: string[];
  years: number[];
  /** Every economy's country-level lengths in `cloudYear`, drawn as grey points behind the trajectories. */
  cloud?: Row[];
  cloudYear?: number;
}) {
  const { wrapRef, Tip, show, showFor, hide } = useHoverTip();
  const [active, setActive] = useState<string | null>(null);
  const [focusSeries, setFocusSeries] = useState<string | null>(null);
  const series = countries.map((country) =>
    years.flatMap((year, yearIndex) => {
      const row = rows.find(
        (item) => item.country === country && item.year === year,
      );
      return finiteValue(row?.PLy_GVC) && finiteValue(row?.PLv_GVC)
        ? [{ year, yearIndex, x: row.PLy_GVC, y: row.PLv_GVC }]
        : [];
    }),
  );
  const cloudPoints = cloud
    .filter((row) => !row.industry && row.country !== "ROW" && !countries.includes(String(row.country)) && finiteValue(row.PLy_GVC) && finiteValue(row.PLv_GVC))
    .map((row) => ({ country: String(row.country), x: row.PLy_GVC as number, y: row.PLv_GVC as number }));
  // The axes fit the selected trajectories, not the whole cloud: fitted to every economy, the selected
  // paths (which move by hundredths) collapsed into one corner. Cloud points outside the range are left out.
  const values = series.flatMap((points) => points.flatMap((point) => [point.x, point.y]));
  if (!series.some((points) => points.length)) return null;
  // Lengths cluster around 2–5 stages and move by hundredths a year: a zero-based axis collapses every
  // trajectory into one dot. Both axes share one range fitted to the data, so the 45° line keeps its meaning.
  const low = Math.min(...values);
  const high = Math.max(...values);
  const pad = Math.max((high - low) * 0.15, 0.02);
  const axis = niceDomain(low - pad, high + pad);
  const lo = axis.lo;
  const extent = axis.hi - lo || 1;
  const scale = (value: number) => ((value - lo) / extent) * 540;
  const x = (value: number) => 120 + scale(value);
  const y = (value: number) => 590 - scale(value);
  const inRange = (value: number) => value >= lo && value <= axis.hi;
  const shownCloud = cloudPoints.filter((point) => inRange(point.x) && inRange(point.y));
  const stage = (value: number) => indicatorNumber(value, "生产阶段");
  const linesFor = (country: string, point: { year: number; x: number; y: number }): TipLine[] => [
    ["", `${countryLabel(country)} · ${point.year}`],
    ["后向 GVC 段长度", stage(point.x)],
    ["前向 GVC 段长度", stage(point.y)],
    ["GVC 位置指数（前向／后向）", (point.y / point.x).toLocaleString("zh-CN", { maximumFractionDigits: 3 })],
  ];
  const dim = (country: string) => (focusSeries && focusSeries !== country ? 0.25 : 1);
  return (
    <section aria-label="前后向 GVC 段长度位置轨迹">
      <h4>前向与后向 GVC 段长度的历年轨迹</h4>
      <p className="muted">
        横轴是后向 GVC 段长度，纵轴是前向 GVC 段长度；每条线从较早年份（空心点）连到较晚年份（实心点）。等长线上方表示前向段相对更长。
      </p>
      {/* The legend sits above the plot in HTML: drawn inside the SVG, its third and later rows ran into the plot. */}
      <div className="trajectory-legend" style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", fontSize: 12, color: "#374151", margin: "4px 0 6px" }}>
        {series.map((points, index) => (
          <span
            key={`legend-${countries[index]}`}
            data-legend={countries[index]}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", opacity: dim(countries[index]) }}
            onMouseEnter={() => setFocusSeries(countries[index])}
            onMouseLeave={() => setFocusSeries(null)}
          >
            <svg width={30} height={10} aria-hidden="true"><line x1={0} x2={24} y1={5} y2={5} stroke={CAT[index]} strokeWidth={2.5} /><circle cx={25} cy={5} r={4} fill={CAT[index]} /></svg>
            {countryLabel(countries[index])}{points.length ? ` · ${points[0].year}→${points.at(-1)!.year}` : " · 无轨迹"}
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#596173" }}>
          <svg width={12} height={12} aria-hidden="true"><circle cx={6} cy={6} r={4.5} fill="white" stroke="#596173" strokeWidth={2} /></svg>起点
          <svg width={12} height={12} aria-hidden="true"><circle cx={6} cy={6} r={4.5} fill="#596173" /></svg>终点
        </span>
        {shownCloud.length > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#596173" }}>
            <svg width={8} height={8} aria-hidden="true"><circle cx={4} cy={4} r={3} fill="#9aa3b5" fillOpacity={0.55} /></svg>{cloudYear} 年落在坐标范围内的其他经济体
          </span>
        )}
      </div>
      {/* A legend entry with no line needs a reason (ISL B09: every backward length is undefined). */}
      {series.some((points) => !points.length) && (
        <p className="muted" role="note">
          {joinCountries(countries.filter((_, index) => !series[index].length))}没有轨迹：轨迹需要同一年的前向和后向 GVC 段长度都有读数，原因见下方说明。
        </p>
      )}
      <div ref={wrapRef} className="hover-wrap" onMouseLeave={() => { setActive(null); hide(); }}>
      <svg
        viewBox="0 0 720 650"
        role="img"
        aria-label={`前向与后向 GVC 段长度历年轨迹，${joinCountries(countries)}`}
        style={{ width: "100%", maxWidth: 680, display: "block", margin: "0 auto" }}
      >
        {axis.ticks.map((tickValue) => {
          return <g key={tickValue}>
            <line x1={120} x2={660} y1={y(tickValue)} y2={y(tickValue)} stroke="#e2e5ee" />
            <line x1={x(tickValue)} x2={x(tickValue)} y1={50} y2={590} stroke="#e2e5ee" />
            <text x={110} y={y(tickValue) + 4} textAnchor="end" fontSize={12}>{indicatorTick(tickValue, "生产阶段", axis.ticks)}</text>
            <text x={x(tickValue)} y={615} textAnchor="middle" fontSize={12}>{indicatorTick(tickValue, "生产阶段", axis.ticks)}</text>
          </g>;
        })}
        {shownCloud.map((point) => (
          <g key={`cloud-${point.country}`} data-cloud={point.country}
            onMouseMove={(event) => { setActive(null); show(event, linesFor(point.country, { year: cloudYear ?? 0, x: point.x, y: point.y }).map((line, at) => (at === 0 && cloudYear == null ? ["", countryLabel(point.country)] : line))); }}
            onMouseLeave={hide}>
            <circle cx={x(point.x)} cy={y(point.y)} r={7} fill="transparent" />
            <circle cx={x(point.x)} cy={y(point.y)} r={3} fill="#9aa3b5" fillOpacity={0.55} />
          </g>
        ))}
        <line x1={x(lo)} y1={y(lo)} x2={x(axis.hi)} y2={y(axis.hi)} stroke="#8a6415" strokeDasharray="6 4" />
        {/* The label ends left of where the dashed line crosses its baseline (the line runs up to the right), so the
            closing bracket never touches the line. */}
        <text x={Math.min(650, x(axis.hi) - 18 * (x(axis.hi) - x(lo)) / Math.max(1, y(lo) - y(axis.hi)) - 6)} y={y(axis.hi) + 18} textAnchor="end" fontSize={11}>等长线（前向 = 后向）</text>
        <text x={390} y={642} textAnchor="middle" fontSize={12}>后向 GVC 段长度</text>
        <text x={66} y={320} textAnchor="middle" fontSize={12} transform="rotate(-90 66 320)">前向 GVC 段长度</text>
        {/* Country A is drawn last (SVG paints in document order), so the comparison trails never hide it. */}
        {series.map((points, countryIndex) => ({ points, countryIndex })).reverse().map(({ points, countryIndex }) => (
          <g
            key={countries[countryIndex]}
            data-series-group={countries[countryIndex]}
            opacity={dim(countries[countryIndex])}
            onMouseEnter={() => setFocusSeries(countries[countryIndex])}
            onMouseLeave={() => setFocusSeries(null)}
          >
            {points.map((point, index) => {
              const next = points[index + 1];
              const connectsToNext = next?.yearIndex === point.yearIndex + 1;
              const endpoint = index === 0 || index === points.length - 1;
              const key = `${countries[countryIndex]}:${point.year}`;
              const lines = linesFor(countries[countryIndex], point);
              return <g key={point.year}>
                {connectsToNext && <line data-series={countries[countryIndex]} x1={x(point.x)} y1={y(point.y)} x2={x(next.x)} y2={y(next.y)} stroke={CAT[countryIndex]} strokeWidth={2.5} />}
                <g
                  data-hit={key}
                  tabIndex={endpoint ? 0 : undefined}
                  role={endpoint ? "graphics-symbol" : undefined}
                  aria-label={endpoint ? `${lines[0][1]}：后向 ${stage(point.x)}，前向 ${stage(point.y)}` : undefined}
                  onMouseMove={(event) => { setActive(key); show(event, lines); }}
                  onFocus={endpoint ? (event) => { setActive(key); showFor(event.currentTarget, lines); } : undefined}
                  onBlur={endpoint ? () => { setActive(null); hide(); } : undefined}
                >
                  <circle cx={x(point.x)} cy={y(point.y)} r={12} fill="transparent" />
                  <circle
                    cx={x(point.x)}
                    cy={y(point.y)}
                    r={(endpoint ? 5 : 3.5) + (active === key ? 2.5 : 0)}
                    fill={index === 0 ? "white" : CAT[countryIndex]}
                    stroke={active === key ? "#1b1f2b" : CAT[countryIndex]}
                    strokeWidth={index === 0 || active === key ? 2.5 : 1}
                  />
                </g>
              </g>;
            })}
          </g>
        ))}
      </svg>
      {Tip}
      </div>
    </section>
  );
}

export function IndicatorPairBars({
  groups,
  countries,
  unit,
  onPick,
}: {
  /** `reasons[i]` replaces "缺失" for a value that is undefined rather than missing ("无法计算"). */
  groups: { key: string; label: string; values: (number | null)[]; reasons?: (string | null)[] }[];
  countries: string[];
  unit: string;
  onPick?: (key: string) => void;
}) {
  const { wrapRef, Tip, show, showFor, hide } = useHoverTip();
  const [hovered, setHovered] = useState<string | null>(null);
  const reading = (group: { values: (number | null)[]; reasons?: (string | null)[] }, index: number) =>
    group.values[index] === null && group.reasons?.[index] ? group.reasons[index]! : textNumber(group.values[index], unit);
  const linesFor = (group: { label: string; values: (number | null)[]; reasons?: (string | null)[] }): TipLine[] => [
    ["", group.label],
    ...group.values.map((_, index): TipLine => [countryLabel(countries[index]), reading(group, index), CAT[index]]),
  ];
  const values = groups.flatMap((group) => group.values.filter(finiteValue));
  const lo = Math.min(0, ...values),
    hi = Math.max(0, ...values),
    extent = hi - lo || 1;
  const zero = (-lo / extent) * 100;
  // The name column fits the longest selected name on one line ("HKG 中国香港", "IDN 印度尼西亚"), the same width in
  // every row so the bars still line up; a fixed 84px wrapped the longer names onto two lines.
  const nameWidth = `${Math.max(5, ...countries.map(labelEm)) + 0.5}em`;
  return (
    <div aria-label="同刻度比较条形图" role="region" className="hover-wrap" ref={wrapRef}>
      {groups.map((group) => (
        <div
          key={group.key}
          className="pair-bar-group"
          data-hovered={hovered === group.key ? "true" : undefined}
          tabIndex={0}
          role="group"
          aria-label={group.label}
          onMouseMove={(event) => { setHovered(group.key); show(event, linesFor(group)); }}
          onMouseLeave={() => { setHovered(null); hide(); }}
          onFocus={(event) => { setHovered(group.key); showFor(event.currentTarget, linesFor(group)); }}
          onBlur={() => { setHovered(null); hide(); }}
        >
          {onPick ? (
            <button className="secondary" onClick={() => onPick(group.key)}>
              查看 {group.label} 的历年变化 →
            </button>
          ) : (
            <b>{group.label}</b>
          )}
          {group.values.map((value, i) => (
            <div
              key={countries[i]}
              style={{
                display: "grid",
                gridTemplateColumns: `${nameWidth} minmax(80px, 1fr) 130px`,
                gap: 10,
                alignItems: "center",
                paddingTop: 7,
              }}
            >
              <span style={{ whiteSpace: "nowrap" }}>{countryLabel(countries[i])}</span>
              <div
                style={{
                  position: "relative",
                  height: 18,
                  background: "#f0f3f8",
                }}
                aria-hidden="true"
              >
                <span
                  style={{
                    position: "absolute",
                    left: `${zero}%`,
                    borderLeft: "1px solid #566173",
                    height: "100%",
                  }}
                />
                {value !== null && (
                  <span
                    style={{
                      position: "absolute",
                      left: `${((Math.min(0, value) - lo) / extent) * 100}%`,
                      width: `${(Math.abs(value) / extent) * 100}%`,
                      height: "100%",
                      background: CAT[i],
                      border: i ? "1px dashed #145840" : undefined,
                    }}
                  />
                )}
              </div>
              <span
                style={{
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {reading(group, i)}
              </span>
            </div>
          ))}
        </div>
      ))}
      <p className="muted">单位：{unitText(unit)}。各国从同一个 0 起画，负值画在左边，缺少或无法计算的数据留空。</p>
      {Tip}
    </div>
  );
}
