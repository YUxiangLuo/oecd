import { isValidElement } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ScrollableRegion } from "./a11y";
import { niceDomain } from "./viz/nice-ticks";

type ChartItem = { label: string; value: number };
/** A bar may name the series it belongs to (e.g. a country); bars of one group share a colour. */
type BarItem = ChartItem & { group?: string };
type ChartPoint = ChartItem & { se?: number; ci_low?: number; ci_high?: number };
type CoefficientItem = ChartItem & { ci_low?: number; ci_high?: number };
/** A reference series (e.g. the global median) is drawn as a grey dashed line, not as a country. */
type LineSeries = { label: string; points: ChartItem[]; reference?: boolean };

type ReportChart =
  | {
      version: 1;
      type: "bar";
      title?: string;
      x_label?: string;
      y_label?: string;
      items: BarItem[];
    }
  | {
      version: 1;
      type: "coefficient";
      title?: string;
      x_label?: string;
      y_label?: string;
      items: CoefficientItem[];
    }
  | {
      version: 1;
      type: "event-study";
      title?: string;
      x_label?: string;
      y_label?: string;
      points: ChartPoint[];
    }
  | {
      version: 1;
      type: "line";
      title?: string;
      x_label?: string;
      y_label?: string;
      series: LineSeries[];
    };

const MAX_POINTS = 100;
const MAX_LABEL_LENGTH = 120;

function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_LABEL_LENGTH;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isItem(value: unknown): value is ChartItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return hasOnlyKeys(item, ["label", "value"])
    && isLabel(item.label)
    && typeof item.value === "number"
    && Number.isFinite(item.value);
}

function isBarItem(value: unknown): value is BarItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return hasOnlyKeys(item, ["label", "value", "group"])
    && isLabel(item.label)
    && (item.group == null || isLabel(item.group))
    && typeof item.value === "number"
    && Number.isFinite(item.value);
}

function isCoefficientItem(value: unknown): value is CoefficientItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!hasOnlyKeys(item, ["label", "value", "ci_low", "ci_high"])) return false;
  if (!isLabel(item.label) || typeof item.value !== "number" || !Number.isFinite(item.value)) return false;
  if (item.ci_low == null && item.ci_high == null) return true;
  return typeof item.ci_low === "number" && Number.isFinite(item.ci_low)
    && typeof item.ci_high === "number" && Number.isFinite(item.ci_high)
    && item.ci_low <= item.value && item.value <= item.ci_high;
}

function isPoint(value: unknown): value is ChartPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  if (!hasOnlyKeys(point, ["label", "value", "se", "ci_low", "ci_high"])) return false;
  if (!isLabel(point.label) || typeof point.value !== "number" || !Number.isFinite(point.value)) return false;
  const hasCi = point.ci_low != null || point.ci_high != null;
  if (hasCi) {
    return typeof point.ci_low === "number" && Number.isFinite(point.ci_low)
      && typeof point.ci_high === "number" && Number.isFinite(point.ci_high)
      && point.ci_low <= point.value && point.value <= point.ci_high
      && point.se == null;
  }
  // 仅用于渲染课程升级前已经持久化的 v1 报告；新报告始终发送后端 t(G−1) CI。
  return typeof point.se === "number" && Number.isFinite(point.se) && point.se >= 0;
}

function isLineSeries(value: unknown): value is LineSeries {
  if (!value || typeof value !== "object") return false;
  const series = value as Record<string, unknown>;
  return hasOnlyKeys(series, ["label", "points", "reference"])
    && (series.reference == null || typeof series.reference === "boolean")
    && isLabel(series.label)
    && Array.isArray(series.points)
    && series.points.length > 0
    && series.points.every(isItem)
    && new Set(series.points.map((point) => point.label)).size === series.points.length;
}

