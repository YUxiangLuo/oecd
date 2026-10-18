import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../../../api";
import { NOT_RECORDED_HINT, RECORD_CHART_ACTION, RECORDED_CHART_LABEL } from "../../../step-task-card";
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
const recordedPatches = (save: { mock: { calls: unknown[][] } }) =>
  (save.mock.calls as Array<[Partial<VizStepState>]>).map(([patch]) => patch).filter((patch) => "observations" in patch);

test("step 9 records the main comparison only when asked; the exploration views sit in the same view bar and never record", async () => {
  expect(STEP10_DEFAULT_LENS).toBe("heat");
  mockApis();
  const data: VizStepState = { chart: "heat", year: 2020, compared: ["CHN", "USA"], observations: [
    { country: "CHN", industry: "C26", entity: "CHN·C26", year: 2019, value: 21, metric: "weighted degree", source: "explicit-network-trend", unit: "百万美元" },
    { country: "USA", industry: "C26", entity: "USA·C26", year: 2019, value: 13, metric: "weighted degree", source: "explicit-network-trend", unit: "百万美元" },
  ] };
  const save = mock((_patch: Partial<VizStepState>) => {});
  render(<NetworkVizStep meta={meta} step={step} state={{ data, save, syncing: false, syncError: null, syncNow: () => {}, complete: false }} />);
  await screen.findByRole("img");
  expect(screen.getByRole("button", { name: "历年变化" }).getAttribute("aria-pressed")).toBe("true");
  expect(recordedPatches(save)).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "历年变化" }));
  await screen.findByRole("img");
  // Legacy observations without a release do not restore the trend selection;
  // the saved comparison pair (CHN, USA) supplies the initial comparison instead.
  expect(screen.getByLabelText("当前图表范围").textContent).toMatch(/CHN 中国 与 USA 美国.*C26/);
  // The legacy record is another chart: the complete main chart is offered, not recorded, until the student asks.
  const record = await screen.findByRole("button", { name: RECORD_CHART_ACTION });
  expect(screen.getByRole("region", { name: "本步报告材料" }).textContent).toContain("已记录的是另一张图；要换成当前图表，点下面的按钮。");
  expect(recordedPatches(save)).toHaveLength(0);
  fireEvent.click(record);
  expect(recordedPatches(save)).toHaveLength(1);
  const recorded = recordedPatches(save)[0];
  expect(recorded).toEqual({ compared: ["CHN", "USA"], metric: "weighted degree", observations: expect.any(Array), material_chosen: true, material_label: expect.any(String) });
  expect(recorded.material_label).toMatch(/^历年变化 · .*CHN 中国 对 USA 美国.*（4 条读数）$/);
  expect(recorded.observations).toHaveLength(4);
  expect(recorded.observations!.every((item) => item.release === meta.dataset!.release_id && item.source === "explicit-network-trend")).toBe(true);

  // The global overview leads; the remaining views retain their order.
  const bar = screen.getByRole("group", { name: "图表视角" });
  expect(within(bar).getAllByRole("button").map((button) => button.textContent)).toEqual([
    "全球贸易网络图", "历年变化", "行业排名", "流量与路径", "买入与卖出", "贸易伙伴",
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
  expect(screen.getByLabelText("当前图表范围").textContent).toContain("这张图没有可记录的读数条目");
  const card = screen.getByRole("region", { name: "本步报告材料" });
  expect(card.querySelector(".material-card-how")!.textContent).toBe("已记录的是另一张图；当前图表没有可记录的读数。");
  expect(card.querySelector(".material-card-action")).toBeNull();
  expect(screen.queryByRole("button", { name: RECORD_CHART_ACTION })).toBeNull();
  expect(card.textContent).not.toContain("暂不能记录");
  expect(card.querySelector(".material-chip")!.textContent).toBe("已记录");
  expect(screen.getAllByRole("region", { name: /行业买入与卖出/ })).toHaveLength(2);
  fireEvent.click(within(bar).getByRole("button", { name: "流量与路径" }));
  expect(screen.getAllByText(/行业的流量与路径/)).toHaveLength(2);
  const beforeNetwork = save.mock.calls.length;
  fireEvent.click(within(bar).getByRole("button", { name: "全球贸易网络图" }));
  expect(await screen.findByText("贸易网络当前没有可显示的数据。")).toBeTruthy();
  expect(screen.queryByLabelText("国家 A")).toBeNull();
  expect(screen.getByLabelText("当前图表范围").textContent).toContain("全球经济体");
  fireEvent.change(screen.getByLabelText("年份"), { target: { value: "2019" } });
  await waitFor(() => expect(api.network).toHaveBeenLastCalledWith(2019));
  expect(save.mock.calls.length).toBe(beforeNetwork);
  fireEvent.click(within(bar).getByRole("button", { name: "历年变化" }));
  expect(screen.getByLabelText("当前图表范围").textContent).toContain("C26");
  expect(recordedPatches(save)).toHaveLength(1);
  expect(document.body.textContent).not.toContain("只供探索");
  expect(document.body.textContent).not.toContain("自动记录");
});

