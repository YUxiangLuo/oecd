import { useState } from "react";
import { Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { countryLabel } from "../../../viz";
import { CAT } from "../../../viz/shared";
import { niceDomain } from "../../../viz/nice-ticks";
import { finiteValue, type YearDistribution } from "./indicator-model";
import { indicatorNumber } from "./indicator-charts";
import type { Row } from "./scaffold";

/* Recharts pilot (design doc 4.7, phase 0): the step 6 trend chart rebuilt on Recharts 3 so the
 * hand-written chart and the library chart can be compared side by side on the same data.
 * Loaded lazily and only with `?pilot=recharts`; it never records material and is not part of
 * the report. The comparison is written up in docs/viz-steps-redesign-analysis.md. */

const REFERENCE_FILL = "#9aa3b5";
const REFERENCE_LINE = "#6b7385";

type Point = Record<string, number | [number, number] | null> & { year: number };

export function IndicatorTrendChartRecharts({
  rows,
  countries,
  years,
  metric,
  label,
  unit,
  distribution = [],
  sameIndustry = false,
  width,
}: {
  rows: Row[];
  countries: string[];
  years: number[];
  metric: string;
  label: string;
  unit: string;
  distribution?: YearDistribution[];
  sameIndustry?: boolean;
  /** Fixed pixel width for tests; the page lets the chart follow its container. */
  width?: number;
}) {
  const [focusSeries, setFocusSeries] = useState<string | null>(null);
  const data: Point[] = years.map((year) => {
    const reference = distribution.find((item) => item.year === year);
    const point: Point = {
      year,
      band: reference ? [reference.p25, reference.p75] : null,
      median: reference?.median ?? null,
    };
    for (const country of countries) {
      const value = rows.find((row) => row.country === country && row.year === year)?.[metric];
      point[country] = finiteValue(value) ? value : null;
    }
    return point;
  });
  const values = data.flatMap((point) => [
    ...countries.flatMap((country) => (point[country] === null ? [] : [point[country] as number])),
    ...(point.band ? (point.band as [number, number]) : []),
  ]);
  if (!countries.some((country) => data.some((point) => point[country] !== null)))
    return <p role="status">该指标没有有效读数，请更换国家、行业或年份。</p>;
  const positionRatio = metric === "GVCPs" || metric === "Pos_TPL";
  const zeroBased = unit === "%" || unit === "百万美元";
  const axis = niceDomain(
    zeroBased ? Math.min(0, ...values) : Math.min(...values, positionRatio ? 1 : Infinity),
    zeroBased ? Math.max(0, ...values) : Math.max(...values, positionRatio ? 1 : -Infinity),
  );
  const referenceLabel = sameIndustry ? "同行业全球中位数" : "全球中位数";
  const seriesName = (country: string, index: number) => (index ? `${countryLabel(country)}（对比）` : countryLabel(country));
  const dim = (country: string) => (focusSeries && focusSeries !== country ? 0.25 : 1);
  const count = distribution.at(-1)?.n;
  const legendItems: { key: string; label: string; country?: string; swatch: React.ReactNode }[] = [
    ...(distribution.length
      ? [
          { key: "band", label: "中间 50% 经济体", swatch: <span style={{ display: "inline-block", width: 24, height: 12, background: REFERENCE_FILL, opacity: 0.3 }} /> },
          { key: "median", label: `${referenceLabel}（${count} 个）`, swatch: <span style={{ display: "inline-block", width: 24, borderTop: `2px dashed ${REFERENCE_LINE}` }} /> },
        ]
      : []),
    ...countries.map((country, index) => ({
      key: country,
      country,
      label: seriesName(country, index),
      swatch: <span style={{ display: "inline-block", width: 24, borderTop: `${index ? 2 : 3}px ${index ? "dashed" : "solid"} ${CAT[index]}` }} />,
    })),
  ];
  const readout = ({ active, label: year, payload }: { active?: boolean; label?: unknown; payload?: readonly unknown[] }) => {
    if (!active || !payload?.length) return null;
    const at = Number(year);
    const point = data.find((item) => item.year === at);
    if (!point) return null;
    return (
      <div className="hover-tip" style={{ position: "static", visibility: "visible" }}>
        <div className="hover-tip-head">{at} 年</div>
        {countries.map((country, index) => (
          <div key={country}>
            <i className="hover-tip-key" style={{ background: CAT[index] }} />
            <b>{indicatorNumber(point[country] as number | null, unit)}</b>
            <span> {seriesName(country, index)}</span>
          </div>
        ))}
        {point.median !== null && (
          <div>
            <i className="hover-tip-key" style={{ background: REFERENCE_LINE }} />
            <b>{indicatorNumber(point.median as number, unit)}</b>
            <span> {referenceLabel}</span>
          </div>
        )}
      </div>
    );
  };
  return (
    <section aria-label={`${label}趋势图（Recharts 试点）`}>
      <h4>{label} · {unit} · Recharts 试点</h4>
      <ComposedChart
        data={data}
        responsive={width === undefined}
        width={width ?? "100%"}
        height={300}
        margin={{ top: 12, right: 44, bottom: 8, left: 12 }}
        title={`${label}历年变化（Recharts 试点）`}
        desc={`${label}历年变化${distribution.length ? "，含全部经济体的中位数与中间 50% 范围" : ""}；缺失不补零，详细读数见下方`}
      >
        <CartesianGrid vertical={false} stroke="#e2e5ee" />
        <XAxis dataKey="year" type="category" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
        <YAxis
          domain={[axis.lo, axis.hi]}
          ticks={axis.ticks}
          tick={{ fontSize: 12, fill: "#596173" }}
          axisLine={false}
          tickLine={false}
          width={70}
          tickFormatter={(value: number) => indicatorNumber(value, unit)}
        />
        <Tooltip content={readout} cursor={{ stroke: "#1b1f2b", strokeDasharray: "3 3" }} isAnimationActive={false} />
        <Legend
          verticalAlign="top"
          align="left"
          wrapperStyle={{ paddingBottom: 8 }}
          content={() => (
            <div className="recharts-pilot-legend" style={{ display: "flex", flexWrap: "wrap", gap: "4px 20px", fontSize: 12, color: "#374151" }}>
              {legendItems.map((item) => (
                <span
                  key={item.key}
                  data-legend={item.country}
                  style={{ display: "inline-flex", alignItems: "center", gap: 7, cursor: item.country ? "pointer" : undefined }}
                  onMouseEnter={item.country ? () => setFocusSeries(item.country!) : undefined}
                  onMouseLeave={item.country ? () => setFocusSeries(null) : undefined}
                >
                  {item.swatch}
                  {item.label}
                </span>
              ))}
            </div>
          )}
        />
        {distribution.length >= 2 && (
          <Area dataKey="band" type="linear" fill={REFERENCE_FILL} fillOpacity={0.22} stroke="none" isAnimationActive={false} activeDot={false} legendType="none" tooltipType="none" />
        )}
        {distribution.length >= 2 && (
          <Line dataKey="median" type="linear" stroke={REFERENCE_LINE} strokeWidth={1.5} strokeDasharray="4 3" dot={false} activeDot={false} isAnimationActive={false} legendType="none" tooltipType="none" />
        )}
        {positionRatio && <ReferenceLine y={1} stroke="#966500" strokeDasharray="6 4" label={{ value: "基准 1", position: "right", fontSize: 11, fill: "#966500" }} />}
        {countries.map((country, index) => (
          <Line
            key={country}
            dataKey={country}
            name={seriesName(country, index)}
            type="linear"
            stroke={CAT[index]}
            strokeWidth={index ? 2 : 3}
            strokeDasharray={index ? "7 4" : undefined}
            strokeOpacity={dim(country)}
            dot={{ r: index ? 3.5 : 4.5, fill: CAT[index], stroke: "none", fillOpacity: dim(country) }}
            activeDot={{ r: index ? 6 : 7, stroke: "#fff", strokeWidth: 2 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </ComposedChart>
    </section>
  );
}
