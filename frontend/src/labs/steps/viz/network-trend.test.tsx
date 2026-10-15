import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../../../api";
import { MATERIAL_LOCKED_NOTE, MATERIAL_RECHOSEN_NEXT, NOT_RECORDED_HINT, RECORD_CHART_ACTION, RECORDED_CHART_LABEL, REPLACE_MATERIAL_ACTION } from "../../../step-task-card";
import type { IndustryPage, Meta } from "../../../types";
import { NetworkTrend, networkTrendPoints } from "./network-trend";
import { networkRanking } from "./network-ranking";
import type { VizObservation } from "./scaffold";

afterEach(() => { cleanup(); mock.restore(); });
/** The same industry across all economies: median 50, CHN ranked 3rd, USA 1st, DEU 2nd in every year. */
const mockReference = () => spyOn(api, "industryDistribution").mockImplementation(async (metric, options = {}) => ({
  metric,
  rows: (options.years ?? [2018, 2019, 2020]).flatMap((year) => (options.industry ? [options.industry] : ["C26", "C27"]).map((industry) => ({
    year, industry, n: 76, p25: 20, median: 50, p75: 80,
    ranks: Object.fromEntries((options.countries ?? []).map((country) => [country, { CHN: 3, USA: 1, DEU: 2 }[country] ?? 40])),
  }))),
}));
const meta: Meta = { countries: ["CHN", "USA", "DEU"], sectors: ["C26", "C27"], years: [2020, 2018, 2019], dataset: { release_id: "a".repeat(32), years: [2018, 2019, 2020] } };
const row = (country: string, year: number, value: number | null, industry = "C26") => ({ country, year, industry, betweenesscentrality: value });
const page = (rows: ReturnType<typeof row>[]): IndustryPage => ({ rows, total: rows.length, page: 1, page_size: 200 });
/** The one way a chart becomes material: its button under the chart (browsing never records). */
const recordButton = () => screen.findByRole("button", { name: RECORD_CHART_ACTION });
const materialCard = () => screen.getByRole("region", { name: "本步报告材料" });
/** The card's one-sentence summary (what is recorded, or why the chart on screen cannot be), its chip and its how line. */
const materialSummary = () => materialCard().querySelector(".material-card-summary")!;
const materialChip = () => materialCard().querySelector(".material-chip")!;
const materialHow = () => materialCard().querySelector(".material-card-how");
const recordedButton = () => screen.getByRole("button", { name: RECORDED_CHART_LABEL }) as HTMLButtonElement;

test("sorts time, separates countries and industries, and preserves zero versus missing", () => {
  expect(networkTrendPoints([
    row("USA", 2020, 83), row("CHN", 2018, 0), row("CHN", 2020, 14),
    row("CHN", 2019, 999, "C27"), row("USA", 2018, NaN),
  ], meta.years, ["CHN", "USA"], "C26")).toEqual([
    { country: "CHN", year: 2018, value: 0 }, { country: "CHN", year: 2019, value: null }, { country: "CHN", year: 2020, value: 14 },
    { country: "USA", year: 2018, value: null }, { country: "USA", year: 2019, value: null }, { country: "USA", year: 2020, value: 83 },
  ]);
});


test("requires at least two years that are valid for both countries before the chart can be recorded", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) =>
    page([
      row(
        country,
        year,
        country === "CHN"
          ? year === 2020 ? null : 10 + year
          : year === 2018 ? null : 20 + year,
      ),
    ]),
  );
  mockReference();
  const save = mock(() => {});
  render(<NetworkTrend meta={meta} initialCountry="CHN" onRecord={save} />);
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "betweenesscentrality" } });
  await screen.findByRole("img");
  await waitFor(() => expect(materialSummary().textContent).toBe("当前图表暂不能记录：所选国家至少需要两个共同有效年份。"));
  expect(screen.queryByRole("button", { name: RECORD_CHART_ACTION })).toBeNull();
  expect(materialChip().textContent).toBe("暂不能记录");
  expect(materialCard().querySelector(".material-card-action")).toBeNull();
  expect(save).not.toHaveBeenCalled();
});


