import { countryLabel } from "../../../viz";
import { CAT } from "../../../viz/shared";
import { changeReading, finiteValue, readingDigits, type YearDistribution } from "./indicator-model";
import { niceDomain } from "../../../viz/nice-ticks";
import type { Row } from "./scaffold";

export const indicatorNumber = (value: number | null, unit: string) =>
  value === null
    ? "缺失"
    : `${(unit === "%" ? value * 100 : value).toLocaleString("zh-CN", { maximumFractionDigits: readingDigits(value, unit) })}${unit === "%" ? "%" : ""}`;

/** Size of a gap or its change as displayed, or null when it rounds to zero (so it never reads “差距扩大 0”). */
const magnitudeReading = (value: number, unit: string) => {
  const reading = changeReading(0, Math.abs(value), unit).replace("+", "");
  return /^0( |$)/.test(reading) ? null : reading;
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
  const [first, second] = countries;
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
  const pair = second != null
    && value(second, firstYear) !== null && value(second, lastYear) !== null;
  let gapCard = null;
  if (pair) {
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
    gapCard = (
      <div>
        <span>与对比国家 {countryLabel(second)}</span>
        <b>{lastYear} 年 {countryLabel(first)} {endGap === 0 ? "与它持平" : endMagnitude === null ? "与它基本持平" : `比它${endGap > 0 ? "高" : "低"} ${endMagnitude}`}</b>
        <small>{firstYear}→{lastYear} {gapStory}；比较的是差距绝对值，不代表因果关系</small>
      </div>
    );
  }
  return (
    <div className="comparison-summary" role="group" aria-label="趋势读数">
      <div>
        <span>{countryLabel(first)} · {firstYear}→{lastYear}</span>
        <b>{changeReading(start, end, unit)}</b>
        <small>{indicatorNumber(start, unit)} → {indicatorNumber(end, unit)}</small>
      </div>
      {startRank != null && endRank != null && endRef && (
        <div>
          <span>{sameIndustry ? "在全部经济体的同一行业中" : "在全部经济体中"}（从高到低）</span>
          <b>第 {startRank} → {endRank} 位</b>
          <small>共 {endRef.n} 个经济体；排名只表示相对高低</small>
        </div>
      )}
      {startRef && endRef && (
        <div>
          <span>{sameIndustry ? "同行业全球中位数" : "全球中位数"} · {firstYear}→{lastYear}</span>
          <b>{changeReading(startRef.median, endRef.median, unit)}</b>
          <small>{indicatorNumber(startRef.median, unit)} → {indicatorNumber(endRef.median, unit)}</small>
        </div>
      )}
      {gapCard}
    </div>
  );
}

