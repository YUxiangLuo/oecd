import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
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

function setup(Component = TradeVizStep, data?: VizStepState, materialLocked = false) {
  const saves: VizStepState[] = [];
  let current = data;
  const state = (): StepStateApi<VizStepState> => ({
    data: current,
    save: (value) => saves.push(value),
    complete: false,
    syncing: false,
    syncError: null,
    syncNow: () => {},
    materialLocked,
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
  test("after the report is submitted, browsing never rewrites the material; the student can record on request", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    const view = setup(TradeVizStep, undefined, true);
    await view.findByRole("button", { name: "出口构成" });
    fireEvent.click(view.getByRole("button", { name: "历年变化" }));
    expect(await view.findByLabelText("趋势读数")).toBeTruthy();
    const record = await view.findByRole("button", { name: /改用当前图表作为报告材料/ });
    expect(view.getByText(/报告已提交：浏览不再自动改动报告材料/)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view.saves).toHaveLength(0);
    fireEvent.click(record);
    expect(view.saves).toHaveLength(1);
    expect(view.saves[0].indicator_selection).toMatchObject({ first: "CHN", second: "USA" });
    // The report must not call the student's own choice an automatic record.
    expect(view.saves[0].material_chosen).toBe(true);
    rows.mockRestore();
    schema.mockRestore();
  });

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

  test("opens on the theme view, records it automatically and follows the chart the student switches to", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(
      async (year) => countryRows(year),
    );
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({
      groups: [],
      fields: {},
    });
    const view = setup();
    await view.findByRole("button", { name: "出口构成" });
    expect((view.getByLabelText("国家 A") as HTMLSelectElement).value).toBe(
      "CHN",
    );
    expect((view.getByLabelText("对比国家 B") as HTMLSelectElement).value).toBe(
      "USA",
    );
    expect((view.getByLabelText("比较范围") as HTMLSelectElement).value).toBe(
      "",
    );
    // The view bar: the step's theme first and open by default, then the two views every step offers.
    expect(within(view.getByRole("group", { name: "图表视角" })).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "出口构成", "历年变化", "国家对比", "定位图", "行业排名",
    ]);
    expect(view.getByRole("button", { name: "出口构成" }).getAttribute("aria-pressed")).toBe("true");
    expect(view.queryByRole("group", { name: "补充图表" })).toBeNull();
    await waitFor(() => expect(view.saves.at(-1)?.indicator_selection?.view).toBe("composition"));
    fireEvent.click(view.getByRole("button", { name: "历年变化" }));
    expect(await view.findByLabelText("趋势读数")).toBeTruthy();
    expect(view.queryByText(/含 2020 年/)).toBeNull();
    const chart = view.getByRole("img");
    // Caveats live in the task card and the report; the chart area keeps only a one-line metric definition.
    expect(view.queryByText("指标口径")).toBeNull();
    // Reading order: the observed country, its rank and the global median, then the comparison country.
    const cards = [...view.getByLabelText("趋势读数").children].map((card) => card.textContent ?? "");
    expect(cards[0]).toContain("CHN 中国");
    expect(cards[1]).toContain("在全部经济体中");
    expect(cards[2]).toContain("全球中位数");
    expect(cards[3]).toContain("与对比国家 USA 美国");
    expect(view.getByText(/差距缩小 .* 个百分点/)).toBeTruthy();
    expect(chart.querySelector('[data-series="global-median"]')).not.toBeNull();
    await waitFor(() => expect(view.saves.at(-1)?.indicator_selection?.view).toBe("trend"));
    expect(view.queryByRole("button", { name: "保存为报告材料" })).toBeNull();
    view.saves.splice(0, view.saves.length - 1); // keep only the trend record for the checks below
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
    fireEvent.click(view.getByRole("button", { name: "国家对比" }));
    await waitFor(() => expect(view.saves).toHaveLength(2));
    // The same-year view shows every economy with the two countries highlighted and ranked, then the ranking bars.
    expect(view.getByRole("region", { name: /全球分布/ })).toBeTruthy();
    expect(view.getByText(/排名 · 前 20 与所选国家/)).toBeTruthy();
    expect(view.getByRole("img", { name: /CHN 中国 .*第 [0-9]+ 位/ })).toBeTruthy();
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
    await legacy.findByRole("button", { name: "出口构成" });
    expect((legacy.getByLabelText("国家 A") as HTMLSelectElement).value).toBe(
      "USA",
    );
    expect(
      (legacy.getByLabelText("对比国家 B") as HTMLSelectElement).value,
    ).toBe("CHN");
    await waitFor(() => expect(legacy.saves).toHaveLength(1));
    expect(legacy.saves[0].observations!.every((item) => item.source === "explicit-indicator-composition")).toBeTrue();
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
    await view.findByRole("button", { name: "出口构成" });
    fireEvent.click(view.getByRole("button", { name: "历年变化" }));
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
    await view.findByRole("button", { name: "出口构成" });
    fireEvent.click(view.getByRole("button", { name: "历年变化" }));
    const scope = view.getByLabelText("当前图表范围").textContent ?? "";
    for (const part of ["CHN 中国 与 USA 美国", "国家整体", "2019–2021", "外国增加值项占比"]) expect(scope).toContain(part);
    fireEvent.click(view.getByRole("button", { name: "出口构成" }));
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
    fireEvent.click(view.getByRole("button", { name: "历年构成" }));
    await waitFor(() => expect(view.saves.at(-1)?.indicator_selection?.view).toBe("evolution"));
    expect(view.getByRole("button", { name: "出口构成" }).getAttribute("aria-pressed")).toBe("true");
    expect(new Set(view.saves.at(-1)?.observations?.map((item) => item.year))).toEqual(new Set([2019, 2020, 2021]));
    view.accept();
    expect(view.getByRole("button", { name: "历年构成" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "单年构成" }));
    expect(view.getByLabelText("当前图表范围").textContent).toMatch(/2021.*出口构成/);
    view.unmount();
    const restored = setup(TradeVizStep, view.saves.at(-1));
    expect(restored.getByRole("button", { name: "出口构成" }).getAttribute("aria-pressed")).toBe("true");
    expect(restored.getByRole("button", { name: "历年构成" }).getAttribute("aria-pressed")).toBe("true");
    expect(restored.saves).toHaveLength(0);
    rows.mockRestore();
    schema.mockRestore();
  });

  test("the positioning view is exploration only: it never records material and keeps the saved record", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    const view = setup();
    await view.findByRole("button", { name: "出口构成" });
    await waitFor(() => expect(view.saves.at(-1)?.indicator_selection?.view).toBe("composition"));
    const before = view.saves.length;
    fireEvent.click(view.getByRole("button", { name: "定位图" }));
    expect(view.getByLabelText("当前图表范围").textContent).toContain("定位图");
    expect(view.getByRole("region", { name: "报告材料" }).textContent).toContain("定位图只供探索，不记录材料");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(view.saves).toHaveLength(before);
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
    await view.findByRole("heading", { name: /前向 GVC 段长度/ });
    expect(
      await view.findByRole("img", { name: /前向 GVC 段长度历年变化/ }),
    ).toBeTruthy();
    expect(
      view.getByRole("img", { name: /后向 GVC 段长度历年变化/ }),
    ).toBeTruthy();
    expect(
      view.getByRole("img", { name: /前向与后向 GVC 段长度历年轨迹/ }),
    ).toBeTruthy();
    rows.mockRestore();
    schema.mockRestore();
  });

  test("length 段长度对照 records the six segment lengths for one year and reads the longest segment", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) =>
      countryRows(year).map((row, i) => ({ ...row, PLv_D: 1.2 + i / 10, PLy_D: 1.1, PLv_RT: 0.4, PLy_RT: 0.5 + i / 10 })),
    );
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    const view = setup(LengthVizStep);
    await view.findByRole("button", { name: "前后向位置" });
    expect(within(view.getByRole("group", { name: "图表视角" })).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "前后向位置", "历年变化", "国家对比", "段长度对照", "定位图", "行业结构", "行业排名",
    ]);
    fireEvent.click(view.getByRole("button", { name: "段长度对照" }));
    await waitFor(() => expect(view.saves.at(-1)?.indicator_selection?.view).toBe("segments"));
    const saved = view.saves.at(-1)!;
    expect(saved.compared).toEqual(["CHN", "USA"]);
    expect(new Set(saved.observations!.map((item) => item.metric))).toEqual(new Set(["PLv_D", "PLy_D", "PLv_RT", "PLy_RT", "PLv_GVC", "PLy_GVC"]));
    expect(saved.observations!.every((item) => item.source === "explicit-indicator-comparison" && item.year === 2021)).toBe(true);
    expect(view.getAllByRole("region", { name: /段长度对照/ })).toHaveLength(2);
    const cards = view.getByRole("group", { name: "段长度读数" }).textContent ?? "";
    expect(cards).toContain("最长的一段");
    expect(cards).toContain("GVC 段 · 前向对后向");
    expect(cards).toContain("与对比国家 USA 美国");
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