test("renders gaps without joining them, records the complete two-country view only when asked, and never offers a pending request", async () => {
  let resolveGerman!: (page: IndustryPage) => void;
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => {
    if (country === "DEU" && year === 2020) return new Promise((resolve) => { resolveGerman = resolve; });
    return page([row(country, year, year === 2019 && country === "CHN" ? null : (country === "CHN" ? 10 : 70) + year - 2018)]);
  });
  mockReference();
  const save = mock(() => {});
  render(<NetworkTrend meta={meta} initialCountry="CHN" onRecord={save} />);
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "betweenesscentrality" } });
  await screen.findByRole("img");
  // The same industry in every economy sits behind the two countries: median line and rank card.
  await waitFor(() => expect(document.querySelector('[data-series="global-median"]')).not.toBeNull());
  expect(screen.getByLabelText("趋势读数").textContent).toContain("在全部经济体的同一行业中");
  expect(screen.getByLabelText("趋势读数").textContent).toContain("同行业全球中位数");
  // Two isolated observations must not be connected over the missing 2019 value.
  expect(document.querySelectorAll('svg line[data-series="CHN"]').length).toBe(0);
  // Browsing records nothing: the complete chart is offered, and recorded only by its button.
  const record = await recordButton();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(record);
  expect(save).toHaveBeenCalledTimes(1);
  const [countries, observations] = save.mock.calls[0] as unknown as [string[], Array<Record<string, unknown>>];
  expect(countries).toEqual(["CHN", "USA"]);
  expect(observations.map(({ country, year, value }) => [country, year, value])).toEqual([
    ["CHN", 2018, 10], ["CHN", 2020, 12], ["USA", 2018, 70], ["USA", 2020, 72],
  ]);
  expect(observations.every((item) => item.source === "explicit-network-trend" && item.release === "a".repeat(32))).toBe(true);
  // While Germany's 2020 request is pending the chart cannot be recorded.
  fireEvent.change(screen.getByLabelText("对比国家 B"), { target: { value: "DEU" } });
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByRole("button", { name: RECORD_CHART_ACTION })).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).toHaveBeenCalledTimes(1);
  resolveGerman(page([row("DEU", 2020, 99)]));
  fireEvent.click(await recordButton());
  expect(save).toHaveBeenCalledTimes(2);
  const [germanCountries, germanObservations] = save.mock.calls[1] as unknown as [string[], Array<Record<string, unknown>>];
  expect(germanCountries).toEqual(["CHN", "DEU"]);
  expect(germanObservations.some((item) => item.country === "DEU" && item.value === 99)).toBe(true);
  // An industry without readings offers nothing to record.
  fireEvent.change(screen.getByLabelText("行业"), { target: { value: "C27" } });
  expect(screen.getByText("该行业没有数据，请更换行业、指标或国家。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: RECORD_CHART_ACTION })).toBeNull();
  expect(materialSummary().textContent).toContain("当前图表暂不能记录");
  expect(materialChip().textContent).toBe("暂不能记录");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).toHaveBeenCalledTimes(2);
});


