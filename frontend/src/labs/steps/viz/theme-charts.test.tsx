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
    // Axis ticks are round numbers and stay trimmed ("25%"), unlike fixed-decimal readings.
    const ticks = [...view.container.querySelectorAll("section")[0].querySelectorAll("svg text")].map((node) => node.textContent);
    expect(ticks.some((text) => /^\d+%$/.test(text ?? ""))).toBeTrue();
    expect(ticks.some((text) => /\.000%$/.test(text ?? ""))).toBeFalse();
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
    expect(readout.textContent).toContain("25.000%");
    expect(readout.textContent).toContain("-3.000%");
    // Keyboard parity on the facet.
    const group = screen.getByRole("group", { name: /USA 美国历年构成/ });
    fireEvent.keyDown(group, { key: "End" });
    expect(readout.textContent).toContain("USA 美国 · 2020");
  });

  test("the negative-part legend and caption appear only when a part is negative", () => {
    const facets = (taxsub: number) => [{ key: "CHN", label: "CHN 中国", rows: [2018, 2019].map((year) => ({
      country: "CHN", year, gross_exports: 100, DVAex: 70, FVA: 30 - taxsub, taxsub,
    })) }];
    const positive = render(<StackedAreaFacets facets={facets(2)} years={[2018, 2019]} segments={segments} total="gross_exports" totalLabel="总出口" />);
    expect(positive.container.textContent).not.toContain("负分项");
    positive.unmount();
    const negative = render(<StackedAreaFacets facets={facets(-3)} years={[2018, 2019]} segments={segments} total="gross_exports" totalLabel="总出口" />);
    expect(negative.container.textContent).toContain("负分项（零轴下方）");
    expect(negative.container.textContent).toContain("负分项（红）画在零轴下方");
  });
});

describe("industry dot plot", () => {
  test("rows are focusable groups that read every economy and show the national line", () => {
    render(
      <IndustryDotPlot
        groups={[{ key: "C26", label: "C26 计算机电子光学", values: [0.3, 0.1] }, { key: "C20", label: "C20 化学品", values: [0.2, null] }]}
        countries={["CHN", "USA"]}
        unit="%"
        nationals={[0.15, 0.08]}
        label="外国增加值项占比"
      />,
    );
    const row = screen.getByRole("group", { name: /C26 计算机电子光学：CHN 中国 30.000%，USA 美国 10.000%/ });
    fireEvent.focus(row);
    expect(screen.getByRole("status").textContent).toContain("30.000%");
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
    expect(screen.getByRole("status").textContent).toContain("25.000%");
  });

  test("butterfly rows without pick buttons are one Tab stop; the arrow keys move between rows", () => {
    const rows = ["JPN", "USA", "DEU"].map((key, i) => ({ key, label: key, left: 10 + i, right: 20 + i }));
    render(<Butterfly rows={rows} leftLabel="进口" rightLabel="出口" unit="百万美元" title="CHN 伙伴榜" />);
    const groups = screen.getAllByRole("group");
    expect(groups.map((group) => group.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(groups[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(groups[1]);
    expect(groups.map((group) => group.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(groups[1], { key: "End" });
    expect(document.activeElement).toBe(groups[2]);
    // Each row names its panel, so two countries' rows do not read the same.
    expect(groups[2].getAttribute("aria-label")).toContain("CHN 伙伴榜 · DEU");
  });
});

test("side-by-side dumbbells given one domain draw the same axis", () => {
  const ticks = (container: HTMLElement) => [...container.querySelectorAll(".dot-plot-axis span")].map((node) => node.textContent);
  const usa = render(<Dumbbell rows={[{ key: "g", label: "GVC 段", left: 1.2, right: 3.8 }]} leftLabel="前向" rightLabel="后向" unit="长度单位" title="USA" domain={[1.2, 4.9]} />);
  const deu = render(<Dumbbell rows={[{ key: "g", label: "GVC 段", left: 2.1, right: 4.9 }]} leftLabel="前向" rightLabel="后向" unit="长度单位" title="DEU" domain={[1.2, 4.9]} />);
  expect(ticks(usa.container).length).toBeGreaterThan(1);
  expect(ticks(usa.container).every((text) => !/\.000$/.test(text ?? ""))).toBeTrue();
  expect(ticks(usa.container)).toEqual(ticks(deu.container));
});

describe("undefined values in the theme charts read as such (round 12)", () => {
  test("段长度对照: LUX B09 has no production in any segment, so its lengths read 无法计算", () => {
    const rows = ["纯国内段", "传统贸易段", "GVC 段"].map((label, index) => ({
      key: String(index), label, left: null, right: null, leftReason: "无法计算", rightReason: "无法计算",
    }));
    const view = render(<Dumbbell title="LUX 卢森堡 段长度对照" unit="长度单位" leftLabel="前向段长度" rightLabel="后向段长度" rows={rows} />);
    expect(view.getByRole("status").textContent).toBe("LUX 卢森堡 段长度对照：各段都没有这类生产活动，长度无法计算（不是缺少数据）。");
    cleanup();
    // MLT B09: a forward GVC length but no backward one.
    const mixed = render(<Dumbbell title="MLT 马耳他 段长度对照" unit="长度单位" leftLabel="前向段长度" rightLabel="后向段长度"
      rows={[{ key: "gvc", label: "GVC 段", left: 5.622, right: null, rightReason: "无法计算" }]} />);
    expect(mixed.container.querySelector(".dot-plot-values")?.textContent).toBe("5.622无法计算");
  });

  test("历年构成 whose total is negative in every year says the shares are undefined", () => {
    const rows: Row[] = [2016, 2020].map((year) => ({ country: "MLT", year, total: -1.268, DVAex: -0.6, FVA: -0.4, taxsub: -0.268 }));
    render(<StackedAreaFacets facets={[{ key: "MLT", label: "MLT 马耳他", rows }]} years={[2016, 2020]} segments={segments} total="total" totalLabel="总增加值" />);
    expect(screen.getByRole("status").textContent).toContain("总增加值都为 0 或为负，份额无法计算（不是缺少数据）");
  });
});
