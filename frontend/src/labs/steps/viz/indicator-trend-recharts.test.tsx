import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IndicatorTrendChartRecharts } from "./indicator-trend-recharts";
import { countryDistribution } from "./indicator-model";
import type { Row } from "./scaffold";

afterEach(cleanup);

const rows: Row[] = [2018, 2019, 2020].flatMap((year) =>
  [["CHN", 0.1], ["USA", 0.05], ["DEU", 0.2], ["JPN", 0.12]].map(([country, value]) => ({
    country, year, FVA_share: (value as number) + (year - 2018) / 100,
  })),
);

/* Pilot findings recorded by this file (design doc 4.7): what a happy-dom unit test can and cannot
 * verify about a Recharts chart. A fixed `width` avoids the ResizeObserver that `responsive` needs. */
describe("recharts pilot trend chart", () => {
  const renderPilot = () =>
    render(
      <IndicatorTrendChartRecharts
        rows={rows}
        countries={["CHN", "USA"]}
        years={[2018, 2019, 2020]}
        metric="FVA_share"
        label="外国增加值项占比"
        unit="%"
        distribution={countryDistribution(rows, "FVA_share", [2018, 2019, 2020])}
        width={780}
      />,
    );

  test("renders one line per country, the band and the median, with the chart title in the svg", () => {
    const view = renderPilot();
    expect(view.container.querySelectorAll(".recharts-line").length).toBe(3);
    expect(view.container.querySelectorAll(".recharts-area").length).toBe(1);
    expect(view.container.querySelector("svg title")?.textContent).toContain("外国增加值项占比历年变化");
    expect(screen.getByText("CHN 中国")).toBeTruthy();
    expect(screen.getByText("USA 美国（对比）")).toBeTruthy();
  });

  test("keyboard: the accessibility layer walks the years and the custom readout lists every series", () => {
    const view = renderPilot();
    // Recharts 3 puts the accessibility layer on the svg: role="application", tabindex 0, arrow keys move the tooltip.
    const surface = view.container.querySelector(".recharts-surface") as HTMLElement;
    expect(surface.getAttribute("tabindex")).toBe("0");
    expect(surface.getAttribute("role")).toBe("application");
    surface.focus();
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    const readout = () => view.container.querySelector(".hover-tip")?.textContent ?? "";
    // Finding: the first ArrowRight lands on the first year in Chrome but on the second in happy-dom,
    // so the test checks the readout shape and the direction of travel rather than the exact year.
    const first = Number(/^(\d{4}) 年/.exec(readout())?.[1]);
    expect([2018, 2019]).toContain(first);
    expect(readout()).toContain("CHN 中国");
    expect(readout()).toContain("USA 美国（对比）");
    expect(readout()).toContain("全球中位数");
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    expect(Number(/^(\d{4}) 年/.exec(readout())?.[1])).toBe(first + 1);
  });

  test("hovering a legend entry dims the other series", () => {
    const view = renderPilot();
    const stroke = (country: string) =>
      (view.container.querySelector(`.recharts-line-curve[stroke="${country === "CHN" ? "#216cc0" : "#1baf7a"}"]`) as SVGElement).getAttribute("stroke-opacity");
    expect(stroke("CHN")).toBe("1");
    fireEvent.mouseEnter(view.container.querySelector('[data-legend="USA"]')!);
    expect(stroke("CHN")).toBe("0.25");
    expect(stroke("USA")).toBe("1");
  });
});