test("ranking records the selected metric and displayed industries when asked, then drills into the same trend", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({
    ...page([]), rows: [
      { ...row(country, year, 999), "weighted degree": country === "CHN" ? 20 : 90 },
      { ...row(country, year, 888, "C27"), "weighted degree": country === "CHN" ? 50 : 3 },
    ],
  }));
  mockReference();
  const save = mock(() => {});
  render(<NetworkTrend meta={meta} initialCountry="CHN" onRecord={save} />);
  fireEvent.click(screen.getByRole("button", { name: "行业排名" }));
  await screen.findByRole("region", { name: "行业排名条形图" });
  // Each industry shows its global median on both bars, and country A's rank in that industry worldwide.
  await waitFor(() => expect(document.querySelectorAll("[data-global-median]")).toHaveLength(4));
  expect(screen.getAllByText("全球第 3 位 / 76")).toHaveLength(2);
  // Opening the ranking records nothing; its button does.
  const record = await recordButton();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(record);
  expect(save).toHaveBeenCalledTimes(1);
  const [countries, observations] = save.mock.calls[0] as unknown as [string[], Array<Record<string, unknown>>];
  expect(countries).toEqual(["CHN", "USA"]);
  expect(observations.map(({ country, industry, year, value }) => [country, industry, year, value])).toEqual([
    ["CHN", "C27", 2020, 50], ["USA", "C27", 2020, 3], ["CHN", "C26", 2020, 20], ["USA", "C26", 2020, 90],
  ]);
  expect(observations.every((item) => item.source === "explicit-network-ranking" && item.metric === "weighted degree" && item.unit === "百万美元")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /查看 C27.*历年变化/ }));
  expect((screen.getByLabelText("行业") as HTMLSelectElement).value).toBe("C27");
  expect((screen.getByLabelText("网络指标") as HTMLSelectElement).value).toBe("weighted degree");
  expect((screen.getByLabelText("对比国家 B") as HTMLSelectElement).value).toBe("USA");
  expect(screen.getByRole("img").getAttribute("aria-label")).toContain("加权总度");
  // Drilling in records nothing by itself; the drilled-in trend becomes the record when asked.
  expect(save).toHaveBeenCalledTimes(1);
  fireEvent.click(await recordButton());
  expect(save).toHaveBeenCalledTimes(2);
  const last = save.mock.calls.at(-1) as unknown as [string[], Array<Record<string, unknown>>];
  expect(last[1].length).toBeGreaterThan(0);
  expect(last[1].every((item) => item.industry === "C27" && item.source === "explicit-network-trend")).toBe(true);
});


test("recording takes a click, never a browse; the card says whether the chart on screen is the recorded one; sync failures are exposed", async () => {
  mockReference();
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({
    ...page([]), rows: [{ ...row(country, year, country === "CHN" ? 7 : 3), "weighted degree": country === "CHN" ? 80 : 15 }],
  }));
  const save = mock((_countries: string[], _observations: VizObservation[]) => {});
  const retry = mock(() => {});
  const props = { meta, initialCountry: "CHN", onRecord: save, onRetrySync: retry };
  const { rerender } = render(<NetworkTrend {...props} />);
  const record = await recordButton();
  expect(save).not.toHaveBeenCalled();
  expect(materialChip().textContent).toBe("尚未记录");
  expect(materialSummary().textContent).toBe(NOT_RECORDED_HINT);
  expect(materialHow()!.textContent).toBe("每步记一张图：看好了就点下面的按钮；再点另一张即替换。");
  fireEvent.click(record);
  expect(save).toHaveBeenCalledTimes(1);
  const saved = save.mock.calls[0][1];
  expect(saved.every((item) => item.metric === "weighted degree")).toBe(true);
  rerender(<NetworkTrend {...props} observations={saved} />);
  expect(materialChip().textContent).toBe("已记录");
  expect(materialSummary().textContent).toBe(`CHN 中国 与 USA 美国 · 加权总度 · 2018–2020 年 · C26 计算机电子光学（${saved.length} 条读数）`);
  expect(materialHow()!.textContent).toBe("当前图表就是已记录的材料；换视角、国家或指标不会改动它。");
  expect(materialCard().querySelector("details.material-card-check summary")!.textContent).toBe(`核对已记录的读数 · ${saved.length} 条`);
  expect(recordedButton().disabled).toBe(true);
  rerender(<NetworkTrend {...props} observations={saved} syncing />);
  expect(screen.getByText("正在同步实验记录…")).toBeTruthy();
  // Changing the indicator shows another chart; nothing is recorded until the student asks.
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "betweenesscentrality" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).toHaveBeenCalledTimes(1);
  expect(materialHow()!.textContent).toBe("已记录的是另一张图；要换成当前图表，点下面的按钮。");
  expect(materialSummary().textContent).toContain("加权总度");
  rerender(<NetworkTrend {...props} observations={saved} syncError="offline" />);
  expect(screen.getByRole("alert").textContent).toContain("还没保存成功");
  fireEvent.click(screen.getByRole("button", { name: "重试同步" }));
  expect(retry).toHaveBeenCalledTimes(1);
  fireEvent.click(await recordButton());
  expect(save).toHaveBeenCalledTimes(2);
  const updated = save.mock.calls[1][1];
  expect(updated).toHaveLength(6);
  expect(updated.map((item) => item.value)).toEqual([7, 7, 7, 3, 3, 3]);
  expect(updated.every((item) => item.metric === "betweenesscentrality")).toBe(true);
  // No flash announces the change: the card and the button say what is recorded.
  expect(document.querySelector(".scope-flash")).toBeNull();
  expect(document.body.textContent).not.toContain("报告材料已更新为");
  rerender(<NetworkTrend {...props} observations={updated} />);
  expect(materialSummary().textContent).toBe("CHN 中国 与 USA 美国 · betweenesscentrality · 2018–2020 年 · C26 计算机电子光学（6 条读数）");
  expect(materialHow()!.textContent).toBe("当前图表就是已记录的材料；换视角、国家或指标不会改动它。");
  expect(recordedButton().disabled).toBe(true);
  expect(document.body.textContent).not.toContain("报告材料已更新为");
});


