import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Butterfly, Dumbbell, IndustryDotPlot, StackedAreaFacets } from "./theme-charts";
import type { Row } from "./scaffold";

afterEach(cleanup);

const segments = [
  { key: "DVAex", name: "国内增加值出口", color: "#216cc0" },
  { key: "FVA", name: "外国增加值", color: "#eda100" },
  { key: "taxsub", name: "税收减补贴", color: "#98a0b3" },
];

describe("stacked area facets", () => {
  const rows = (country: string): Row[] => [2018, 2019, 2020].map((year) => ({
    country, year, gross_exports: 100, DVAex: 70 + (year - 2018), FVA: 25, taxsub: year === 2019 ? -3 : 2,
  }));

  test("one facet per economy, negative parts below zero, readout per year, gaps never bridged", () => {
    const view = render(
      <StackedAreaFacets
        facets={[{ key: "CHN", label: "CHN 中国", rows: rows("CHN") }, { key: "USA", label: "USA 美国", rows: rows("USA").filter((row) => row.year !== 2019) }]}
        years={[2018, 2019, 2020]}
        segments={segments}
        total="gross_exports"
        totalLabel="总出口"
      />,
    );
    expect(screen.getAllByRole("img")).toHaveLength(2);
    // CHN: taxsub is negative in 2019 only, so the tax area is split into pieces and marked red.
    const chn = view.container.querySelectorAll("section")[0];
    expect(chn.querySelectorAll('[data-area="taxsub"]').length).toBeGreaterThanOrEqual(1);
    // USA lacks 2019: the DVAex area is cut into two single-year pieces instead of being bridged.
    const usa = view.container.querySelectorAll("section")[1];
    expect(usa.querySelectorAll('[data-area="DVAex"]')).toHaveLength(2);
    fireEvent.mouseMove(chn.querySelector('rect[data-year="2019"]')!, { clientX: 10, clientY: 10 });
    const readout = screen.getByRole("status");
    expect(readout.textContent).toContain("CHN 中国 · 2019");
    expect(readout.textContent).toContain("外国增加值");
    expect(readout.textContent).toContain("25%");
    expect(readout.textContent).toContain("-3%");
    // Keyboard parity on the facet.
    const group = screen.getByRole("group", { name: /USA 美国历年构成/ });
    fireEvent.keyDown(group, { key: "End" });
    expect(readout.textContent).toContain("USA 美国 · 2020");
  });
});

describe("industry dot plot", () => {
  test("rows are focusable groups that read every economy and show the national line", () => {
    const view = render(
      <IndustryDotPlot
        groups={[{ key: "C26", label: "C26 计算机电子光学", values: [0.3, 0.1] }, { key: "C20", label: "C20 化学品", values: [0.2, null] }]}
        countries={["CHN", "USA"]}
        unit="%"
        nationals={[0.15, 0.08]}
        label="外国增加值项占比"
      />,
    );
    const row = screen.getByRole("group", { name: /C26 计算机电子光学：CHN 中国 30%，USA 美国 10%/ });
    fireEvent.focus(row);
    expect(screen.getByRole("status").textContent).toContain("30%");
    expect(row.querySelectorAll(".national")).toHaveLength(2);
    // Missing readings leave no dot.
    expect(screen.getByRole("group", { name: /C20 化学品/ }).querySelectorAll("i.dot")).toHaveLength(1);
  });
});

describe("dumbbell and butterfly", () => {
  test("dumbbell links forward and backward values and reads their difference", () => {
    render(<Dumbbell rows={[{ key: "gvc", label: "GVC 段", left: 1.5, right: 1.2 }, { key: "d", label: "纯国内段", left: null, right: 2 }]} leftLabel="前向段长度" rightLabel="后向段长度" unit="生产阶段（账户比值）" title="段长度对照" />);
    const row = screen.getByRole("group", { name: /GVC 段：前向段长度 1.5/ });
    fireEvent.mouseMove(row, { clientX: 5, clientY: 5 });
    expect(screen.getByRole("status").textContent).toContain("0.3");
    expect(screen.getByRole("group", { name: /纯国内段/ }).querySelectorAll("i.link")).toHaveLength(0);
  });

  test("butterfly reads buying, selling and the selling share", () => {
    render(<Butterfly rows={[{ key: "C26", label: "C26 计算机电子光学", left: 300, right: 100 }]} leftLabel="加权入度（买入）" rightLabel="加权出度（卖出）" unit="百万美元" title="买入与卖出" />);
    const row = screen.getByRole("group", { name: /C26/ });
    fireEvent.focus(row);
    expect(screen.getByRole("status").textContent).toContain("卖出占比");
    expect(screen.getByRole("status").textContent).toContain("25%");
  });
});
