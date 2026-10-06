import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DistributionStrip, IndicatorPairBars, IndicatorTrendChart, LengthPositionTrajectory } from "./indicator-charts";
import { countryDistribution } from "./indicator-model";
import type { Row } from "./scaffold";

afterEach(cleanup);

const trendRows: Row[] = [2018, 2019, 2020].flatMap((year) =>
  [["CHN", 0.1], ["USA", 0.05], ["DEU", 0.2], ["JPN", 0.12]].map(([country, value]) => ({
    country, year, FVA_share: (value as number) + (year - 2018) / 100,
  })),
);

describe("trend chart hover layer", () => {
  const renderTrend = () =>
    render(
      <IndicatorTrendChart
        rows={trendRows}
        countries={["CHN", "USA"]}
        years={[2018, 2019, 2020]}
        metric="FVA_share"
        label="外国增加值项占比"
        unit="%"
        distribution={countryDistribution(trendRows, "FVA_share", [2018, 2019, 2020])}
        mode="context"
      />,
    );

  test("the crosshair snaps to a year and reads every series plus the global median", () => {
    const view = renderTrend();
    expect(view.container.querySelector("[data-crosshair]")).toBeNull();
    fireEvent.mouseMove(view.container.querySelector('rect[data-year="2019"]')!, { clientX: 300, clientY: 120 });
    const readout = screen.getByRole("status");
    expect(readout.textContent).toContain("2019 年");
    expect(readout.textContent).toContain("CHN 中国");
    expect(readout.textContent).toContain("11%");
    expect(readout.textContent).toContain("USA 美国（对比）");
    expect(readout.textContent).toContain("6%");
    expect(readout.textContent).toContain("全球中位数");
    expect(view.container.querySelector("[data-crosshair]")).not.toBeNull();
    // Leaving the chart clears the crosshair and the readout.
    fireEvent.mouseLeave(screen.getByRole("group", { name: /外国增加值项占比历年变化图/ }));
    expect(view.container.querySelector("[data-crosshair]")).toBeNull();
    expect(readout.textContent).toBe("");
  });

  test("keyboard users walk the years with the arrow keys and get the same readout", () => {
    const view = renderTrend();
    const chart = screen.getByRole("group", { name: /按左右方向键逐年读数/ });
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(screen.getByRole("status").textContent).toContain("2018 年");
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(screen.getByRole("status").textContent).toContain("2020 年");
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(screen.getByRole("status").textContent).toContain("2020 年");
    fireEvent.keyDown(chart, { key: "Home" });
    expect(screen.getByRole("status").textContent).toContain("2018 年");
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(view.container.querySelector("[data-crosshair]")).toBeNull();
  });

  test("hovering a legend entry dims the other series without touching the hovered one", () => {
    const view = renderTrend();
    const group = (country: string) => view.container.querySelector(`[data-series-group="${country}"]`)!;
    expect(group("CHN").getAttribute("opacity")).toBe("1");
    fireEvent.mouseEnter(view.container.querySelector('[data-legend="USA"]')!);
    expect(group("CHN").getAttribute("opacity")).toBe("0.25");
    expect(group("USA").getAttribute("opacity")).toBe("1");
    fireEvent.mouseLeave(view.container.querySelector('[data-legend="USA"]')!);
    expect(group("CHN").getAttribute("opacity")).toBe("1");
  });
});

describe("mark-level hover layers", () => {
  test("every economy on the distribution strip is a hit target with its rank, and the highlighted ones take focus", () => {
    const rows: Row[] = [["CHN", 0.12], ["USA", 0.06], ["DEU", 0.17], ["JPN", 0.1]].map(([country, value]) => ({ country, year: 2020, FVA_share: value }));
    const [distribution] = countryDistribution(rows, "FVA_share", [2020]);
    const view = render(
      <DistributionStrip rows={rows} metric="FVA_share" unit="%" label="外国增加值项占比" year={2020} highlight={["CHN", "USA"]} distribution={distribution} />,
    );
    fireEvent.mouseMove(view.container.querySelector('[data-hit="DEU"]')!, { clientX: 10, clientY: 10 });
    const readout = screen.getByRole("status");
    expect(readout.textContent).toContain("DEU 德国");
    expect(readout.textContent).toContain("第 1 位");
    const marked = screen.getByRole("graphics-symbol", { name: /CHN 中国/ });
    fireEvent.focus(marked);
    expect(readout.textContent).toContain("CHN 中国");
    expect(readout.textContent).toContain("第 2 位");
    fireEvent.blur(marked);
    // Hidden again: the live region is emptied rather than left announcing a stale value.
    expect(readout.textContent).toBe("");
    // The chart itself is still the one image.
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  test("pair bars read the whole group on hover and on keyboard focus", () => {
    render(
      <IndicatorPairBars
        countries={["CHN", "USA"]}
        unit="%"
        groups={[{ key: "C26", label: "C26 计算机电子光学", values: [0.3, 0.1] }]}
      />,
    );
    const group = screen.getByRole("group", { name: "C26 计算机电子光学" });
    fireEvent.focus(group);
    expect(group.getAttribute("data-hovered")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("30%");
    expect(screen.getByRole("status").textContent).toContain("USA 美国");
    fireEvent.blur(group);
    expect(group.getAttribute("data-hovered")).toBeNull();
  });

  test("trajectory points read both lengths and the ratio; endpoints are focusable", () => {
    const rows: Row[] = [
      { country: "CHN", year: 2016, PLy_GVC: 2, PLv_GVC: 3 },
      { country: "CHN", year: 2020, PLy_GVC: 2.5, PLv_GVC: 3.5 },
    ];
    const view = render(<LengthPositionTrajectory rows={rows} countries={["CHN"]} years={[2016, 2020]} />);
    fireEvent.mouseMove(view.container.querySelector('[data-hit="CHN:2020"]')!, { clientX: 5, clientY: 5 });
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("CHN 中国 · 2020");
    expect(text).toContain("后向 GVC 段长度");
    expect(text).toContain("前向／后向");
    expect(screen.getAllByRole("graphics-symbol")).toHaveLength(2);
  });
});