test("after the report is submitted, step 9 replaces its material only when the student asks, then points to step 15", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => page([row(country, year, (country === "CHN" ? 10 : 70) + year - 2018)]));
  mockReference();
  const save = mock(() => {});
  const release = "a".repeat(32);
  // Material recorded before submission: the pair's 加权总度 trend (readings the data no longer matches).
  const earlier: VizObservation[] = ["CHN", "USA"].flatMap((country) => [2018, 2019, 2020].map((year) => ({
    entity: `${country}·C26`, country, industry: "C26", year, value: 1, metric: "weighted degree", unit: "百万美元", source: "explicit-network-trend", release,
  })));
  const props = { meta, initialCountry: "CHN", initialCountries: ["CHN", "USA"], observations: earlier, onRecord: save, locked: true };
  const view = render(<NetworkTrend {...props} />);
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "betweenesscentrality" } });
  const replace = await screen.findByRole("button", { name: REPLACE_MATERIAL_ACTION });
  expect(screen.queryByRole("button", { name: RECORD_CHART_ACTION })).toBeNull();
  expect(materialChip().textContent).toBe("已记录");
  expect(materialHow()!.textContent).toBe(`已记录的是另一张图；要换成当前图表，点下面的按钮。 ${MATERIAL_LOCKED_NOTE}`);
  expect(materialCard().textContent).not.toContain(MATERIAL_RECHOSEN_NEXT);
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(replace);
  expect(save).toHaveBeenCalledTimes(1);
  const [countries, observations] = (save.mock.calls[0] as unknown as [string[], VizObservation[]]);
  expect(countries).toEqual(["CHN", "USA"]);
  expect(observations.every((item) => item.metric === "betweenesscentrality")).toBe(true);
  expect(materialHow()!.textContent).toContain(`${MATERIAL_LOCKED_NOTE}${MATERIAL_RECHOSEN_NEXT}`);
  // Once the parent holds the recorded readings, the confirmation says what to do next.
  view.rerender(<NetworkTrend {...props} observations={observations} />);
  expect(materialHow()!.textContent).toBe(`当前图表就是已记录的材料；换视角、国家或指标不会改动它。 ${MATERIAL_LOCKED_NOTE}${MATERIAL_RECHOSEN_NEXT}`);
  expect(recordedButton().disabled).toBe(true);
});


