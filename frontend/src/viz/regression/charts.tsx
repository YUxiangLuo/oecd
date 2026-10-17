import { stripNegativeZero, unitText } from "../../format";
import { cardStyle } from "../shared";

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

/** One line of the 加税前后 chart: a group's mean change, relative to its own mean before the first tariff year. */
export interface GroupLine {
  key: string;
  label: string;
  color: string;
  points: { year: number; change: number }[];
  /** Drawn dashed too, so two lines of one colour family never differ by colour alone. */
  dashed?: boolean;
}

/**
 * Each group's mean Y minus its own mean before the first tariff year: the first wave, the second wave and the
 * untaxed countries (teaching data v10). A dashed vertical line marks each wave's start; the gap that opens after
 * it is what the regression then quantifies (together with what else changed at the same time).
 */
export function GroupChangeChart({
  years, markers, lines, scale = 1, unit, title,
}: {
  years: number[];
  /** Tariff start years, with their labels ("2018 年第一批加税"); the first one ends the baseline period. */
  markers: { year: number; label: string }[];
  lines: GroupLine[];
  /** Multiplier from stored Y units to displayed units (e.g. 100 for shares shown in percentage points). */
  scale?: number;
  unit: string;
  title: string;
}) {
  const width = 640, height = 250, padL = 64, padR = 140, padT = 30, padB = 34;
  const values = lines.flatMap((line) => line.points.map((point) => point.change * scale));
  const maxAbs = (Math.max(0, ...values.map(Math.abs)) || 1) * 1.1;
  const ticks = niceSymmetricTicks(maxAbs);
  const extent = ticks.at(-1)!;
  const decimals = Math.max(0, Math.min(4, 1 - Math.floor(Math.log10(extent / 2))));
  const small = extent < 1e-4;
  // A per-year reading; a small change that rounds to zero reads "0.00", never "-0.00".
  const reading = (change: number) => small
    ? String(Number((change * scale).toPrecision(4)))
    : stripNegativeZero((change * scale).toFixed(decimals + 1));
  // A dimensionless Y (the position index) has its unit named once, in the axis title; its readings are bare numbers.
  const withUnit = (text: string) => (unit === "无量纲" ? text : `${text} ${unit}`);
  const x = (year: number) => padL + ((year - years[0]) / Math.max(1, years.at(-1)! - years[0])) * (width - padL - padR);
  const y = (value: number) => padT + ((extent - value) / (2 * extent)) * (height - padT - padB);
  const path = (series: { year: number; change: number }[]) => series
    .map((point, index) => `${index ? "L" : "M"}${x(point.year)},${y(point.change * scale)}`).join(" ");
  // On the wave's first taxed year, as every chart of steps 10–14 marks a tariff (halfway before it read as the year
  // before).
  const markerX = (year: number) => x(year);
  const firstPolicy = markers[0]?.year ?? years[1];
  const baseline = years.length && firstPolicy != null
    ? `相对 ${years[0]}–${firstPolicy - 1} 年平均水平的变化`
    : "相对基期平均水平的变化（基期未指定）";
  // The group names sit at their line ends, pushed apart only from each other when lines end close together.
  const slots = spreadLabels(
    lines.filter((line) => line.points.length).map((line) => ({ key: line.key, at: y(line.points.at(-1)!.change * scale), size: 14 })),
    padT, height - 4,
  );
  const description = `${title}：${lines.map((line) => line.label).join("、")}相对加税前平均水平的变化；${markers.map((marker) => marker.label).join("，")}`;
  return (
    <div className="group-change-chart" style={{ ...cardStyle, flex: "1 1 320px", minWidth: 280 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#3a4050" }}>{title}</div>
      <div style={{ fontSize: 11, color: "#5f6677", marginBottom: 6 }}>
        纵轴：{baseline}（{unitText(unit)}）
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={description} style={{ display: "block", width: "100%", maxWidth: 760, height: "auto" }}>
        <title>{description}</title>
        {ticks.map((value) => (
          <g key={value}>
            <line x1={padL} x2={width - padR} y1={y(value)} y2={y(value)} stroke={value === 0 ? "#9aa0ad" : "#eef0f4"} strokeWidth={1} />
            <text x={padL - 8} y={y(value)} dominantBaseline="middle" textAnchor="end" fontSize={11} fill="#5f6677">{value === 0 ? "0" : small ? String(Number(value.toPrecision(3))) : stripNegativeZero(value.toFixed(decimals))}</text>
          </g>
        ))}
        {years.map((year) => <text key={year} x={x(year)} y={height - 12} textAnchor="middle" fontSize={11} fill="#5f6677">{year}</text>)}
        {markers.map((marker, index) => (
          <g key={marker.year} data-marker={marker.year}>
            <line x1={markerX(marker.year)} x2={markerX(marker.year)} y1={padT - 10 + index * 12} y2={height - padB} stroke="#3a4050" strokeWidth={1.2} strokeDasharray="4 4" />
            {/* Stacked, so two wave labels a year apart never overlap. */}
            <text x={markerX(marker.year) + 6} y={padT - 18 + index * 12} fontSize={10.5} fill="#3a4050">{marker.label}</text>
          </g>
        ))}
        {lines.map((line) => (
          <g key={line.key} data-line={line.key}>
            <path d={path(line.points)} fill="none" stroke={line.color} strokeWidth={2.4} strokeDasharray={line.dashed ? "6 3" : undefined} />
            {line.points.map((point) => (
              <circle key={point.year} cx={x(point.year)} cy={y(point.change * scale)} r={3.5} fill={line.color}>
                <title>{`${line.label} ${point.year} 年：${withUnit(reading(point.change))}`}</title>
              </circle>
            ))}
            {line.points.length > 0 && (
              <text x={x(line.points.at(-1)!.year) + 8} y={slots[line.key]} dominantBaseline="middle" fontSize={11.5} fontWeight={700} fill={line.color}>{svgTextWidth(line.label, 11.5) > padR - 12 ? `${[...line.label].slice(0, 10).join("")}…` : line.label}<title>{line.label}</title></text>
            )}
          </g>
        ))}
      </svg>
      {/* The per-year values for keyboard and screen-reader users (the dots' tooltips need a mouse). */}
      <details className="chart-data-disclosure group-change-table">
        <summary>各组逐年读数</summary>
        <table className="data-table">
          <caption className="sr-only">{title}：{baseline}（{unitText(unit)}）</caption>
          <thead><tr><th scope="col">年份</th>{lines.map((line) => <th key={line.key} scope="col">{line.label}（{unitText(unit)}）</th>)}</tr></thead>
          <tbody>{years.map((year) => {
            const marker = markers.find((item) => item.year === year);
            return (
              <tr key={year}>
                <th scope="row">{year}{marker ? `（${marker.label.replace(/^\d+ 年/, "")}）` : ""}</th>
                {lines.map((line) => {
                  const point = line.points.find((item) => item.year === year);
                  return <td key={line.key}>{point ? reading(point.change) : "—"}</td>;
                })}
              </tr>
            );
          })}</tbody>
        </table>
      </details>
    </div>
  );
}
