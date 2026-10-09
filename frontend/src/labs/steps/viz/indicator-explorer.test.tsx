import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { api } from "../../../api";
import type { Meta, Step, StepStateApi } from "../../../types";
import type { VizStepState } from "./scaffold";
import { LengthPositionTrajectory } from "./indicator-charts";
import { LengthVizStep } from "./length";
import { ProductionVizStep } from "./production";
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
    // The confirmation says what to do next, as step 13 does.
    view.accept();
    await waitFor(() => expect(view.getByRole("region", { name: "报告材料" }).textContent).toContain("当前图表就是已记录的材料。请到步骤 15 更新报告并重新提交给老师。"));
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
    // Two dumbbells sit side by side only when each gets ~440px; at 1024 they stack instead of squeezing to ~40px.
    expect(view.getAllByRole("region", { name: /段长度对照/ })[0].closest(".comparison-facets")?.classList.contains("comparison-facets--roomy")).toBe(true);
    const css = await Bun.file(new URL("../../../workbench.css", import.meta.url)).text();
    expect(css).toContain(".dumbbell .dot-plot-row { grid-template-columns: 84px minmax(0, 1fr)");
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

describe("readouts and update notes follow the chart on screen (round 10)", () => {
  test("a hover readout left open does not survive a change of indicator while the pointer stays on the chart", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = setup();
      await view.findByRole("button", { name: "出口构成" });
      fireEvent.click(view.getByRole("button", { name: "历年变化" }));
      await view.findByLabelText("趋势读数");
      fireEvent.mouseMove(view.container.querySelector('rect[data-year="2020"]')!, { clientX: 300, clientY: 120 });
      expect(view.container.querySelector(".hover-tip")!.textContent).toContain("2020 年");
      expect(view.container.querySelector("[data-crosshair]")).not.toBeNull();
      // No mouseleave: the student changes the indicator with the keyboard while the pointer rests on the chart.
      fireEvent.change(view.getByLabelText("指标"), { target: { value: "FVA" } });
      expect(view.getByRole("group", { name: /^外国增加值历年变化图/ })).toBeTruthy();
      expect(view.container.querySelector(".hover-tip")?.textContent ?? "").toBe("");
      expect(view.container.querySelector("[data-crosshair]")).toBeNull();
      // The same for a keyboard readout followed by a change of years.
      fireEvent.keyDown(view.getByRole("group", { name: /按左右方向键逐年读数/ }), { key: "ArrowRight" });
      expect(view.container.querySelector(".hover-tip")!.textContent).toContain("2019 年");
      fireEvent.change(view.getByLabelText("起始年份"), { target: { value: "2020" } });
      await view.findByLabelText("趋势读数");
      expect(view.container.querySelector(".hover-tip")?.textContent ?? "").toBe("");
      expect(view.container.querySelector("[data-crosshair]")).toBeNull();
    } finally { rows.mockRestore(); schema.mockRestore(); }
  });

  test("the update note names the indicator, follows each update and goes once the chart cannot be recorded", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = setup();
      await view.findByRole("button", { name: "出口构成" });
      await waitFor(() => expect(view.saves).toHaveLength(1));
      view.accept();
      fireEvent.click(view.getByRole("button", { name: "历年变化" }));
      await waitFor(() => expect(view.saves).toHaveLength(2));
      expect(view.container.querySelector(".scope-flash")?.textContent).toContain("报告材料已更新为：历年变化 · 外国增加值项占比 · ");
      view.accept();
      // A second update with another indicator says so (the words used to be identical between indicators).
      fireEvent.change(view.getByLabelText("指标"), { target: { value: "FVA" } });
      await waitFor(() => expect(view.saves).toHaveLength(3));
      expect(view.container.querySelector(".scope-flash")?.textContent).toContain("历年变化 · 外国增加值 · ");
      view.accept();
      // 定位图 records nothing: the note about the previous chart must not stay beside it.
      fireEvent.click(view.getByRole("button", { name: "定位图" }));
      await view.findByText(/定位图只供探索，不记录材料。/, { selector: "[role=status]" });
      expect(view.container.querySelector(".scope-flash")).toBeNull();
      // Back on the recorded chart nothing was replaced, so no note comes back.
      fireEvent.click(view.getByRole("button", { name: "历年变化" }));
      await view.findByLabelText("趋势读数");
      expect(view.container.querySelector(".scope-flash")).toBeNull();
      expect(view.saves).toHaveLength(3);
    } finally { rows.mockRestore(); schema.mockRestore(); }
  });

  test("定位图 with an industry reads that industry in every economy, not only the selected two", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    const sector = spyOn(api, "industryIndicatorsForIndustry").mockImplementation(async (year, industry) => {
      const sectorRows = ["CHN", "USA", "DEU", "JPN", "KOR", "FRA"].map((country, i) => ({ country, industry, year, gross_exports: 10 + i, FVA: 1 + i }));
      return { rows: sectorRows, total: sectorRows.length, page: 1, page_size: 200 };
    });
    const perCountry = spyOn(api, "industryIndicatorsAll");
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = setup();
      await view.findByRole("button", { name: "出口构成" });
      fireEvent.click(view.getByRole("button", { name: "定位图" }));
      await view.findByLabelText("定位读数");
      fireEvent.change(view.getByLabelText("比较范围"), { target: { value: "A" } });
      await waitFor(() => expect(view.getByLabelText("定位读数").textContent).toContain("中位数按图上 6 个经济体计算"));
      expect(sector).toHaveBeenCalled();
      expect(perCountry).not.toHaveBeenCalled();
      expect(view.getByRole("heading", { name: /定位图 · 2021 年全部经济体 · A/ })).toBeTruthy();
      expect(view.getByText(/轨迹只在“国家整体”下提供/)).toBeTruthy();
    } finally { rows.mockRestore(); sector.mockRestore(); perCountry.mockRestore(); schema.mockRestore(); }
  });

  test("a negative total is named on the composition cards instead of being called missing", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) =>
      countryRows(year).map((row) => (row.country === "USA" ? { ...row, gross_exports: -5, FVA: -1, DVAex: -4, DVArt: 0, DDC: 0, FDC: 0, taxsub: 0 } : row)));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = setup();
      await view.findByRole("button", { name: "出口构成" });
      const cards = await view.findByLabelText("构成读数");
      expect(cards.textContent).toContain("为负");
      expect(cards.textContent).not.toContain("对比国家构成不完整");
      expect(view.getByText(/构成份额无法计算，占比图里不画/)).toBeTruthy();
      expect(view.getByRole("region", { name: "报告材料" }).textContent).toContain("为负，构成份额无法计算（不是缺少数据）");
      // In the 金额 view the card does not send the student to the view they are already in.
      expect(cards.textContent).toContain("切到“金额”可看各分项");
      fireEvent.click(view.getByRole("button", { name: "金额" }));
      await waitFor(() => expect(view.getByLabelText("构成读数").textContent).not.toContain("切到“金额”"));
      expect(view.getByLabelText("构成读数").textContent).toContain("无法算比重");
    } finally { rows.mockRestore(); schema.mockRestore(); }
  });

  test("a total of 0 with every part 0 does not send the student to 金额, which would be empty too", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) =>
      countryRows(year).map((row) => (row.country === "USA" ? { ...row, gross_exports: 0, FVA: 0, DVAex: 0, DVArt: 0, DDC: 0, FDC: 0, taxsub: 0 } : row)));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = setup();
      const note = await view.findByText(/构成份额无法计算，占比图里不画/);
      expect(note.textContent).toContain("USA 美国 · 2021：总出口（含产品税减补贴）为 0，构成份额无法计算，占比图里不画。");
      expect(note.textContent).not.toContain("金额");
      // 历年构成 draws bands, not bars: its note does not say "每条".
      fireEvent.click(view.getByRole("button", { name: "历年构成" }));
      await waitFor(() => expect(view.container.textContent).toContain("每个色带是总出口的一项"));
      expect(view.container.textContent).not.toContain("每条是");
    } finally { rows.mockRestore(); schema.mockRestore(); }
  });
});