test("one economy alone can be recorded against the same-industry reference", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => page([row(country, year, (country === "CHN" ? 10 : 70) + year - 2018)]));
  mockReference();
  const save = mock((_countries: string[], _observations: VizObservation[]) => {});
  render(<NetworkTrend meta={meta} initialCountry="CHN" onRecord={save} />);
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "betweenesscentrality" } });
  fireEvent.click(await recordButton());
  expect(save.mock.calls.at(-1)![0]).toEqual(["CHN", "USA"]);
  fireEvent.click(screen.getByRole("button", { name: /^移除对比国家 B/ }));
  fireEvent.click(await recordButton());
  expect(save.mock.calls.at(-1)![0]).toEqual(["CHN"]);
  expect(save.mock.calls.at(-1)![1].every((item) => item.country === "CHN")).toBe(true);
  // A second comparison country can be added; the scope card lists all three.
  // Choosing in the add control only stages the country; 添加 commits it.
  fireEvent.change(screen.getByLabelText("加一个对比国家（可选）"), { target: { value: "USA" } });
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  fireEvent.change(screen.getByLabelText("再加一个对比国家"), { target: { value: "DEU" } });
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  fireEvent.click(await recordButton());
  expect(save.mock.calls.at(-1)![0]).toEqual(["CHN", "USA", "DEU"]);
  expect(save).toHaveBeenCalledTimes(3);
  expect(screen.getByLabelText("当前图表范围").textContent).toContain("CHN 中国、USA 美国、DEU 德国");
});


test("an all-zero trend (an industry with no output) is refused with a reason and keeps the earlier material", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({
    ...page([]), rows: [
      { ...row(country, year, 5), "weighted degree": country === "CHN" ? 80 + year : 15 + year },
      { ...row(country, year, 0, "C27"), "weighted degree": 0 },
    ],
  }));
  mockReference();
  const save = mock((_countries: string[], _observations: VizObservation[]) => {});
  const props = { meta, initialCountry: "CHN", onRecord: save };
  const { rerender } = render(<NetworkTrend {...props} />);
  fireEvent.click(await recordButton());
  expect(save).toHaveBeenCalledTimes(1);
  const useful = save.mock.calls[0][1];
  rerender(<NetworkTrend {...props} observations={useful} />);
  expect(recordedButton().disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("行业"), { target: { value: "C27" } });
  await waitFor(() => expect(materialHow()!.textContent).toContain("全部为 0"));
  expect(materialHow()!.textContent).toBe("已记录的是另一张图；当前图表暂不能记录：图上所选国家历年的加权总度全部为 0（真实的 0，例如没有生产或连接，不是缺少数据），没有可比较的差别，不记录为报告材料。");
  expect(screen.queryByRole("button", { name: RECORD_CHART_ACTION })).toBeNull();
  expect(materialCard().querySelector(".material-card-action")).toBeNull();
  // Nothing is recorded, so the earlier material stays and the card still lists it.
  expect(materialChip().textContent).toBe("已记录");
  expect(materialSummary().textContent).toContain(`（${useful.length} 条读数）`);
  expect(materialCard().querySelector("details.material-card-check summary")!.textContent).toBe(`核对已记录的读数 · ${useful.length} 条`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(save).toHaveBeenCalledTimes(1);
  // Every value equal but not zero is refused as well.
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "betweenesscentrality" } });
  fireEvent.change(screen.getByLabelText("行业"), { target: { value: "C26" } });
  await waitFor(() => expect(materialHow()!.textContent).toContain("相同（都是 5）"));
  expect(screen.queryByRole("button", { name: RECORD_CHART_ACTION })).toBeNull();
  expect(save).toHaveBeenCalledTimes(1);
});


