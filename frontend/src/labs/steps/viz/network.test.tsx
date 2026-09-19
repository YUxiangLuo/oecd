import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../../../api";
import type { Meta, Step } from "../../../types";
import { NetworkVizStep, STEP10_DEFAULT_LENS } from "./network";
import type { VizStepState } from "./scaffold";

afterEach(() => { cleanup(); mock.restore(); });

test("step 9 details are read-only and browsing never clears saved report material", async () => {
  expect(STEP10_DEFAULT_LENS).toBe("heat");
  const meta: Meta = { countries: ["CHN", "USA"], sectors: ["C26"], years: [2019, 2020], dataset: { release_id: "a".repeat(32), years: [2019, 2020] } };
  const step: Step = { n: 9, stage: 3, lab: "viz", status: "done", title: "网络指标可视化", goal: "", tasks: ["", "", ""], concept: "", tip: "", deps: [], handoff: { input: "", action: "", output: "" } };
  const data: VizStepState = { chart: "heat", year: 2020, compared: ["CHN", "USA"], observations: [
    { country: "CHN", industry: "C26", entity: "CHN·C26", year: 2019, value: 21, metric: "weighted degree", source: "explicit-network-trend", unit: "百万美元" },
    { country: "USA", industry: "C26", entity: "USA·C26", year: 2019, value: 13, metric: "weighted degree", source: "explicit-network-trend", unit: "百万美元" },
  ] };
  spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
  spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({ rows: [{ country, industry: "C26", year, "weighted degree": 5, betweenesscentrality: 2 }], total: 1, page: 1, page_size: 200 }));
  spyOn(api, "network").mockResolvedValue({ nodes: [], edges: [] });
  const save = mock((_patch: Partial<VizStepState>) => {});
  render(<NetworkVizStep meta={meta} step={step} state={{ data, save, syncing: false, syncError: null, syncNow: () => {}, complete: false }} />);
  await screen.findByRole("img");
  const checklist = screen.getByText("本步完成清单与口径说明").closest("details") as HTMLDetailsElement;
  expect(checklist.open).toBe(false);
  fireEvent.click(screen.getByText("查看行业明细表（可选）"));
  await screen.findByText(/本表仅供查数/, { selector: "caption" });
  expect(screen.queryByText("记录拓扑基准")).toBeNull();
  expect(screen.queryByText("报告证据（固定拓扑基准）")).toBeNull();
  fireEvent.change(screen.getByLabelText("下钻国家"), { target: { value: "USA" } });
  fireEvent.change(screen.getByLabelText("年份"), { target: { value: "2019" } });
  fireEvent.change(screen.getByLabelText("排序指标"), { target: { value: "weighted degree" } });
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls.every(([patch]) => !("observations" in patch))).toBe(true);
  expect(data.observations?.map((item) => item.value)).toEqual([21, 13]);
});