test("a complete chart's readings summary has no blank-reading suffix (round 13)", async () => {
  const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
  const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
  try {
    const view = setup();
    await view.findByRole("button", { name: "出口构成" });
    fireEvent.click(view.getByRole("button", { name: "历年变化" }));
    const summary = await view.findByText(/核对当前图表读数 · \d+ 条/);
    await waitFor(() => expect(summary.textContent).toMatch(/核对当前图表读数 · [1-9]\d* 条$/));
    expect(summary.textContent).not.toContain("留空");
  } finally { rows.mockRestore(); schema.mockRestore(); }
});

describe("行业排名 with an industry that exports nothing (round 12)", () => {
  // USA plays KHM: its O exports are 0, so its O shares are undefined, not missing.
  const usaO = (country: string, industry: string) => country === "USA" && industry === "O";
  const industryRows = (country: string, year: number, industries: string[], zero = usaO) => industries.map((industry) => (
    zero(country, industry)
      ? { country, industry, year, gross_exports: 0, FVA: 0, DVAex: 0, DVArt: 0, DDC: 0, FDC: 0, taxsub: 0 }
      : { country, industry, year, gross_exports: 100, FVA: industry === "A" ? 20 : 10, DVAex: industry === "A" ? 70 : 80, DVArt: 2, DDC: 2, FDC: 4, taxsub: 2 }));

  const open = async (industries: string[], zero = usaO) => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    const perCountry = spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => {
      const page = industryRows(country as string, year, industries, zero);
      return { rows: page, total: page.length, page: 1, page_size: 200 };
    });
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    const view = setup();
    await view.findByRole("button", { name: "出口构成" });
    fireEvent.click(view.getByRole("button", { name: "行业排名" }));
    fireEvent.change(view.getByLabelText("指标"), { target: { value: "DVAex_share" } });
    return { view, restore: () => { rows.mockRestore(); perCountry.mockRestore(); schema.mockRestore(); } };
  };

  test("the O row reads 无法计算, and the complete rows are still recorded", async () => {
    const { view, restore } = await open(["A", "O"]);
    try {
      const plot = await view.findByRole("region", { name: "国内增加值出口占比行业点图" });
      await waitFor(() => expect(plot.textContent).toContain("无法计算"));
      expect(plot.textContent).not.toContain("缺失");
      expect(view.getByText(/O 公共管理与国防：USA 美国该行业总出口为 0，国内增加值出口占比无法计算（不是缺少数据）。这些行业照常显示，但不记入报告材料/)).toBeTruthy();
      await waitFor(() => expect(view.saves.length).toBeGreaterThan(0));
      const recorded = view.saves.at(-1)!.observations ?? [];
      expect(recorded.map((item) => [item.country, item.industry])).toEqual([["CHN", "A"], ["USA", "A"]]);
      expect(view.getByRole("region", { name: "报告材料" }).textContent).not.toContain("暂不能记录");
    } finally { restore(); }
  });

  test("country A's own undefined rows are named under the ranking instead of vanishing (round 13)", async () => {
    // CHN plays LUX / CHN: its O exports are 0, so O cannot be placed in A's order.
    const { view, restore } = await open(["A", "O"], (country, industry) => country === "CHN" && industry === "O");
    try {
      const plot = await view.findByRole("region", { name: "国内增加值出口占比行业点图" });
      await waitFor(() => expect(plot.textContent).toContain("A →"));
      expect(plot.textContent).not.toContain("O ");
      expect(view.getByText("另有 1 个行业没有画出：国家 A（CHN 中国）在这个行业没有读数，无法排序。O 总出口为 0，国内增加值出口占比无法计算（不是缺少数据）。")).toBeTruthy();
    } finally { restore(); }
  });

  test("more than three unrecorded rows: the note names three, the full list opens below it (round 13)", async () => {
    const { view, restore } = await open(["A", "B", "C", "D", "E"], (country, industry) => country === "USA" && industry !== "A");
    try {
      await view.findByRole("region", { name: "国内增加值出口占比行业点图" });
      await waitFor(() => expect(view.getByText(/等 4 个行业。这些行业照常显示/)).toBeTruthy());
      const list = view.getByText("查看全部 4 个行业").closest("details")!;
      expect(list.querySelectorAll("li")).toHaveLength(4);
      expect(list.textContent).toContain("E ");
    } finally { restore(); }
  });

  test("when no row is complete the notice gives the real reason and does not suggest another year", async () => {
    const { view, restore } = await open(["O"]);
    try {
      const material = view.getByRole("region", { name: "报告材料" });
      await waitFor(() => expect(material.textContent).toContain("USA 美国该行业总出口为 0，国内增加值出口占比无法计算（不是缺少数据）"));
      expect(material.textContent).toContain("请换国家。");
      expect(material.textContent).not.toContain("缺少数据（缺少的数据留空");
      expect(material.textContent).not.toContain("换一个年份");
      // Only the opening 出口构成 chart was recorded; the ranking was not.
      expect(view.saves.every((saved) => saved.indicator_selection?.view !== "industry")).toBe(true);
    } finally { restore(); }
  });
});