test("the material card says whether the chart on screen is the recorded one, and moving between charts changes nothing", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({
    ...page([]), rows: [{ ...row(country, year, country === "CHN" ? 7 : 3), "weighted degree": country === "CHN" ? 80 + year : 15 + year }],
  }));
  mockReference();
  const save = mock((_countries: string[], _observations: VizObservation[]) => {});
  const props = { meta, initialCountry: "CHN", onRecord: save };
  const { rerender } = render(<NetworkTrend {...props} />);
  fireEvent.click(await recordButton());
  const saved = save.mock.calls[0][1];
  rerender(<NetworkTrend {...props} observations={saved} />);
  expect(materialChip().textContent).toBe("已记录");
  expect(materialSummary().textContent).toBe("CHN 中国 与 USA 美国 · 加权总度 · 2018–2020 年 · C26 计算机电子光学（6 条读数）");
  expect(materialHow()!.textContent).toBe("当前图表就是已记录的材料；换视角、国家或指标不会改动它。");
  expect(recordedButton().disabled).toBe(true);
  // Another chart on screen: the card points to the button, and the move itself records nothing.
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "betweenesscentrality" } });
  expect(materialHow()!.textContent).toBe("已记录的是另一张图；要换成当前图表，点下面的按钮。");
  expect(screen.getByRole("button", { name: RECORD_CHART_ACTION })).toBeTruthy();
  expect(save).toHaveBeenCalledTimes(1);
  // An exploration view has no readings to record; the card still says another chart is recorded.
  fireEvent.click(screen.getByRole("button", { name: "流量与路径" }));
  expect(materialHow()!.textContent).toBe("已记录的是另一张图；当前图表没有可记录的读数。");
  expect(materialChip().textContent).toBe("已记录");
  expect(materialSummary().textContent).toBe("CHN 中国 与 USA 美国 · 加权总度 · 2018–2020 年 · C26 计算机电子光学（6 条读数）");
  expect(screen.getByLabelText("当前图表范围").textContent).toContain("这张图没有可记录的读数条目");
  expect(screen.queryByRole("button", { name: RECORD_CHART_ACTION })).toBeNull();
  expect(materialCard().querySelector(".material-card-action")).toBeNull();
  // Back on the recorded chart.
  fireEvent.click(screen.getByRole("button", { name: "历年变化" }));
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "weighted degree" } });
  expect(materialHow()!.textContent).toBe("当前图表就是已记录的材料；换视角、国家或指标不会改动它。");
  expect(recordedButton().disabled).toBe(true);
  expect(save).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain("报告材料已更新为");
  expect(document.body.textContent).not.toContain("只供探索");
  expect(document.body.textContent).not.toContain("自动记录");
});

test("path metrics of an industry that reaches no other industry are undefined, not 0", async () => {
  const rows = [
    { country: "CHN", year: 2020, industry: "C26", Eccentricity: 0, closnesscentrality: 0, betweenesscentrality: 0 },
    { country: "USA", year: 2020, industry: "C26", Eccentricity: 2, closnesscentrality: 0.4, betweenesscentrality: 0 },
    { country: "CHN", year: 2020, industry: "C27", Eccentricity: 3, closnesscentrality: 0.3, betweenesscentrality: 0 },
    { country: "USA", year: 2020, industry: "C27", Eccentricity: 0, closnesscentrality: 0, betweenesscentrality: 0 },
  ];
  expect(networkTrendPoints(rows, [2020], ["CHN", "USA"], "C26", "Eccentricity")).toEqual([
    { country: "CHN", year: 2020, value: null, undefined: true },
    { country: "USA", year: 2020, value: 2 },
  ]);
  // Betweenness 0 is a real zero.
  expect(networkTrendPoints(rows, [2020], ["CHN"], "C26")).toEqual([{ country: "CHN", year: 2020, value: 0 }]);
  // Country A's undefined industry is not ranked; a comparison country's undefined value is marked.
  expect(networkRanking(rows, 2020, ["CHN", "USA"], "closnesscentrality", 10)).toEqual([
    { industry: "C27", values: [0.3, null], undefinedAt: [false, true] },
  ]);
});

test("a path metric undefined in every year names the economy instead of saying 有的年份", async () => {
  // KHM B05_06: no outgoing links in any year, so 离心率 is undefined throughout; USA has readings.
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) =>
    page([{ country, year, industry: "C26", Eccentricity: country === "CHN" ? 0 : year === 2020 ? 3 : 2 } as unknown as ReturnType<typeof row>]),
  );
  mockReference();
  const schema = {
    groups: [{ key: "network", label: "生产网络指标", fields: ["weighted degree", "Eccentricity"] }],
    fields: { Eccentricity: { label: "离心率", format: "count" as const, desc: "" } },
  };
  render(<NetworkTrend meta={meta} schema={schema} initialCountry="CHN" onRecord={mock(() => {})} />);
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "Eccentricity" } });
  const note = await screen.findByText(/都没有离心率读数/);
  expect(note.textContent).toContain("CHN 中国在所选年份都没有离心率读数（该行业无连接）");
  expect(note.textContent).not.toContain("有的年份");
  expect(note.textContent).not.toContain("至少需要两个共同有效年份");
  // The reason is said once, by the chart's reading for country A.
  expect(document.body.textContent!.split("离心率无法定义").length - 1).toBe(1);
});

