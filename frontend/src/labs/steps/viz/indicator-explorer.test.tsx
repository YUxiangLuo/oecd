import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { api } from "../../../api";
import type { Meta, Step, StepStateApi } from "../../../types";
import type { VizStepState } from "./scaffold";
import { LengthVizStep } from "./length";
import { TradeVizStep } from "./trade";

const release = "a".repeat(32);
const meta: Meta = {
  years: [2019, 2020, 2021],
  countries: ["CHN", "USA"],
  sectors: ["A"],
  dataset: { years: [2019, 2020, 2021], release_id: release },
};
const step = { n: 6 } as Step;
const countryRows = (year: number) =>
  ["CHN", "USA"].map((country, i) => ({
    country,
    gross_exports: 100 + i * 100,
    FVA: 10 + i * 30 + year - 2019,
    DVAex: 55 + i,
    DVArt: 8,
    DDC: 4,
    FDC: 2,
    taxsub: -1,
    PLv_GVC: 2 + i,
    PLy_GVC: 3 + i,
    GVCPs: 0.8 + i * 0.4,
  }));

afterEach(() => cleanup());

function setup(Component = TradeVizStep, data?: VizStepState) {
  const saves: VizStepState[] = [];
  let current = data;
  const state = (): StepStateApi<VizStepState> => ({
    data: current,
    save: (value) => saves.push(value),
    complete: false,
    syncing: false,
    syncError: null,
    syncNow: () => {},
  });
  const view = render(<Component meta={meta} step={step} state={state()} />);
  return {
    ...view,
    saves,
    accept() {
      current = saves.at(-1);
      if (current?.indicator_selection)
        current = {
          ...current,
          indicator_selection: Object.fromEntries(
            Object.entries(current.indicator_selection).sort(([a], [b]) =>
              a.localeCompare(b),
            ),
          ) as typeof current.indicator_selection,
        };
      view.rerender(<Component meta={meta} step={step} state={state()} />);
    },
  };
}