test("step 7 行业结构 says how many industries it leaves out and why (round 12)", async () => {
  const part = { "1_VA_D": 4, "2_VA_RT": 2, "3a_VA_GVC_S": 1, "3b_VA_GVC_C": 3 };
  const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year).map((row) => ({ ...row, SVA: 10, ...part })));
  const perCountry = spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => {
    const page = [
      { country, year, industry: "A", SVA: 10, ...part },
      // MLT H51: negative value added; LUX B09: no production at all.
      { country, year, industry: "H51", SVA: -1.268, "1_VA_D": -0.04, "2_VA_RT": -0.634, "3a_VA_GVC_S": -0.397, "3b_VA_GVC_C": -0.197 },
      { country, year, industry: "B09", SVA: 0, "1_VA_D": 0, "2_VA_RT": 0, "3a_VA_GVC_S": 0, "3b_VA_GVC_C": 0 },
    ];
    return { rows: page, total: page.length, page: 1, page_size: 200 };
  });
  const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
  try {
    const view = setup(ProductionVizStep);
    await view.findByRole("button", { name: "四类生产活动" });
    fireEvent.click(view.getByRole("button", { name: "行业结构" }));
    await waitFor(() => expect(view.getAllByText("另有 2 个行业没有画出：H51 总增加值为负；B09 总增加值为 0（没有这类生产活动），份额无法计算（不是缺少数据）。")).toHaveLength(2));
  } finally { rows.mockRestore(); perCountry.mockRestore(); schema.mockRestore(); }
});

