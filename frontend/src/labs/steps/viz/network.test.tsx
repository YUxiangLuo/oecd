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
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({ rows: [{ country, industry: "C26", year, "weighted degree": country === "CHN" ? 5 : 3, betweenesscentrality: 2 }], total: 1, page: 1, page_size: 200 }));
  spyOn(api, "network").mockResolvedValue({ nodes: [], edges: [] });
}

test("step 9 records the main comparison automatically; supplementary charts open in modals without replacing it", async () => {
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
  expect(screen.getByLabelText("当前比较口径").textContent).toContain("CHN 中国与USA 美国 · C26");
  expect(screen.queryByRole("button", { name: "保存为报告材料" })).toBeNull();
  // The complete main chart replaces the legacy record automatically.
  await waitFor(() => expect(save.mock.calls.some(([patch]) => "observations" in patch)).toBe(true));
  const recorded = save.mock.calls.map(([patch]) => patch).filter((patch) => "observations" in patch).at(-1)!;
  expect(recorded.compared).toEqual(["CHN", "USA"]);
  expect(recorded.observations!.every((item) => item.release === meta.dataset!.release_id && item.source === "explicit-network-trend")).toBe(true);

  // Supplementary charts are buttons that open a modal; the main chart stays mounted.
  const group = screen.getByRole("group", { name: "补充图表" });
  expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual([
    "贸易联系概览（国家间网络图） ↗",
    "单国行业热力表 ↗",
  ]);
  fireEvent.click(within(group).getByRole("button", { name: /单国行业热力表/ }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/本表仅供查数/, { selector: "caption" })).toBeTruthy();
  const callsBefore = save.mock.calls.length;
  fireEvent.change(within(dialog).getByLabelText("下钻国家"), { target: { value: "CHN" } });
  fireEvent.change(within(dialog).getByLabelText("排序指标"), { target: { value: "weighted degree" } });
  // Browsing inside the modal never touches the report material.
  await waitFor(() => expect(save.mock.calls.length).toBeGreaterThan(callsBefore));
  expect(save.mock.calls.slice(callsBefore).every(([patch]) => !("observations" in patch))).toBe(true);
  expect(screen.getByLabelText("当前比较口径")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: /关闭/ }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByLabelText("当前比较口径").textContent).toContain("C26");
});
