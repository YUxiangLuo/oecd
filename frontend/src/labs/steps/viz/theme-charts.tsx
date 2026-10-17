import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { countryLabel } from "../../../viz";
import { useHoverTip, type TipLine } from "../../../viz/hover";
import { CAT, CAT_TEXT } from "../../../viz/shared";
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
  const { wrapRef, Tip, show, showNear, hide } = useHoverTip();
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
  const anyNegative = facetData.some((facet) => facet.points.some((point) => point.shares?.some((share) => share < 0)));
  const extremes = facetData.flatMap((facet) => facet.points.flatMap((point) => {
    if (!point.shares) return [];
    const positive = point.shares.filter((share) => share > 0).reduce((sum, share) => sum + share, 0);
    const negative = point.shares.filter((share) => share < 0).reduce((sum, share) => sum + share, 0);
    return [positive, negative];
  }));
  // Zero totals have undefined shares; negative totals are not displayed as shares on this page.
  const nonPositive = (row: Row | undefined) => Boolean(row) && finiteValue(row![total]) && (row![total] as number) <= 0;
  const allUndefined = facets.every((facet) => years.every((year) => nonPositive(facet.rows.find((item) => item.year === year))));
  /** Explain each omitted year without calling a negative denominator mathematically undefined. */
  const undefinedNote = (rows: Row[]) => {
    const clauses = (["为负", "为 0"] as const).flatMap((word) => {
      const at = years.filter((year) => {
        const value = rows.find((item) => item.year === year)?.[total];
        return finiteValue(value) && (word === "为负" ? value < 0 : value === 0);
      });
      return at.length ? [`${at.join("、")} 年${totalLabel}${word}，${word === "为负" ? "本页面不展示比重" : "构成份额无法计算"}`] : [];
    });
    return clauses.length ? `${clauses.join("；")}，图中留空。` : null;
  };
  if (!extremes.length) return <p role="status">{allUndefined
    ? `没有可画出的历年构成：所选年份的${totalLabel}都为 0 或为负，为 0 时构成份额无法计算，为负时本页面不展示比重（不是缺少数据）；请换一个行业或国家。`
    : "没有可画出的历年构成，请更换国家、行业或年份（缺少的数据留空，不当作 0）。"}</p>;
  const axis = niceDomain(Math.min(0, ...extremes), Math.max(0, ...extremes));
  const W = 420, H = 230, left = 56, right = 14, top = 14, bottom = 30;
  const x = (year: number) => left + ((year - years[0]) / Math.max(1, years.at(-1)! - years[0])) * (W - left - right);
  const y = (value: number) => top + ((axis.hi - value) / (axis.hi - axis.lo || 1)) * (H - top - bottom);
  const linesFor = (facet: typeof facetData[number], year: number): TipLine[] => {
    const point = facet.points.find((item) => item.year === year);
    const base = facet.rows.find((item) => item.year === year)?.[total];
    return [
      ["", `${facet.label} · ${year}`],
      ...(point?.shares
        ? segments.map((segment, index): TipLine => [segment.name, pct(point.shares![index]), point.shares![index] < 0 ? NEGATIVE : segment.color])
        : [["构成", base === 0 ? `无法计算（${totalLabel}为 0）` : finiteValue(base) && base < 0 ? `本页面不展示比重（${totalLabel}为负）` : "缺失", undefined] as TipLine]),
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
    showNear(event.currentTarget.querySelector(`rect[data-year="${next}"]`) ?? event.currentTarget, linesFor(facet, next));
  };
  // Band paths: for each segment, the area between the running sums before and after it, per sign.
  const areas = (facet: typeof facetData[number]) => {
    // Every band must bend at every part's crossing, not only its own:
    // interpolating already-stacked endpoints would leave wedges or overlaps.
    const points = facet.points.flatMap((point, at) => {
      const previous = facet.points[at - 1];
      if (!previous?.shares || !point.shares) return [point];
      const before = previous.shares, after = point.shares;
      const crossings = before.map((share, i) => share * after[i] < 0 ? share / (share - after[i]) : null);
      const fractions = [...new Set(crossings.filter((fraction): fraction is number => fraction !== null))].sort((a, b) => a - b);
      return [...fractions.map((fraction) => ({
        year: previous.year + fraction * (point.year - previous.year),
        shares: before.map((share, i) => crossings[i] === fraction ? 0 : share + fraction * (after[i] - share)),
        total: null,
      })), point];
    });
    const runs = points.map((point) => {
      if (!point.shares) return null;
      let up = 0, down = 0;
      return point.shares.map((share) => {
        if (share >= 0) { const from = up; up += share; return { from, to: up }; }
        const from = down; down += share; return { from, to: down };
      });
    });
    return segments.map((segment, index) => {
      // Split at missing years so a gap is never bridged.
      const paths: { d: string; negative: boolean; isolated: boolean }[] = [];
      let segmentPoints: { year: number; from: number; to: number }[] = [];
      let negative = false;
      const flush = () => {
        if (segmentPoints.length >= 1) {
          const upper = segmentPoints.map((point) => `${x(point.year)},${y(point.to)}`).join(" L");
          const lower = [...segmentPoints].reverse().map((point) => `${x(point.year)},${y(point.from)}`).join(" L");
          paths.push({ d: `M${upper} L${lower} Z`, negative, isolated: segmentPoints.length === 1 });
        }
        segmentPoints = [];
      };
      points.forEach((point, at) => {
        const run = runs[at]?.[index];
        if (!run) { flush(); return; }
        const nextNegative = point.shares![index] < 0;
        const previous = points[at - 1];
        if (segmentPoints.length && nextNegative !== negative) {
          // Interpolate shares, not the signed stack endpoints: the positive and
          // negative stacks can have different baselines at the zero crossing.
          const before = previous.shares![index];
          const fraction = before / (before - point.shares![index]);
          const year = previous.year + fraction * (point.year - previous.year);
          const baseline = (below: boolean) => segments.slice(0, index).reduce((sum, _, i) => {
            const share = previous.shares![i] + fraction * (point.shares![i] - previous.shares![i]);
            return sum + (below ? Math.min(0, share) : Math.max(0, share));
          }, 0);
          const end = baseline(negative);
          segmentPoints.push({ year, from: end, to: end });
          flush();
          const start = baseline(nextNegative);
          segmentPoints.push({ year, from: start, to: start });
        }
        negative = nextNegative;
        segmentPoints.push({ year: point.year, ...run });
      });
      flush();
      return { segment, paths };
    });
  };
  return (
    <div ref={wrapRef} className="hover-wrap">
      <div className="stacked-area-legend" aria-hidden="true">
        {segments.map((segment) => (
          <span key={segment.key}><i style={{ background: segment.color }} />{segment.name}</span>
        ))}
        {/* Only when some part is negative (e.g. negative value added): step 7's parts usually never are. */}
        {anyNegative && <span><i style={{ background: NEGATIVE }} />负分项（零轴下方）</span>}
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
                    <text x={left - 6} y={y(tick) + 4} textAnchor="end" fontSize={11} fill="#596173">{indicatorTick(tick, "%", axis.ticks)}</text>
                  </g>
                ))}
                {areas(facet).map(({ segment, paths }) => paths.map(({ d, negative, isolated }, at) => (
                  <path key={`${segment.key}-${at}`} d={d} fill={negative ? NEGATIVE : segment.color} fillOpacity={0.85} stroke={isolated ? (negative ? NEGATIVE : segment.color) : "#fff"} strokeWidth={isolated ? 6 : 0.8} data-area={segment.key} />
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
            <p className="muted" style={{ fontSize: 11.5, margin: "4px 0 0" }}>{facetIndex === 0 ? `每一色带是该分项占${totalLabel}的比重${anyNegative ? "；负分项（红）画在零轴下方" : ""}。` : "同一刻度、同一分项颜色。"}</p>
            {undefinedNote(facet.rows) && (
              <p className="muted" role="note" style={{ fontSize: 11.5, margin: "2px 0 0" }}>{undefinedNote(facet.rows)}</p>
            )}
          </section>
        ))}
      </div>
      {Tip}
    </div>
  );
}