describe("undefined lengths and medians that say nothing (round 11)", () => {
  // Household production (T): no GVC production in either direction, so every GVC length is undefined.
  const idleRow = (country: string, year: number, industry = "A") => ({
    country, industry, year, PLv_GVC: null, PLy_GVC: null, GVCPs: null, "3_VA_GVC": 0, "3_FGY_GVC": 0,
  });

  test("step 8 names the missing GVC production instead of calling the lengths missing data", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    const perCountry = spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({
      rows: [idleRow(country, year)], total: 1, page: 1, page_size: 200,
    }));
    const sector = spyOn(api, "industryIndicatorsForIndustry").mockImplementation(async (year, industry) => {
      const sectorRows = ["CHN", "USA", "DEU", "JPN", "KOR", "FRA"].map((country) => idleRow(country, year, industry));
      return { rows: sectorRows, total: sectorRows.length, page: 1, page_size: 200 };
    });
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = setup(LengthVizStep);
      await view.findByRole("button", { name: "前后向位置" });
      fireEvent.click(view.getByRole("button", { name: "历年变化" }));
      fireEvent.change(view.getByLabelText("比较范围"), { target: { value: "A" } });
      const material = view.getByRole("region", { name: "报告材料" });
      await waitFor(() => expect(material.textContent).toContain("该行业没有 GVC 生产（GVC 增加值为 0），前向 GVC 段长度无法计算（不是缺少数据）"));
      expect(material.textContent).not.toContain("缺少数据（缺少的数据留空");
      // The empty chart says why in its place; the readings summary does not call the gaps missing.
      const chartStatus = view.getAllByRole("status").find((node) => node.textContent?.includes("没有 GVC 生产") && !material.contains(node));
      expect(chartStatus?.textContent).toContain("（不是缺少数据）；请换一个行业或国家。");
      expect(view.container.textContent).not.toContain("该指标没有有效读数");
      expect(view.getByText(/核对当前图表读数 · 0 条/).textContent).toContain("无法计算的读数留空");

      // 定位图 of the same industry: no economy has a point, the cards say why, and no median is named.
      fireEvent.click(view.getByRole("button", { name: "定位图" }));
      const cards = await view.findByLabelText("定位读数");
      await waitFor(() => expect(cards.textContent).toContain("该行业没有 GVC 生产（GVC 增加值为 0），前向 GVC 段长度无法计算（不是缺少数据）"));
      expect(cards.textContent).toContain("没有后向 GVC 生产（最终品中的 GVC 增加值为 0），后向 GVC 段长度无法计算");
      expect(cards.textContent).not.toContain("缺少其中一项");
      expect(view.container.textContent).not.toContain("灰色虚线是图上各经济体的中位数");
    } finally { rows.mockRestore(); perCountry.mockRestore(); sector.mockRestore(); schema.mockRestore(); }
  });

  test("step 8 with T: economies sharing one reason share one sentence (round 13)", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    const perCountry = spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({
      rows: [idleRow(country as string, year)], total: 1, page: 1, page_size: 200,
    }));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = setup(LengthVizStep);
      await view.findByRole("button", { name: "前后向位置" });
      fireEvent.change(view.getByLabelText("比较范围"), { target: { value: "A" } });
      const material = view.getByRole("region", { name: "报告材料" });
      await waitFor(() => expect(material.textContent).toContain("没有 GVC 生产"));
      const charts = view.getAllByRole("status").filter((node) => !material.contains(node) && node.textContent?.includes("无法计算"));
      const text = charts.map((node) => node.textContent).join("\n");
      expect(text).toContain("CHN 中国 与 USA 美国在所选年份该行业没有 GVC 生产（GVC 增加值为 0），前向 GVC 段长度无法计算（不是缺少数据）");
      expect(text).not.toContain("；USA 美国在所选年份");
    } finally { rows.mockRestore(); perCountry.mockRestore(); schema.mockRestore(); }
  });

  test("定位图 names a backward GVC length that is undefined while the forward one is not (MLT B09)", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    const sector = spyOn(api, "industryIndicatorsForIndustry").mockImplementation(async (year, industry) => {
      const sectorRows = ["CHN", "USA", "DEU", "JPN", "KOR", "FRA"].map((country, i) => (country === "CHN"
        ? { country, industry, year, PLv_GVC: 5.6, PLy_GVC: null, GVCPs: null, "3_VA_GVC": 1.67, "3_FGY_GVC": 0 }
        : { country, industry, year, PLv_GVC: 3 + i / 10, PLy_GVC: 3.5 - i / 10, GVCPs: (3 + i / 10) / (3.5 - i / 10), "3_VA_GVC": 10, "3_FGY_GVC": 8 }));
      return { rows: sectorRows, total: sectorRows.length, page: 1, page_size: 200 };
    });
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = setup(LengthVizStep);
      await view.findByRole("button", { name: "前后向位置" });
      fireEvent.click(view.getByRole("button", { name: "定位图" }));
      await view.findByLabelText("定位读数");
      fireEvent.change(view.getByLabelText("比较范围"), { target: { value: "A" } });
      await waitFor(() => expect(view.getByLabelText("定位读数").textContent).toContain("该行业没有后向 GVC 生产（最终品中的 GVC 增加值为 0），后向 GVC 段长度无法计算（不是缺少数据）"));
      const cards = view.getByLabelText("定位读数").textContent ?? "";
      expect(cards).not.toContain("前向 GVC 段长度无法计算");
      expect(cards).not.toContain("缺少其中一项");
    } finally { rows.mockRestore(); sector.mockRestore(); schema.mockRestore(); }
  });

  test("step 8: each undefined length names its own economies (MLT B09 has a forward GVC length)", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    // CHN plays MLT B09 (forward GVC production, none backward); USA plays LUX B09 (neither).
    const perCountry = spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({
      rows: [country === "CHN"
        ? { country, industry: "A", year, PLv_GVC: 5.6, PLy_GVC: null, GVCPs: null, "3_VA_GVC": 1.67, "3_FGY_GVC": 0 }
        : idleRow(country as string, year)],
      total: 1, page: 1, page_size: 200,
    }));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = setup(LengthVizStep);
      await view.findByRole("button", { name: "前后向位置" });
      fireEvent.change(view.getByLabelText("比较范围"), { target: { value: "A" } });
      const material = view.getByRole("region", { name: "报告材料" });
      await waitFor(() => expect(material.textContent).toContain("USA 美国在所选年份该行业没有 GVC 生产（GVC 增加值为 0），前向 GVC 段长度无法计算；"));
      expect(material.textContent).toContain("CHN 中国 与 USA 美国在所选年份该行业没有后向 GVC 生产（最终品中的 GVC 增加值为 0），后向 GVC 段长度无法计算（不是缺少数据）");
      expect(material.textContent).not.toContain("CHN 中国 与 USA 美国在所选年份该行业没有 GVC 生产");
    } finally { rows.mockRestore(); perCountry.mockRestore(); schema.mockRestore(); }
  });

  test("定位图 where every economy sits at the same point draws and reads no medians", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    const sector = spyOn(api, "industryIndicatorsForIndustry").mockImplementation(async (year, industry) => {
      const sectorRows = ["CHN", "USA", "DEU", "JPN", "KOR", "FRA"].map((country) => ({ country, industry, year, PLv_GVC: 2, PLy_GVC: 2, "3_VA_GVC": 1, "3_FGY_GVC": 1 }));
      return { rows: sectorRows, total: sectorRows.length, page: 1, page_size: 200 };
    });
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = setup(LengthVizStep);
      await view.findByRole("button", { name: "前后向位置" });
      fireEvent.click(view.getByRole("button", { name: "定位图" }));
      await view.findByLabelText("定位读数");
      // At country scope the two economies are too few for a median.
      expect(view.getByLabelText("定位读数").textContent).toContain("图上只有 2 个经济体，不比较中位数");
      fireEvent.change(view.getByLabelText("比较范围"), { target: { value: "A" } });
      await waitFor(() => expect(view.getByLabelText("定位读数").textContent).toContain("图上 6 个经济体的读数相同，不比较中位数"));
      expect(view.getByLabelText("定位读数").textContent).not.toContain("等于中位数");
      expect(view.getByText(/图上 6 个点的读数相同，不画中位数和象限。/)).toBeTruthy();
      expect(view.container.textContent).not.toContain("前后向均较高");
      expect(view.container.textContent).not.toContain("灰色虚线是图上各经济体的中位数");
    } finally { rows.mockRestore(); sector.mockRestore(); schema.mockRestore(); }
  });
});

