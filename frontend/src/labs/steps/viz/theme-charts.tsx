import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { countryLabel } from "../../../viz";
import { useHoverTip, type TipLine } from "../../../viz/hover";
import { CAT } from "../../../viz/shared";
import { niceDomain } from "../../../viz/nice-ticks";
import { finiteValue } from "./indicator-model";
import { indicatorNumber, indicatorTick } from "./indicator-charts";
import type { Row } from "./scaffold";

/* Phase 2 theme charts (design doc 4.3): small, hand-written SVG components on the shared hover layer.
 *   StackedAreaFacets  composition shares over the years, one facet per economy (steps 6–7 历年构成)
 *   IndustryDotPlot    one row per industry, one dot per economy, a line for each economy's national value (行业结构)
 *   Dumbbell           forward vs backward length per segment (step 8 段长度对照)
 *   Butterfly          weighted in-degree vs out-degree per industry (step 9 买入与卖出)
 * Colours: economies in CAT order; composition parts keep their topic colour; negatives red. */

export interface Segment { key: string; name: string; color: string }
const NEGATIVE = "#e34948";
const pct = (value: number | null) => indicatorNumber(value, "%");

/* ----------------------------------------------------------------- stacked area facets */

export function StackedAreaFacets({ facets, years, segments, total, totalLabel }: {
  facets: { key: string; label: string; rows: Row[] }[];
  years: number[];
  segments: Segment[];
  total: string;
  totalLabel: string;
}) {
  const { wrapRef, Tip, show, showFor, hide } = useHoverTip();
  const [active, setActive] = useState<string | null>(null);
  // Shares of the total per year; negative parts stack downwards from zero, like the signed bars.
  const facetData = facets.map((facet) => ({
    ...facet,
    points: years.map((year) => {
      const row = facet.rows.find((item) => item.year === year);
      const base = row?.[total];
      const ok = row && finiteValue(base) && base > 0 && segments.every((segment) => finiteValue(row[segment.key]));
      return { year, shares: ok ? segments.map((segment) => (row![segment.key] as number) / (base as number)) : null, total: ok ? (base as number) : null };
    }),
  }));
  const extremes = facetData.flatMap((facet) => facet.points.flatMap((point) => {
    if (!point.shares) return [];
    const positive = point.shares.filter((share) => share > 0).reduce((sum, share) => sum + share, 0);
    const negative = point.shares.filter((share) => share < 0).reduce((sum, share) => sum + share, 0);
    return [positive, negative];
  }));
  if (!extremes.length) return <p role="status">没有可画出的历年构成，请更换国家、行业或年份（缺失不补零）。</p>;
  const axis = niceDomain(Math.min(0, ...extremes), Math.max(0, ...extremes));
  const W = 420, H = 230, left = 56, right = 14, top = 14, bottom = 30;
  const x = (year: number) => left + ((year - years[0]) / Math.max(1, years.at(-1)! - years[0])) * (W - left - right);
  const y = (value: number) => top + ((axis.hi - value) / (axis.hi - axis.lo || 1)) * (H - top - bottom);
  const linesFor = (facet: typeof facetData[number], year: number): TipLine[] => {
    const point = facet.points.find((item) => item.year === year);
    return [
      ["", `${facet.label} · ${year}`],
      ...(point?.shares
        ? segments.map((segment, index): TipLine => [segment.name, pct(point.shares![index]), point.shares![index] < 0 ? NEGATIVE : segment.color])
        : [["构成", "缺失", undefined] as TipLine]),
      ...(point?.total != null ? [[totalLabel, `${indicatorNumber(point.total, "百万美元")} 百万美元`] as TipLine] : []),
    ];
  };
  const onKeyDown = (facet: typeof facetData[number]) => (event: KeyboardEvent<HTMLDivElement>) => {
    const current = active?.startsWith(`${facet.key}:`) ? Number(active.split(":")[1]) : null;
    const index = current === null ? -1 : years.indexOf(current);
    let next: number | undefined;
    if (event.key === "ArrowRight") next = years[Math.min(years.length - 1, index + 1)];
    else if (event.key === "ArrowLeft") next = years[index < 0 ? years.length - 1 : Math.max(0, index - 1)];
    else if (event.key === "Home") next = years[0];
    else if (event.key === "End") next = years[years.length - 1];
    else if (event.key === "Escape") { setActive(null); hide(); return; }
    if (next === undefined) return;
    event.preventDefault();
    setActive(`${facet.key}:${next}`);
    showFor(event.currentTarget, linesFor(facet, next));
  };
  // Band paths: for each segment, the area between the running sums before and after it, per sign.
  const areas = (facet: typeof facetData[number]) => {
    const runs = facet.points.map((point) => {
      if (!point.shares) return null;
      let up = 0, down = 0;
      return point.shares.map((share) => {
        if (share >= 0) { const from = up; up += share; return { from, to: up }; }
        const from = down; down += share; return { from, to: down };
      });
    });
    return segments.map((segment, index) => {
      // Split at missing years so a gap is never bridged.
      const paths: string[] = [];
      let segmentPoints: { year: number; from: number; to: number }[] = [];
      const flush = () => {
        if (segmentPoints.length >= 1) {
          const upper = segmentPoints.map((point) => `${x(point.year)},${y(point.to)}`).join(" L");
          const lower = [...segmentPoints].reverse().map((point) => `${x(point.year)},${y(point.from)}`).join(" L");
          paths.push(`M${upper} L${lower} Z`);
        }
        segmentPoints = [];
      };
      facet.points.forEach((point, at) => {
        const run = runs[at]?.[index];
        if (!run) { flush(); return; }
        segmentPoints.push({ year: point.year, ...run });
      });
      flush();
      const negative = facet.points.some((point, at) => runs[at]?.[index] && point.shares![index] < 0);
      return { segment, paths, negative };
    });
  };
  return (
    <div ref={wrapRef} className="hover-wrap">
      <div className="stacked-area-legend" aria-hidden="true">
        {segments.map((segment) => (
          <span key={segment.key}><i style={{ background: segment.color }} />{segment.name}</span>
        ))}
        <span><i style={{ background: NEGATIVE }} />负分项（零轴下方）</span>
      </div>
      <div className="comparison-facets">
        {facetData.map((facet, facetIndex) => (
          <section key={facet.key} className="comparison-facet">
            <h4>{facet.label} · 构成演变</h4>
            <div
              className="chart-focus"
              role="group"
              tabIndex={0}
              aria-label={`${facet.label}历年构成堆叠面积图；按左右方向键逐年读数，Esc 关闭`}
              onKeyDown={onKeyDown(facet)}
              onBlur={() => { setActive(null); hide(); }}
              onMouseLeave={() => { setActive(null); hide(); }}
            >
              <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${facet.label}各分项占${totalLabel}比重的历年变化；缺失年份留空`} style={{ width: "100%", display: "block" }}>
                {axis.ticks.map((tick) => (
                  <g key={tick}>
                    <line x1={left} x2={W - right} y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? "#4b5263" : "#e2e5ee"} />
                    <text x={left - 6} y={y(tick) + 4} textAnchor="end" fontSize={11} fill="#596173">{indicatorTick(tick, "%")}</text>
                  </g>
                ))}
                {areas(facet).map(({ segment, paths, negative }) => paths.map((d, at) => (
                  <path key={`${segment.key}-${at}`} d={d} fill={negative ? NEGATIVE : segment.color} fillOpacity={0.85} stroke="#fff" strokeWidth={0.8} data-area={segment.key} />
                )))}
                {years.map((year) => (
                  <text key={year} x={x(year)} y={H - 10} textAnchor="middle" fontSize={11} fill="#374151">{year}</text>
                ))}
                {active?.startsWith(`${facet.key}:`) && (
                  <line data-crosshair x1={x(Number(active.split(":")[1]))} x2={x(Number(active.split(":")[1]))} y1={top} y2={H - bottom} stroke="#1b1f2b" strokeDasharray="3 3" pointerEvents="none" />
                )}
                {years.map((year, index) => {
                  const lo = index === 0 ? left : (x(years[index - 1]) + x(year)) / 2;
                  const hi = index === years.length - 1 ? W - right : (x(year) + x(years[index + 1])) / 2;
                  return (
                    <rect key={`hit-${year}`} data-year={year} x={lo} y={top} width={Math.max(1, hi - lo)} height={H - top - bottom} fill="transparent"
                      onMouseMove={(event) => { setActive(`${facet.key}:${year}`); show(event, linesFor(facet, year)); }} />
                  );
                })}
              </svg>
            </div>
            <p className="muted" style={{ fontSize: 11.5, margin: "4px 0 0" }}>{facetIndex === 0 ? `每一色带是该分项占${totalLabel}的比重；负分项（红）画在零轴下方。` : "同一刻度、同一分项颜色。"}</p>
          </section>
        ))}
      </div>
      {Tip}
    </div>
  );
}

/* ----------------------------------------------------------------- industry dot plot */

export function IndustryDotPlot({ groups, countries, unit, nationals = [], label, onPick }: {
  /** One row per industry, ordered as they should appear; values follow `countries`. */
  groups: { key: string; label: string; values: (number | null)[] }[];
  countries: string[];
  unit: string;
  /** Each economy's national (country-level) value, drawn as a vertical line in its colour. */
  nationals?: (number | null)[];
  label: string;
  onPick?: (key: string) => void;
}) {
  const { wrapRef, Tip, show, showFor, hide } = useHoverTip();
  const [hovered, setHovered] = useState<string | null>(null);
  const values = [...groups.flatMap((group) => group.values), ...nationals].filter(finiteValue);
  if (!values.length) return <p role="status">显示的行业没有有效读数，请更换指标或国家。</p>;
  const zeroBased = unit === "%" || unit === "百万美元";
  const axis = niceDomain(zeroBased ? Math.min(0, ...values) : Math.min(...values), zeroBased ? Math.max(0, ...values) : Math.max(...values));
  const px = (value: number) => ((value - axis.lo) / (axis.hi - axis.lo || 1)) * 100;
  const linesFor = (group: typeof groups[number]): TipLine[] => [
    ["", group.label],
    ...group.values.map((value, index): TipLine => [countryLabel(countries[index]), indicatorNumber(value, unit), CAT[index]]),
  ];
  return (
    // The value column fits every compared economy's reading (five did not fit the fixed 110px column).
    <div ref={wrapRef} className="hover-wrap dot-plot" role="region" aria-label={`${label}行业点图`} style={{ "--dot-values": `${Math.max(110, countries.length * 62)}px` } as CSSProperties}>
      <div className="dot-plot-legend" aria-hidden="true">
        {countries.map((country, index) => (
          <span key={country}><i className="dot" style={{ background: CAT[index] }} />{countryLabel(country)}</span>
        ))}
        {nationals.some(finiteValue) && <span><i className="bar" />竖线：该国国家整体值</span>}
      </div>
      <div className="dot-plot-axis" aria-hidden="true">
        {axis.ticks.map((tick) => <span key={tick} style={{ left: `${px(tick)}%` }}>{indicatorTick(tick, unit)}</span>)}
      </div>
      {groups.map((group) => (
        <div
          key={group.key}
          className="dot-plot-row"
          data-hovered={hovered === group.key || undefined}
          // One Tab stop per row: the industry button when the row can be picked, the row itself otherwise.
          tabIndex={onPick ? -1 : 0}
          role="group"
          aria-label={`${group.label}：${group.values.map((value, index) => `${countryLabel(countries[index])} ${indicatorNumber(value, unit)}`).join("，")}`}
          onMouseMove={(event) => { setHovered(group.key); show(event, linesFor(group)); }}
          onMouseLeave={() => { setHovered(null); hide(); }}
          onFocus={(event) => { setHovered(group.key); showFor(event.currentTarget, linesFor(group)); }}
          onBlur={() => { setHovered(null); hide(); }}
        >
          {onPick
            ? <button type="button" className="dot-plot-label" onClick={() => onPick(group.key)} aria-label={`查看${group.label}历年变化`}>{group.label} →</button>
            : <span className="dot-plot-label">{group.label}</span>}
          <div className="dot-plot-track">
            {axis.ticks.map((tick) => <i key={tick} className="tick" style={{ left: `${px(tick)}%`, borderLeftColor: tick === 0 ? "#4b5263" : "#e2e5ee" }} />)}
            {nationals.map((value, index) => finiteValue(value) && (
              <i key={`national-${countries[index]}`} className="national" style={{ left: `${px(value)}%`, borderLeftColor: CAT[index] }} />
            ))}
            {group.values.map((value, index) => finiteValue(value) && (
              <i key={countries[index]} className="dot" data-country={countries[index]} style={{ left: `${px(value)}%`, background: CAT[index], zIndex: 10 - index }} />
            ))}
          </div>
          <span className="dot-plot-values">{group.values.map((value, index) => <b key={countries[index]} style={{ color: CAT[index] }}>{indicatorNumber(value, unit)}</b>)}</span>
        </div>
      ))}
      {Tip}
    </div>
  );
}

/* ----------------------------------------------------------------- dumbbell */

export function Dumbbell({ rows, leftLabel, rightLabel, unit, title, domain }: {
  rows: { key: string; label: string; left: number | null; right: number | null }[];
  leftLabel: string;
  rightLabel: string;
  unit: string;
  title: string;
  /** Shared value range when several economies are drawn side by side, so their axes match. */
  domain?: readonly [number, number];
}) {
  const { wrapRef, Tip, show, showFor, hide } = useHoverTip();
  const [hovered, setHovered] = useState<string | null>(null);
  const values = rows.flatMap((row) => [row.left, row.right]).filter(finiteValue);
  if (!values.length) return <p role="status">{title}没有有效读数（缺失不补零）。</p>;
  const axis = niceDomain(Math.min(...values, ...(domain ? [domain[0]] : [])), Math.max(...values, ...(domain ? [domain[1]] : [])));
  const px = (value: number) => ((value - axis.lo) / (axis.hi - axis.lo || 1)) * 100;
  const reading = (value: number | null) => indicatorNumber(value, unit);
  const linesFor = (row: typeof rows[number]): TipLine[] => [
    ["", row.label],
    [leftLabel, reading(row.left), CAT[0]],
    [rightLabel, reading(row.right), CAT[1]],
    ...(finiteValue(row.left) && finiteValue(row.right)
      ? [[`${leftLabel.slice(0, 2)}−${rightLabel.slice(0, 2)}`, indicatorNumber(row.left - row.right, unit)] as TipLine]
      : []),
  ];
  return (
    <div ref={wrapRef} className="hover-wrap dumbbell" role="region" aria-label={title}>
      <div className="dot-plot-legend" aria-hidden="true">
        <span><i className="dot" style={{ background: CAT[0] }} />{leftLabel}</span>
        <span><i className="dot" style={{ background: CAT[1] }} />{rightLabel}</span>
      </div>
      <div className="dot-plot-axis" aria-hidden="true">
        {axis.ticks.map((tick) => <span key={tick} style={{ left: `${px(tick)}%` }}>{indicatorTick(tick, unit)}</span>)}
      </div>
      {rows.map((row) => (
        <div
          key={row.key}
          className="dot-plot-row"
          data-hovered={hovered === row.key || undefined}
          tabIndex={0}
          role="group"
          aria-label={`${row.label}：${leftLabel} ${reading(row.left)}，${rightLabel} ${reading(row.right)}`}
          onMouseMove={(event) => { setHovered(row.key); show(event, linesFor(row)); }}
          onMouseLeave={() => { setHovered(null); hide(); }}
          onFocus={(event) => { setHovered(row.key); showFor(event.currentTarget, linesFor(row)); }}
          onBlur={() => { setHovered(null); hide(); }}
        >
          <span className="dot-plot-label">{row.label}</span>
          <div className="dot-plot-track">
            {axis.ticks.map((tick) => <i key={tick} className="tick" style={{ left: `${px(tick)}%` }} />)}
            {finiteValue(row.left) && finiteValue(row.right) && (
              <i className="link" style={{ left: `${px(Math.min(row.left, row.right))}%`, width: `${Math.abs(px(row.left) - px(row.right))}%` }} />
            )}
            {/* Equal values would draw one dot exactly over the other: the second becomes a ring around the first. */}
            {finiteValue(row.left) && <i className="dot" style={{ left: `${px(row.left)}%`, background: CAT[0] }} />}
            {finiteValue(row.right) && (finiteValue(row.left) && Math.abs(px(row.left) - px(row.right)) < 1.2
              ? <i className="dot dot--ring" style={{ left: `${px(row.right)}%`, borderColor: CAT[1] }} />
              : <i className="dot" style={{ left: `${px(row.right)}%`, background: CAT[1] }} />)}
          </div>
          <span className="dot-plot-values">
            <b style={{ color: CAT[0] }}>{reading(row.left)}</b>
            <b style={{ color: CAT[1] }}>{reading(row.right)}</b>
          </span>
        </div>
      ))}
      {Tip}
    </div>
  );
}

/* ----------------------------------------------------------------- butterfly */

export function Butterfly({ rows, leftLabel, rightLabel, unit, title, onPick }: {
  rows: { key: string; label: string; left: number | null; right: number | null }[];
  leftLabel: string;
  rightLabel: string;
  unit: string;
  title: string;
  onPick?: (key: string) => void;
}) {
  const { wrapRef, Tip, show, showFor, hide } = useHoverTip();
  const [hovered, setHovered] = useState<string | null>(null);
  const values = rows.flatMap((row) => [row.left, row.right]).filter(finiteValue);
  if (!values.length) return <p role="status">{title}没有有效读数（缺失不补零）。</p>;
  const max = Math.max(...values.map(Math.abs)) || 1;
  const width = (value: number | null) => (finiteValue(value) ? (Math.abs(value) / max) * 100 : 0);
  const reading = (value: number | null) => indicatorNumber(value, unit);
  const linesFor = (row: typeof rows[number]): TipLine[] => [
    ["", row.label],
    [leftLabel, reading(row.left), CAT[1]],
    [rightLabel, reading(row.right), CAT[0]],
    ...(finiteValue(row.left) && finiteValue(row.right) && row.left + row.right > 0
      ? [["卖出占比", pct(row.right / (row.left + row.right))] as TipLine]
      : []),
  ];
  return (
    <div ref={wrapRef} className="hover-wrap butterfly" role="region" aria-label={title}>
      <div className="butterfly-head" aria-hidden="true">
        <span style={{ color: CAT[1] }}>◀ {leftLabel}</span>
        <span />
        <span style={{ color: CAT[0] }}>{rightLabel} ▶</span>
      </div>
      {rows.map((row) => (
        <div
          key={row.key}
          className="butterfly-row"
          data-hovered={hovered === row.key || undefined}
          tabIndex={onPick ? -1 : 0}
          role="group"
          aria-label={`${row.label}：${leftLabel} ${reading(row.left)}，${rightLabel} ${reading(row.right)}`}
          onMouseMove={(event) => { setHovered(row.key); show(event, linesFor(row)); }}
          onMouseLeave={() => { setHovered(null); hide(); }}
          onFocus={(event) => { setHovered(row.key); showFor(event.currentTarget, linesFor(row)); }}
          onBlur={() => { setHovered(null); hide(); }}
        >
          <span className="butterfly-value" style={{ textAlign: "right" }}>{reading(row.left)}</span>
          <div className="butterfly-track left"><i style={{ width: `${width(row.left)}%`, background: CAT[1] }} /></div>
          {onPick
            ? <button type="button" className="butterfly-label" onClick={() => onPick(row.key)} aria-label={`查看${row.label}历年变化`}>{row.label}</button>
            : <span className="butterfly-label">{row.label}</span>}
          <div className="butterfly-track right"><i style={{ width: `${width(row.right)}%`, background: CAT[0] }} /></div>
          <span className="butterfly-value">{reading(row.right)}</span>
        </div>
      ))}
      {Tip}
    </div>
  );
}