test("browsing across all six views of step 9 records nothing: material is made only by its button", async () => {
  mockApis();
  const data: VizStepState = { chart: "heat", year: 2020, compared: ["CHN", "USA"] };
  const save = mock((_patch: Partial<VizStepState>) => {});
  const saveView = mock((_patch: Partial<VizStepState>) => {});
  render(<NetworkVizStep meta={meta} step={step} state={{ data, save, saveView, syncing: false, syncError: null, syncNow: () => {}, complete: false }} />);
  await screen.findByRole("img");
  const bar = screen.getByRole("group", { name: "图表视角" });
  for (const name of ["历年变化", "行业排名", "流量与路径", "买入与卖出", "贸易伙伴", "全球贸易网络图"]) {
    fireEvent.click(within(bar).getByRole("button", { name }));
    expect(within(bar).getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true");
  }
  // The recording views: change countries, indicator and year while they are complete.
  fireEvent.click(within(bar).getByRole("button", { name: "历年变化" }));
  await screen.findByRole("img");
  fireEvent.change(screen.getByLabelText("国家 A"), { target: { value: "USA" } });
  await screen.findByRole("img");
  fireEvent.change(screen.getByLabelText("网络指标"), { target: { value: "betweenesscentrality" } });
  await screen.findByRole("img");
  fireEvent.click(within(bar).getByRole("button", { name: "行业排名" }));
  await screen.findByRole("region", { name: "行业排名条形图" });
  fireEvent.change(screen.getAllByLabelText("年份")[0], { target: { value: "2019" } });
  await screen.findByRole("region", { name: "行业排名条形图" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Browsing is kept as browsing state only; no observations or material flag were ever saved.
  expect(saveView.mock.calls.some(([patch]) => "network_browse" in patch)).toBe(true);
  expect(saveView.mock.calls.every(([patch]) => !("observations" in patch) && !("material_chosen" in patch))).toBe(true);
  expect(save.mock.calls.every(([patch]) => !("observations" in patch) && !("material_chosen" in patch))).toBe(true);
  expect(screen.getByRole("region", { name: "本步报告材料" }).textContent).toContain(`尚未记录${NOT_RECORDED_HINT}`);
  // The complete chart is offered; recording it is the one thing that saves material.
  fireEvent.click(screen.getByRole("button", { name: RECORD_CHART_ACTION }));
  // A new pair first clears the material saved for the old one (useVizLab.pickCountries), then the record is saved.
  expect(recordedPatches(save)).toEqual([{ observations: [] }, expect.objectContaining({ compared: ["USA", "CHN"], metric: "betweenesscentrality", material_chosen: true, material_label: expect.stringMatching(/^行业排名 · .*2019 年 · USA 美国 对 CHN 中国/) })]);
  expect(recordedPatches(save).at(-1)!.observations!.every((item) => item.source === "explicit-network-ranking" && item.year === 2019)).toBe(true);
  expect(screen.queryByRole("button", { name: RECORDED_CHART_LABEL })).toBeNull();
});
