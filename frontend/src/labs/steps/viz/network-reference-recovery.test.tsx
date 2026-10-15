import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../../../api";
import { RECORD_CHART_ACTION } from "../../../step-task-card";
import type { Meta } from "../../../types";
import { NetworkTrend } from "./network-trend";
import type { VizObservation } from "./scaffold";

afterEach(() => { cleanup(); mock.restore(); });

const meta: Meta = {
  countries: ["CHN", "USA"], sectors: ["C26", "C27"], years: [2019, 2020],
  dataset: { release_id: "a".repeat(32), years: [2019, 2020] },
};
type Reference = Awaited<ReturnType<typeof api.industryDistribution>>;
const referenceResponse = (view: "trend" | "ranking", metric = "weighted degree", rank = 3): Reference => ({
  metric,
  rows: (view === "trend" ? meta.years : [2020]).flatMap((year) => (view === "trend" ? ["C26"] : meta.sectors).map((industry) => ({
    year, industry, n: 76, p25: 5, median: 10, p75: 15, ranks: { CHN: rank, USA: rank + 1 },
  }))),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(view: "trend" | "ranking") {
  const readings = spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({
    rows: meta.sectors.map((industry, index) => ({
      year, country, industry,
      "weighted degree": (country === "CHN" ? 20 : 40) + year - 2019 + index * 5,
      "weighted indegree": (country === "CHN" ? 8 : 12) + year - 2019 + index * 2,
    })), total: 2, page: 1, page_size: 200,
  }));
  const earlier: VizObservation[] = [{
    entity: "CHN·C27", country: "CHN", industry: "C27", year: 2019, value: 901,
    metric: "weighted degree", unit: "百万美元", source: "explicit-network-ranking", release: meta.dataset!.release_id,
  }];
  const record = mock((_countries: string[], _observations: VizObservation[]) => {});
  const rendered = render(<NetworkTrend meta={meta} initialCountry="CHN" onRecord={record}
    initialBrowse={{ countries: ["CHN", "USA"], view, industry: "C26", metric: "weighted degree", year: 2020 }}
    observations={earlier} savedLabel="历史材料：2019 年 C27 行业" />);
  return { readings, record, ...rendered };
}
const referenceMarks = () => document.querySelectorAll('[data-series="global-median"], [data-global-median]');
const savedMaterial = () => screen.getByRole("region", { name: "本步报告材料" });
const shownValues = (view: "trend" | "ranking") => view === "trend"
  ? screen.getByRole("region", { name: "行业趋势逐年读数" }).textContent
  : [...document.querySelectorAll(".rank-value b")].map((node) => node.textContent).join("|");
const shownChart = (view: "trend" | "ranking") => view === "trend"
  ? screen.getByRole("img") : screen.getByRole("region", { name: "行业排名条形图" });

for (const view of ["trend", "ranking"] as const) {
  test(`${view}: global reference retry preserves the visible readings and saved material`, async () => {
    const retry = deferred<Reference>();
    const reference = spyOn(api, "industryDistribution")
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockImplementationOnce(() => retry.promise);
    const { readings, record } = setup(view);
    expect((await screen.findByRole("alert")).textContent).toContain("全球参照加载失败：网络连接中断");
    const status = screen.getByRole("region", { name: "全球参照加载状态" });
    expect(status.textContent).toContain("当前国家的有效读数仍可查看和记录");
    expect(status.textContent).toContain(view === "trend" ? "全球中位数、区间和排名暂未显示" : "全球中位数和排名暂未显示");
    const chart = shownChart(view);
    const values = shownValues(view);
    const material = savedMaterial().innerHTML;
    expect(referenceMarks()).toHaveLength(0);
    expect(readings).toHaveBeenCalledTimes(4);
    expect((screen.getByRole("button", { name: RECORD_CHART_ACTION }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(within(status).getByRole("button", { name: "重试" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("正在加载全球参照…").getAttribute("role")).toBe("status");
    expect(shownChart(view)).toBe(chart);
    expect(shownValues(view)).toBe(values);
    expect(savedMaterial().innerHTML).toBe(material);
    expect(referenceMarks()).toHaveLength(0);
    expect(record).not.toHaveBeenCalled();
    expect(readings).toHaveBeenCalledTimes(4);

    await act(async () => { retry.resolve(referenceResponse(view)); });
    await waitFor(() => expect(referenceMarks().length).toBeGreaterThan(0));
    expect(screen.queryByRole("region", { name: "全球参照加载状态" })).toBeNull();
    expect(shownChart(view)).toBe(chart);
    expect(shownValues(view)).toBe(values);
    expect(savedMaterial().innerHTML).toBe(material);
    expect(reference).toHaveBeenCalledTimes(2);
    expect(reference.mock.calls[1]).toEqual(reference.mock.calls[0]);
    expect(readings).toHaveBeenCalledTimes(4);
    expect(record).not.toHaveBeenCalled();
    // Recording remains an explicit action and still stores the current country readings only.
    fireEvent.click(screen.getByRole("button", { name: RECORD_CHART_ACTION }));
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toEqual(["CHN", "USA"]);
    expect(record.mock.calls[0][1].every((item) => item.metric === "weighted degree"
      && item.source === `explicit-network-${view}` && item.value >= 20 && item.value <= 46)).toBe(true);
  });

  test(`${view}: changing the metric during retry never exposes the earlier reference response`, async () => {
    const staleRetry = deferred<Reference>();
    const current = deferred<Reference>();
    const reference = spyOn(api, "industryDistribution")
      .mockRejectedValueOnce(new Error("服务暂时不可用"))
      .mockImplementationOnce(() => staleRetry.promise)
      .mockImplementationOnce(() => current.promise);
    const { readings, record } = setup(view);
    await screen.findByRole("alert");
    const material = savedMaterial().innerHTML;
    fireEvent.click(within(screen.getByRole("region", { name: "全球参照加载状态" })).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(reference).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "weighted indegree" } });
    await waitFor(() => expect(reference).toHaveBeenCalledTimes(3));
    await act(async () => { staleRetry.resolve(referenceResponse(view, "weighted degree", 71)); });
    expect(referenceMarks()).toHaveLength(0);
    expect(screen.getByText("正在加载全球参照…")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(savedMaterial().innerHTML).toBe(material);

    await act(async () => { current.resolve(referenceResponse(view, "weighted indegree", 6)); });
    await waitFor(() => expect(referenceMarks().length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toContain("第 71");
    expect(document.body.textContent).toContain("第 6");
    expect(screen.queryByRole("region", { name: "全球参照加载状态" })).toBeNull();
    expect(savedMaterial().innerHTML).toBe(material);
    expect(readings).toHaveBeenCalledTimes(4);
    expect(record).not.toHaveBeenCalled();
  });

  test(`${view}: changing view ignores a late failure from the previous reference retry`, async () => {
    const staleRetry = deferred<Reference>();
    const current = deferred<Reference>();
    const reference = spyOn(api, "industryDistribution")
      .mockRejectedValueOnce(new Error("服务暂时不可用"))
      .mockImplementationOnce(() => staleRetry.promise)
      .mockImplementationOnce(() => current.promise);
    const { readings, record } = setup(view);
    await screen.findByRole("alert");
    const material = savedMaterial().innerHTML;
    fireEvent.click(within(screen.getByRole("region", { name: "全球参照加载状态" })).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(reference).toHaveBeenCalledTimes(2));
    const nextView = view === "trend" ? "ranking" : "trend";
    fireEvent.click(screen.getByRole("button", { name: nextView === "trend" ? "历年变化" : "行业排名" }));
    await waitFor(() => expect(reference).toHaveBeenCalledTimes(3));
    await act(async () => { current.resolve(referenceResponse(nextView)); staleRetry.reject(new Error("上一个视角的延迟失败")); });
    await waitFor(() => expect(referenceMarks().length).toBeGreaterThan(0));
    expect(shownChart(nextView)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("region", { name: "全球参照加载状态" })).toBeNull();
    expect(document.body.textContent).not.toContain("上一个视角的延迟失败");
    expect(savedMaterial().innerHTML).toBe(material);
    expect(readings).toHaveBeenCalledTimes(4);
    expect(record).not.toHaveBeenCalled();
  });
}