/** Parse only the versioned report-chart schema; arbitrary JSON/HTML never reaches the DOM. */
export function parseReportChart(source: string): ReportChart | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || (value.title != null && !isLabel(value.title))) return null;
  if (value.x_label != null && !isLabel(value.x_label)) return null;
  if (value.y_label != null && !isLabel(value.y_label)) return null;

  if (value.type === "bar") {
    if (!hasOnlyKeys(value, ["version", "type", "title", "x_label", "y_label", "items"])) return null;
    if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > MAX_POINTS) return null;
    if (!value.items.every(isBarItem)) return null;
    return value as ReportChart;
  }
  if (value.type === "coefficient") {
    if (!hasOnlyKeys(value, ["version", "type", "title", "x_label", "y_label", "items"])) return null;
    if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > 8) return null;
    if (!value.items.every(isCoefficientItem)) return null;
    return value as ReportChart;
  }
  if (value.type === "event-study") {
    if (!hasOnlyKeys(value, ["version", "type", "title", "x_label", "y_label", "points"])) return null;
    if (!Array.isArray(value.points) || value.points.length === 0 || value.points.length > MAX_POINTS) return null;
    if (!value.points.every(isPoint)) return null;
    return value as ReportChart;
  }
  if (value.type === "line") {
    if (!hasOnlyKeys(value, ["version", "type", "title", "x_label", "y_label", "series"])) return null;
    if (!Array.isArray(value.series) || value.series.length < 2 || value.series.length > 8) return null;
    if (!value.series.every(isLineSeries)) return null;
    if (new Set(value.series.map((series) => series.label)).size !== value.series.length) return null;
    if (value.series.reduce((count, series) => count + series.points.length, 0) > MAX_POINTS) return null;
    return value as ReportChart;
  }
  return null;
}

const fmt = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
  if (abs < 0.01 && value !== 0) return value.toFixed(4);
  return value.toFixed(3).replace(/\.0+$|(?<=\.[0-9]*)0+$/, "");
};

const GROUP_COLORS = ["#4b47e0", "#e0812e", "#198a78", "#7b4ab5"];

/** Approximate SVG text width: CJK glyphs take about one em, Latin about 0.6 em. */
function textWidth(text: string, size: number) {
  return [...text].reduce((width, char) => width + (/[⺀-￿]/.test(char) ? size : size * 0.6), 0);
}

/** Lay legend entries left to right, wrapping to a new row when the next entry would not fit. */
function legendLayout(labels: string[], left: number, right: number, size = 11) {
  let x = left;
  let row = 0;
  const positions = labels.map((label) => {
    const width = 24 + textWidth(label, size) + 18;
    if (x + width > right && x > left) {
      x = left;
      row += 1;
    }
    const position = { x, row };
    x += width;
    return position;
  });
  return { positions, rows: labels.length ? row + 1 : 0 };
}

function BarChart({ chart }: { chart: Extract<ReportChart, { type: "bar" }> }) {
  const W = 720;
  const barH = 18;
  const groups = [...new Set(chart.items.flatMap((item) => (item.group ? [item.group] : [])))];
  const grouped = groups.length > 0;
  const legend = legendLayout(groups, 220, W - 20);
  const m = { l: 220, r: 62, t: 14 + legend.rows * 20, b: 36 };
  // Grouped bars that share a label (e.g. one industry, two countries) sit together under one label.
  const rows: { y: number; first: boolean }[] = [];
  let cursor = m.t;
  chart.items.forEach((item, index) => {
    const first = index === 0 || !grouped || item.label !== chart.items[index - 1].label;
    if (index > 0) cursor += first ? (grouped ? 14 : 16) : 4;
    rows.push({ y: cursor, first });
    cursor += barH;
  });
  const H = cursor + m.b;
  const values = chart.items.map((item) => item.value);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const plotW = W - m.l - m.r;
  const x = (value: number) => m.l + ((value - min) / span) * plotW;
  const zero = x(0);
  const fill = (item: BarItem) =>
    item.group ? GROUP_COLORS[groups.indexOf(item.group) % GROUP_COLORS.length] : item.value < 0 ? "#d95f45" : "#4b47e0";
  const runEnd = (index: number) => {
    let end = index;
    while (end + 1 < rows.length && !rows[end + 1].first) end += 1;
    return end;
  };

  return (
    <ReportFigure title={chart.title ?? "指标 Top 5"}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.title ?? "指标条形图"} style={{ width: "100%", height: "auto" }}>
        {groups.map((group, index) => {
          const position = legend.positions[index];
          const y = 6 + position.row * 20;
          return (
            <g key={group}>
              <rect x={position.x} y={y} width={16} height={10} rx={2} fill={GROUP_COLORS[index % GROUP_COLORS.length]} fillOpacity={0.82} />
              <text x={position.x + 22} y={y + 9} fontSize={11} fill="#4b5563">{group}</text>
            </g>
          );
        })}
        <line x1={zero} x2={zero} y1={m.t - 5} y2={H - m.b} stroke="#cfd3dd" />
        {chart.items.map((item, i) => {
          const { y, first } = rows[i];
          const end = x(item.value);
          const left = Math.min(zero, end);
          const width = Math.max(1, Math.abs(end - zero));
          const labelY = first ? (y + rows[runEnd(i)].y + barH) / 2 + 4 : 0;
          return (
            <g key={`${item.group ?? ""}-${item.label}-${i}`}>
              {first && <text x={m.l - 10} y={labelY} textAnchor="end" fontSize={12} fill="#4b5563">{item.label}</text>}
              <rect x={left} y={y} width={width} height={barH} rx={4} fill={fill(item)} fillOpacity={0.82}>
                {item.group && <title>{`${item.group} · ${item.label}：${fmt(item.value)}`}</title>}
              </rect>
              <text x={item.value < 0 ? left - 6 : left + width + 6} y={y + 13} textAnchor={item.value < 0 ? "end" : "start"} fontSize={11} fill="#596173">{fmt(item.value)}</text>
            </g>
          );
        })}
        {(chart.y_label || chart.x_label) && <text x={m.l + plotW / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="#5f6677">{chart.y_label ?? chart.x_label}</text>}
      </svg>
    </ReportFigure>
  );
}

