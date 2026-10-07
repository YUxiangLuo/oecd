import { useMemo, useState, type KeyboardEvent } from "react";
import { countryLabel } from "../../../viz";
import { useHoverTip, type TipLine } from "../../../viz/hover";
import { CAT } from "../../../viz/shared";
import { changeReading, finiteValue, NO_RANK, NO_RANK_NOTE, rankText, readingDigits, type YearDistribution } from "./indicator-model";
import { niceDomain } from "../../../viz/nice-ticks";
import { stripNegativeZero } from "../../../format";
import type { Row } from "./scaffold";

/** Axis ticks: round values, trailing zeros trimmed ("10%", "1.5"). */
export const indicatorTick = (value: number | null, unit: string) =>
  value === null
    ? "缺失"
    : stripNegativeZero(`${(unit === "%" ? value * 100 : value).toLocaleString("zh-CN", { maximumFractionDigits: readingDigits(value, unit) })}${unit === "%" ? "%" : ""}`);

/** Readings in labels, tables and tooltips keep fixed decimals, so values side by side line up
 * ("11.730%" next to "15.613%", not "11.73%"); an exact zero reads "0". */
export const indicatorNumber = (value: number | null, unit: string) =>
  value === 0 ? `0${unit === "%" ? "%" : ""}` : fixedIndicatorNumber(value, unit);

/** Card readings keep the same decimals on both ends ("11.556% → 11.730%"); hover readouts stay trimmed. */
export const fixedIndicatorNumber = (value: number | null, unit: string) =>
  value === null
    ? "缺失"
    // A tiny negative that rounds to zero reads "0.000", not "-0.000".
    : stripNegativeZero(`${(unit === "%" ? value * 100 : value).toLocaleString("zh-CN", { minimumFractionDigits: readingDigits(value, unit), maximumFractionDigits: readingDigits(value, unit) })}${unit === "%" ? "%" : ""}`);

/** Size of a gap or its change as displayed, or null when it rounds to zero (so it never reads “差距扩大 0”). */
const magnitudeReading = (value: number, unit: string) => {
  const reading = changeReading(0, Math.abs(value), unit).replace("+", "");
  return /^0(\.0+)?( |$)/.test(reading) ? null : reading;
};

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
}: {
  readings: ComparisonReading[];
  countries: string[];
  years: number[];
  unit: string;
  distribution?: YearDistribution[];
  /** Step 9: the reference is the same industry in every economy. */
  sameIndustry?: boolean;
}) {
  const value = (country: string, year: number) =>
    readings.find((item) => item.country === country && item.year === year)?.value ?? null;
  const [first, ...others] = countries;
  const own = years.filter((year) => value(first, year) !== null);
  if (own.length < 2) {
    return <p className="muted">有效年份不足，暂不能读出期间变化。</p>;
  }
  const firstYear = own[0];
  const lastYear = own.at(-1)!;
  const start = value(first, firstYear)!;
  const end = value(first, lastYear)!;
  const startRef = distribution.find((item) => item.year === firstYear);
  const endRef = distribution.find((item) => item.year === lastYear);
  const startRank = startRef?.ranks[first];
  const endRank = endRef?.ranks[first];
  const gapCards = others.map((second) => {
    if (value(second, firstYear) === null || value(second, lastYear) === null) {
      return (
        <div key={second}>
          <span>与对比国家 {countryLabel(second)}</span>
          <b>期间读数不完整</b>
          <small>{firstYear} 或 {lastYear} 年缺失，暂不比较差距（缺失不补零）</small>
        </div>
      );
    }
    const startGap = start - value(second, firstYear)!;
    const endGap = end - value(second, lastYear)!;
    const gapChange = Math.abs(endGap) - Math.abs(startGap);
    const gapMagnitude = magnitudeReading(gapChange, unit);
    const endMagnitude = magnitudeReading(endGap, unit);
    const reversed = startGap !== 0 && endGap !== 0 && Math.sign(startGap) !== Math.sign(endGap);
    const gapStory = reversed
      ? "领先方反转"
      : gapMagnitude === null
        ? "差距基本不变"
        : gapChange > 0
          ? `差距扩大 ${gapMagnitude}`
          : `差距缩小 ${gapMagnitude}`;
    return (
      <div key={second}>
        <span>与对比国家 {countryLabel(second)}</span>
        <b>{lastYear} 年 {countryLabel(first)} {endGap === 0 ? "与它持平" : endMagnitude === null ? "与它基本持平" : `比它${endGap > 0 ? "高" : "低"} ${endMagnitude}`}</b>
        <small>{firstYear}→{lastYear} {gapStory}；比较的是差距绝对值，不代表因果关系</small>
      </div>
    );
  });
  return (
    <div className="comparison-summary" role="group" aria-label="趋势读数">
      <div>
        <span>{countryLabel(first)} · {firstYear}→{lastYear}</span>
        <b>{changeReading(start, end, unit)}</b>
        <small>{fixedIndicatorNumber(start, unit)} → {fixedIndicatorNumber(end, unit)}</small>
      </div>
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
          <b>{changeReading(startRef.median, endRef.median, unit)}</b>
          <small>{fixedIndicatorNumber(startRef.median, unit)} → {fixedIndicatorNumber(endRef.median, unit)}</small>
        </div>
      )}
      {gapCards}
    </div>
  );
}