describe("steps 6–8 keep an exploration-only selection and say where carried countries came from", () => {
  const wide: Meta = { ...meta, countries: ["BRN", "CHN", "LUX", "USA"] };
  const wideRows = (year: number) => ["BRN", "CHN", "LUX", "USA"].map((country, i) => ({ ...countryRows(year)[0], country, gross_exports: 100 + i * 50 }));
  const stateOf = (data: VizStepState | undefined, views: VizStepState[], extra: Partial<StepStateApi<VizStepState>> = {}): StepStateApi<VizStepState> => ({
    data, save: () => {}, saveView: (value) => views.push(value), complete: false, syncing: false, syncError: null, syncNow: () => {}, ...extra,
  });

  test("a country changed in 定位图 (not recorded) comes back with its view after leaving the step", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => wideRows(year));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const views: VizStepState[] = [];
      const first = render(<TradeVizStep meta={wide} step={step} state={stateOf({ compared: ["LUX", "USA"] }, views)} />);
      await first.findByRole("button", { name: "定位图" });
      fireEvent.click(first.getByRole("button", { name: "定位图" }));
      fireEvent.change(first.getByLabelText("国家 A"), { target: { value: "BRN" } });
      fireEvent.click(first.getByRole("button", { name: /移除对比国家 B/ }));
      await waitFor(() => expect(views.at(-1)?.browse_selection).toMatchObject({ first: "BRN", others: [], view: "positioning" }));
      first.unmount();
      // Back on the step: the saved browsing selection wins over the carried / recorded countries.
      const again = render(<TradeVizStep meta={wide} step={step} state={stateOf({ compared: ["LUX", "USA"], browse_selection: views.at(-1)!.browse_selection }, [])} />);
      expect((again.getByLabelText("国家 A") as HTMLSelectElement).value).toBe("BRN");
      expect(again.queryByLabelText("对比国家 B")).toBeNull();
      expect(again.getByRole("button", { name: "定位图" }).getAttribute("aria-pressed")).toBe("true");
    } finally { rows.mockRestore(); schema.mockRestore(); }
  });

  test("a carried set says which step it came from until the countries change here", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => wideRows(year));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = render(<TradeVizStep meta={wide} step={step} state={stateOf({ compared: ["LUX", "USA"] }, [], { carriedFrom: 3 })} />);
      expect(view.getByText("沿用你在步骤 3 选的国家，可以更换。")).toBeTruthy();
      // Another view is not another set of countries.
      fireEvent.click(view.getByRole("button", { name: "定位图" }));
      expect(view.queryByText("沿用你在步骤 3 选的国家，可以更换。")).toBeTruthy();
      fireEvent.change(view.getByLabelText("国家 A"), { target: { value: "CHN" } });
      expect(view.queryByText("沿用你在步骤 3 选的国家，可以更换。")).toBeNull();
      cleanup();
      // The step's own selection (not the carried set) has no line.
      const own = render(<TradeVizStep meta={wide} step={step} state={stateOf({ compared: ["LUX", "USA"], browse_selection: { first: "BRN", second: "", others: [], industry: "", metric: "FVA_share", start: 2019, end: 2021, year: 2021, view: "trend", limit: 10 } }, [], { carriedFrom: 3 })} />);
      expect(own.queryByText(/沿用你在步骤/)).toBeNull();
    } finally { rows.mockRestore(); schema.mockRestore(); }
  });

  test("picking a comparison country as A swaps the two, says so, and drops the （默认） mark", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => wideRows(year));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = render(<TradeVizStep meta={wide} step={step} state={stateOf({ compared: ["CHN", "USA"] }, [])} />);
      const marked = () => [...(view.getByLabelText("对比国家 B") as HTMLSelectElement).options].filter((option) => option.text.includes("（默认）")).map((option) => option.value);
      expect(marked()).toEqual(["USA"]);
      fireEvent.change(view.getByLabelText("国家 A"), { target: { value: "USA" } });
      expect((view.getByLabelText("对比国家 B") as HTMLSelectElement).value).toBe("CHN");
      expect(view.getByText("已与对比国家 B 互换。")).toBeTruthy();
      expect(marked()).toEqual([]);
      fireEvent.change(view.getByLabelText("对比国家 B"), { target: { value: "LUX" } });
      expect(view.queryByText("已与对比国家 B 互换。")).toBeNull();
    } finally { rows.mockRestore(); schema.mockRestore(); }
  });
});
