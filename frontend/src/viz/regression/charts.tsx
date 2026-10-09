import { cardStyle } from "../shared";
import { TAXED, UNTAXED } from "./palette";

/** Approximate SVG text width (generous, so a clamped label never reaches a neighbour): CJK 1 em, Latin 0.62 em. */
export function svgTextWidth(text: string, size: number): number {
  return [...text].reduce((width, char) => width + (/[⺀-￿]/.test(char) ? size : size * 0.62), 0);
}

/** Symmetric "nice" axis around 0 so the zero line always sits in the middle. */
function niceSymmetricTicks(maxAbs: number): number[] {
  const raw = maxAbs / 2;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) ?? raw;
  const count = Math.max(1, Math.ceil(maxAbs / step));
  return Array.from({ length: 2 * count + 1 }, (_, index) => (index - count) * step);
}

/**
 * Two lines: taxed vs untaxed countries, each group's mean Y minus its own pre-policy mean.
 * A dashed line marks when the simulated tariff starts; the gap that opens after it is what the
 * regression then quantifies.
 */
/** Centres for stacked labels: in order of their wanted position, at least half of both heights apart, inside [top, bottom]. */
export function spreadLabels(items: { key: string; at: number; size: number }[], top: number, bottom: number): Record<string, number> {
  const sorted = [...items].sort((a, b) => a.at - b.at);
  const centres = sorted.map((item) => item.at);
  const gap = (index: number) => (sorted[index - 1].size + sorted[index].size) / 2 + 2;
  for (let index = 1; index < sorted.length; index++) centres[index] = Math.max(centres[index], centres[index - 1] + gap(index));
  const last = sorted.length - 1;
  if (last >= 0) centres[last] = Math.min(centres[last], bottom - sorted[last].size / 2);
  for (let index = last - 1; index >= 0; index--) centres[index] = Math.min(centres[index], centres[index + 1] - gap(index + 1));
  if (sorted.length) centres[0] = Math.max(centres[0], top + sorted[0].size / 2);
  for (let index = 1; index < sorted.length; index++) centres[index] = Math.max(centres[index], centres[index - 1] + gap(index));
  return Object.fromEntries(sorted.map((item, index) => [item.key, centres[index]]));
}

/**
 * The centre nearest `at` for a label of height `size` that overlaps none of the fixed labels (centres `taken`,
 * height `takenSize`) and stays inside [top, bottom]; `at` itself when it is free.
 */
export function freeSlot(at: number, size: number, taken: number[], takenSize: number, top: number, bottom: number): number {
  const half = size / 2, clearance = (size + takenSize) / 2 + 2;
  const inside = (centre: number) => Math.min(Math.max(centre, top + half), bottom - half);
  const free = (centre: number) => taken.every((other) => Math.abs(centre - other) >= clearance - 1e-9);
  const candidates = [at, ...taken.flatMap((other) => [other - clearance, other + clearance])].map(inside);
  const open = candidates.filter(free).sort((a, b) => Math.abs(a - at) - Math.abs(b - at));
  return open[0] ?? inside(at);
}