export function ComparisonSummary({
  readings,
  countries,
  years,
  unit,
}: {
  readings: ComparisonReading[];
  countries: string[];
  years: number[];
  unit: string;
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
          <small>{indicatorNumber(starts[index], unit)} → {indicatorNumber(ends[index], unit)}</small>
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
        <small>比较差距绝对值，不代表因果关系</small>
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
}) {
  const context = mode === "context";
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
  const x = (year: number) =>
    110 + ((year - years[0]) / Math.max(1, years.at(-1)! - years[0])) * 620;
  const readings = countries.flatMap((country, index) =>
    series[index].map((point) => ({ country, ...point })),
  );
  const bandPath = band.length >= 2
    ? `M${band.map((item) => `${x(item.year)},${y(item.p75)}`).join(" L")} L${[...band].reverse().map((item) => `${x(item.year)},${y(item.p25)}`).join(" L")} Z`
    : "";
  const legend = [
    ...(band.length ? [
      { key: "band", label: "中间 50% 经济体", draw: <rect x={0} y={-6} width={24} height={12} fill={REFERENCE_FILL} fillOpacity={0.3} /> },
      { key: "median", label: `${sameIndustry ? "同行业全球中位数" : "全球中位数"}（${band.at(-1)!.n} 个）`, draw: <line x1={0} x2={24} y1={0} y2={0} stroke={REFERENCE_LINE} strokeWidth={1.5} strokeDasharray="4 3" /> },
    ] : []),
    ...countries.map((country, index) => ({
      key: country,
      label: index && context ? `${countryLabel(country)}（对比）` : countryLabel(country),
      draw: <>
        <line x1={0} x2={24} y1={0} y2={0} stroke={CAT[index]} strokeWidth={context && index ? 2 : context ? 3 : 2.5} strokeDasharray={index ? "7 4" : undefined} />
        <circle cx={12} cy={0} r={context && index ? 3.5 : 4} fill={CAT[index]} />
      </>,
    })),
  ];
  // Steps 6–8 read left to right from the reference; step 10's two equal partners keep the legend on the right.
  let legendX = context ? 110 : 455;
  return (
    <section aria-label={`${label}趋势图`}>
      <h4>
        {label} · {unit}
      </h4>
      <svg
        viewBox="0 0 780 295"
        role="img"
        aria-label={`${label}历年变化${band.length ? "，含全部经济体的中位数与中间 50% 范围" : ""}；缺失不补零，详细读数见下方`}
        style={{ width: "100%", display: "block" }}
      >
        {legend.map((item) => {
          const at = legendX;
          legendX += 40 + item.label.length * 12;
          return (
            <g key={`legend-${item.key}`} transform={`translate(${at} 14)`}>
              {item.draw}
              <text x={31} y={4} fontSize={12} fill="#374151">{item.label}</text>
            </g>
          );
        })}
        {axis.ticks.map((tick) => (
          <g key={tick}>
            <line x1={110} x2={730} y1={y(tick)} y2={y(tick)} stroke="#e2e5ee" />
            <text x={100} y={y(tick) + 4} textAnchor="end" fontSize={12} fill="#596173">
              {indicatorNumber(tick, unit)}
            </text>
          </g>
        ))}
        {bandPath && <path d={bandPath} fill={REFERENCE_FILL} fillOpacity={0.22} stroke="none" />}
        {band.length >= 2 && (
          <polyline
            data-series="global-median"
            points={band.map((item) => `${x(item.year)},${y(item.median)}`).join(" ")}
            fill="none"
            stroke={REFERENCE_LINE}
            strokeWidth={1.5}
            strokeDasharray="4 3"
          >
            <title>{band.map((item) => `${item.year} 年全球中位数 ${indicatorNumber(item.median, unit)}`).join("；")}</title>
          </polyline>
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
          <g key={countries[index]}>
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
                  <circle cx={x(point.year)} cy={y(point.value)} r={context && index ? 3.5 : context ? 4.5 : 4} fill={CAT[index]}>
                    <title>{`${countryLabel(countries[index])} · ${point.year}：${indicatorNumber(point.value, unit)}`}</title>
                  </circle>
                </g>
              ),
            )}
          </g>
        ))}
      </svg>
      {context
        ? <TrendSummary readings={readings} countries={countries} years={years} unit={unit} distribution={band} sameIndustry={sameIndustry} />
        : <ComparisonSummary
          readings={readings}
          countries={countries}
          years={years.filter((_, i) => series.every((points) => points[i].value !== null))}
          unit={unit}
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
  if (laid.length !== 2) return laid.map((point, row) => ({ ...point, row }));
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
  const height = base + 60;
  const cy = (lane: number) => base - 8 - lane * 9;
  const marked = layoutStripLabels(highlight.flatMap((country, index) => {
    const point = placed.find((item) => item.country === country);
    return point ? [{ ...point, index, text: `${countryLabel(country)} ${reading(point.value)} · 第 ${distribution.ranks[country]} 位` }] : [];
  }));
  return (
    <section aria-label={`${year} 年${label}全球分布`}>
      <h4>{year} 年 · {label}在全部经济体中的位置</h4>
      <svg
        viewBox={`0 0 800 ${height}`}
        role="img"
        aria-label={`${year} 年${label}的全部 ${distribution.n} 个经济体分布；${marked.map((item) => `${countryLabel(item.country)} ${reading(item.value)}，第 ${distribution.ranks[item.country]} 位`).join("；")}；全球中位数 ${reading(distribution.median)}`}
        style={{ width: "100%", display: "block" }}
      >
        <rect x={x(distribution.p25)} y={30} width={Math.max(1, x(distribution.p75) - x(distribution.p25))} height={base - 30} fill={REFERENCE_FILL} fillOpacity={0.2} />
        <line x1={x(distribution.median)} x2={x(distribution.median)} y1={24} y2={base} stroke={REFERENCE_LINE} strokeWidth={1.5} strokeDasharray="4 3" />
        <text x={x(distribution.median)} y={18} textAnchor="middle" fontSize={11} fill={REFERENCE_LINE}>
          中位数 {reading(distribution.median)}
        </text>
        <line x1={60} x2={740} y1={base} y2={base} stroke="#c7ccd8" />
        {axis.ticks.map((tick) => (
          <text key={tick} x={x(tick)} y={base + 18} textAnchor="middle" fontSize={11} fill="#596173">{indicatorNumber(tick, unit)}</text>
        ))}
        {placed.map((point) => highlight.includes(point.country) ? null : (
          <circle key={point.country} cx={point.px} cy={cy(point.lane)} r={3.6} fill="#8b93a6" fillOpacity={0.55}>
            <title>{`${countryLabel(point.country)}：${reading(point.value)}`}</title>
          </circle>
        ))}
        {marked.map((point) => (
          <g key={point.country}>
            <line x1={point.px} x2={point.px} y1={cy(point.lane)} y2={base + 26 + point.row * 14} stroke={CAT[point.index]} strokeWidth={1} />
            <circle cx={point.px} cy={cy(point.lane)} r={6} fill={CAT[point.index]} stroke="#fff" strokeWidth={1.5} />
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
}: {
  rows: Row[];
  countries: string[];
  years: number[];
}) {
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
  const values = series.flatMap((points) =>
    points.flatMap((point) => [point.x, point.y]),
  );
  if (!values.length) return null;
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
  return (
    <section aria-label="前后向生产长度位置轨迹">
      <h4>前向—后向位置轨迹 · 时间与国家对照</h4>
      <p className="muted">
        横轴是后向 GVC 段长度，纵轴是前向 GVC 段长度；箭头从较早年份指向较晚年份。等长线上方表示前向段相对更长。
      </p>
      <svg
        viewBox="0 0 720 650"
        role="img"
        aria-label={`前向与后向GVC段长度历年轨迹，${countries.map(countryLabel).join("与")}`}
        style={{ width: "100%", maxHeight: 520, display: "block" }}
      >
        <defs>
          {countries.map((country, index) => (
            <marker key={country} id={`length-arrow-${index}`} markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="8" refX="11" refY="4" orient="auto" viewBox="0 0 12 8">
              <path d="M0,0 L8,4 L0,8 z" fill={CAT[index]} />
            </marker>
          ))}
        </defs>
        {series.map((points, index) => (
          <g key={`legend-${countries[index]}`} transform={`translate(125 ${18 + index * 24})`}>
            <line x1={0} x2={28} y1={0} y2={0} stroke={CAT[index]} strokeWidth={2.5} markerEnd={`url(#length-arrow-${index})`} />
            <text x={38} y={4} fontSize={12} fill="#374151">
              {countryLabel(countries[index])}{points.length ? ` · ${points[0].year}→${points.at(-1)!.year}` : ""}
            </text>
          </g>
        ))}
        <g transform="translate(430 18)">
          <circle cx={0} cy={0} r={5} fill="white" stroke="#596173" strokeWidth={2} />
          <text x={10} y={4} fontSize={11} fill="#596173">起点</text>
          <circle cx={58} cy={0} r={5} fill="#596173" />
          <text x={68} y={4} fontSize={11} fill="#596173">终点</text>
        </g>
        {axis.ticks.map((tickValue) => {
          return <g key={tickValue}>
            <line x1={120} x2={660} y1={y(tickValue)} y2={y(tickValue)} stroke="#e2e5ee" />
            <line x1={x(tickValue)} x2={x(tickValue)} y1={50} y2={590} stroke="#e2e5ee" />
            <text x={110} y={y(tickValue) + 4} textAnchor="end" fontSize={12}>{indicatorNumber(tickValue, "生产阶段")}</text>
            <text x={x(tickValue)} y={615} textAnchor="middle" fontSize={12}>{indicatorNumber(tickValue, "生产阶段")}</text>
          </g>;
        })}
        <line x1={x(lo)} y1={y(lo)} x2={x(axis.hi)} y2={y(axis.hi)} stroke="#8a6415" strokeDasharray="6 4" />
        <text x={650} y={y(axis.hi) + 18} textAnchor="end" fontSize={11}>前向 = 后向</text>
        <text x={390} y={642} textAnchor="middle" fontSize={12}>后向 GVC 段长度</text>
        <text x={18} y={320} textAnchor="middle" fontSize={12} transform="rotate(-90 18 320)">前向 GVC 段长度</text>
        {series.map((points, countryIndex) => (
          <g key={countries[countryIndex]}>
            {points.map((point, index) => {
              const next = points[index + 1];
              const connectsToNext = next?.yearIndex === point.yearIndex + 1;
              const endpoint = index === 0 || index === points.length - 1;
              return <g key={point.year}>
                {connectsToNext && <line data-series={countries[countryIndex]} x1={x(point.x)} y1={y(point.y)} x2={x(next.x)} y2={y(next.y)} stroke={CAT[countryIndex]} strokeWidth={2.5} markerEnd={index === points.length - 2 ? `url(#length-arrow-${countryIndex})` : undefined} />}
                <circle
                  cx={x(point.x)}
                  cy={y(point.y)}
                  r={endpoint ? 5 : 3.5}
                  fill={index === 0 ? "white" : CAT[countryIndex]}
                  stroke={CAT[countryIndex]}
                  strokeWidth={index === 0 ? 2.5 : 1}
                >
                  <title>{`${countryLabel(countries[countryIndex])} · ${point.year}：后向 ${indicatorNumber(point.x, "生产阶段")}；前向 ${indicatorNumber(point.y, "生产阶段")}`}</title>
                </circle>
              </g>;
            })}
          </g>
        ))}
      </svg>
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
  const values = groups.flatMap((group) => group.values.filter(finiteValue));
  const lo = Math.min(0, ...values),
    hi = Math.max(0, ...values),
    extent = hi - lo || 1;
  const zero = (-lo / extent) * 100;
  return (
    <div aria-label="同刻度比较条形图" role="region">
      {groups.map((group) => (
        <div
          key={group.key}
          style={{ padding: "12px 0", borderBottom: "1px solid #e3e7ee" }}
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
    </div>
  );
}