test("T 离心率: undefined for every selected economy, the reason is said once", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) =>
    page([{ country, year, industry: "C26", Eccentricity: 0 } as unknown as ReturnType<typeof row>]),
  );
  mockReference();
  const schema = {
    groups: [{ key: "network", label: "生产网络指标", fields: ["weighted degree", "Eccentricity"] }],
    fields: { Eccentricity: { label: "离心率", format: "count" as const, desc: "" } },
  };
  render(<NetworkTrend meta={meta} schema={schema} initialCountry="CHN" initialCountries={["CHN", "USA"]} onRecord={mock(() => {})} />);
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "Eccentricity" } });
  await screen.findByText(/都没有离心率读数/);
  expect(document.body.textContent!.split("离心率无法定义").length - 1).toBe(1);
  expect(screen.queryByText(/图上留空/)).toBeNull();
});


test("加权总度 of an industry with no flows anywhere (T) reads as real zeros, with its 指标 named (round 12)", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) =>
    page([{ country, year, industry: "C26", "weighted degree": 0, Eccentricity: 0 } as unknown as ReturnType<typeof row>]),
  );
  mockReference();
  const schema = {
    groups: [{ key: "network", label: "生产网络指标", fields: ["weighted degree", "Eccentricity"] }],
    fields: { "weighted degree": { label: "加权总度", format: "amount" as const, desc: "" }, Eccentricity: { label: "离心率", format: "count" as const, desc: "" } },
  };
  const save = mock(() => {});
  render(<NetworkTrend meta={meta} schema={schema} initialCountry="CHN" onRecord={save} />);
  // The reason sits where the record button would be.
  await waitFor(() => expect(materialSummary().textContent).toContain("全部为 0（真实的 0，例如没有生产或连接，不是缺少数据）"));
  expect(materialChip().textContent).toBe("暂不能记录");
  expect(screen.getByText(/都是 0：这是真实的 0/)).toBeTruthy();
  expect(screen.queryByText("该行业没有数据，请更换行业、指标或国家。")).toBeNull();
  expect(materialSummary().textContent).not.toContain("至少需要两个共同有效年份");
  expect(screen.queryByRole("button", { name: RECORD_CHART_ACTION })).toBeNull();
  // A pick the list does not offer (the select then reads "") falls back to 加权总度 instead of a blank 指标.
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "不存在的指标" } });
  const scope = screen.getByRole("group", { name: "当前图表范围" });
  await waitFor(() => expect(scope.textContent).toContain("指标加权总度"));
  expect(materialSummary().textContent).toContain("全部为 0");
  expect(save).not.toHaveBeenCalled();
});

test("step 9 keeps the countries, view and industry of an exploration view after leaving the step", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => page([row(country, year, 10)]));
  mockReference();
  const browsed: unknown[] = [];
  const first = render(<NetworkTrend meta={meta} initialCountry="CHN" initialCountries={["CHN", "USA"]} onRecord={() => {}} onBrowse={(value) => browsed.push(value)} />);
  fireEvent.click(screen.getByRole("button", { name: "流量与路径" }));
  fireEvent.change(screen.getByLabelText("国家 A"), { target: { value: "DEU" } });
  await waitFor(() => expect(browsed.at(-1)).toMatchObject({ countries: ["DEU", "USA"], view: "topology", industry: "C26" }));
  first.unmount();
  render(<NetworkTrend meta={meta} initialCountry="CHN" initialCountries={["CHN", "USA"]} onRecord={() => {}} initialBrowse={{ ...(browsed.at(-1) as { countries: string[]; view: string; industry: string; metric: string; year: number }), industry: "C27" }} />);
  expect((screen.getByLabelText("国家 A") as HTMLSelectElement).value).toBe("DEU");
  expect(screen.getByRole("button", { name: "流量与路径" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "历年变化" }));
  expect((screen.getByLabelText("行业") as HTMLSelectElement).value).toBe("C27");
});

