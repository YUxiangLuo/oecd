import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../../../api";
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

test("sorts time, separates countries and industries, and preserves zero versus missing", () => {
  expect(networkTrendPoints([
    row("USA", 2020, 83), row("CHN", 2018, 0), row("CHN", 2020, 14),
    row("CHN", 2019, 999, "C27"), row("USA", 2018, NaN),
  ], meta.years, ["CHN", "USA"], "C26")).toEqual([
    { country: "CHN", year: 2018, value: 0 }, { country: "CHN", year: 2019, value: null }, { country: "CHN", year: 2020, value: 14 },
    { country: "USA", year: 2018, value: null }, { country: "USA", year: 2019, value: null }, { country: "USA", year: 2020, value: 83 },
  ]);
});

test("requires at least two years that are valid for both countries before anything is recorded", async () => {
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
  await waitFor(() => expect(screen.getByText(/至少需要两个共同有效年份/)).toBeTruthy());
  expect(screen.queryByRole("button", { name: "保存为报告材料" })).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

test("renders gaps without joining them, records the complete two-country view automatically, and never records stale requests", async () => {
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
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  const [countries, observations] = save.mock.calls[0] as unknown as [string[], Array<Record<string, unknown>>];
  expect(countries).toEqual(["CHN", "USA"]);
  expect(observations.map(({ country, year, value }) => [country, year, value])).toEqual([
    ["CHN", 2018, 10], ["CHN", 2020, 12], ["USA", 2018, 70], ["USA", 2020, 72],
  ]);
  expect(observations.every((item) => item.source === "explicit-network-trend" && item.release === "a".repeat(32))).toBe(true);
  // While Germany's 2020 request is pending nothing new is recorded.
  fireEvent.change(screen.getByLabelText("对比国家 B"), { target: { value: "DEU" } });
  expect(screen.queryByRole("img")).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).toHaveBeenCalledTimes(1);
  resolveGerman(page([row("DEU", 2020, 99)]));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  const [germanCountries, germanObservations] = save.mock.calls[1] as unknown as [string[], Array<Record<string, unknown>>];
  expect(germanCountries).toEqual(["CHN", "DEU"]);
  expect(germanObservations.some((item) => item.country === "DEU" && item.value === 99)).toBe(true);
  // An industry without readings never overwrites the record.
  fireEvent.change(screen.getByLabelText("行业"), { target: { value: "C27" } });
  expect(screen.getByText("该行业没有数据，请更换行业、指标或国家。")).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).toHaveBeenCalledTimes(2);
});

test("ranking records the selected metric and displayed industries, then drills into the same trend", async () => {
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
  const rankingCall = () => (save.mock.calls as unknown as Array<[string[], Array<Record<string, unknown>>]>)
    .find(([, observations]) => observations[0]?.source === "explicit-network-ranking");
  await waitFor(() => expect(rankingCall()).toBeTruthy());
  const [countries, observations] = rankingCall()!;
  expect(countries).toEqual(["CHN", "USA"]);
  expect(observations.map(({ country, industry, year, value }) => [country, industry, year, value])).toEqual([
    ["CHN", "C27", 2020, 50], ["USA", "C27", 2020, 3], ["CHN", "C26", 2020, 20], ["USA", "C26", 2020, 90],
  ]);
  expect(observations.every((item) => item.metric === "weighted degree" && item.unit === "百万美元")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /查看 C27.*历年变化/ }));
  expect((screen.getByLabelText("行业") as HTMLSelectElement).value).toBe("C27");
  expect((screen.getByLabelText("网络指标") as HTMLSelectElement).value).toBe("weighted degree");
  expect((screen.getByLabelText("对比国家 B") as HTMLSelectElement).value).toBe("USA");
  expect(screen.getByRole("img").getAttribute("aria-label")).toContain("加权总度");
  // The drilled-in trend becomes the record.
  await waitFor(() => {
    const last = save.mock.calls.at(-1) as unknown as [string[], Array<Record<string, unknown>>];
    expect(last[1].every((item) => item.industry === "C27" && item.source === "explicit-network-trend")).toBe(true);
  });
});

