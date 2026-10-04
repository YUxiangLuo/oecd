import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { api } from "../../../api";
import type { Meta, Step, StepStateApi } from "../../../types";
import type { VizStepState } from "./scaffold";
import { LengthPositionTrajectory } from "./indicator-charts";
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

describe("indicator explorer with automatic report material", () => {
  for (const delayed of [false, true]) {
    for (const invalid of [
      { view: "trend" as const, start: 2021, end: 2019, year: 2021 },
      { view: "trend" as const, start: 2018, end: 2021, year: 2021 },
      { view: "comparison" as const, start: 2019, end: 2021, year: 2099 },
    ]) {
      test(`invalid restored years are actionable without overwriting materials (${JSON.stringify(invalid)}, delayed=${delayed})`, async () => {
        const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
        const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
        const data: VizStepState = {
          observations: [{ country: "CHN", entity: "CHN", year: 2019, metric: "FVA_share", value: 0.1, source: "explicit-indicator-trend", release }],
          indicator_selection: { first: "CHN", second: "USA", industry: "", metric: "FVA_share", limit: 10, ...invalid },
        };
        const original = JSON.stringify(data);
        const saves: VizStepState[] = [];
        const state = (value?: VizStepState): StepStateApi<VizStepState> => ({ data: value, save: (value) => saves.push(value), complete: false, syncing: false, syncError: null, syncNow: () => {} });
        try {
          const view = render(<TradeVizStep meta={meta} step={step} state={state(delayed ? undefined : data)} />);
          if (delayed) view.rerender(<TradeVizStep meta={meta} step={step} state={state(data)} />);
          expect((await view.findByRole("alert")).textContent).toContain("年份范围无效");
          expect(view.queryByText("正在加载所选年份的指标…")).toBeNull();
          expect(view.getByRole("region", { name: "报告材料" }).textContent).toContain("请先修正年份范围");
          if (!delayed) expect(rows).not.toHaveBeenCalled();
          // An invalid range is never recorded and never overwrites the saved material.
          expect(saves).toHaveLength(0);
          expect(JSON.stringify(data)).toBe(original);
          fireEvent.click(view.getByRole("button", { name: "重置年份" }));
          await waitFor(() => expect(saves).toHaveLength(1));
          expect(view.queryByRole("alert")).toBeNull();
          expect(saves[0].indicator_selection).toMatchObject({ start: 2019, end: 2021, year: 2021 });
          expect(rows.mock.calls.every(([year]) => meta.years.includes(year))).toBe(true);
        } finally { rows.mockRestore(); schema.mockRestore(); }
      });
    }
  }

  test("records the default two-country trend automatically and follows the chart the student switches to", async () => {
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
    expect((view.getByLabelText("对比国家 B") as HTMLSelectElement).value).toBe(
      "USA",
    );
    expect((view.getByLabelText("比较范围") as HTMLSelectElement).value).toBe(
      "",
    );
    expect(await view.findByLabelText("两国趋势结论")).toBeTruthy();
    expect(view.getByLabelText("2020 年数据解释边界")).toBeTruthy();
    const chart = view.getByRole("img");
    const supplementary = view.getByRole("group", { name: "补充图表" });
    const materials = view.getByRole("region", { name: "报告材料" });
    // Supplementary charts sit under the main chart and open in a modal; they never replace it.
    expect(chart.compareDocumentPosition(supplementary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(supplementary.compareDocumentPosition(materials) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((view.getByText("指标口径").closest("details") as HTMLDetailsElement).open).toBe(false);
    expect(view.getByText(/两国差距/)).toBeTruthy();
    expect(view.getByText(/差距缩小 .* 个百分点/)).toBeTruthy();
    await waitFor(() => expect(view.saves).toHaveLength(1));
    expect(view.queryByRole("button", { name: "保存为报告材料" })).toBeNull();
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
    expect(view.getByRole("region", { name: "报告材料" }).textContent).toContain("当前图表已自动记录");
    expect(view.saves).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: "同年差异" }));
    expect(view.queryByLabelText("2020 年数据解释边界")).toBeNull();
    await waitFor(() => expect(view.saves).toHaveLength(2));
    expect(
      view.saves[1].observations!.every(
        (x) => x.year === 2021 && x.source === "explicit-indicator-comparison",
      ),
    ).toBeTrue();
    rows.mockRestore();
    schema.mockRestore();
  });

  test("carries a legacy country pair without treating legacy observations as saved material", async () => {
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
      "USA",
    );
    expect(
      (legacy.getByLabelText("对比国家 B") as HTMLSelectElement).value,
    ).toBe("CHN");
    await waitFor(() => expect(legacy.saves).toHaveLength(1));
    expect(legacy.saves[0].observations!.every((item) => item.source === "explicit-indicator-trend")).toBeTrue();
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
    await modern.findByText(/已自动记录/);
    expect((modern.getByLabelText("国家 A") as HTMLSelectElement).value).toBe(
      "USA",
    );
    expect(
      (modern.getByLabelText("对比国家 B") as HTMLSelectElement).value,
    ).toBe("CHN");
    rows.mockRestore();
    schema.mockRestore();
  });

  test("a superseded async country request is never recorded", async () => {
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
    await waitFor(() => expect(view.saves.length).toBeGreaterThan(0));
    resolveOld(countryRows(2019));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The late 2019 response belongs to a superseded request and must never reach the record.
    expect(view.saves.every((save) => save.observations!.every((x) => x.year >= 2020))).toBeTrue();
    expect(view.saves.at(-1)!.observations).toHaveLength(4);
    request.mockRestore();
    schema.mockRestore();
  });

  test("trade composition records the total and all six components, including negative TLS", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(
      async (year) => countryRows(year),
    );
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({
      groups: [],
      fields: {},
    });
    const view = setup();
    await view.findByRole("heading", { name: /外国增加值项占比/ });
    expect(view.getByRole("group", { name: "补充图表" })).toBeTruthy();
    expect(view.getByLabelText("当前比较口径").textContent).toContain("CHN 中国与USA 美国 · 国家整体 · 2019–2021");
    fireEvent.click(view.getByRole("button", { name: "构成分析" }));
    await waitFor(() => expect(view.saves.at(-1)?.indicator_selection?.view).toBe("composition"));
    expect(new Set(view.saves.at(-1)!.observations!.map((x) => x.metric))).toEqual(
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
      view.saves.at(-1)!.observations!.some(
        (x) => x.metric === "taxsub" && x.value < 0,
      ),
    ).toBeTrue();
    fireEvent.click(view.getByRole("button", { name: "历年" }));
    await waitFor(() => expect(view.saves.at(-1)?.indicator_selection?.view).toBe("evolution"));
    expect(view.getByRole("button", { name: "构成分析" }).getAttribute("aria-pressed")).toBe("true");
    expect(new Set(view.saves.at(-1)?.observations?.map((item) => item.year))).toEqual(new Set([2019, 2020, 2021]));
    view.accept();
    expect(view.getByRole("button", { name: "历年" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "单年" }));
    expect(view.getByLabelText("当前比较口径").textContent).toContain("2021 · 构成分析");
    view.unmount();
    const restored = setup(TradeVizStep, view.saves.at(-1));
    expect(restored.getByRole("button", { name: "构成分析" }).getAttribute("aria-pressed")).toBe("true");
    expect(restored.getByRole("button", { name: "历年" }).getAttribute("aria-pressed")).toBe("true");
    expect(restored.saves).toHaveLength(0);
    rows.mockRestore();
    schema.mockRestore();
  });

  test("length defaults to separate forward/backward trends plus a time trajectory", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(
      async (year) => countryRows(year),
    );
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({
      groups: [],
      fields: {},
    });
    const view = setup(LengthVizStep);
    await view.findByRole("heading", { name: /前向GVC段长度/ });
    expect(
      await view.findByRole("img", { name: /前向GVC段长度历年变化/ }),
    ).toBeTruthy();
    expect(
      view.getByRole("img", { name: /后向GVC段长度历年变化/ }),
    ).toBeTruthy();
    expect(
      view.getByRole("img", { name: /前向与后向GVC段长度历年轨迹/ }),
    ).toBeTruthy();
    rows.mockRestore();
    schema.mockRestore();
  });

  test("length trajectory does not bridge a missing middle year", () => {
    const rows = [
      { country: "CHN", year: 2019, PLv_GVC: 2, PLy_GVC: 3 },
      { country: "CHN", year: 2021, PLv_GVC: 4, PLy_GVC: 5 },
    ];
    render(
      <LengthPositionTrajectory
        rows={rows}
        countries={["CHN"]}
        years={[2019, 2020, 2021]}
      />,
    );
    expect(document.querySelectorAll('line[data-series="CHN"]')).toHaveLength(0);
  });
});
