import { useId } from "react";
import { ScrollableRegion } from "../../a11y";
import { cjkSpace, formatMetric } from "../../format";
import type { IndicatorSchema } from "../../types";
import { type Row, SEQ, cardStyle, rowLabel } from "../shared";

/* ----------------------------- 步骤9:热力表 ----------------------------- */

export const HEAT_EVIDENCE_METRIC = "betweenesscentrality" as const;

/**
 * Path metrics follow a node's out-edges to the nodes it can reach. A node that reaches none gets 0 from the
 * pipeline (as Gephi does), but closeness, eccentricity and harmonic closeness (Σ 1/d ÷ reachable nodes) are then
 * 0/0: undefined, not "very far". In 2016–2020 these are the isolated nodes (no intermediate purchases or sales,
 * mostly T) and two sinks whose only out-edge is a self-loop (CMR·Q, PER·Q). Betweenness and degrees are real.
 */
export const PATH_METRICS: ReadonlySet<string> = new Set(["Eccentricity", "closnesscentrality", "harmonicclosnesscentrality"]);
export const PATH_UNDEFINED_LABEL = "到不了其他节点，无法定义";
export const PATH_UNDEFINED_NOTE = "沿供货方向到不了其他国家×行业（多为既不买也不卖中间品的行业，如 T 家庭自用生产；少数只向自己供货），距离没有定义";
export function pathMetricUndefined(metric: string, value: unknown): boolean {
  return PATH_METRICS.has(metric) && value === 0;
}
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
  { key: HEAT_EVIDENCE_METRIC, label: "介数" },
  { key: HEAT_WEIGHTED_DEGREE_METRIC, label: "加权总度" },
];
export const HEAT_COVERAGE_OPTIONS: { key: HeatCoverage; label: string }[] = [
  { key: "top15", label: "前 15 个" },
  { key: "all", label: "全部行业" },
];

export function normalizeHeatSortMetric(value: unknown): HeatSortMetric {
  return value === HEAT_WEIGHTED_DEGREE_METRIC ? value : HEAT_EVIDENCE_METRIC;
}

export function normalizeHeatCoverage(value: unknown): HeatCoverage {
  return value === "all" ? value : "top15";
}

export function heatSortLabel(metric: HeatSortMetric): string {
  return HEAT_SORT_OPTIONS.find((option) => option.key === metric)?.label ?? "介数";
}

export function heatCoverageLabel(coverage: HeatCoverage): string {
  return HEAT_COVERAGE_OPTIONS.find((option) => option.key === coverage)?.label ?? "前 15 个";
}

const HEAT_COLS = [
  { key: HEAT_WEIGHTED_DEGREE_METRIC, name: "加权总度", fmt: "amount", desc: "买入 + 卖出的金额（百万美元）；自环（行业卖给自己的部分）在两边各计一次。" },
  { key: HEAT_EVIDENCE_METRIC, name: "介数", fmt: "count", desc: "只看连接、不看金额：经过该行业的最短路线所占比例，对所有节点对求和（未归一化）。" },
  { key: "closnesscentrality", name: "接近中心性", fmt: "num", desc: "沿出边可达节点数除以到这些节点的最短距离之和。" },
  { key: "harmonicclosnesscentrality", name: "调和中心性", fmt: "num", desc: "沿出边到可达节点的距离倒数平均值。" },
  { key: "eigencentrality", name: "特征向量中心性（软件近似）", fmt: "num", desc: "被重要节点连接的节点得分更高；按 Gephi 网络软件的算法近似计算，只作参考。" },
] as const;

// Unnormalised betweenness sums shares of shortest routes over node pairs, so it is rarely a whole number; from 1 up
// it is rounded to one ("13", not "13.188" beside "4,769"), as in the step 9 charts and the report.
const fmtVal = (v: number, fmt: string) => formatMetric(v, fmt === "amount" ? "amount" : fmt === "count" && Math.abs(v) >= 1 ? "count" : "number");
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export const heatTextColor = (colorIndex: number) => colorIndex >= 4 ? "#fff" : "#1b1f2b";

export function heatRowKey(row: Row): string {
  return `${String(row.country ?? "")}\u0000${String(row.industry ?? "")}`;
}

/** Sorting affects display only; unavailable secondary metrics remain visible. */
export function visibleHeatRows(
  rows: readonly Row[],
  sortMetric: HeatSortMetric = DEFAULT_HEAT_VIEW.sortMetric,
  coverage: HeatCoverage = DEFAULT_HEAT_VIEW.coverage,
): Row[] {
  const sorted = rows
    .filter((row) => finite(row[sortMetric]))
    .map((row, sourceIndex) => ({ row, sourceIndex }))
    .sort((first, second) => {
      const valueOrder = (second.row[sortMetric] as number) - (first.row[sortMetric] as number);
      return valueOrder || first.sourceIndex - second.sourceIndex;
    });
  return (coverage === "top15" ? sorted.slice(0, 15) : sorted).map(({ row }) => row);
}

export function HeatTableViz({
  rows,
  schema,
  sortMetric = DEFAULT_HEAT_VIEW.sortMetric,
  coverage = DEFAULT_HEAT_VIEW.coverage,
  countryName,
}: {
  rows: Row[];
  schema?: IndicatorSchema | null;
  sortMetric?: HeatSortMetric;
  coverage?: HeatCoverage;
  countryName?: string;
}) {
  const definitionsId = `heat-definitions-${useId().replaceAll(":", "")}`;
  const isIndustry = rows.some((row) => row.industry != null);
  const visible = visibleHeatRows(rows, sortMetric, coverage);
  const maxOf: Record<string, number> = {};
  HEAT_COLS.forEach((column) => {
    const values = visible.map((row) => row[column.key]).filter(finite).filter((value) => !pathMetricUndefined(column.key, value));
    maxOf[column.key] = Math.max(...values, 1e-9);
  });
  const cell = (row: Row, key: string, fmt: string, name: string) => {
    const raw = row[key];
    if (pathMetricUndefined(key, raw)) {
      return (
        <span
          data-metric-undefined="true"
          title={`${name}：${PATH_UNDEFINED_NOTE}`}
          style={{
            display: "inline-block", minWidth: 92, padding: "5px 6px", borderRadius: 7, textAlign: "center",
            background: "#f2f3f7", color: "#5f6677", fontSize: 12,
          }}
        >{PATH_UNDEFINED_LABEL}</span>
      );
    }
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
          {shownCountry}行业节点中心性；在完整全球国家×行业图上计算，按{sortLabel}{cjkSpace("降序显示", coverageLabel)}。本表仅供查数，不记录报告材料。
        </caption>
        <thead>
          <tr>
            <th scope="col">{isIndustry ? "行业节点" : "国家 / 地区"}</th>
            {HEAT_COLS.map((column) => (
              <th key={column.key} scope="col">{column.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const rowKey = heatRowKey(row);
            return (
              <tr key={rowKey}>
                <th scope="row" title={row.industry != null ? String(row.industry) : undefined}>{rowLabel(row)}</th>
                {HEAT_COLS.map((column) => (
                  <td key={column.key} style={{ textAlign: "center" }}>
                    {cell(row, column.key, column.fmt, column.name)}
                  </td>
                ))}
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
          颜色深浅表示该列可见行中的相对大小（每列单独计算）。“{PATH_UNDEFINED_LABEL}”：该行业{PATH_UNDEFINED_NOTE}，接近中心性与调和中心性无法定义（软件记为 0，不表示最远）。这张表上的操作不会改变报告材料。
        </div>
      </div>
    </ScrollableRegion>
  );
}