test("the record follows the current chart, waits while a sync is in flight, and exposes sync failures", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({
    ...page([]), rows: [{ ...row(country, year, country === "CHN" ? 7 : 3), "weighted degree": country === "CHN" ? 80 : 15 }],
  }));
  const save = mock((_countries: string[], _observations: VizObservation[]) => {});
  const retry = mock(() => {});
  const props = { meta, initialCountry: "CHN", onRecord: save, onRetrySync: retry };
  const { rerender } = render(<NetworkTrend {...props} />);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  const saved = save.mock.calls[0][1];
  expect(saved.every((item) => item.metric === "weighted degree")).toBe(true);
  rerender(<NetworkTrend {...props} observations={saved} />);
  expect(screen.getByRole("region", { name: "步骤9报告材料" }).textContent).toContain("当前图表已自动记录");
  rerender(<NetworkTrend {...props} observations={saved} syncing />);
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "betweenesscentrality" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).toHaveBeenCalledTimes(1);
  rerender(<NetworkTrend {...props} observations={saved} syncError="offline" />);
  expect(screen.getByRole("alert").textContent).toContain("还没保存成功");
  fireEvent.click(screen.getByRole("button", { name: "重试同步" }));
  expect(retry).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  const updated = save.mock.calls[1][1];
  expect(updated).toHaveLength(6);
  expect(updated.map((item) => item.value)).toEqual([7, 7, 7, 3, 3, 3]);
  expect(updated.every((item) => item.metric === "betweenesscentrality")).toBe(true);
  // The task card says 报告材料：未保存 while the save fails: no green "已更新为" note beside it.
  expect(document.querySelector(".scope-flash")).toBeNull();
  rerender(<NetworkTrend {...props} observations={updated} />);
  expect(document.querySelector(".scope-flash")?.textContent).toContain("报告材料已更新为");
});

test("after the report is submitted, step 9 records only when the student asks", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => page([row(country, year, (country === "CHN" ? 10 : 70) + year - 2018)]));
  mockReference();
  const save = mock(() => {});
  const view = render(<NetworkTrend meta={meta} initialCountry="CHN" initialCountries={["CHN", "USA"]} onRecord={save} locked />);
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "betweenesscentrality" } });
  const record = await screen.findByRole("button", { name: /改用当前图表作为报告材料/ });
  expect(screen.getByText(/报告已提交：浏览不再自动改动报告材料/)).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(record);
  expect(save).toHaveBeenCalledTimes(1);
  // Once the parent holds the recorded readings, the confirmation says what to do next.
  const [countries, observations] = (save.mock.calls[0] as unknown as [string[], VizObservation[]]);
  expect(countries).toEqual(["CHN", "USA"]);
  view.rerender(<NetworkTrend meta={meta} initialCountry="CHN" initialCountries={["CHN", "USA"]} observations={observations} onRecord={save} locked />);
  expect(screen.getByRole("region", { name: "步骤9报告材料" }).textContent).toContain("当前图表就是已记录的材料。请到步骤 15 更新报告并重新提交给老师。");
});

test("one economy alone records against the same-industry reference", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => page([row(country, year, (country === "CHN" ? 10 : 70) + year - 2018)]));
  mockReference();
  const save = mock((_countries: string[], _observations: VizObservation[]) => {});
  render(<NetworkTrend meta={meta} initialCountry="CHN" onRecord={save} />);
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "betweenesscentrality" } });
  await waitFor(() => expect(save).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /^移除对比国家 B/ }));
  await waitFor(() => expect(save.mock.calls.at(-1)![0]).toEqual(["CHN"]));
  expect(save.mock.calls.at(-1)![1].every((item) => item.country === "CHN")).toBe(true);
  // A second comparison country can be added; the scope card lists all three.
  // Choosing in the add control only stages the country; 添加 commits it.
  fireEvent.change(screen.getByLabelText("加一个对比国家（可选）"), { target: { value: "USA" } });
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  fireEvent.change(screen.getByLabelText("再加一个对比国家"), { target: { value: "DEU" } });
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  await waitFor(() => expect(save.mock.calls.at(-1)![0]).toEqual(["CHN", "USA", "DEU"]));
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
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  const useful = save.mock.calls[0][1];
  rerender(<NetworkTrend {...props} observations={useful} />);
  fireEvent.change(screen.getByLabelText("行业"), { target: { value: "C27" } });
  const material = screen.getByRole("region", { name: "步骤9报告材料" });
  await waitFor(() => expect(material.textContent).toContain("全部为 0"));
  expect(material.textContent).toContain("没有可比较的差别");
  expect(material.textContent).toContain("已记录的材料保持不变");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(save).toHaveBeenCalledTimes(1);
  // Every value equal but not zero is refused as well.
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "betweenesscentrality" } });
  fireEvent.change(screen.getByLabelText("行业"), { target: { value: "C26" } });
  await waitFor(() => expect(material.textContent).toContain("相同（都是 5）"));
  expect(save).toHaveBeenCalledTimes(1);
});