/** Symmetric "nice" ticks around 0, as on the step 11–14 coefficient plot. */
function symmetricTicks(maxAbs: number): number[] {
  const raw = maxAbs / 2;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => candidate >= raw) ?? raw;
  const count = Math.max(1, Math.ceil(maxAbs / step));
  return Array.from({ length: 2 * count + 1 }, (_, index) => (index - count) * step);
}

/** One row per estimate: a bar from 0 (red positive, blue negative) and the 95% interval as a capped whisker. */
function CoefficientChart({ chart }: { chart: Extract<ReportChart, { type: "coefficient" }> }) {
  const W = 720;
  const rowH = 64;
  const m = { l: 170, r: 30, t: 16, b: 46 };
  const H = m.t + chart.items.length * rowH + m.b;
  const plotW = W - m.l - m.r;
  const hasCi = chart.items.some((item) => item.ci_low != null && item.ci_high != null);
  const maxAbs = Math.max(
    ...chart.items.map((item) => Math.max(Math.abs(item.ci_low ?? item.value), Math.abs(item.ci_high ?? item.value))),
    1e-6,
  ) * 1.08;
  const ticks = symmetricTicks(maxAbs);
  const extent = ticks.at(-1)!;
  const x = (value: number) => m.l + ((value + extent) / (2 * extent)) * plotW;
  const y = (index: number) => m.t + (index + 0.5) * rowH;
  const decimals = Math.max(0, Math.min(4, 1 - Math.floor(Math.log10(extent / 2))));
  const tick = (value: number) => (value === 0 ? "0" : value.toFixed(decimals));
  const value = (number: number) => number.toFixed(Math.max(2, decimals));

  return (
    <ReportFigure title={chart.title ?? "系数图"}>
      <div style={{ fontSize: 11, color: "#5f6677", marginBottom: 6 }}>
        {hasCi
          ? "条形 = 点估计（红为正、蓝为负） · 横线 = 标称 95% 近似区间 · 竖线 = 0；区间跨过 0 时方向不确定"
          : "统计推断已抑制，只显示描述性点估计，不能据此判断方向"}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.title ?? "系数图"} style={{ width: "100%", height: "auto" }}>
        {ticks.map((tickValue) => (
          <g key={tickValue}>
            {tickValue !== 0 && <line x1={x(tickValue)} x2={x(tickValue)} y1={m.t} y2={H - m.b} stroke="#eef0f4" />}
            <text x={x(tickValue)} y={H - m.b + 16} textAnchor="middle" fontSize={11} fill="#5f6677">{tick(tickValue)}</text>
          </g>
        ))}
        <line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} stroke="#d7dae2" />
        {chart.x_label && <text x={m.l + plotW / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="#5f6677">{chart.x_label}</text>}
        {chart.items.map((item, index) => {
          const color = !hasCi ? "#b6bac6" : item.value >= 0 ? "#d64545" : "#2f6fd0";
          const barX = Math.min(x(0), x(item.value));
          const barW = Math.max(1, Math.abs(x(item.value) - x(0)));
          const labelAt = Math.min(Math.max(x(item.value), m.l + 24), W - m.r - 24);
          return (
            <g key={`${item.label}-${index}`}>
              <text x={m.l - 12} y={y(index) + 4} textAnchor="end" fontSize={12} fill="#3a4050">{item.label}</text>
              <rect x={barX} y={y(index) - 11} width={barW} height={22} rx={2} fill={color} fillOpacity={0.85} />
              {item.ci_low != null && item.ci_high != null && (
                <g stroke="#2a2f3a" strokeWidth={1.6}>
                  <line x1={x(item.ci_low)} x2={x(item.ci_high)} y1={y(index)} y2={y(index)} />
                  <line x1={x(item.ci_low)} x2={x(item.ci_low)} y1={y(index) - 7} y2={y(index) + 7} />
                  <line x1={x(item.ci_high)} x2={x(item.ci_high)} y1={y(index) - 7} y2={y(index) + 7} />
                </g>
              )}
              <circle cx={x(item.value)} cy={y(index)} r={4} fill="#fff" stroke="#2a2f3a" strokeWidth={1.6} />
              <text x={labelAt} y={y(index) - 21} textAnchor="middle" fontSize={11.5} fontWeight={700} fill="#2a2f3a">
                {value(item.value)}
                {item.ci_low != null && item.ci_high != null ? `  [${value(item.ci_low)}, ${value(item.ci_high)}]` : ""}
              </text>
            </g>
          );
        })}
        <line x1={x(0)} x2={x(0)} y1={m.t - 6} y2={H - m.b} stroke="#1f2430" strokeWidth={1.8} />
      </svg>
    </ReportFigure>
  );
}

