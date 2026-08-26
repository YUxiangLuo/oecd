import { useId } from "react";
import { ScrollableRegion } from "../../a11y";
import { formatMetric } from "../../format";
import type { IndicatorSchema } from "../../types";
import { type Row, SEQ, cardStyle, rowLabel } from "../shared";

/* ----------------------------- 步骤10:热力表 ----------------------------- */

export const HEAT_EVIDENCE_METRIC = "betweenesscentrality" as const;
export const HEAT_WEIGHTED_DEGREE_METRIC = "weighted degree" as const;
export type HeatSortMetric = typeof HEAT_EVIDENCE_METRIC | typeof HEAT_WEIGHTED_DEGREE_METRIC;
export type HeatCoverage = "top15" | "all";
export interface HeatViewOptions {
  sortMetric: HeatSortMetric;
  coverage: HeatCoverage;
}

export const DEFAULT_HEAT_VIEW: HeatViewOptions = {
  sortMetric: HEAT_EVIDENCE_METRIC,
  coverage: "top15",
};

export const HEAT_SORT_OPTIONS: { key: HeatSortMetric; label: string }[] = [
  { key: HEAT_EVIDENCE_METRIC, label: "介数中心性" },
  { key: HEAT_WEIGHTED_DEGREE_METRIC, label: "加权度" },
];
export const HEAT_COVERAGE_OPTIONS: { key: HeatCoverage; label: string }[] = [
  { key: "top15", label: "Top 15" },
  { key: "all", label: "全部有限行业" },
];

export function normalizeHeatSortMetric(value: unknown): HeatSortMetric {
  return value === HEAT_WEIGHTED_DEGREE_METRIC ? value : HEAT_EVIDENCE_METRIC;
}

export function normalizeHeatCoverage(value: unknown): HeatCoverage {
  return value === "all" ? value : "top15";
}

export function sameHeatView(first: HeatViewOptions, second: HeatViewOptions): boolean {
  return first.sortMetric === second.sortMetric && first.coverage === second.coverage;
}

export function heatSortLabel(metric: HeatSortMetric): string {
  return HEAT_SORT_OPTIONS.find((option) => option.key === metric)?.label ?? "介数中心性";
}

export function heatCoverageLabel(coverage: HeatCoverage): string {
  return HEAT_COVERAGE_OPTIONS.find((option) => option.key === coverage)?.label ?? "Top 15";
}

const HEAT_COLS = [
  { key: HEAT_WEIGHTED_DEGREE_METRIC, name: "加权度", fmt: "amount", desc: "与该节点直接相连的中间投入边流量总和(百万美元)。" },
  { key: HEAT_EVIDENCE_METRIC, name: "介数中心性", fmt: "raw", desc: "各有序节点对最短路径经过该节点的份额之和；未按节点对数归一化。" },
  { key: "closnesscentrality", name: "接近中心性", fmt: "num", desc: "沿出边可达节点数除以到这些节点的最短距离之和。" },
  { key: "harmonicclosnesscentrality", name: "调和中心性", fmt: "num", desc: "沿出边到可达节点的距离倒数平均值。" },
  { key: "eigencentrality", name: "特征向量中心性", fmt: "num", desc: "按入边邻居的重要性迭代并以最大值归一。" },
] as const;

const fmtVal = (v: number, fmt: string) => formatMetric(v, fmt === "amount" ? "amount" : "number");
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export const heatTextColor = (colorIndex: number) => colorIndex >= 4 ? "#fff" : "#1b1f2b";

export function heatRowKey(row: Row): string {
  return `${String(row.country ?? "")}\u0000${String(row.industry ?? "")}`;
}

/** The sole collection used for both rendering and evidence eligibility. */
export function visibleHeatRows(
  rows: readonly Row[],
  sortMetric: HeatSortMetric = DEFAULT_HEAT_VIEW.sortMetric,
  coverage: HeatCoverage = DEFAULT_HEAT_VIEW.coverage,
): Row[] {
  const sorted = rows
    // Every visible row must support both the chosen ordering and the fixed report metric.
    .filter((row) => finite(row[sortMetric]) && finite(row[HEAT_EVIDENCE_METRIC]))
    .map((row, sourceIndex) => ({ row, sourceIndex }))
    .sort((first, second) => {
      const valueOrder = (second.row[sortMetric] as number) - (first.row[sortMetric] as number);
      return valueOrder || first.sourceIndex - second.sourceIndex;
    });
  return (coverage === "top15" ? sorted.slice(0, 15) : sorted).map(({ row }) => row);
}

export interface HeatActivation {
  row: Row;
  rowKey: string;
  metric: typeof HEAT_EVIDENCE_METRIC;
  visibleIndex: number;
  sortMetric: HeatSortMetric;
  coverage: HeatCoverage;
}

export function heatActivationForRow(
  rows: readonly Row[],
  requestedRowKey: string,
  sortMetric: HeatSortMetric = DEFAULT_HEAT_VIEW.sortMetric,
  coverage: HeatCoverage = DEFAULT_HEAT_VIEW.coverage,
): HeatActivation | null {
  const visible = visibleHeatRows(rows, sortMetric, coverage);
  const visibleIndex = visible.findIndex((row) => heatRowKey(row) === requestedRowKey);
  if (visibleIndex < 0) return null;
  const row = visible[visibleIndex];
  return {
    row,
    rowKey: heatRowKey(row),
    metric: HEAT_EVIDENCE_METRIC,
    visibleIndex,
    sortMetric,
    coverage,
  };
}