test("undefined path metrics: no long note under the chart; the readings mark those years 无连接，无法定义", async () => {
  // CHN and USA have no outgoing links in every year; DEU only in 2018.
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => page([{
    country, year, industry: "C26", closnesscentrality: country === "DEU" ? (year === 2018 ? 0 : 0.5) : 0,
  } as never]));
  mockReference();
  render(<NetworkTrend meta={meta} initialCountry="CHN" initialCountries={["CHN", "USA", "DEU"]} onRecord={() => {}}
    initialBrowse={{ countries: ["CHN", "USA", "DEU"], view: "trend", industry: "C26", metric: "closnesscentrality", year: 2020 }} />);
  const table = await screen.findByRole("region", { name: "行业趋势逐年读数" });
  await waitFor(() => expect(table.textContent).toContain("无连接，无法定义"));
  // The undefined years are blank on the chart and labelled in the readings; no note repeats the reason.
  expect(document.body.textContent).not.toContain("不参与排名和中位数");
  expect(document.body.textContent).not.toContain("（不是 0");
  const rows = [...table.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent));
  expect(rows.find((cells) => cells[0] === "2018")?.slice(1)).toEqual(["无连接，无法定义", "无连接，无法定义", "无连接，无法定义"]);
  expect(rows.find((cells) => cells[0] === "2016")?.[3]).not.toBe("无连接，无法定义");
});

test("流量与路径 says which industries it leaves out and why", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => page([
    { country, year, industry: "C26", "weighted degree": 120, betweenesscentrality: 3 },
    { country, year, industry: "C27", "weighted degree": 0, betweenesscentrality: 0 },
    { country, year, industry: "T", "weighted degree": 0, betweenesscentrality: 0 },
  ] as never));
  mockReference();
  render(<NetworkTrend meta={{ ...meta, sectors: ["C26", "C27", "T"] }} initialCountry="CHN" initialCountries={["CHN", "USA"]} onRecord={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "流量与路径" }));
  await waitFor(() => expect(screen.getAllByText("另有 2 个行业没有画出：C27、T 加权总度为 0（没有买卖，无法在对数刻度上显示）。")).toHaveLength(2));
});

test("a recorded ranking does not change the trend's industry; a carried pair says where it came from", () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => page([row(country, year, 10)]));
  mockReference();
  const release = "a".repeat(32);
  const ranking: VizObservation[] = ["C27", "C26"].map((industry) => ({ entity: `CHN·${industry}`, country: "CHN", industry, year: 2020, value: 1, metric: "weighted degree", source: "explicit-network-ranking", release }));
  render(<NetworkTrend meta={meta} initialCountry="CHN" initialCountries={["CHN", "USA"]} observations={ranking} carriedNote="沿用步骤 6 的国家，可以更换。" onRecord={() => {}} />);
  expect(screen.getByRole("button", { name: "行业排名" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "历年变化" }));
  // The top-ranked C27 is not the trend's industry: the trend keeps its default.
  expect((screen.getByLabelText("行业") as HTMLSelectElement).value).toBe("C26");
  expect(screen.queryByText("沿用步骤 6 的国家，可以更换。")).toBeNull();
  cleanup();
  render(<NetworkTrend meta={meta} initialCountry="CHN" initialCountries={["CHN", "USA"]} carriedNote="沿用步骤 6 的国家，可以更换。" onRecord={() => {}} />);
  expect(screen.getByText("沿用步骤 6 的国家，可以更换。")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("国家 A"), { target: { value: "USA" } });
  expect(screen.queryByText("沿用步骤 6 的国家，可以更换。")).toBeNull();
  expect(screen.getByText("已与对比国家 B 互换。")).toBeTruthy();
});