function EventChart({ chart }: { chart: Extract<ReportChart, { type: "event-study" }> }) {
  const W = 720;
  const H = 280;
  const m = { l: 66, r: 26, t: 22, b: 46 };
  const intervals = chart.points.map((point) => ({
    ...point,
    lo: point.ci_low ?? point.value - 1.96 * (point.se ?? 0),
    hi: point.ci_high ?? point.value + 1.96 * (point.se ?? 0),
  }));
  const extent = Math.max(...intervals.flatMap((point) => [Math.abs(point.lo), Math.abs(point.hi)]), 1e-6) * 1.12;
  const plotW = W - m.l - m.r;
  const plotH = H - m.t - m.b;
  const x = (i: number) => m.l + ((i + 0.5) / intervals.length) * plotW;
  const y = (value: number) => m.t + ((extent - value) / (2 * extent)) * plotH;

  return (
    <ReportFigure title={chart.title ?? "事件研究动态效应"}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.title ?? "事件研究动态图"} style={{ width: "100%", height: "auto" }}>
        {[-extent, 0, extent].map((tick) => (
          <g key={tick}>
            <line x1={m.l} x2={W - m.r} y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? "#b9bec9" : "#eceef3"} />
            <text x={m.l - 8} y={y(tick) + 4} textAnchor="end" fontSize={10} fill="#5f6677">{fmt(tick)}</text>
          </g>
        ))}
        {intervals.map((point, i) => (
          <g key={`${point.label}-${i}`}>
            <line x1={x(i)} x2={x(i)} y1={y(point.lo)} y2={y(point.hi)} stroke="#7773df" strokeWidth={2} />
            <circle cx={x(i)} cy={y(point.value)} r={5} fill="#4b47e0" stroke="#fff" strokeWidth={2} />
            <text x={x(i)} y={H - m.b + 18} textAnchor="middle" fontSize={11} fill="#596173">{point.label}</text>
          </g>
        ))}
        {chart.y_label && <text x={14} y={m.t + plotH / 2} textAnchor="middle" fontSize={11} fill="#5f6677" transform={`rotate(-90 14 ${m.t + plotH / 2})`}>{chart.y_label}</text>}
        {chart.x_label && <text x={m.l + plotW / 2} y={H - 7} textAnchor="middle" fontSize={11} fill="#5f6677">{chart.x_label}</text>}
      </svg>
    </ReportFigure>
  );
}