test("the update note names the indicator and goes when the chart can no longer be recorded", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({
    ...page([]), rows: [{ ...row(country, year, country === "CHN" ? 7 : 3), "weighted degree": country === "CHN" ? 80 + year : 15 + year }],
  }));
  mockReference();
  const save = mock((_countries: string[], _observations: VizObservation[]) => {});
  const props = { meta, initialCountry: "CHN", onRecord: save };
  const { rerender } = render(<NetworkTrend {...props} />);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  rerender(<NetworkTrend {...props} observations={save.mock.calls[0][1]} />);
  expect(document.querySelector(".scope-flash")).toBeNull();
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "betweenesscentrality" } });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  rerender(<NetworkTrend {...props} observations={save.mock.calls[1][1]} />);
  expect(document.querySelector(".scope-flash")?.textContent).toContain("报告材料已更新为：历年变化 · C26 计算机电子光学 · betweenesscentrality · 6 条读数");
  // An exploration view records nothing: the note about the trend must not stay beside it.
  fireEvent.click(screen.getByRole("button", { name: "流量与路径" }));
  expect(document.querySelector(".scope-flash")).toBeNull();
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
  const note = await screen.findByText(/离心率都无法定义/);
  expect(note.textContent).toContain("CHN 中国的该行业在所选年份都");
  expect(note.textContent).not.toContain("有的年份");
  expect(note.textContent).not.toContain("至少需要两个共同有效年份");
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
  const material = screen.getByRole("region", { name: "步骤9报告材料" });
  await waitFor(() => expect(material.textContent).toContain("全部为 0（真实的 0，例如没有生产或连接，不是缺少数据）"));
  expect(screen.getByText(/都是 0：这是真实的 0/)).toBeTruthy();
  expect(screen.queryByText("该行业没有数据，请更换行业、指标或国家。")).toBeNull();
  expect(material.textContent).not.toContain("至少需要两个共同有效年份");
  // A pick the list does not offer (the select then reads "") falls back to 加权总度 instead of a blank 指标.
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "不存在的指标" } });
  const scope = screen.getByRole("group", { name: "当前图表范围" });
  await waitFor(() => expect(scope.textContent).toContain("指标加权总度"));
  expect(material.textContent).toContain("全部为 0");
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

test("undefined path metrics: economies with the same years share one clause", async () => {
  // CHN and USA have no outgoing links in every year; DEU only in 2018.
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => page([{
    country, year, industry: "C26", closnesscentrality: country === "DEU" ? (year === 2018 ? 0 : 0.5) : 0,
  } as never]));
  mockReference();
  render(<NetworkTrend meta={meta} initialCountry="CHN" initialCountries={["CHN", "USA", "DEU"]} onRecord={() => {}}
    initialBrowse={{ countries: ["CHN", "USA", "DEU"], view: "trend", industry: "C26", metric: "closnesscentrality", year: 2020 }} />);
  await waitFor(() => expect(screen.getByText(/无法定义（不是 0，不参与排名和中位数，图上留空）/)).toBeTruthy());
  const note = screen.getByText(/无法定义（不是 0，不参与排名和中位数，图上留空）/).textContent!;
  expect(note.startsWith("CHN 中国、USA 美国 历年，DEU 德国 2018 年的 C26")).toBe(true);
  expect(note).not.toContain("中国历年");
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
  render(<NetworkTrend meta={meta} initialCountry="CHN" initialCountries={["CHN", "USA"]} observations={ranking} carriedNote="沿用你在步骤 6 选的国家，可以更换。" onRecord={() => {}} />);
  expect(screen.getByRole("button", { name: "行业排名" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "历年变化" }));
  // The top-ranked C27 is not the trend's industry: the trend keeps its default.
  expect((screen.getByLabelText("行业") as HTMLSelectElement).value).toBe("C26");
  expect(screen.queryByText("沿用你在步骤 6 选的国家，可以更换。")).toBeNull();
  cleanup();
  render(<NetworkTrend meta={meta} initialCountry="CHN" initialCountries={["CHN", "USA"]} carriedNote="沿用你在步骤 6 选的国家，可以更换。" onRecord={() => {}} />);
  expect(screen.getByText("沿用你在步骤 6 选的国家，可以更换。")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("国家 A"), { target: { value: "USA" } });
  expect(screen.queryByText("沿用你在步骤 6 选的国家，可以更换。")).toBeNull();
  expect(screen.getByText("已与对比国家 B 互换。")).toBeTruthy();
});
