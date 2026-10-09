import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ComparisonSummary, DistributionStrip, IndicatorPairBars, IndicatorTrendChart, LengthPositionTrajectory, TrendSummary } from "./indicator-charts";
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
    expect(readout.textContent).toContain("11.000%");
    expect(readout.textContent).toContain("USA 美国（对比）");
    expect(readout.textContent).toContain("6.000%");
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
    expect(screen.getByRole("status").textContent).toContain("30.000%");
    expect(screen.getByRole("status").textContent).toContain("USA 美国");
    fireEvent.blur(group);
    expect(group.getAttribute("data-hovered")).toBeNull();
  });

  test("step 10 with both X = 0: the gap card says 差距为 0, not 差距基本不变", () => {
    const readings = [2016, 2020].flatMap((year) => ["MEX", "CRI"].map((country) => ({ country, year, value: 0 })));
    const view = render(<ComparisonSummary readings={readings} countries={["MEX", "CRI"]} years={[2016, 2020]} unit="个百分点" gapNote="两国都未被加税：X 一直为 0，没有差距" />);
    const text = view.getByRole("group", { name: "两国趋势结论" }).textContent ?? "";
    expect(text).toContain("差距为 0");
    expect(text).not.toContain("差距基本不变");
    cleanup();
  });

  test("pair bar labels read amounts under 10 at the cards' three decimals (8.765, -2.235, not 9, -2)", () => {
    const view = render(
      <IndicatorPairBars
        countries={["CHN", "USA"]}
        unit="百万美元"
        groups={[{ key: "H51", label: "H51 航空运输", values: [8.765, -2.235] }, { key: "C26", label: "C26 计算机电子光学", values: [1234.4, 0.5] }]}
      />,
    );
    const text = view.container.textContent ?? "";
    expect(text).toContain("8.765");
    expect(text).toContain("-2.235");
    expect(text).toContain("1,234");
    cleanup();
  });

  test("pair bars name an undefined value and say both kinds of gap are left blank (round 12)", () => {
    const view = render(
      <IndicatorPairBars
        countries={["LUX", "KHM"]}
        unit="%"
        groups={[{ key: "O", label: "O 公共管理与国防", values: [0.868, null], reasons: [null, "无法计算"] }]}
      />,
    );
    expect(view.container.textContent).toContain("无法计算");
    expect(view.container.textContent).toContain("负值画在左边，缺少或无法计算的数据留空。");
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

describe("trend chart axis and empty state", () => {
  test("a whole-number metric ticks on integers without repeating a label (step 9 离心率)", () => {
    const rows: Row[] = [2018, 2019, 2020].flatMap((year) => [
      { country: "KHM", year, Eccentricity: 2 },
      { country: "USA", year, Eccentricity: year === 2020 ? 3 : 2 },
    ]);
    const view = render(
      <IndicatorTrendChart rows={rows} countries={["KHM", "USA"]} years={[2018, 2019, 2020]} metric="Eccentricity" label="离心率" unit="路径长度" mode="context" />,
    );
    const ticks = [...view.container.querySelectorAll('svg text[x="100"]')].map((node) => node.textContent);
    expect(ticks.length).toBeGreaterThan(1);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(ticks.every((tick) => /^\d+$/.test(tick ?? ""))).toBe(true);
  });

  test("an all-zero amount series (step 9 加权总度 of T) reads a single 0 tick, not 0.25 / 0.5 / 0.75", () => {
    const rows: Row[] = [2018, 2019, 2020].flatMap((year) => [
      { country: "CHN", year, "weighted degree": 0 },
      { country: "USA", year, "weighted degree": 0 },
    ]);
    const view = render(
      <IndicatorTrendChart rows={rows} countries={["CHN", "USA"]} years={[2018, 2019, 2020]} metric="weighted degree" label="加权总度"
        unit="百万美元" mode="context" distribution={countryDistribution(rows, "weighted degree", [2018, 2019, 2020])} />,
    );
    const ticks = [...view.container.querySelectorAll('svg text[x="100"]')].map((node) => node.textContent);
    expect(ticks).toEqual(["0"]);
  });

  test("an undefined series says why in place of the missing-data message", () => {
    const rows: Row[] = [{ country: "CHN", year: 2020, PLv_GVC: null }];
    const view = render(
      <IndicatorTrendChart rows={rows} countries={["CHN"]} years={[2020]} metric="PLv_GVC" label="前向 GVC 段长度" unit="长度单位" mode="context"
        emptyStatus="CHN 中国在所选年份该行业没有 GVC 生产（GVC 增加值为 0），前向 GVC 段长度无法计算（不是缺少数据）；请换一个行业或国家。" />,
    );
    expect(view.getByRole("status").textContent).toContain("没有 GVC 生产");
    expect(view.container.textContent).not.toContain("没有有效读数");
  });
});

describe("trend cards name the empty year and say why (round 12)", () => {
  const readings = [
    { country: "CHN", year: 2016, value: 0.2 }, { country: "CHN", year: 2020, value: 0.3 },
    { country: "MLT", year: 2016, value: 0.1 }, { country: "MLT", year: 2020, value: null },
  ];

  test("step 7 MLT H51: a negative 2020 total is undefined, not missing, and 2020 is named", () => {
    const view = render(
      <TrendSummary readings={readings} countries={["CHN", "MLT"]} years={[2016, 2020]} unit="%"
        reasonFor={(country, year) => (country === "MLT" && year === 2020 ? "该行业总增加值为负，复杂 GVC 生产份额无法计算（不是缺少数据）" : null)} />,
    );
    const text = view.getByLabelText("趋势读数").textContent ?? "";
    expect(text).toContain("期间读数无法计算");
    expect(text).toContain("2020 年该行业总增加值为负，复杂 GVC 生产份额无法计算（不是缺少数据），暂不比较差距");
    expect(text).not.toContain("2016 或 2020");
    expect(text).not.toContain("缺失");
  });

  test("起始 = 结束 says the two years are the same, not that data is missing", () => {
    const view = render(<TrendSummary readings={readings.filter((item) => item.year === 2020)} countries={["CHN", "MLT"]} years={[2020]} unit="%" />);
    expect(view.container.textContent).toBe("起始年份和结束年份相同，请选两个不同年份。");
    cleanup();
  });

  test("really missing data still says so, with its year", () => {
    const view = render(<TrendSummary readings={readings} countries={["CHN", "MLT"]} years={[2016, 2020]} unit="%" />);
    const text = view.getByLabelText("趋势读数").textContent ?? "";
    expect(text).toContain("期间读数不完整");
    expect(text).toContain("2020 年缺少数据（缺少的数据留空），暂不比较差距");
  });

  test("step 9 离心率 A03: an isolated LUX reads 无法定义, not 没有读数", () => {
    const isolated = [2016, 2020].flatMap((year) => [{ country: "LUX", year, value: null }, { country: "USA", year, value: 2 }]);
    const view = render(
      <TrendSummary readings={isolated} countries={["LUX", "USA"]} years={[2016, 2020]} unit="路径长度"
        reasonFor={(country) => (country === "LUX" ? "该行业无连接，离心率无法定义（不是 0）" : null)} />,
    );
    expect(view.container.textContent).toBe("LUX 卢森堡在所选年份该行业无连接，离心率无法定义（不是 0），暂不能读出期间变化。");
    cleanup();
    const comparison = render(
      <TrendSummary readings={isolated} countries={["USA", "LUX"]} years={[2016, 2020]} unit="路径长度"
        reasonFor={(country) => (country === "LUX" ? "该行业无连接，离心率无法定义（不是 0）" : null)} />,
    );
    const text = comparison.getByLabelText("趋势读数").textContent ?? "";
    expect(text).toContain("期间读数无法定义");
    expect(text).toContain("2016、2020 年该行业无连接，离心率无法定义（不是 0），暂不比较差距");
  });
});

describe("trend cards name the industry when the scope is one industry (round 21)", () => {
  const readings = [2016, 2020].map((year) => ({ country: "JPN", year, value: year === 2016 ? 0.13084 : 0.14945 }));

  test("step 6 JPN C29: the observed country's card reads country · industry · years", () => {
    const view = render(<TrendSummary readings={readings} countries={["JPN"]} years={[2016, 2020]} unit="%" industry="C29" />);
    expect(view.getByLabelText("趋势读数").textContent).toContain("JPN 日本 · C29 汽车及零部件 · 2016→2020");
    cleanup();
  });

  test("country level keeps the plain country label", () => {
    const view = render(<TrendSummary readings={readings} countries={["JPN"]} years={[2016, 2020]} unit="%" />);
    const text = view.getByLabelText("趋势读数").textContent ?? "";
    expect(text).toContain("JPN 日本 · 2016→2020");
    expect(text).not.toContain("C29");
    cleanup();
  });

  test("the context trend chart passes its industry to the cards (step 9 C26)", () => {
    const rows = [2016, 2020].map((year) => ({ country: "JPN", year, industry: "C26", m: year === 2016 ? 158133 : 151048 }));
    const view = render(
      <IndicatorTrendChart rows={rows} countries={["JPN"]} years={[2016, 2020]} metric="m" label="加权总度" unit="百万美元" mode="context" sameIndustry industry="C26" />,
    );
    expect(view.getByLabelText("趋势读数").textContent).toContain("JPN 日本 · C26 计算机电子光学 · 2016→2020");
    cleanup();
  });
});