describe("material of one to five economies (design doc 4.1)", () => {
  const meta3: Meta = { ...meta, countries: ["CHN", "USA", "DEU"] };
  const rows3 = (year: number) =>
    ["CHN", "USA", "DEU"].map((country, i) => ({
      country, gross_exports: 100 + i * 100, FVA: 10 + i * 30 + year - 2019, DVAex: 55 + i, DVArt: 8, DDC: 4, FDC: 2, taxsub: -1,
    }));
  function mount(data?: VizStepState) {
    const saves: VizStepState[] = [];
    const state: StepStateApi<VizStepState> = { data, save: (value) => saves.push(value), complete: false, syncing: false, syncError: null, syncNow: () => {} };
    return { saves, ...render(<TradeVizStep meta={meta3} step={step} state={state} />) };
  }

  test("one economy at country scope is recorded against the global reference; at industry scope it is not", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => rows3(year));
    const industry = spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({
      rows: rows3(year).filter((row) => row.country === country).map((row) => ({ ...row, industry: "A" })), total: 1, page: 1, page_size: 200,
    }));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = mount({ compared: ["CHN"] });
      await view.findByRole("button", { name: "出口构成" });
      // The carried-over single entity opens alone: no comparison select is filled, the add control is offered.
      expect((view.getByLabelText("加一个对比国家（可选）") as HTMLSelectElement).value).toBe("");
      await waitFor(() => expect(view.saves.at(-1)?.compared).toEqual(["CHN"]));
      expect(view.saves.at(-1)!.observations!.every((item) => item.country === "CHN")).toBe(true);
      // An industry has no global reference, so one economy alone is exploration there.
      const before = view.saves.length;
      fireEvent.change(view.getByLabelText("比较范围"), { target: { value: "A" } });
      await view.findByText(/要把“比较范围”设为“国家整体”/);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(view.saves.slice(before).every((save) => !("observations" in save))).toBe(true);
    } finally { rows.mockRestore(); industry.mockRestore(); schema.mockRestore(); }
  });

  test("a third country joins the same chart: one series per economy, all recorded together", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => rows3(year));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = mount();
      await view.findByRole("button", { name: "出口构成" });
      fireEvent.click(view.getByRole("button", { name: "历年变化" }));
      await waitFor(() => expect(view.saves.at(-1)?.compared).toEqual(["CHN", "USA"]));
      fireEvent.change(view.getByLabelText("再加一个对比国家"), { target: { value: "DEU" } });
      fireEvent.click(view.getByRole("button", { name: "添加" }));
      await waitFor(() => expect(view.saves.at(-1)?.compared).toEqual(["CHN", "USA", "DEU"]));
      expect(view.getByLabelText("对比国家 C")).toBeTruthy();
      expect(view.container.querySelectorAll("[data-series-group]")).toHaveLength(3);
      expect(view.saves.at(-1)!.indicator_selection).toMatchObject({ first: "CHN", second: "USA", others: ["USA", "DEU"] });
      expect(new Set(view.saves.at(-1)!.observations!.map((item) => item.country))).toEqual(new Set(["CHN", "USA", "DEU"]));
      // Every comparison country gets its own gap card.
      expect(view.getAllByText(/与对比国家/)).toHaveLength(2);
      // Choosing a comparison country as A swaps it with the old A instead of dropping it.
      fireEvent.change(view.getByLabelText("国家 A"), { target: { value: "DEU" } });
      await waitFor(() => expect(view.saves.at(-1)?.compared).toEqual(["DEU", "USA", "CHN"]));
    } finally { rows.mockRestore(); schema.mockRestore(); }
  });
});