export function HeatTableViz({
  rows,
  schema,
  onActivate,
  activeRowKey = null,
  sortMetric = DEFAULT_HEAT_VIEW.sortMetric,
  coverage = DEFAULT_HEAT_VIEW.coverage,
  countryName,
}: {
  rows: Row[];
  schema?: IndicatorSchema | null;
  onActivate: (activation: HeatActivation) => void;
  activeRowKey?: string | null;
  sortMetric?: HeatSortMetric;
  coverage?: HeatCoverage;
  countryName?: string;
}) {
  const definitionsId = `heat-definitions-${useId().replaceAll(":", "")}`;
  const isIndustry = rows.some((row) => row.industry != null);
  const visible = visibleHeatRows(rows, sortMetric, coverage);
  const maxOf: Record<string, number> = {};
  HEAT_COLS.forEach((column) => {
    const values = visible.map((row) => row[column.key]).filter(finite);
    maxOf[column.key] = Math.max(...values, 1e-9);
  });
  const cell = (row: Row, key: string, fmt: string, name: string) => {
    const raw = row[key];
    if (!finite(raw)) {
      return (
        <span
          data-metric-unavailable="true"
          aria-label={`${name}不可用`}
          title={`${name}不可用`}
          style={{
            display: "inline-block", minWidth: 92, padding: "5px 6px", borderRadius: 7, textAlign: "center",
            background: "#f2f3f7", color: "#5f6677", fontSize: 12,
          }}
        >—</span>
      );
    }
    const index = Math.max(0, Math.min(SEQ.length - 1, Math.floor((raw / maxOf[key]) * SEQ.length)));
    return (
      <span style={{
        display: "inline-block", minWidth: 92, padding: "5px 6px", borderRadius: 7, textAlign: "center",
        background: SEQ[index], color: heatTextColor(index),
        fontSize: 12, fontVariantNumeric: "tabular-nums",
      }}>{fmtVal(raw, fmt)}</span>
    );
  };
  const shownCountry = countryName ?? String(visible[0]?.country ?? rows[0]?.country ?? "所选国家");
  const sortLabel = heatSortLabel(sortMetric);
  const coverageLabel = heatCoverageLabel(coverage);
  return (
    <ScrollableRegion
      className="heat-table-scroll"
      label="行业节点中心性热力表，可横向滚动"
      style={{ ...cardStyle, padding: 0 }}
    >
      <table
        className="heat-table-grid data-table"
        data-sort-metric={sortMetric}
        data-coverage={coverage}
        aria-describedby={definitionsId}
      >
        <caption style={{ textAlign: "left", padding: "12px 16px", color: "#3a4050", lineHeight: 1.6 }}>
          {shownCountry}行业节点中心性；在完整全球国家×行业图上计算，按{sortLabel}降序显示{coverageLabel}。
          排序与范围只改变可见行；“记录介数”始终保存介数中心性，不随排序指标改变。
        </caption>
        <thead>
          <tr>
            <th scope="col">{isIndustry ? "行业节点" : "国家 / 地区"}</th>
            {HEAT_COLS.map((column) => (
              <th key={column.key} scope="col">{column.name}</th>
            ))}
            <th scope="col">报告证据（固定介数中心性）</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const rowKey = heatRowKey(row);
            const selected = rowKey === activeRowKey;
            return (
              <tr key={rowKey} className={selected ? "heat-row-recorded" : undefined}>
                <th scope="row" title={row.industry != null ? String(row.industry) : undefined}>{rowLabel(row)}</th>
                {HEAT_COLS.map((column) => (
                  <td key={column.key} style={{ textAlign: "center" }}>
                    {cell(row, column.key, column.fmt, column.name)}
                  </td>
                ))}
                <td style={{ textAlign: "center" }}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-label={`${selected ? "已记录" : "记录"}${rowLabel(row)}的介数中心性观测；当前按${sortLabel}排序，记录指标固定为介数中心性`}
                    onClick={() => {
                      const activation = heatActivationForRow(rows, rowKey, sortMetric, coverage);
                      if (activation) onActivate(activation);
                    }}
                  >
                    {selected ? "已记录介数" : "记录介数"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div id={definitionsId} style={{ padding: "10px 16px", fontSize: 11, color: "#5f6677", lineHeight: 1.65 }}>
        <b>指标定义：</b>
        {HEAT_COLS.map((column) => (
          <span key={column.key}> {schema?.fields[column.key]?.label ?? column.name}：{schema?.fields[column.key]?.desc ?? column.desc}</span>
        ))}
        <div>
          颜色深浅表示该列当前可见行内的相对大小（每列独立归一化）。只有明确按下可见行的“记录介数”按钮才会保存报告证据；排序、切换范围、渲染、悬停和聚焦都不会记录。
        </div>
      </div>
    </ScrollableRegion>
  );
}