export function GroupChangeChart({
  years, policyYear, taxed, untaxed, scale = 1, unit, title, estimate,
}: {
  years: number[];
  policyYear: number;
  taxed: { year: number; change: number }[];
  untaxed: { year: number; change: number }[];
  /** Multiplier from stored Y units to displayed units (e.g. 100 for shares shown in percentage points). */
  scale?: number;
  unit: string;
  title: string;
  /** After the run: the gap the estimate implies (β × mean exposure), in stored Y units, drawn at the last year. */
  estimate?: {
    gap: number;
    label: string;
    /** The 95% interval includes 0: a third line says "（方向不确定）", as the reading card below does. */
    uncertain?: boolean;
  } | null;
}) {
  const width = 640, height = 250, padL = 64, padR = 140, padT = 22, padB = 34;
  const values = [...taxed, ...untaxed].map((point) => point.change * scale);
  const estimateEnd = estimate ? (untaxed.at(-1)?.change ?? 0) + estimate.gap : null;
  if (estimateEnd != null) values.push(estimateEnd * scale);
  const maxAbs = Math.max(...values.map(Math.abs), 1e-9) * 1.1;
  const ticks = niceSymmetricTicks(maxAbs);
  const extent = ticks.at(-1)!;
  const decimals = Math.max(0, Math.min(4, 1 - Math.floor(Math.log10(extent / 2))));
  const x = (year: number) => padL + ((year - years[0]) / Math.max(1, years.at(-1)! - years[0])) * (width - padL - padR);
  const y = (value: number) => padT + ((extent - value) / (2 * extent)) * (height - padT - padB);
  const path = (series: { year: number; change: number }[]) => series
    .map((point, index) => `${index ? "L" : "M"}${x(point.year)},${y(point.change * scale)}`).join(" ");
  const policyX = (x(policyYear - 1) + x(policyYear)) / 2;
  const lastTaxed = taxed.at(-1)?.change ?? 0, lastUntaxed = untaxed.at(-1)?.change ?? 0;
  // The two group names and the two-line estimate share the right margin. The group names stay at their line
  // ends (pushed apart only from each other when the lines end close together); the estimate then takes the free
  // place nearest its bracket, so a bracket longer than the gap between the lines never pushes a name away.
  const estimateY = estimate && estimateEnd != null ? (y(lastUntaxed * scale) + y(estimateEnd * scale)) / 2 : null;
  const groupSlots = spreadLabels([
    { key: "taxed", at: y(lastTaxed * scale) + (lastTaxed < lastUntaxed ? 8 : -8), size: 14 },
    { key: "untaxed", at: y(lastUntaxed * scale) + (lastTaxed < lastUntaxed ? -8 : 8), size: 14 },
  ], padT, height - 4);
  const slots: Record<string, number> = estimateY == null
    ? groupSlots
    : { ...groupSlots, estimate: freeSlot(estimateY, estimate?.uncertain ? 42 : 28, [groupSlots.taxed, groupSlots.untaxed], 14, padT, height - 4) };
  const label = (series: { year: number; change: number }[], text: string, color: string, key: string) => {
    const last = series.at(-1);
    return last && <text x={x(last.year) + 8} y={slots[key]} dominantBaseline="middle" fontSize={11.5} fontWeight={700} fill={color}>{text}</text>;
  };
  const [estimateHead, ...estimateRest] = (estimate?.label ?? "").split(" ");
  const estimateValue = estimateRest.join(" ");
  const description = `${title}：被加税组与未被加税组相对加税前平均水平的变化，${policyYear} 年起加税${estimate ? `；${estimate.label}` : ""}`;
  return (
    <div className="group-change-chart" style={{ ...cardStyle, flex: "1 1 320px", minWidth: 280 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#3a4050" }}>{title}</div>
      <div style={{ fontSize: 11, color: "#5f6677", marginBottom: 6 }}>
        纵轴：相对 {years[0]}–{policyYear - 1} 年平均水平的变化（{unit}）
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={description} style={{ display: "block", width: "100%", maxWidth: 760, height: "auto" }}>
        <title>{description}</title>
        {ticks.map((value) => (
          <g key={value}>
            <line x1={padL} x2={width - padR} y1={y(value)} y2={y(value)} stroke={value === 0 ? "#9aa0ad" : "#eef0f4"} strokeWidth={1} />
            <text x={padL - 8} y={y(value)} dominantBaseline="middle" textAnchor="end" fontSize={11} fill="#5f6677">{value === 0 ? "0" : value.toFixed(decimals)}</text>
          </g>
        ))}
        {years.map((year) => <text key={year} x={x(year)} y={height - 12} textAnchor="middle" fontSize={11} fill="#5f6677">{year}</text>)}
        {estimate && estimateEnd != null && (() => {
          const lastYear = years.at(-1)!;
          const bx = x(lastYear) + 3;
          const y0 = y((untaxed.at(-1)?.change ?? 0) * scale), y1 = y(estimateEnd * scale);
          return (
            <g data-estimate stroke="#2a2f3a" strokeWidth={1.6}>
              <line x1={bx} x2={bx} y1={y0} y2={y1} strokeDasharray="3 3" />
              <line x1={bx - 4} x2={bx + 4} y1={y0} y2={y0} />
              <line x1={bx - 4} x2={bx + 4} y1={y1} y2={y1} />
              {/* Two lines ("回归估计的差距" / value and unit): on one line a unit such as 中心性原始单位 ran off the chart.
                  The head keeps its trailing space, so the text reads "回归估计的差距 -1.98 个百分点" when copied or read aloud. */}
              <text data-estimate-label x={bx + 7} y={slots.estimate + 4} fontSize={10.5} fill="#2a2f3a" stroke="none">
                <tspan x={bx + 7} dy={estimate.uncertain ? "-1.2em" : "-0.6em"}>{`${estimateHead} `}</tspan>
                <tspan x={bx + 7} dy="1.2em">{estimateValue}</tspan>
                {estimate.uncertain && <tspan data-estimate-uncertain x={bx + 7} dy="1.2em">（方向不确定）</tspan>}
              </text>
            </g>
          );
        })()}
        <line x1={policyX} x2={policyX} y1={padT - 8} y2={height - padB} stroke="#3a4050" strokeWidth={1.2} strokeDasharray="4 4" />
        <text x={policyX + 6} y={padT - 6} fontSize={11} fill="#3a4050">{policyYear} 年起加税</text>
        {([[untaxed, UNTAXED], [taxed, TAXED]] as const).map(([series, color]) => (
          <g key={color}>
            <path d={path(series)} fill="none" stroke={color} strokeWidth={2.4} />
            {series.map((point) => (
              <circle key={point.year} cx={x(point.year)} cy={y(point.change * scale)} r={3.5} fill={color}>
                <title>{`${point.year} 年：${(point.change * scale).toFixed(decimals + 1)} ${unit}`}</title>
              </circle>
            ))}
          </g>
        ))}
        {label(taxed, "被加税国家组", TAXED, "taxed")}
        {label(untaxed, "未被加税国家组", UNTAXED, "untaxed")}
      </svg>
      {/* The per-year values for keyboard and screen-reader users (the dots' tooltips need a mouse). */}
      <details className="chart-data-disclosure group-change-table">
        <summary>两组逐年读数</summary>
        <table className="data-table">
          <caption className="sr-only">{title}：相对 {years[0]}–{policyYear - 1} 年平均水平的变化（{unit}）</caption>
          <thead><tr><th scope="col">年份</th><th scope="col">被加税组（{unit}）</th><th scope="col">未被加税组（{unit}）</th></tr></thead>
          <tbody>{years.map((year) => {
            const cell = (series: { year: number; change: number }[]) => {
              const point = series.find((item) => item.year === year);
              return point ? (point.change * scale).toFixed(decimals + 1) : "—";
            };
            return <tr key={year}><th scope="row">{year}{year === policyYear ? "（起加税）" : ""}</th><td>{cell(taxed)}</td><td>{cell(untaxed)}</td></tr>;
          })}</tbody>
        </table>
      </details>
    </div>
  );
}