/* ----------------------------------------------------------------- industry dot plot */

export function IndustryDotPlot({ groups, countries, unit, nationals = [], label, onPick }: {
  /** One row per industry, ordered as they should appear; values follow `countries`. `reasons[i]` replaces
   *  "缺失" for a value that is undefined rather than missing ("无法计算": the industry exports nothing). */
  groups: { key: string; label: string; values: (number | null)[]; reasons?: (string | null)[] }[];
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
  const reading = (group: typeof groups[number], index: number) =>
    group.values[index] === null && group.reasons?.[index] ? group.reasons[index]! : indicatorNumber(group.values[index], unit);
  const linesFor = (group: typeof groups[number]): TipLine[] => [
    ["", group.label],
    ...group.values.map((_, index): TipLine => [countryLabel(countries[index]), reading(group, index), CAT[index]]),
  ];
  return (
    // The value column fits every compared economy's reading (five did not fit the fixed 110px column).
    <div ref={wrapRef} className="hover-wrap dot-plot" role="region" aria-label={`${label}行业点图`} style={{ "--dot-values": `${Math.max(110, countries.length * 62)}px` } as CSSProperties}>
      <div className="dot-plot-legend" aria-hidden="true">
        {countries.map((country, index) => (
          <span key={country}><i className="dot" style={{ background: CAT[index] }} />{countryLabel(country)}</span>
        ))}
        {nationals.some(finiteValue) && <span><i className="bar" />竖线：各国的国家整体值（颜色同点）</span>}
      </div>
      <div className="dot-plot-axis" aria-hidden="true">
        {axis.ticks.map((tick) => <span key={tick} style={{ left: `${px(tick)}%` }}>{indicatorTick(tick, unit, axis.ticks)}</span>)}
      </div>
      {groups.map((group) => (
        <div
          key={group.key}
          className="dot-plot-row"
          data-hovered={hovered === group.key || undefined}
          // One Tab stop per row: the industry button when the row can be picked, the row itself otherwise.
          tabIndex={onPick ? -1 : 0}
          role="group"
          aria-label={`${group.label}：${group.values.map((_, index) => `${countryLabel(countries[index])} ${reading(group, index)}`).join("，")}`}
          onMouseMove={(event) => { setHovered(group.key); show(event, linesFor(group)); }}
          onMouseLeave={() => { setHovered(null); hide(); }}
          onFocus={(event) => { setHovered(group.key); showFor(event.currentTarget, linesFor(group)); }}
          onBlur={() => { setHovered(null); hide(); }}
        >
          {onPick
            ? <button type="button" className="dot-plot-label" onClick={() => onPick(group.key)} aria-label={`查看 ${group.label} 的历年变化`}>{group.label} →</button>
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
          <span className="dot-plot-values">{group.values.map((_, index) => <b key={countries[index]} style={{ color: CAT_TEXT[index] }}>{reading(group, index)}</b>)}</span>
        </div>
      ))}
      {Tip}
    </div>
  );
}

/* ----------------------------------------------------------------- dumbbell */

export function Dumbbell({ rows, leftLabel, rightLabel, unit, title, domain }: {
  /** `leftReason`/`rightReason` replace "缺失" for a length that is undefined (the segment has no activity). */
  rows: { key: string; label: string; left: number | null; right: number | null; leftReason?: string | null; rightReason?: string | null }[];
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
  if (!values.length) return <p role="status">{rows.every((row) => row.leftReason && row.rightReason)
    ? `${title}：各段都没有这类生产活动，长度无法计算（不是缺少数据）。`
    : `${title}没有有效读数（缺失留空）。`}</p>;
  const axis = niceDomain(Math.min(...values, ...(domain ? [domain[0]] : [])), Math.max(...values, ...(domain ? [domain[1]] : [])));
  const px = (value: number) => ((value - axis.lo) / (axis.hi - axis.lo || 1)) * 100;
  const reading = (value: number | null, reason?: string | null) => (value === null && reason ? reason : indicatorNumber(value, unit));
  const linesFor = (row: typeof rows[number]): TipLine[] => [
    ["", row.label],
    [leftLabel, reading(row.left, row.leftReason), CAT[0]],
    [rightLabel, reading(row.right, row.rightReason), CAT[1]],
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
        {axis.ticks.map((tick) => <span key={tick} style={{ left: `${px(tick)}%` }}>{indicatorTick(tick, unit, axis.ticks)}</span>)}
      </div>
      {rows.map((row) => (
        <div
          key={row.key}
          className="dot-plot-row"
          data-hovered={hovered === row.key || undefined}
          tabIndex={0}
          role="group"
          // The facet title names the economy, so five facets do not read identically.
          aria-label={`${title} · ${row.label}：${leftLabel} ${reading(row.left, row.leftReason)}，${rightLabel} ${reading(row.right, row.rightReason)}`}
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
            <b style={{ color: CAT_TEXT[0] }}>{reading(row.left, row.leftReason)}</b>
            <b style={{ color: CAT_TEXT[1] }}>{reading(row.right, row.rightReason)}</b>
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
  // Without pick buttons the rows themselves are read by keyboard: one Tab stop, arrow keys between rows.
  const [activeIndex, setActiveIndex] = useState(0);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const values = rows.flatMap((row) => [row.left, row.right]).filter(finiteValue);
  if (!values.length) return <p role="status">{title}没有有效读数（缺失留空）。</p>;
  const current = Math.min(activeIndex, rows.length - 1);
  const onRowKey = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    if (onPick) return;
    let next: number | undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = Math.min(rows.length - 1, index + 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    setActiveIndex(next);
    rowRefs.current[next]?.focus();
  };
  const max = Math.max(...values.map(Math.abs)) || 1;
  const width = (value: number | null) => (finiteValue(value) ? (Math.abs(value) / max) * 100 : 0);
  const reading = (value: number | null) => indicatorNumber(value, unit);
  // The readout names the unit; the row values beside the bars stay bare numbers.
  const withUnit = (value: number | null) => (value === null || unit === "%" ? reading(value) : `${reading(value)} ${unit}`);
  const linesFor = (row: typeof rows[number]): TipLine[] => [
    ["", row.label],
    [leftLabel, withUnit(row.left), CAT[1]],
    [rightLabel, withUnit(row.right), CAT[0]],
    ...(finiteValue(row.left) && finiteValue(row.right) && row.left + row.right > 0
      ? [["卖出占比", pct(row.right / (row.left + row.right))] as TipLine]
      : []),
  ];
  return (
    <div ref={wrapRef} className="hover-wrap butterfly" role="region" aria-label={unit === "%" ? title : `${title}（单位：${unit}）`}>
      <div className="butterfly-head" aria-hidden="true">
        <span style={{ color: CAT_TEXT[1] }}>◀ {leftLabel}</span>
        {/* The values beside the bars are bare numbers: their unit sits between the two column titles. */}
        <span className="butterfly-unit">{unit === "%" ? "" : `单位：${unit}`}</span>
        <span style={{ color: CAT_TEXT[0] }}>{rightLabel} ▶</span>
      </div>
      {rows.map((row, index) => (
        <div
          key={row.key}
          ref={(node) => { rowRefs.current[index] = node; }}
          className="butterfly-row"
          data-hovered={hovered === row.key || undefined}
          tabIndex={onPick || index !== current ? -1 : 0}
          role="group"
          aria-label={`${title} · ${row.label}：${leftLabel} ${reading(row.left)}，${rightLabel} ${reading(row.right)}${onPick ? "" : `（第 ${index + 1}/${rows.length} 行，上下方向键换行）`}`}
          onMouseMove={(event) => { setHovered(row.key); show(event, linesFor(row)); }}
          onMouseLeave={() => { setHovered(null); hide(); }}
          onKeyDown={(event) => onRowKey(event, index)}
          onFocus={(event) => { if (!onPick) setActiveIndex(index); setHovered(row.key); showFor(event.currentTarget, linesFor(row)); }}
          onBlur={() => { setHovered(null); hide(); }}
        >
          <span className="butterfly-value" style={{ textAlign: "right" }}>{reading(row.left)}</span>
          <div className="butterfly-track left"><i style={{ width: `${width(row.left)}%`, background: CAT[1] }} /></div>
          {onPick
            ? <button type="button" className="butterfly-label" onClick={() => onPick(row.key)} aria-label={`查看 ${row.label} 的历年变化`} title={row.label}>{row.label}</button>
            : <span className="butterfly-label" title={row.label}>{row.label}</span>}
          <div className="butterfly-track right"><i style={{ width: `${width(row.right)}%`, background: CAT[0] }} /></div>
          <span className="butterfly-value">{reading(row.right)}</span>
        </div>
      ))}
      {Tip}
    </div>
  );
}