export function ComparisonSummary({
  readings,
  countries,
  years,
  unit,
  gapNote = "比较差距绝对值，不代表因果关系",
}: {
  readings: ComparisonReading[];
  countries: string[];
  years: number[];
  unit: string;
  /** Caption under the gap card; the tariff chart on step 10 explains the gap instead of hedging it. */
  gapNote?: string;
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
  const startGap = starts[0] - starts[1];
  const endGap = ends[0] - ends[1];
  const gapChange = Math.abs(endGap) - Math.abs(startGap);
  const gapMagnitude = magnitudeReading(gapChange, unit);
  const reversed = startGap !== 0 && endGap !== 0 && Math.sign(startGap) !== Math.sign(endGap);
  const gapStory = reversed
    ? "领先方反转"
    : gapMagnitude === null
      ? "差距基本不变"
      : gapChange > 0
        ? `差距扩大 ${gapMagnitude}`
        : `差距缩小 ${gapMagnitude}`;
  return (
    <div className="comparison-summary" role="group" aria-label="两国趋势结论">
      {countries.map((country, index) => (
        <div key={country}>
          <span>{countryLabel(country)} · {firstYear}→{lastYear}</span>
          <b>{changeReading(starts[index], ends[index], unit)}</b>
          <small>{fixedIndicatorNumber(starts[index], unit)} → {fixedIndicatorNumber(ends[index], unit)}</small>
        </div>
      ))}
      <div>
        <span>{lastYear} 年 A−B</span>
        <b>{changeReading(ends[1], ends[0], unit)}</b>
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
  gapNote,
}: {
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
  markYear?: { year: number; label: string };
  /** Pair mode only: caption under the gap card. */
  gapNote?: string;
}) {
  const context = mode === "context";
  const { wrapRef, Tip, show, showFor, hide } = useHoverTip();
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
    return <p role="status">该指标没有有效读数，请更换国家、行业或年份。</p>;
  // Shares and amounts keep a zero baseline; lengths (always ≥ 1) and position ratios fit their range,
  // otherwise a band around 4 production stages collapses into a sliver. Position ratios keep 1 in view.
  const positionRatio = metric === "GVCPs" || metric === "Pos_TPL";
  const zeroBased = unit === "%" || unit === "百万美元";
  const axis = niceDomain(
    zeroBased ? Math.min(0, ...values) : Math.min(...values, positionRatio ? 1 : Infinity),
    zeroBased ? Math.max(0, ...values) : Math.max(...values, positionRatio ? 1 : -Infinity),
  );
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
  const bandPath = band.length >= 2
    ? `M${band.map((item) => `${x(item.year)},${y(item.p75)}`).join(" L")} L${[...band].reverse().map((item) => `${x(item.year)},${y(item.p25)}`).join(" L")} Z`
    : "";
  // The legend is HTML so five economies plus the reference wrap instead of running off the svg.
  const legend: { key: string; label: string; draw: React.ReactNode; country?: string }[] = [
    ...(band.length >= 2 ? [
      { key: "band", label: "中间 50% 经济体", draw: <svg width={24} height={12} aria-hidden="true"><rect x={0} y={0} width={24} height={12} fill={REFERENCE_FILL} fillOpacity={0.3} /></svg> },
      { key: "median", label: `${sameIndustry ? "同行业全球中位数" : "全球中位数"}（${band.at(-1)!.n} 个）`, draw: <svg width={24} height={12} aria-hidden="true"><line x1={0} x2={24} y1={6} y2={6} stroke={REFERENCE_LINE} strokeWidth={1.5} strokeDasharray="4 3" /></svg> },
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
      ["", `${year} 年`],
      ...countries.map((country, index): TipLine => [
        index && context ? `${countryLabel(country)}（对比）` : countryLabel(country),
        indicatorNumber(series[index].find((point) => point.year === year)?.value ?? null, unit),
        CAT[index],
      ]),
      ...(reference ? [[referenceLabel, indicatorNumber(reference.median, unit), REFERENCE_LINE] as TipLine] : []),
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
    showFor(event.currentTarget, linesFor(next));
  };
  const dim = (country: string) => (focusSeries && focusSeries !== country ? 0.25 : 1);
  return (
    <section aria-label={`${label}趋势图`}>
      <h4>
        {label} · {unit}
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
        aria-label={`${label}历年变化${band.length >= 2 ? "，含全部经济体的中位数与中间 50% 范围" : ""}；缺失不补零，详细读数见下方`}
        style={{ width: "100%", display: "block" }}
      >
        {axis.ticks.map((tick) => (
          <g key={tick}>
            <line x1={110} x2={730} y1={y(tick)} y2={y(tick)} stroke="#e2e5ee" />
            <text x={100} y={y(tick) + 4} textAnchor="end" fontSize={12} fill="#596173">
              {indicatorTick(tick, unit)}
            </text>
          </g>
        ))}
        {markYear && years.includes(markYear.year) && markYear.year > years[0] && (
          <g data-mark-year={markYear.year}>
            <line x1={x(markYear.year - 0.5)} x2={x(markYear.year - 0.5)} y1={34} y2={250} stroke="#4b5563" strokeDasharray="5 4" />
            <text x={x(markYear.year - 0.5) + 6} y={46} fontSize={12} fill="#374151">{markYear.label}</text>
          </g>
        )}
        {bandPath && <path d={bandPath} fill={REFERENCE_FILL} fillOpacity={0.22} stroke="none" />}
        {band.length >= 2 && (
          <polyline
            data-series="global-median"
            points={band.map((item) => `${x(item.year)},${y(item.median)}`).join(" ")}
            fill="none"
            stroke={REFERENCE_LINE}
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        )}
        {(metric === "GVCPs" || metric === "Pos_TPL") && (
          <g>
            <line x1={110} x2={730} y1={y(1)} y2={y(1)} stroke="#966500" strokeDasharray="6 4">
              <title>位置基准 = 1</title>
            </line>
            {/* Ratios hover around 1, so a label on the line would cover the data; it sits in the right margin. */}
            <text x={737} y={y(1) + 4} fontSize={11} fill="#966500">
              基准 1
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
                  {i > 0 && series[index][i - 1].value !== null && (
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
      {context
        ? <TrendSummary readings={readings} countries={countries} years={years} unit={unit} distribution={band} sameIndustry={sameIndustry} />
        : <ComparisonSummary
          readings={readings}
          countries={countries}
          years={years.filter((_, i) => series.every((points) => points[i].value !== null))}
          unit={unit}
          gapNote={gapNote}
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
  const clamp = (left: number, width: number) => Math.min(796 - width, Math.max(4, left));
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
 * Fallback when crowded dots leave no free slot: a staircase. Left-half labels end at their dot and
 * right-half labels start at theirs; the outermost dots take row 0 and each step inwards takes the next
 * row, so an inner leader always ends below the outer labels it passes and never crosses them.
 */
function staircaseStripLabels<T extends { px: number; width: number; labelX: number; row: number }>(
  laid: T[],
  sorted: T[],
  clamp: (left: number, width: number) => number,
) {
  const half = Math.floor(sorted.length / 2);
  sorted.forEach((point, index) => {
    const fromLeft = index < half || (index === half && sorted.length % 2 === 1);
    point.row = fromLeft ? index : sorted.length - 1 - index;
    point.labelX = clamp(fromLeft ? point.px - point.width : point.px, point.width);
  });
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
  const reading = (value: number) => indicatorNumber(value, unit);
  const zeroBased = unit === "%" || unit === "百万美元";
  const valuesOnAxis = points.map((point) => point.value);
  const axis = niceDomain(
    zeroBased ? Math.min(0, ...valuesOnAxis) : Math.min(...valuesOnAxis),
    zeroBased ? Math.max(0, ...valuesOnAxis) : Math.max(...valuesOnAxis),
  );
  const extent = axis.hi - axis.lo || 1;
  const x = (value: number) => 60 + ((value - axis.lo) / extent) * 680;
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
          <text key={tick} x={x(tick)} y={base + 18} textAnchor="middle" fontSize={11} fill="#596173">{indicatorTick(tick, unit)}</text>
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
        {marked.map((point) => (
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
              fill={CAT[point.index]}
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
      <h4>前向—后向位置轨迹 · 时间与国家对照</h4>
      <p className="muted">
        横轴是后向 GVC 段长度，纵轴是前向 GVC 段长度；箭头从较早年份指向较晚年份。等长线上方表示前向段相对更长。
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
            <svg width={30} height={10} aria-hidden="true"><line x1={0} x2={20} y1={5} y2={5} stroke={CAT[index]} strokeWidth={2.5} /><path d="M20,1 L28,5 L20,9 z" fill={CAT[index]} /></svg>
            {countryLabel(countries[index])}{points.length ? ` · ${points[0].year}→${points.at(-1)!.year}` : ""}
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
      <div ref={wrapRef} className="hover-wrap" onMouseLeave={() => { setActive(null); hide(); }}>
      <svg
        viewBox="0 0 720 650"
        role="img"
        aria-label={`前向与后向 GVC 段长度历年轨迹，${countries.map(countryLabel).join("与")}`}
        style={{ width: "100%", maxWidth: 680, display: "block", margin: "0 auto" }}
      >
        <defs>
          {countries.map((country, index) => (
            <marker key={country} id={`length-arrow-${index}`} markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="8" refX="11" refY="4" orient="auto" viewBox="0 0 12 8">
              <path d="M0,0 L8,4 L0,8 z" fill={CAT[index]} />
            </marker>
          ))}
        </defs>
        {axis.ticks.map((tickValue) => {
          return <g key={tickValue}>
            <line x1={120} x2={660} y1={y(tickValue)} y2={y(tickValue)} stroke="#e2e5ee" />
            <line x1={x(tickValue)} x2={x(tickValue)} y1={50} y2={590} stroke="#e2e5ee" />
            <text x={110} y={y(tickValue) + 4} textAnchor="end" fontSize={12}>{indicatorTick(tickValue, "生产阶段")}</text>
            <text x={x(tickValue)} y={615} textAnchor="middle" fontSize={12}>{indicatorTick(tickValue, "生产阶段")}</text>
          </g>;
        })}
        {shownCloud.map((point) => (
          <g key={`cloud-${point.country}`} data-cloud={point.country}
            onMouseMove={(event) => { setActive(null); show(event, [["", `${countryLabel(point.country)} · ${cloudYear ?? ""}`], ["后向 GVC 段长度", stage(point.x)], ["前向 GVC 段长度", stage(point.y)]]); }}
            onMouseLeave={hide}>
            <circle cx={x(point.x)} cy={y(point.y)} r={7} fill="transparent" />
            <circle cx={x(point.x)} cy={y(point.y)} r={3} fill="#9aa3b5" fillOpacity={0.55} />
          </g>
        ))}
        <line x1={x(lo)} y1={y(lo)} x2={x(axis.hi)} y2={y(axis.hi)} stroke="#8a6415" strokeDasharray="6 4" />
        <text x={650} y={y(axis.hi) + 18} textAnchor="end" fontSize={11}>前向 = 后向</text>
        <text x={390} y={642} textAnchor="middle" fontSize={12}>后向 GVC 段长度</text>
        <text x={18} y={320} textAnchor="middle" fontSize={12} transform="rotate(-90 18 320)">前向 GVC 段长度</text>
        {series.map((points, countryIndex) => (
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
                {connectsToNext && <line data-series={countries[countryIndex]} x1={x(point.x)} y1={y(point.y)} x2={x(next.x)} y2={y(next.y)} stroke={CAT[countryIndex]} strokeWidth={2.5} markerEnd={index === points.length - 2 ? `url(#length-arrow-${countryIndex})` : undefined} />}
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
  groups: { key: string; label: string; values: (number | null)[] }[];
  countries: string[];
  unit: string;
  onPick?: (key: string) => void;
}) {
  const { wrapRef, Tip, show, showFor, hide } = useHoverTip();
  const [hovered, setHovered] = useState<string | null>(null);
  const linesFor = (group: { label: string; values: (number | null)[] }): TipLine[] => [
    ["", group.label],
    ...group.values.map((value, index): TipLine => [countryLabel(countries[index]), indicatorNumber(value, unit), CAT[index]]),
  ];
  const values = groups.flatMap((group) => group.values.filter(finiteValue));
  const lo = Math.min(0, ...values),
    hi = Math.max(0, ...values),
    extent = hi - lo || 1;
  const zero = (-lo / extent) * 100;
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
                gridTemplateColumns: "50px minmax(80px, 1fr) 130px",
                gap: 10,
                alignItems: "center",
                paddingTop: 7,
              }}
            >
              <span>{countries[i]}</span>
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
                {indicatorNumber(value, unit)}
              </span>
            </div>
          ))}
        </div>
      ))}
      <p className="muted">单位：{unit}；共同零轴，负值向左，缺失值不补零。</p>
      {Tip}
    </div>
  );
}
