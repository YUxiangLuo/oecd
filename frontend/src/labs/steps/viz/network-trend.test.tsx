import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../../../api";
import type { IndustryPage, Meta } from "../../../types";
import { NetworkTrend, networkTrendPoints } from "./network-trend";
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
});

test("after the report is submitted, step 9 records only when the student asks", async () => {
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => page([row(country, year, (country === "CHN" ? 10 : 70) + year - 2018)]));
  mockReference();
  const save = mock(() => {});
  render(<NetworkTrend meta={meta} initialCountry="CHN" initialCountries={["CHN", "USA"]} onRecord={save} locked />);
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "betweenesscentrality" } });
  const record = await screen.findByRole("button", { name: /改用当前图表作为报告材料/ });
  expect(screen.getByText(/报告已提交：浏览不再自动改动报告材料/)).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(record);
  expect(save).toHaveBeenCalledTimes(1);
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
