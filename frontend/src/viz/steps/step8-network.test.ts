import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addInspectedCountry } from "../../labs/steps/viz/scaffold";
import {
  NetworkViz,
  directedVisibleEdgeText,
  finiteNetworkMetric,
  networkMetricDisplay,
  networkNodeActivation,
  networkNodeEncodingModel,
  networkThresholdAriaValueText,
  nextNetworkNode,
  thresholdedNetworkModel,
} from "./step8-network";

describe("network fullscreen activation", () => {
  test("an inline node always opens the large view with that node selected", () => {
    expect(networkNodeActivation(null, "CHN", false)).toEqual({ selected: "CHN", expanded: true });
    expect(networkNodeActivation("CHN", "CHN", false)).toEqual({ selected: "CHN", expanded: true });
  });

  test("node selection can change or clear without closing the large view", () => {
    expect(networkNodeActivation("CHN", "USA", true)).toEqual({ selected: "USA", expanded: true });
    expect(networkNodeActivation("CHN", "CHN", true)).toEqual({ selected: null, expanded: true });
  });

  test("inspecting a node adds it to the comparison list; clearing does not drop it", () => {
    const allowed = ["CHN", "USA", "DEU"];
    const afterOpen = networkNodeActivation(null, "CHN", false).selected;
    expect(afterOpen).toBe("CHN");
    const picked = addInspectedCountry([], afterOpen!, allowed);
    const afterSwitch = networkNodeActivation("CHN", "USA", true).selected;
    expect(addInspectedCountry(picked, afterSwitch!, allowed)).toEqual(["CHN", "USA"]);
    const afterClear = networkNodeActivation("USA", "USA", true).selected;
    expect(afterClear).toBeNull();
    expect(addInspectedCountry(["CHN", "USA"], afterClear ?? "", allowed)).toEqual(["CHN", "USA"]);
  });
});

