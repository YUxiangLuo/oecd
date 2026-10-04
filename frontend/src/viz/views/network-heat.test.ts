import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SEQ, type Row } from "../shared";
import {
  DEFAULT_HEAT_VIEW,
  HEAT_EVIDENCE_METRIC,
  HEAT_WEIGHTED_DEGREE_METRIC,
  HeatTableViz,
  heatTextColor,
  normalizeHeatCoverage,
  normalizeHeatSortMetric,
  visibleHeatRows,
} from "./network-heat";

function relativeLuminance(color: string): number {
  const hex = color.length === 4
    ? [...color.slice(1)].map((digit) => digit.repeat(2))
    : [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)];
  const [red, green, blue] = hex.map((value) => {
    const channel = Number.parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const heatRows = (count: number): Row[] => Array.from({ length: count }, (_, index) => ({
  country: "CHN",
  industry: `I${String(index).padStart(2, "0")}`,
  [HEAT_EVIDENCE_METRIC]: index,
  [HEAT_WEIGHTED_DEGREE_METRIC]: (count - index) * 10,
  closnesscentrality: index / 100,
  harmonicclosnesscentrality: index / 100,
  eigencentrality: index / 100,
}));

describe("read-only network heat visibility", () => {
  test("sorts deterministically by either metric with stable ties", () => {
    const rows: Row[] = [
      { country: "CHN", industry: "A", [HEAT_EVIDENCE_METRIC]: 8, [HEAT_WEIGHTED_DEGREE_METRIC]: 1 },
      { country: "CHN", industry: "B", [HEAT_EVIDENCE_METRIC]: 4, [HEAT_WEIGHTED_DEGREE_METRIC]: 9 },
      { country: "CHN", industry: "C", [HEAT_EVIDENCE_METRIC]: 4, [HEAT_WEIGHTED_DEGREE_METRIC]: 5 },
      { country: "CHN", industry: "D", [HEAT_EVIDENCE_METRIC]: 2, [HEAT_WEIGHTED_DEGREE_METRIC]: 9 },
    ];
    expect(visibleHeatRows(rows, HEAT_EVIDENCE_METRIC, "all").map((row) => row.industry))
      .toEqual(["A", "B", "C", "D"]);
    expect(visibleHeatRows(rows, HEAT_WEIGHTED_DEGREE_METRIC, "all").map((row) => row.industry))
      .toEqual(["B", "D", "C", "A"]);
  });

  test("uses Top 15 or all and excludes only nonfinite sort values", () => {
    const rows = [
      ...heatRows(20),
      { country: "CHN", industry: "bad-evidence", [HEAT_EVIDENCE_METRIC]: null, [HEAT_WEIGHTED_DEGREE_METRIC]: 999 },
      { country: "CHN", industry: "bad-sort", [HEAT_EVIDENCE_METRIC]: 999, [HEAT_WEIGHTED_DEGREE_METRIC]: Number.NaN },
    ];
    expect(visibleHeatRows(rows, HEAT_EVIDENCE_METRIC, "top15")).toHaveLength(15);
    const weightedAll = visibleHeatRows(rows, HEAT_WEIGHTED_DEGREE_METRIC, "all");
    expect(weightedAll).toHaveLength(21);
    expect(weightedAll.map((row) => row.industry)).toContain("bad-evidence");
    expect(weightedAll.map((row) => row.industry)).not.toContain("bad-sort");
  });

  test("keeps a sort/evidence-valid row visible while rendering a null secondary metric as unavailable", () => {
    const row: Row = {
      country: "CHN",
      industry: "NULL-SECONDARY",
      [HEAT_EVIDENCE_METRIC]: 4,
      [HEAT_WEIGHTED_DEGREE_METRIC]: 8,
      closnesscentrality: null,
      harmonicclosnesscentrality: 0.5,
      eigencentrality: 0.2,
    };
    expect(visibleHeatRows([row], HEAT_WEIGHTED_DEGREE_METRIC, "all")).toEqual([row]);
    const markup = renderToStaticMarkup(createElement(HeatTableViz, {
      rows: [row],
      sortMetric: HEAT_WEIGHTED_DEGREE_METRIC,
      coverage: "all",
    }));
    expect(markup).toContain('data-metric-unavailable="true"');
    expect(markup).toContain('aria-label="接近中心性不可用"');
    expect(markup).toContain(">—</span>");
  });

  test("normalizes only recognized persisted view values", () => {
    expect(normalizeHeatSortMetric(HEAT_WEIGHTED_DEGREE_METRIC)).toBe(HEAT_WEIGHTED_DEGREE_METRIC);
    expect(normalizeHeatSortMetric("gross_exports")).toBe(DEFAULT_HEAT_VIEW.sortMetric);
    expect(normalizeHeatCoverage("all")).toBe("all");
    expect(normalizeHeatCoverage("top100")).toBe(DEFAULT_HEAT_VIEW.coverage);
  });

  test("renders a captioned read-only table without report evidence controls", () => {
    const rows = heatRows(2);
    const markup = renderToStaticMarkup(createElement(HeatTableViz, {
      rows,
      sortMetric: HEAT_WEIGHTED_DEGREE_METRIC,
      coverage: "all",
      countryName: "中国",
    }));
    expect(markup).toContain("<table");
    expect(markup).toContain("<caption");
    expect(markup).toContain("中国行业节点中心性");
    expect(markup).toContain("按加权总度（自环双计）降序显示全部有限行业");
    expect(markup).toContain("本表仅供查数");
    expect(markup).toContain("<thead>");
    expect(markup).toContain("<tbody>");
    expect(markup.match(/scope="col"/g)).toHaveLength(6);
    expect(markup.match(/scope="row"/g)).toHaveLength(2);
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("记录拓扑基准");
    expect(markup).not.toContain("报告证据");
    expect(markup).toContain("指标定义");
    expect(markup).toContain("这张表上的操作不会改变报告材料");
    expect(markup).not.toContain("<button><tr");
  });
});

describe("network heat table contrast", () => {
  test("uses dark text on the mid-blue cell that fails with white text", () => {
    expect(heatTextColor(3)).toBe("#1b1f2b");
    expect(heatTextColor(4)).toBe("#fff");
  });

  test("every actual sequential palette cell meets WCAG AA text contrast", () => {
    for (const [index, background] of SEQ.entries()) {
      expect(contrastRatio(background, heatTextColor(index))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
