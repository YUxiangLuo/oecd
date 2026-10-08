import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../../../api";
import type { Meta, Step } from "../../../types";
import { NetworkVizStep, STEP10_DEFAULT_LENS } from "./network";
import type { VizStepState } from "./scaffold";

afterEach(() => { cleanup(); mock.restore(); });

const meta: Meta = { countries: ["CHN", "USA"], sectors: ["C26"], years: [2019, 2020], dataset: { release_id: "a".repeat(32), years: [2019, 2020] } };
const step: Step = { n: 9, stage: 3, lab: "viz", status: "done", title: "网络指标可视化", goal: "", tasks: ["", "", ""], concept: "", tip: "", deps: [], handoff: { input: "", action: "", output: "" } };

function mockApis() {
  spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({ rows: [{ country, industry: "C26", year, "weighted degree": country === "CHN" ? 5 : 3, "weighted indegree": 2, "weighted outdegree": country === "CHN" ? 3 : 1, betweenesscentrality: 2 }], total: 1, page: 1, page_size: 200 }));
  spyOn(api, "network").mockResolvedValue({ nodes: [], edges: [] });
}

test("step 9 records the main comparison automatically; the exploration views sit in the same view bar and never record", async () => {
  expect(STEP10_DEFAULT_LENS).toBe("heat");
  mockApis();
  const data: VizStepState = { chart: "heat", year: 2020, compared: ["CHN", "USA"], observations: [
    { country: "CHN", industry: "C26", entity: "CHN·C26", year: 2019, value: 21, metric: "weighted degree", source: "explicit-network-trend", unit: "百万美元" },
    { country: "USA", industry: "C26", entity: "USA·C26", year: 2019, value: 13, metric: "weighted degree", source: "explicit-network-trend", unit: "百万美元" },
  ] };
  const save = mock((_patch: Partial<VizStepState>) => {});
  render(<NetworkVizStep meta={meta} step={step} state={{ data, save, syncing: false, syncError: null, syncNow: () => {}, complete: false }} />);
  await screen.findByRole("img");
  // Legacy observations without a release do not restore the trend selection;
  // the saved comparison pair (CHN, USA) supplies the initial comparison instead.
  expect(screen.getByLabelText("当前图表范围").textContent).toMatch(/CHN 中国 与 USA 美国.*C26/);
  expect(screen.queryByRole("button", { name: "保存为报告材料" })).toBeNull();
  // The complete main chart replaces the legacy record automatically.
  await waitFor(() => expect(save.mock.calls.some(([patch]) => "observations" in patch)).toBe(true));
  const recorded = save.mock.calls.map(([patch]) => patch).filter((patch) => "observations" in patch).at(-1)!;
  expect(recorded.compared).toEqual(["CHN", "USA"]);
  expect(recorded.observations!.every((item) => item.release === meta.dataset!.release_id && item.source === "explicit-network-trend")).toBe(true);

  // One view bar: the two recording views in the task order, then the exploration views; no modals.
  const bar = screen.getByRole("group", { name: "图表视角" });
  expect(within(bar).getAllByRole("button").map((button) => button.textContent)).toEqual([
    "历年变化", "行业排名", "流量与路径", "买入与卖出", "贸易伙伴",
  ]);
  expect(screen.queryByRole("group", { name: "补充图表" })).toBeNull();
  // The full-indicator table folds into 行业排名.
  fireEvent.click(within(bar).getByRole("button", { name: "行业排名" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(await screen.findByText(/本表仅供查数/, { selector: "caption" })).toBeTruthy();
  expect(screen.getByText(/全部指标表（一个国家各行业/)).toBeTruthy();
  const callsBefore = save.mock.calls.length;
  // The table opens on country A of the comparison, not on the comparison country B.
  expect((screen.getByLabelText("查看国家") as HTMLSelectElement).value).toBe("CHN");
  fireEvent.change(screen.getByLabelText("查看国家"), { target: { value: "USA" } });
  fireEvent.change(screen.getByLabelText("排序指标"), { target: { value: "weighted degree" } });
  // Browsing an exploration view never touches the report material.
  await waitFor(() => expect(save.mock.calls.length).toBeGreaterThan(callsBefore));
  expect(save.mock.calls.slice(callsBefore).every(([patch]) => !("observations" in patch))).toBe(true);
  fireEvent.click(within(bar).getByRole("button", { name: "买入与卖出" }));
  expect(screen.getByLabelText("当前图表范围").textContent).toContain("探索视角，不记录材料");
  expect(screen.getAllByRole("region", { name: /行业买入与卖出/ })).toHaveLength(2);
  fireEvent.click(within(bar).getByRole("button", { name: "流量与路径" }));
  expect(screen.getAllByText(/行业的流量与路径/)).toHaveLength(2);
  fireEvent.click(within(bar).getByRole("button", { name: "历年变化" }));
  expect(screen.getByLabelText("当前图表范围").textContent).toContain("C26");
});