describe("network threshold semantics", () => {
  const edges = [
    { source: "A", target: "B", flow: 100 },
    { source: "B", target: "A", flow: 50 },
    { source: "A", target: "C", flow: 20 },
  ];

  test("one thresholded model synchronizes visible edges, partners and directed text", () => {
    const model = thresholdedNetworkModel(edges, 0.5);
    expect(model.maxFlow).toBe(100);
    expect(model.cutoff).toBe(50);
    expect(model.visibleEdges.map((edge) => `${edge.source}-${edge.target}`)).toEqual(["A-B", "B-A"]);
    expect(model.neighbors.A).toEqual([{ c: "B", inflow: 50, outflow: 100, total: 150 }]);
    expect(model.neighbors.C).toBeUndefined();
    expect(directedVisibleEdgeText(model)).toEqual(["A → B: 100", "B → A: 50"]);

    const raised = thresholdedNetworkModel(edges, 0.6);
    expect(raised.visibleEdges).toEqual([edges[0]]);
    expect(raised.neighbors.A).toEqual([{ c: "B", inflow: 0, outflow: 100, total: 100 }]);
    expect(raised.neighbors.B).toEqual([{ c: "A", inflow: 100, outflow: 0, total: 100 }]);
    expect(directedVisibleEdgeText(raised)).toEqual(["A → B: 100"]);
  });

  test("announces a successful empty network without graph controls or actionable copy", () => {
    const html = renderToStaticMarkup(createElement(NetworkViz, { data: { nodes: [], edges: [] } }));
    expect(html).toContain('role="status"');
    expect(html).toContain("已成功加载空网络：0 个节点，0 条边");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("点击");
  });

  test("states preset geography and the published-Top-edge cutoff formula in visible and accessible copy", () => {
    const html = renderToStaticMarkup(createElement(NetworkViz, {
      data: {
        nodes: [
          { country: "CHN", gvc_production_share: 0.4, "weighted degree": 150, gross_exports: 100 },
          { country: "USA", gvc_production_share: 0.3, "weighted degree": 150, gross_exports: 100 },
        ],
        edges: [{ source: "CHN", target: "USA", flow: 100 }],
      },
    }));
    expect(html).toContain("预设地理区域布局（不是社区检测）");
    expect(html).toContain("区域内 / 区域间流向");
    expect(html).toContain("边流量 ÷ 当前发布 Top 边中的最大流量 ≥ 0%");
    expect(html).toContain("显示 1/1 条已发布 Top 边");
    expect(html).toContain("完整图上的中心性指标保持不变");
    expect(html).toContain("节点位置采用预设地理区域布局，不是社区检测结果");
  });

  test("renders a named unavailable state with no actionable graph when the selected metric is all null", () => {
    const html = renderToStaticMarkup(createElement(NetworkViz, {
      data: {
        nodes: [
          { country: "CHN", gvc_production_share: null, "weighted degree": 150, gross_exports: 100 },
          { country: "USA", gvc_production_share: null, "weighted degree": 120, gross_exports: 90 },
        ],
        edges: [{ source: "CHN", target: "USA", flow: 100 }],
      },
    }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="贸易网络所选指标不可用"');
    expect(html).toContain("数据已成功加载，但所有节点均缺少有限的GVC 生产份额值");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<select");
    expect(html).not.toContain('type="range"');
    expect(html).not.toContain('role="button"');
  });

  test("keeps mixed-null nodes as unavailable neutral context without changing the finite scale", () => {
    const html = renderToStaticMarkup(createElement(NetworkViz, {
      data: {
        nodes: [
          { country: "CHN", gvc_production_share: null, "weighted degree": null, gross_exports: 100 },
          { country: "USA", gvc_production_share: 0.4, "weighted degree": 150, gross_exports: 90 },
        ],
        edges: [{ source: "CHN", target: "USA", flow: 100 }],
      },
    }));
    expect(html).toContain("network-node--metric-unavailable");
    expect(html).toContain('r="3.5" fill="#7c828d" stroke="#343a46" stroke-width="2" stroke-dasharray="2.5 2"');
    expect(html).toContain("所选指标不可用节点 = 灰色虚线、固定最小尺寸（仅保留网络上下文）");
    expect(html).toContain('r="14.5"');
    expect(html).toContain("GVC 生产份额 —（该指标不可用）");
    expect(html).toContain("双向贸易加权度 —（该指标不可用）");
    expect(html).toContain("GVC 生产份额 40.00%");
    expect(html).not.toContain("GVC 生产份额 0.00%");
    expect(html).not.toContain("双向贸易加权度 0");
  });

  test("shares finite/unavailable text across node names, tooltips and selected details", () => {
    expect(finiteNetworkMetric(null)).toBeNull();
    expect(finiteNetworkMetric(Number.NaN)).toBeNull();
    expect(finiteNetworkMetric(Number.POSITIVE_INFINITY)).toBeNull();
    expect(finiteNetworkMetric(0)).toBe(0);
    expect(networkMetricDisplay(null, "pct")).toBe("—（该指标不可用）");
    expect(networkMetricDisplay(0, "pct")).toBe("0.00%");
    expect(networkMetricDisplay(125, "amount")).toBe("125");
  });

  test("announces the displayed integer cutoff and its max-published-edge meaning", () => {
    expect(networkThresholdAriaValueText(0.25)).toBe("25%，相对当前已发布 Top 边最大流量");
    const html = renderToStaticMarkup(createElement(NetworkViz, {
      data: {
        nodes: [{ country: "CHN", gvc_production_share: 0.4, "weighted degree": 150, gross_exports: 100 }],
        edges: [],
      },
    }));
    expect(html).toContain('type="range"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="0.5"');
    expect(html).toContain('step="0.01"');
    expect(html).toContain('aria-valuetext="0%，相对当前已发布 Top 边最大流量"');
  });
});

describe("network node encoding domains", () => {
  const eligibleNodes = [
    { country: "USA", gvc_production_share: 0.4, "weighted degree": 10, gross_exports: 100 },
    { country: "DEU", gvc_production_share: 0.2, "weighted degree": 5, gross_exports: 80 },
  ];

  test("an extreme finite size with null numeric color cannot compress eligible size or color", () => {
    const baseline = networkNodeEncodingModel(eligibleNodes, "gvc_production_share", "weighted degree");
    const withIneligibleExtreme = networkNodeEncodingModel([
      ...eligibleNodes,
      { country: "CHN", gvc_production_share: 1_000_000, "weighted degree": null, gross_exports: 90 },
    ], "gvc_production_share", "weighted degree");

    expect(withIneligibleExtreme.sizeMax).toBe(baseline.sizeMax);
    expect(withIneligibleExtreme.colorMax).toBe(baseline.colorMax);
    expect(withIneligibleExtreme.nodes.USA).toEqual(baseline.nodes.USA);
    expect(withIneligibleExtreme.nodes.DEU).toEqual(baseline.nodes.DEU);
    expect(withIneligibleExtreme.nodes.CHN).toEqual({ eligible: false, radius: 3.5, color: "#7c828d" });
  });

  test("a null size with extreme finite numeric color cannot compress eligible size or color", () => {
    const baseline = networkNodeEncodingModel(eligibleNodes, "gvc_production_share", "weighted degree");
    const withIneligibleExtreme = networkNodeEncodingModel([
      ...eligibleNodes,
      { country: "CHN", gvc_production_share: null, "weighted degree": 1_000_000, gross_exports: 90 },
    ], "gvc_production_share", "weighted degree");

    expect(withIneligibleExtreme.sizeMax).toBe(baseline.sizeMax);
    expect(withIneligibleExtreme.colorMax).toBe(baseline.colorMax);
    expect(withIneligibleExtreme.nodes.USA).toEqual(baseline.nodes.USA);
    expect(withIneligibleExtreme.nodes.DEU).toEqual(baseline.nodes.DEU);
    expect(withIneligibleExtreme.nodes.CHN).toEqual({ eligible: false, radius: 3.5, color: "#7c828d" });
  });

  test("region color requires only a finite size metric and keeps size-null nodes neutral", () => {
    const baseline = networkNodeEncodingModel(eligibleNodes, "gvc_production_share", "region");
    const withPartialNodes = networkNodeEncodingModel([
      ...eligibleNodes,
      { country: "CHN", gvc_production_share: 0.3, "weighted degree": null, gross_exports: null },
      { country: "JPN", gvc_production_share: null, "weighted degree": 1_000_000, gross_exports: 90 },
    ], "gvc_production_share", "region");

    expect(withPartialNodes.encodedMetrics).toEqual(["gvc_production_share"]);
    expect(withPartialNodes.sizeMax).toBe(baseline.sizeMax);
    expect(withPartialNodes.colorMax).toBeNull();
    expect(withPartialNodes.nodes.USA).toEqual(baseline.nodes.USA);
    expect(withPartialNodes.nodes.DEU).toEqual(baseline.nodes.DEU);
    expect(withPartialNodes.nodes.CHN.eligible).toBe(true);
    expect(withPartialNodes.nodes.CHN.color).not.toBe("#7c828d");
    expect(withPartialNodes.nodes.JPN).toEqual({ eligible: false, radius: 3.5, color: "#7c828d" });
  });
});

describe("network keyboard navigation", () => {
  const nodes = ["CHN", "JPN", "USA"];

  test("moves with arrow keys and wraps at both ends", () => {
    expect(nextNetworkNode(nodes, "CHN", "ArrowRight")).toBe("JPN");
    expect(nextNetworkNode(nodes, "USA", "ArrowDown")).toBe("CHN");
    expect(nextNetworkNode(nodes, "CHN", "ArrowLeft")).toBe("USA");
  });

  test("supports Home and End without treating unrelated keys as navigation", () => {
    expect(nextNetworkNode(nodes, "JPN", "Home")).toBe("CHN");
    expect(nextNetworkNode(nodes, "JPN", "End")).toBe("USA");
    expect(nextNetworkNode(nodes, "JPN", "Enter")).toBeNull();
  });
});