function LineChart({ chart }: { chart: Extract<ReportChart, { type: "line" }> }) {
  const W = 720;
  const legend = legendLayout(chart.series.map((series) => series.label), 68, W - 26);
  const m = { l: 68, r: 26, t: 24 + legend.rows * 18, b: 48 };
  const H = 292 + legend.rows * 18;
  const colors = ["#4b47e0", "#d95f45", "#198a78", "#b36b00", "#7b4ab5", "#3274a1", "#657000", "#a44078"];
  const labels = [...new Set(chart.series.flatMap((series) => series.points.map((point) => point.label)))];
  const values = chart.series.flatMap((series) => series.points.map((point) => point.value));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = (rawMax - rawMin || Math.max(Math.abs(rawMax), 1)) * 0.12;
  // Non-negative series (amounts, shares, lengths) must not get a negative axis tick from padding.
  const axis = niceDomain(rawMin >= 0 ? Math.max(0, rawMin - padding) : rawMin - padding, rawMax + padding, 3);
  const min = axis.lo;
  const max = axis.hi;
  const plotW = W - m.l - m.r;
  const plotH = H - m.t - m.b;
  const x = (label: string) => m.l + (labels.length === 1 ? plotW / 2 : labels.indexOf(label) / (labels.length - 1) * plotW);
  const y = (value: number) => m.t + (max - value) / (max - min) * plotH;
  const ticks = axis.ticks;

  return (
    <ReportFigure title={chart.title ?? "两国历年趋势"}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.title ?? "两国历年趋势折线图"} style={{ width: "100%", height: "auto" }}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={m.l} x2={W - m.r} y1={y(tick)} y2={y(tick)} stroke="#e5e7ed" />
            <text x={m.l - 8} y={y(tick) + 4} textAnchor="end" fontSize={10} fill="#5f6677">{fmt(tick)}</text>
          </g>
        ))}
        {chart.series.map((series, seriesIndex) => {
          const reference = series.reference === true;
          const color = reference
            ? "#8a8f9c"
            : colors[chart.series.slice(0, seriesIndex).filter((item) => item.reference !== true).length];
          return (
            <g key={series.label}>
              <polyline
                points={series.points.map((point) => `${x(point.label)},${y(point.value)}`).join(" ")}
                fill="none"
                stroke={color}
                strokeWidth={reference ? 1.8 : 2.5}
                strokeDasharray={reference ? "6 4" : undefined}
                strokeLinejoin="round"
              />
              {series.points.map((point) => <circle key={point.label} cx={x(point.label)} cy={y(point.value)} r={reference ? 2.5 : 4} fill={color} stroke="#fff" strokeWidth={1.5} />)}
              <line x1={legend.positions[seriesIndex].x} x2={legend.positions[seriesIndex].x + 18} y1={14 + legend.positions[seriesIndex].row * 18} y2={14 + legend.positions[seriesIndex].row * 18} stroke={color} strokeWidth={reference ? 2 : 3} strokeDasharray={reference ? "5 3" : undefined} />
              <text x={legend.positions[seriesIndex].x + 24} y={18 + legend.positions[seriesIndex].row * 18} fontSize={11} fill="#4b5563">{series.label}</text>
            </g>
          );
        })}
        {labels.map((label) => <text key={label} x={x(label)} y={H - m.b + 18} textAnchor="middle" fontSize={10} fill="#596173">{label}</text>)}
        {chart.y_label && <text x={14} y={m.t + plotH / 2} textAnchor="middle" fontSize={11} fill="#5f6677" transform={`rotate(-90 14 ${m.t + plotH / 2})`}>{chart.y_label}</text>}
        {chart.x_label && <text x={m.l + plotW / 2} y={H - 7} textAnchor="middle" fontSize={11} fill="#5f6677">{chart.x_label}</text>}
      </svg>
    </ReportFigure>
  );
}

function ReportFigure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <figure style={{ margin: "18px 0", padding: "14px 16px", border: "1px solid #e7e9f0", borderRadius: 12, breakInside: "avoid" }}>
      <figcaption style={{ fontSize: 13, fontWeight: 700, color: "#303747", marginBottom: 6 }}>{title}</figcaption>
      {children}
    </figure>
  );
}