describe("explicit indicator explorer", () => {
  test("starts at CHN country trend without saving; two-country save and update are explicit", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(
      async (year) => countryRows(year),
    );
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({
      groups: [],
      fields: {},
    });
    const view = setup();
    await view.findByRole("heading", { name: /外国增加值项占比/ });
    expect((view.getByLabelText("国家 A") as HTMLSelectElement).value).toBe(
      "CHN",
    );
    expect((view.getByLabelText("比较范围") as HTMLSelectElement).value).toBe(
      "",
    );
    expect(view.saves).toHaveLength(0);
    fireEvent.change(view.getByLabelText("对比国家 B"), {
      target: { value: "USA" },
    });
    await waitFor(() =>
      expect(
        view
          .getByRole("button", { name: "保存为报告材料" })
          .hasAttribute("disabled"),
      ).toBeFalse(),
    );
    fireEvent.click(view.getByRole("button", { name: "保存为报告材料" }));
    expect(view.saves).toHaveLength(1);
    expect(view.saves[0].indicator_selection).toMatchObject({
      first: "CHN",
      second: "USA",
      industry: "",
      metric: "FVA_share",
      view: "trend",
    });
    expect(view.saves[0].observations).toHaveLength(6);
    expect(view.saves[0].observations![0]).toMatchObject({
      country: "CHN",
      year: 2019,
      scope: "country",
      source: "explicit-indicator-trend",
      release,
    });
    view.accept(); // parent owns persistence; only its rerender marks the selection saved
    expect(
      view
        .getByRole("button", { name: "当前比较已记录" })
        .hasAttribute("disabled"),
    ).toBeTrue();
    fireEvent.click(view.getByRole("button", { name: "同年比较" }));
    expect(view.saves).toHaveLength(1);
    await waitFor(() =>
      expect(
        view
          .getByRole("button", { name: "更新报告材料" })
          .hasAttribute("disabled"),
      ).toBeFalse(),
    );
    fireEvent.click(view.getByRole("button", { name: "更新报告材料" }));
    expect(view.saves).toHaveLength(2);
    expect(
      view.saves[1].observations!.every(
        (x) => x.year === 2021 && x.source === "explicit-indicator-comparison",
      ),
    ).toBeTrue();
    rows.mockRestore();
    schema.mockRestore();
  });

  test("restores only new source plus indicator_selection, not legacy compared/observations", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(
      async (year) => countryRows(year),
    );
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({
      groups: [],
      fields: {},
    });
    const legacy = setup(TradeVizStep, {
      compared: ["USA", "CHN"],
      observations: [{ entity: "USA", country: "USA", year: 2020, value: 9 }],
    });
    await legacy.findByRole("heading", { name: /外国增加值项占比/ });
    expect((legacy.getByLabelText("国家 A") as HTMLSelectElement).value).toBe(
      "CHN",
    );
    expect(
      (legacy.getByLabelText("对比国家 B") as HTMLSelectElement).value,
    ).toBe("");
    expect(legacy.getByText(/尚未保存/)).toBeTruthy();
    cleanup();
    const selection = {
      first: "USA",
      second: "CHN",
      industry: "",
      metric: "FVA_share",
      start: 2019,
      end: 2021,
      year: 2021,
      view: "trend" as const,
      limit: 10,
    };
    const modern = setup(TradeVizStep, {
      indicator_selection: selection,
      observations: [
        {
          entity: "USA",
          country: "USA",
          year: 2020,
          value: 0.2,
          metric: "FVA_share",
          release,
          source: "explicit-indicator-trend",
          scope: "country",
          unit: "%",
        },
      ],
    });
    await modern.findByText(/已保存一份比较/);
    expect((modern.getByLabelText("国家 A") as HTMLSelectElement).value).toBe(
      "USA",
    );
    expect(
      (modern.getByLabelText("对比国家 B") as HTMLSelectElement).value,
    ).toBe("CHN");
    rows.mockRestore();
    schema.mockRestore();
  });

  test("a superseded async country request cannot enable saving stale data", async () => {
    let resolveOld!: (rows: ReturnType<typeof countryRows>) => void;
    const old = new Promise<ReturnType<typeof countryRows>>((resolve) => {
      resolveOld = resolve;
    });
    const request = spyOn(api, "countryIndicators").mockImplementation(
      (year) => (year === 2019 ? old : Promise.resolve(countryRows(year))),
    );
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({
      groups: [],
      fields: {},
    });
    const view = setup();
    fireEvent.change(view.getByLabelText("起始年份"), {
      target: { value: "2020" },
    });
    fireEvent.change(view.getByLabelText("对比国家 B"), {
      target: { value: "USA" },
    });
    await waitFor(() => expect(view.getByText(/4 条有效读数/)).toBeTruthy());
    resolveOld(countryRows(2019));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(view.getByRole("button", { name: "保存为报告材料" }));
    expect(view.saves[0].observations!.every((x) => x.year >= 2020)).toBeTrue();
    request.mockRestore();
    schema.mockRestore();
  });

  test("trade composition saves total and all six components, including negative TLS", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(
      async (year) => countryRows(year),
    );
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({
      groups: [],
      fields: {},
    });
    const view = setup();
    await view.findByRole("heading", { name: /外国增加值项占比/ });
    fireEvent.change(view.getByLabelText("对比国家 B"), {
      target: { value: "USA" },
    });
    fireEvent.click(view.getByRole("button", { name: "两国构成" }));
    await waitFor(() => expect(view.getByText(/14 条有效读数/)).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "保存为报告材料" }));
    expect(new Set(view.saves[0].observations!.map((x) => x.metric))).toEqual(
      new Set([
        "DVAex",
        "DVArt",
        "DDC",
        "FVA",
        "FDC",
        "taxsub",
        "gross_exports",
      ]),
    );
    expect(
      view.saves[0].observations!.some(
        (x) => x.metric === "taxsub" && x.value < 0,
      ),
    ).toBeTrue();
    rows.mockRestore();
    schema.mockRestore();
  });

  test("length directions render separate forward/backward charts", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(
      async (year) => countryRows(year),
    );
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({
      groups: [],
      fields: {},
    });
    const view = setup(LengthVizStep);
    await view.findByRole("heading", { name: /前向GVC段长度/ });
    fireEvent.click(view.getByRole("button", { name: "前后向对照" }));
    expect(
      await view.findByRole("img", { name: /前向GVC段长度历年变化/ }),
    ).toBeTruthy();
    expect(
      view.getByRole("img", { name: /后向GVC段长度历年变化/ }),
    ).toBeTruthy();
    rows.mockRestore();
    schema.mockRestore();
  });
});