function ReportCode({ className, children, ...props }: ComponentPropsWithoutRef<"code">) {
  const source = String(children ?? "").replace(/\n$/, "");
  if (className?.split(" ").includes("language-gvcsim-chart")) {
    const chart = parseReportChart(source);
    if (chart?.type === "bar") return <BarChart chart={chart} />;
    if (chart?.type === "coefficient") return <CoefficientChart chart={chart} />;
    if (chart?.type === "event-study") return <EventChart chart={chart} />;
    if (chart?.type === "line") return <LineChart chart={chart} />;
  }
  return <code className={className} {...props}>{children}</code>;
}

function ReportPre({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  if (isValidElement<{ className?: string; children?: ReactNode }>(children)) {
    const className = children.props.className;
    if (className?.split(" ").includes("language-gvcsim-reflection")) {
      return <div className="report-student-prose" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "14px 0" }}>
        {String(children.props.children ?? "").replace(/\n$/, "")}
      </div>;
    }
    if (className?.split(" ").includes("language-gvcsim-chart")) {
      const chart = parseReportChart(String(children.props.children ?? "").replace(/\n$/, ""));
      if (chart?.type === "bar") return <BarChart chart={chart} />;
    if (chart?.type === "coefficient") return <CoefficientChart chart={chart} />;
      if (chart?.type === "event-study") return <EventChart chart={chart} />;
      if (chart?.type === "line") return <LineChart chart={chart} />;
    }
  }
  return <pre {...props}>{children}</pre>;
}

// Minimal HAST shape: this transformer only reads headings/text and names tables.
// Work on the parsed tree rather than a render-time counter (React may re-render
// children independently) or a Markdown regex (code fences may contain headings).
type ReportNode = {
  type: string;
  tagName?: string;
  value?: string;
  children?: ReportNode[];
  properties?: Record<string, unknown>;
};

function rehypeReportTableLabels() {
  return (tree: ReportNode) => {
    let heading = "";
    let tableIndex = 0;
    const text = (node: ReportNode): string => node.type === "text"
      ? node.value ?? ""
      : (node.children ?? []).map(text).join("");
    const visit = (node: ReportNode) => {
      if (node.type === "element" && /^h[1-6]$/.test(node.tagName ?? "")) {
        heading = text(node).replace(/\s+/g, " ").trim();
      }
      if (node.type === "element" && node.tagName === "table") {
        tableIndex += 1;
        node.properties = {
          ...node.properties,
          ariaLabel: `报告数据表 ${tableIndex}${heading ? `：${heading}` : ""}，可横向滚动`,
        };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/** Shared student/teacher report body. Raw HTML is intentionally not enabled. */
export function ReportMarkdown({ markdown, className = "report-md" }: { markdown: string; className?: string }) {
  return (
    <article className={className} style={{ whiteSpace: "normal" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeReportTableLabels]}
        skipHtml
        components={{
          code: ReportCode,
          pre: ReportPre,
          table: ({ node: _node, children, ...props }) => (
            <ScrollableRegion
              className="table-wrap"
              label={props["aria-label"]}
              style={{ margin: "14px 0" }}
            >
              <table className="data-table" {...props}>{children}</table>
            </ScrollableRegion>
          ),
          h1: ({ children, ...props }) => <h1 style={{ breakAfter: "avoid" }} {...props}>{children}</h1>,
          h2: ({ children, ...props }) => <h2 style={{ breakAfter: "avoid", marginTop: 24 }} {...props}>{children}</h2>,
          h3: ({ children, ...props }) => <h3 style={{ breakAfter: "avoid", marginTop: 20 }} {...props}>{children}</h3>,
          blockquote: ({ children, ...props }) => (
            <blockquote style={{ margin: "14px 0", padding: "8px 14px", borderLeft: "3px solid #4b47e0", background: "#f7f8fb", color: "#596173" }} {...props}>{children}</blockquote>
          ),
          // 提交内容会在教师端打开；禁用 Markdown 图片，避免自动请求学生指定的外部跟踪 URL。
          // 链接保留可点(react-markdown 默认 urlTransform 已拦截 javascript: 等危险协议),
          // 教师主动点击学生提供的外部链接是已接受的残余风险。
          img: ({ alt }) => <span className="muted">[图片已禁用{alt ? `：${alt}` : ""}]</span>,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  );
}
