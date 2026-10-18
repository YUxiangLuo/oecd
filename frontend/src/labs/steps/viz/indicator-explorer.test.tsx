import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { api } from "../../../api";
import type { Meta, Step, StepStateApi } from "../../../types";
import type { VizStepState } from "./scaffold";
import { LengthPositionTrajectory } from "./indicator-charts";
import { COMPOSITION_MATERIAL_SCALE_NOTE } from "./indicator-explorer";
import { MATERIAL_CARD_TITLE, MATERIAL_STATE_LABELS } from "../../../material-card";
import { LengthVizStep } from "./length";
import { ProductionVizStep } from "./production";
import { TradeVizStep } from "./trade";
import {
  MATERIAL_LOCKED_NOTE,
  MATERIAL_RECHOSEN_NEXT,
  NO_READINGS_NOTE,
  NOT_RECORDED_HINT,
  RECORD_CHART_ACTION,
  RECORDED_CHART_LABEL,
  REPLACE_MATERIAL_ACTION,
} from "../../../step-task-card";
import { NEGATIVE_VALUE_ADDED_CAUSE, NEGATIVE_VALUE_ADDED_NOTE } from "../../../value-added-notes";

/** The one 本步报告材料 card under the chart: its chip says the state, its one button records the chart on screen. */
type Queries = Pick<ReturnType<typeof render>, "getByRole">;
const materialCard = (view: Queries) => view.getByRole("region", { name: MATERIAL_CARD_TITLE });
const materialChip = (view: Queries) => materialCard(view).querySelector(".material-chip")?.textContent;

/** The chart on screen becomes report material only when the student asks: wait for its button and press it. */
async function record(view: Pick<ReturnType<typeof render>, "findByRole">, name: string = RECORD_CHART_ACTION) {
  const button = await view.findByRole("button", { name });
  await act(async () => { fireEvent.click(button); });
}

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

describe("indicator explorer with report material recorded on request", () => {
  test("after the report is submitted, browsing never rewrites the material; the student can replace it on request", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    // The submitted report holds a composition chart; the student now browses the trend.
    const view = setup(TradeVizStep, {
      compared: ["CHN", "USA"],
      observations: [{ entity: "CHN", country: "CHN", year: 2021, metric: "gross_exports", value: 100, unit: "百万美元", scope: "country", source: "explicit-indicator-composition", release }],
      indicator_selection: { first: "CHN", second: "USA", others: ["USA"], industry: "", metric: "FVA_share", start: 2019, end: 2021, year: 2021, view: "composition", limit: 10 },
    }, true);
    await view.findByRole("button", { name: "出口构成" });
    fireEvent.click(view.getByRole("button", { name: "历年变化" }));
    expect(await view.findByLabelText("趋势读数")).toBeTruthy();
    // Under the chart the only action is to replace the submitted material, and it says what that entails.
    const replace = await view.findByRole("button", { name: REPLACE_MATERIAL_ACTION });
    expect(view.queryByRole("button", { name: RECORD_CHART_ACTION })).toBeNull();
    const material = materialCard(view);
    expect(material.textContent).toContain(`已记录的是另一张图；要换成当前图表，点下面的按钮。 ${MATERIAL_LOCKED_NOTE}`);
    expect(material.textContent).not.toContain(MATERIAL_RECHOSEN_NEXT);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view.saves).toHaveLength(0);
    await act(async () => { fireEvent.click(replace); });
    expect(view.saves).toHaveLength(1);
    expect(view.saves[0].indicator_selection).toMatchObject({ first: "CHN", second: "USA", view: "trend" });
    expect(view.saves[0].observations!.every((item) => item.source === "explicit-indicator-trend")).toBe(true);
    // The report must not call the student's own choice an automatic record.
    expect(view.saves[0].material_chosen).toBe(true);
    // The confirmation says what to do next, as step 13 does.
    view.accept();
    await waitFor(() => expect(materialCard(view).textContent).toContain(`当前图表就是已记录的材料；换视角、国家或年份不会改动它。 ${MATERIAL_LOCKED_NOTE}${MATERIAL_RECHOSEN_NEXT}`));
    expect((view.getByRole("button", { name: RECORDED_CHART_LABEL }) as HTMLButtonElement).disabled).toBe(true);
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
          // The saved trend stays the material; the card says the years, not the chart, are what to fix.
          expect(materialChip(view)).toBe(MATERIAL_STATE_LABELS.recorded);
          expect(materialCard(view).textContent).toContain("请先修正年份范围，当前图表才能被记录。");
          expect(materialCard(view).textContent).not.toContain("没有可记录的读数");
          expect(view.queryByRole("button", { name: RECORD_CHART_ACTION })).toBeNull();
          if (!delayed) expect(rows).not.toHaveBeenCalled();
          // An invalid range is never recorded and never overwrites the saved material.
          expect(saves).toHaveLength(0);
          expect(JSON.stringify(data)).toBe(original);
          fireEvent.click(view.getByRole("button", { name: "重置年份" }));
          expect(view.queryByRole("alert")).toBeNull();
          // The reset chart is offered for recording, not recorded by itself.
          await view.findByRole("button", { name: RECORD_CHART_ACTION });
          expect(saves).toHaveLength(0);
          await record(view);
          expect(saves).toHaveLength(1);
          expect(saves[0].indicator_selection).toMatchObject({ start: 2019, end: 2021, year: 2021 });
          expect(saves[0].material_chosen).toBe(true);
          expect(rows.mock.calls.every(([year]) => meta.years.includes(year))).toBe(true);
        } finally { rows.mockRestore(); schema.mockRestore(); }
      });
    }
  }

  test("opens on the theme view, records nothing until asked, and records the chart the student asks for", async () => {
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
    // Opening the step draws the chart and offers to record it; nothing is recorded by itself.
    await view.findByRole("button", { name: RECORD_CHART_ACTION });
    expect(view.saves).toHaveLength(0);
    expect(materialChip(view)).toBe(MATERIAL_STATE_LABELS.missing);
    expect(within(materialCard(view)).getByRole("status").textContent).toBe(NOT_RECORDED_HINT);
    expect(within(materialCard(view)).queryByText(/核对已记录的读数/)).toBeNull();
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
    expect(view.getByText(/差距（不计正负）缩小 .* 个百分点/)).toBeTruthy();
    expect(chart.querySelector('[data-series="global-median"]')).not.toBeNull();
    // Switching the view records nothing either: the student records the chart they want.
    await view.findByRole("button", { name: RECORD_CHART_ACTION });
    expect(view.saves).toHaveLength(0);
    await record(view);
    expect(view.saves).toHaveLength(1);
    expect(view.saves[0].indicator_selection).toMatchObject({
      first: "CHN",
      second: "USA",
      industry: "",
      metric: "FVA_share",
      view: "trend",
    });
    expect(view.saves[0].material_chosen).toBe(true);
    expect(view.saves[0].compared).toEqual(["CHN", "USA"]);
    expect(view.saves[0].observations).toHaveLength(6);
    expect(view.saves[0].observations![0]).toMatchObject({
      country: "CHN",
      year: 2019,
      scope: "country",
      source: "explicit-indicator-trend",
      release,
    });
    view.accept(); // parent owns persistence; only its rerender marks the selection saved
    expect(materialChip(view)).toBe(MATERIAL_STATE_LABELS.recorded);
    expect(within(materialCard(view)).getByText("核对已记录的读数 · 6 条").tagName).toBe("SUMMARY");
    expect(materialCard(view).textContent).toContain("当前图表就是已记录的材料；换视角、国家或年份不会改动它。");
    expect((view.getByRole("button", { name: RECORDED_CHART_LABEL }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.saves).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: "国家对比" }));
    // The same-year view shows every economy with the two countries highlighted and ranked, then the ranking bars.
    expect(await view.findByRole("region", { name: /全球分布/ })).toBeTruthy();
    expect(view.getByText(/排名 · 前 20 与所选国家/)).toBeTruthy();
    expect(view.getByRole("img", { name: /CHN 中国 .*第 [0-9]+ 位/ })).toBeTruthy();
    // The recorded trend stays until the student records this chart instead.
    await view.findByRole("button", { name: RECORD_CHART_ACTION });
    expect(view.saves).toHaveLength(1);
    expect(materialCard(view).textContent).toContain("已记录的是另一张图；要换成当前图表，点下面的按钮。");
    await record(view);
    expect(view.saves).toHaveLength(2);
    expect(view.saves[1].indicator_selection?.view).toBe("comparison");
    expect(view.saves[1].material_chosen).toBe(true);
    expect(
      view.saves[1].observations!.every(
        (x) => x.year === 2021 && x.source === "explicit-indicator-comparison",
      ),
    ).toBeTrue();
    rows.mockRestore();
    schema.mockRestore();
  });

  test("restores a recorded chart's countries without recording it again", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(
      async (year) => countryRows(year),
    );
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({
      groups: [],
      fields: {},
    });
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
      material_label: "历年变化 · 外国增加值项占比 · USA 美国 对 CHN 中国 · 国家整体 · 2020（1 条读数）",
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
    await modern.findByText("核对已记录的读数 · 1 条");
    expect(materialChip(modern)).toBe(MATERIAL_STATE_LABELS.recorded);
    expect(within(materialCard(modern)).getByRole("status").textContent).toBe("历年变化 · 外国增加值项占比 · USA 美国 对 CHN 中国 · 国家整体 · 2020（1 条读数）");
    expect(modern.saves).toHaveLength(0);
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
    // The 2020–2021 chart is ready while the superseded 2019 request still hangs.
    await record(view);
    expect(view.saves).toHaveLength(1);
    resolveOld(countryRows(2019));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // The late 2019 response belongs to a superseded request and must never reach the record.
    expect(view.saves).toHaveLength(1);
    expect(view.saves.every((save) => save.observations!.every((x) => x.year >= 2020))).toBeTrue();
    expect(view.saves.at(-1)!.observations).toHaveLength(4);
    expect(view.saves.at(-1)!.indicator_selection).toMatchObject({ start: 2020, end: 2021, view: "trend" });
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
    await record(view);
    expect(view.saves.at(-1)?.indicator_selection?.view).toBe("composition");
    expect(view.saves.at(-1)?.material_chosen).toBe(true);
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
    await record(view);
    expect(view.saves).toHaveLength(2);
    expect(view.saves.at(-1)?.indicator_selection?.view).toBe("evolution");
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

  test("the positioning view has no readings to record: it offers no button and keeps the saved record", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    const view = setup();
    await view.findByRole("button", { name: "出口构成" });
    await record(view);
    expect(view.saves.at(-1)?.indicator_selection?.view).toBe("composition");
    view.accept();
    const before = view.saves.length;
    fireEvent.click(view.getByRole("button", { name: "定位图" }));
    expect(view.getByLabelText("当前图表范围").textContent).toContain("定位图");
    const card = materialCard(view);
    expect(within(card).getByRole("status").textContent).toMatch(/^出口构成 · .*（\d+ 条读数）$/);
    expect(card.textContent).not.toContain(NO_READINGS_NOTE);
    expect(within(card).queryByRole("button")).toBeNull();
    // A view that never records does not say "暂不能记录", and nothing on the page calls it 只供探索 any more.
    expect(card.textContent).not.toContain("暂不能记录");
    expect(view.container.textContent).not.toContain("只供探索");
    // The recorded composition stays the material.
    expect(materialChip(view)).toBe(MATERIAL_STATE_LABELS.recorded);
    expect(within(card).getByText(/^核对已记录的读数 · \d+ 条$/)).toBeTruthy();
    expect(card.textContent).toContain("已记录的是另一张图；当前图表没有可记录的读数。");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(view.saves).toHaveLength(before);
    rows.mockRestore();
    schema.mockRestore();
  });

  test("length defaults to the time trajectory alone; the forward/backward trends live under 历年变化", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(
      async (year) => countryRows(year),
    );
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({
      groups: [],
      fields: {},
    });
    const view = setup(LengthVizStep);
    expect(
      await view.findByRole("img", { name: /前向与后向 GVC 段长度历年轨迹/ }),
    ).toBeTruthy();
    expect(view.queryByRole("img", { name: /前向 GVC 段长度历年变化/ })).toBeNull();
    expect(view.queryByRole("img", { name: /后向 GVC 段长度历年变化/ })).toBeNull();
    expect(view.container.textContent).toContain("切换到“历年变化”");
    const scope = view.getByRole("group", { name: "当前图表范围" });
    const keys = [...scope.querySelectorAll(".scope-country")];
    expect(keys.map((key) => key.textContent)).toEqual(["CHN 中国", "USA 美国"]);
    expect(keys.map((key) => key.querySelector("circle")?.getAttribute("fill"))).toEqual(["#216cc0", "#1baf7a"]);
    expect(keys.map((key) => key.querySelector("line")?.getAttribute("stroke-dasharray"))).toEqual([null, "7 4"]);
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
      "前后向位置", "历年变化", "国家对比", "段长度对照", "行业排名",
    ]);
    fireEvent.click(view.getByRole("button", { name: "段长度对照" }));
    await record(view);
    expect(view.saves).toHaveLength(1);
    const saved = view.saves.at(-1)!;
    expect(saved.indicator_selection?.view).toBe("segments");
    expect(saved.material_chosen).toBe(true);
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
    // At country level 纯国内 and 传统贸易 read the same forward and backward: the page says why (round 21).
    expect(view.container.textContent).toContain("国家整体上，纯国内段与传统贸易段的前向长度和后向长度总是相等，这是恒等关系，不是数据错误");
    view.accept();
    fireEvent.click(view.getByRole("button", { name: "前后向位置" }));
    await record(view);
    expect(view.saves.at(-1)?.indicator_selection?.view).toBe("directions");
    view.accept();
    fireEvent.click(view.getByRole("button", { name: "全球参照" }));
    await view.findByLabelText("定位读数");
    expect(view.getByRole("button", { name: "前后向位置" }).getAttribute("aria-pressed")).toBe("true");
    expect(view.queryByRole("button", { name: RECORD_CHART_ACTION })).toBeNull();
    expect(view.saves).toHaveLength(2);
    fireEvent.click(view.getByRole("button", { name: "所选国家轨迹" }));
    expect((await view.findByRole("button", { name: RECORDED_CHART_LABEL }) as HTMLButtonElement).disabled).toBe(true);
    rows.mockRestore();
    schema.mockRestore();
  });

  test("length 前后向位置: a country with no backward GVC length says why it has no trajectory, once", async () => {
    // CHN plays ISL B09: no backward GVC production in any year, so every PLy_GVC is undefined.
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) =>
      countryRows(year).map((row) => (row.country === "CHN" ? { ...row, PLy_GVC: null, "3_FGY_GVC": 0 } : row)) as never,
    );
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    const view = setup(LengthVizStep);
    const legend = await waitFor(() => { const found = view.container.querySelector('[data-legend="CHN"]'); expect(found).toBeTruthy(); return found!; });
    expect(legend.textContent).toBe("CHN 中国 · 无轨迹");
    expect(view.getAllByRole("note").filter((note) => note.textContent?.includes("CHN 中国没有轨迹"))).toHaveLength(1);
    // No trend chart under the trajectory any more: the note below the chart is the one place that says why.
    await waitFor(() => expect(view.container.textContent).toContain("后向 GVC 段长度无法计算"));
    expect(view.container.textContent).not.toContain("原因见下方趋势图");
    expect(view.container.textContent).toContain("原因见下方说明");
    // The blocked-record notice under the chart repeats the reason by design; the chart area itself says it once.
    const material = materialCard(view).textContent ?? "";
    expect(material).toContain("当前图表暂不能记录：");
    expect(materialChip(view)).toBe(MATERIAL_STATE_LABELS.blocked);
    const outside = (view.container.textContent ?? "").replace(material, "");
    expect(outside.split("后向 GVC 段长度无法计算").length - 1).toBe(1);
    expect(outside).not.toContain("暂不能读出期间变化");
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
      await record(view);
      expect(view.saves.at(-1)?.compared).toEqual(["CHN"]);
      expect(view.saves.at(-1)!.observations!.every((item) => item.country === "CHN")).toBe(true);
      expect(view.saves.at(-1)!.material_chosen).toBe(true);
      // An industry has no global reference, so one economy alone is exploration there: no button to record it.
      const before = view.saves.length;
      fireEvent.change(view.getByLabelText("比较范围"), { target: { value: "A" } });
      const notice = await view.findByText(/要把“比较范围”设为“国家整体”/);
      expect(notice.textContent).toContain("当前图表暂不能记录：");
      expect(materialCard(view).contains(notice)).toBe(true);
      expect(materialChip(view)).toBe(MATERIAL_STATE_LABELS.blocked);
      expect(view.queryByRole("button", { name: RECORD_CHART_ACTION })).toBeNull();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(view.saves).toHaveLength(before);
    } finally { rows.mockRestore(); industry.mockRestore(); schema.mockRestore(); }
  });

  test("a third country joins the same chart: one series per economy, all recorded together", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => rows3(year));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = mount();
      await view.findByRole("button", { name: "出口构成" });
      fireEvent.click(view.getByRole("button", { name: "历年变化" }));
      await record(view);
      expect(view.saves.at(-1)?.compared).toEqual(["CHN", "USA"]);
      fireEvent.change(view.getByLabelText("再加一个对比国家"), { target: { value: "DEU" } });
      fireEvent.click(view.getByRole("button", { name: "添加" }));
      expect(view.getByLabelText("对比国家 C")).toBeTruthy();
      await waitFor(() => expect(view.container.querySelectorAll("[data-series-group]")).toHaveLength(3));
      // Adding a country changes the chart, not the record, until the student records the new chart.
      await view.findByRole("button", { name: RECORD_CHART_ACTION });
      expect(view.saves).toHaveLength(1);
      await record(view);
      expect(view.saves).toHaveLength(2);
      expect(view.saves.at(-1)?.compared).toEqual(["CHN", "USA", "DEU"]);
      expect(view.saves.at(-1)!.indicator_selection).toMatchObject({ first: "CHN", second: "USA", others: ["USA", "DEU"] });
      expect(view.saves.at(-1)!.material_chosen).toBe(true);
      expect(new Set(view.saves.at(-1)!.observations!.map((item) => item.country))).toEqual(new Set(["CHN", "USA", "DEU"]));
      // Every comparison country gets its own gap card.
      expect(view.getAllByText(/与对比国家/)).toHaveLength(2);
      // Choosing a comparison country as A swaps it with the old A instead of dropping it.
      fireEvent.change(view.getByLabelText("国家 A"), { target: { value: "DEU" } });
      const scope = view.getByRole("group", { name: "当前图表范围" });
      const keys = [...scope.querySelectorAll(".scope-country")];
      expect(keys.map((key) => key.textContent)).toEqual(["DEU 德国", "USA 美国", "CHN 中国"]);
      await record(view);
      expect(view.saves).toHaveLength(3);
      expect(view.saves.at(-1)?.compared).toEqual(["DEU", "USA", "CHN"]);
      expect(keys.map((key) => key.querySelector("circle")?.getAttribute("fill"))).toEqual(["#216cc0", "#1baf7a", "#eda100"]);
      expect(keys.map((key) => key.querySelector("line")?.getAttribute("stroke-dasharray"))).toEqual([null, "7 4", "7 4"]);
      fireEvent.click(view.getByRole("button", { name: "出口构成" }));
      expect(scope.querySelector(".scope-country")).toBeNull();
    } finally { rows.mockRestore(); schema.mockRestore(); }
  });
});

describe("readouts and the record button follow the chart on screen (round 10)", () => {
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

  test("the record button follows each change of chart, records only on request, and goes once the chart has no readings", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = setup();
      await view.findByRole("button", { name: "出口构成" });
      await record(view);
      expect(view.saves).toHaveLength(1);
      view.accept();
      expect((view.getByRole("button", { name: RECORDED_CHART_LABEL }) as HTMLButtonElement).disabled).toBe(true);
      // Another view: the button offers to record it, the card says the record is another chart, no flash appears.
      fireEvent.click(view.getByRole("button", { name: "历年变化" }));
      await view.findByRole("button", { name: RECORD_CHART_ACTION });
      expect(view.saves).toHaveLength(1);
      expect(materialCard(view).textContent).toContain("已记录的是另一张图");
      expect(view.container.querySelector(".scope-flash")).toBeNull();
      expect(view.container.textContent).not.toContain("报告材料已更新为");
      await record(view);
      expect(view.saves).toHaveLength(2);
      expect(view.saves[1].indicator_selection).toMatchObject({ view: "trend", metric: "FVA_share" });
      view.accept();
      // Another indicator is another chart: the recorded one stays until the student records this one.
      fireEvent.change(view.getByLabelText("指标"), { target: { value: "FVA" } });
      await view.findByRole("button", { name: RECORD_CHART_ACTION });
      expect(view.saves).toHaveLength(2);
      await record(view);
      expect(view.saves).toHaveLength(3);
      expect(view.saves[2].indicator_selection).toMatchObject({ view: "trend", metric: "FVA" });
      expect(view.saves[2].material_chosen).toBe(true);
      view.accept();
      // 定位图 has no readings to record: no button, one plain sentence in its place; the recorded trend stays.
      fireEvent.click(view.getByRole("button", { name: "定位图" }));
      await waitFor(() => expect(materialCard(view).textContent).toContain("已记录的是另一张图；当前图表没有可记录的读数。"));
      expect(materialChip(view)).toBe(MATERIAL_STATE_LABELS.recorded);
      expect(view.queryByRole("button", { name: RECORD_CHART_ACTION })).toBeNull();
      expect(view.queryByRole("button", { name: RECORDED_CHART_LABEL })).toBeNull();
      expect(view.container.querySelector(".scope-flash")).toBeNull();
      // Back on the recorded chart: it is the material, so the button is the disabled confirmation.
      fireEvent.click(view.getByRole("button", { name: "历年变化" }));
      await view.findByLabelText("趋势读数");
      expect((await view.findByRole("button", { name: RECORDED_CHART_LABEL }) as HTMLButtonElement).disabled).toBe(true);
      expect(materialCard(view).textContent).toContain("当前图表就是已记录的材料");
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
      expect(view.getByText(/本页面不展示比重，占比图里不画/)).toBeTruthy();
      // Only value added explains itself as a loss; step 6's export total is another matter.
      expect(view.container.textContent).not.toContain(NEGATIVE_VALUE_ADDED_CAUSE);
      const card = materialCard(view);
      expect(materialChip(view)).toBe(MATERIAL_STATE_LABELS.blocked);
      expect(card.textContent).toContain("当前图表暂不能记录：");
      expect(card.textContent).toContain("为负，本页面不展示比重（不是缺少数据）");
      expect(within(card).queryByRole("button")).toBeNull();
      // In the 金额 view the card does not send the student to the view they are already in.
      expect(cards.textContent).toContain("切到“金额”可看各分项");
      fireEvent.click(view.getByRole("button", { name: "金额" }));
      await waitFor(() => expect(view.getByLabelText("构成读数").textContent).not.toContain("切到“金额”"));
      expect(view.getByLabelText("构成读数").textContent).toContain("本页面不展示比重");
    } finally { rows.mockRestore(); schema.mockRestore(); }
  });

  test("mixed zero and negative totals keep their distinct explanations in the chart and blocked material", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) =>
      countryRows(year).map((row) => ({ ...row, gross_exports: row.country === "USA" ? -5 : 0 })));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = setup();
      const note = await view.findByText(/本页面不展示比重，占比图里不画/);
      expect(note.textContent).toContain("为 0，构成份额无法计算，占比图里不画");
      expect(note.textContent).toContain("为负（-5.000 百万美元），本页面不展示比重");
      expect(materialCard(view).textContent).toContain("为 0 或为负：为 0 时构成份额无法计算，为负时本页面不展示比重");
      expect(view.saves).toHaveLength(0);
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
      // 0 in every year of the range: another year range would not help, so it is not suggested (round 5).
      expect(materialCard(view).textContent).toContain("为 0，构成份额无法计算（不是缺少数据）；请换一个国家。");
      expect(materialCard(view).textContent).not.toContain("调整年份范围");
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
      const plot = await view.findByRole("region", { name: "国内增加值出口占比行业点图（单位：%）" });
      await waitFor(() => expect(plot.textContent).toContain("无法计算"));
      expect(plot.textContent).not.toContain("缺失");
      expect(view.getByText(/O 公共管理与国防：USA 美国该行业总出口为 0，国内增加值出口占比无法计算（不是缺少数据）。这些行业照常显示，但不记入报告材料/)).toBeTruthy();
      // The chart is recordable (the complete row carries it), so the button is offered and nothing is saved yet.
      await view.findByRole("button", { name: RECORD_CHART_ACTION });
      expect(view.saves).toHaveLength(0);
      expect(materialCard(view).textContent).not.toContain("暂不能记录");
      expect(materialChip(view)).toBe(MATERIAL_STATE_LABELS.missing);
      await record(view);
      expect(view.saves).toHaveLength(1);
      const recorded = view.saves.at(-1)!.observations ?? [];
      expect(recorded.map((item) => [item.country, item.industry])).toEqual([["CHN", "A"], ["USA", "A"]]);
      expect(view.saves.at(-1)!.indicator_selection).toMatchObject({ view: "industry", metric: "DVAex_share" });
      expect(view.saves.at(-1)!.material_chosen).toBe(true);
    } finally { restore(); }
  });

  test("country A's own undefined rows are named under the ranking instead of vanishing (round 13)", async () => {
    // CHN plays LUX / CHN: its O exports are 0, so O cannot be placed in A's order.
    const { view, restore } = await open(["A", "O"], (country, industry) => country === "CHN" && industry === "O");
    try {
      const plot = await view.findByRole("region", { name: "国内增加值出口占比行业点图（单位：%）" });
      await waitFor(() => expect(plot.textContent).toContain("A →"));
      expect(plot.textContent).not.toContain("O ");
      expect(view.getByText("另有 1 个行业没有画出：国家 A（CHN 中国）在这个行业没有读数，无法排序。O 总出口为 0，国内增加值出口占比无法计算（不是缺少数据）。")).toBeTruthy();
    } finally { restore(); }
  });

  test("more than three unrecorded rows: the note names three, the full list opens below it (round 13)", async () => {
    const { view, restore } = await open(["A", "B", "C", "D", "E"], (country, industry) => country === "USA" && industry !== "A");
    try {
      await view.findByRole("region", { name: "国内增加值出口占比行业点图（单位：%）" });
      await waitFor(() => expect(view.getByText(/等 4 个行业。这些行业照常显示/)).toBeTruthy());
      const list = view.getByText("查看全部 4 个行业").closest("details")!;
      expect(list.querySelectorAll("li")).toHaveLength(4);
      expect(list.textContent).toContain("E ");
    } finally { restore(); }
  });

  test("when no row is complete the notice gives the real reason and does not suggest another year", async () => {
    const { view, restore } = await open(["O"]);
    try {
      const notice = materialCard(view);
      await waitFor(() => expect(notice.textContent).toContain("USA 美国该行业总出口为 0，国内增加值出口占比无法计算（不是缺少数据）"));
      expect(materialChip(view)).toBe(MATERIAL_STATE_LABELS.blocked);
      expect(notice.textContent).toContain("当前图表暂不能记录：");
      expect(notice.textContent).toContain("请换国家。");
      expect(notice.textContent).not.toContain("缺少数据（缺少的数据留空");
      expect(notice.textContent).not.toContain("换一个年份");
      // A ranking with no complete row cannot be recorded: no button, and nothing was saved on the way here.
      expect(within(notice).queryByRole("button")).toBeNull();
      expect(view.saves).toHaveLength(0);
    } finally { restore(); }
  });
});

test("step 7 aligns industry compositions by country A and keeps undefined comparison rows", async () => {
  const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
  const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
  const perCountry = spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => {
    const values = country === "CHN" ? [["A", 100, 40], ["B09", 100, 10]] : [["B09", 100, 80], ["A", 0, 0]];
    const data = values.map(([industry, total, complex]) => ({ country, year, industry: String(industry), SVA: Number(total),
      "1_VA_D": Number(total) - Number(complex), "2_VA_RT": 0, "3a_VA_GVC_S": 0, "3b_VA_GVC_C": Number(complex) }));
    return { rows: data, total: data.length, page: 1, page_size: 200 };
  });
  try {
    const view = setup(ProductionVizStep);
    fireEvent.click(view.getByRole("button", { name: "行业结构" }));
    await waitFor(() => expect(view.container.querySelectorAll(".composition-chart-row")).toHaveLength(4));
    const panels = [...view.container.querySelectorAll(".comparison-facet")];
    const labels = (panel: Element) => [...panel.querySelectorAll(".composition-chart-label")].map((node) => node.textContent);
    expect(labels(panels[0])).toEqual(labels(panels[1]));
    expect(labels(panels[0])[0]).toBe("A");
    const usa = [...panels[1].querySelectorAll(".composition-chart-row")];
    expect(usa[0].textContent).toContain("无法计算");
    expect(usa[0].querySelectorAll(".composition-chart-track span")).toHaveLength(0);
    expect(usa[1].textContent).toContain("80.000%");
    expect(view.saves).toHaveLength(0);
  } finally { rows.mockRestore(); perCountry.mockRestore(); schema.mockRestore(); }
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
    await waitFor(() => expect(view.getAllByText("该国有 2 个行业无法绘制份额（比较时保留对应空行）：H51 总增加值为负，本页面不展示比重（不是缺少数据）；B09 总增加值为 0，份额无法计算（不是缺少数据）。")).toHaveLength(2));
    // Why value added is negative is said once under the two countries' charts (round 6).
    expect(view.getAllByText(NEGATIVE_VALUE_ADDED_NOTE)).toHaveLength(1);
  } finally { rows.mockRestore(); perCountry.mockRestore(); schema.mockRestore(); }
});

test("step 7 四类生产活动 in 金额 describes amounts, and the material says the report draws shares", async () => {
  const part = { "1_VA_D": 4, "2_VA_RT": 2, "3a_VA_GVC_S": 1, "3b_VA_GVC_C": 3 };
  const backward = { FGY: 12, "1_FGY_D": 5, "2_FGY_RT": 2, "3a_FGY_GVC_S": 2, "3b_FGY_GVC_C": 3 };
  const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year).map((row) => ({ ...row, SVA: 10, ...part, ...backward })));
  const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
  try {
    const view = setup(ProductionVizStep);
    await view.findByRole("button", { name: "四类生产活动" });
    await record(view);
    expect(view.saves).toHaveLength(1);
    view.accept();
    await waitFor(() => expect(view.container.textContent).toContain("四类生产活动各占本国总增加值的份额"));
    const material = materialCard(view);
    await waitFor(() => expect(material.textContent).toContain(COMPOSITION_MATERIAL_SCALE_NOTE));
    expect(material.textContent).not.toContain("本页现在按金额显示");

    fireEvent.click(view.getByRole("button", { name: "金额" }));
    expect(view.container.textContent).toContain("本国总增加值按四类生产活动分成的金额");
    expect(view.container.textContent).not.toContain("四类生产活动各占本国总增加值的份额");
    expect(material.textContent).toContain("本页现在按金额显示。");
    // Switching the bars records nothing new: the material is the same readings.
    expect(view.saves).toHaveLength(1);

    // The backward side's note in 金额 does not speak of shares either.
    fireEvent.click(view.getByRole("button", { name: "后向（按最终品）" }));
    expect(view.container.textContent).toContain("前向、后向的金额不能逐项对照");
    // The backward composition is another chart: offered for recording, not recorded by itself.
    await view.findByRole("button", { name: RECORD_CHART_ACTION });
    expect(view.saves).toHaveLength(1);
    expect(material.textContent).toContain("已记录的是另一张图");
    expect(material.textContent).not.toContain(COMPOSITION_MATERIAL_SCALE_NOTE);
    await record(view);
    expect(view.saves).toHaveLength(2);
    expect(view.saves[1].indicator_selection).toMatchObject({ view: "composition", composition_side: "alternate" });
    expect(view.saves[1].material_chosen).toBe(true);
    expect(view.container.querySelector(".scope-flash")).toBeNull();
    view.accept();
    expect(view.getByLabelText("当前图表范围").textContent).toContain("四类生产活动 · 后向");
    expect(materialCard(view).textContent).toContain(`${COMPOSITION_MATERIAL_SCALE_NOTE}本页现在按金额显示。`);
  } finally { rows.mockRestore(); schema.mockRestore(); }
});

test("step 7 占比 says nothing about red negative parts when the only negative total is left out (ITA·C19, round 27)", async () => {
  const part = { SVA: 10, "1_VA_D": 4, "2_VA_RT": 2, "3a_VA_GVC_S": 1, "3b_VA_GVC_C": 3 };
  const negative = { SVA: -2, "1_VA_D": -5, "2_VA_RT": 1, "3a_VA_GVC_S": 1, "3b_VA_GVC_C": 1 };
  const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) =>
    countryRows(year).map((row) => ({ ...row, ...(row.country === "USA" ? negative : part) })));
  const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
  try {
    const view = setup(ProductionVizStep);
    await view.findByText(/本页面不展示比重，占比图里不画/);
    expect(view.container.textContent).not.toContain("负分项画成红色");
    // A share of a negative total would read as a share of value added: the page says why it has none, right under
    // the line that names the negative total (round 6).
    expect(view.getByText(NEGATIVE_VALUE_ADDED_NOTE).previousElementSibling?.textContent).toContain("占比图里不画");
    fireEvent.click(view.getByRole("button", { name: "金额" }));
    await waitFor(() => expect(view.container.textContent).toContain("负分项画在零轴左侧"));
  } finally { rows.mockRestore(); schema.mockRestore(); }
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
      await waitFor(() => expect(view.getByLabelText("比较范围")).toBeTruthy());
      expect(view.container.textContent).not.toContain("选择了行业时只显示所选国家的同行业走势");
      fireEvent.change(view.getByLabelText("比较范围"), { target: { value: "A" } });
      // The industry trend says why it has no global reference, as 国家对比 does (round 5).
      await waitFor(() => expect(view.container.textContent).toContain("全球中位数与中间 50% 按国家整体计算；选择了行业时只显示所选国家的同行业走势，不画全球参照。"));
      // The notice under the chart (where the record button would be) names the real reason.
      const material = materialCard(view);
      await waitFor(() => expect(material.textContent).toContain("该行业没有 GVC 生产（GVC 增加值为 0），前向 GVC 段长度无法计算（不是缺少数据）"));
      expect(material.textContent).toContain("当前图表暂不能记录：");
      expect(material.textContent).not.toContain("缺少数据（缺少的数据留空");
      expect(within(material).queryByRole("button")).toBeNull();
      // The empty chart says why in its place; the readings summary does not call the gaps missing.
      const chartStatus = view.getAllByRole("status").find((node) => node.textContent?.includes("没有 GVC 生产") && !material.contains(node));
      expect(chartStatus?.textContent).toContain("（不是缺少数据）；请换一个行业或国家。");
      expect(view.container.textContent).not.toContain("该指标没有有效读数");
      expect(view.getByText(/核对当前图表读数 · 0 条/).textContent).toContain("无法计算的读数留空");

      // 定位图 of the same industry: no economy has a point, the cards say why, and no median is named.
      fireEvent.click(view.getByRole("button", { name: "前后向位置" }));
      fireEvent.click(view.getByRole("button", { name: "全球参照" }));
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
      const material = materialCard(view);
      await waitFor(() => expect(material.textContent).toContain("没有 GVC 生产"));
      // The note under the trajectory (there is no trend chart to say it): one sentence for both economies.
      const text = (view.container.textContent ?? "").replace(material.textContent ?? "", "");
      expect(text).toContain("CHN 中国 与 USA 美国在所选年份该行业没有 GVC 生产（GVC 增加值为 0），前向 GVC 段长度无法计算");
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
      fireEvent.click(view.getByRole("button", { name: "前后向位置" }));
      fireEvent.click(view.getByRole("button", { name: "全球参照" }));
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
      const material = materialCard(view);
      await waitFor(() => expect(material.textContent).toContain("USA 美国在所选年份该行业没有 GVC 生产（GVC 增加值为 0），前向 GVC 段长度无法计算；"));
      expect(material.textContent).toContain("CHN 中国 与 USA 美国在所选年份该行业没有后向 GVC 生产（最终品中的 GVC 增加值为 0），后向 GVC 段长度无法计算（不是缺少数据）");
      expect(material.textContent).not.toContain("CHN 中国 与 USA 美国在所选年份该行业没有 GVC 生产");
    } finally { rows.mockRestore(); perCountry.mockRestore(); schema.mockRestore(); }
  });

  test("step 8 段长度对照: more than two reasons read as one count, not six clauses (B09, round 6)", async () => {
    const rows = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year));
    // CHN plays MLT B09 (forward segments only, nothing backward); USA plays LUX B09 (no segment at all).
    const perCountry = spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, country) => ({
      rows: [country === "CHN"
        ? { country, industry: "A", year, PLv_D: 3.2, PLv_RT: 3.5, PLv_GVC: 5.6, PLy_D: null, PLy_RT: null, PLy_GVC: null,
          "1_VA_D": 1, "2_VA_RT": 1, "3_VA_GVC": 1.67, "1_FGY_D": 0, "2_FGY_RT": 0, "3_FGY_GVC": 0 }
        : { country, industry: "A", year, PLv_D: null, PLv_RT: null, PLv_GVC: null, PLy_D: null, PLy_RT: null, PLy_GVC: null,
          "1_VA_D": 0, "2_VA_RT": 0, "3_VA_GVC": 0, "1_FGY_D": 0, "2_FGY_RT": 0, "3_FGY_GVC": 0 }],
      total: 1, page: 1, page_size: 200,
    }));
    const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
    try {
      const view = setup(LengthVizStep);
      await view.findByRole("button", { name: "前后向位置" });
      fireEvent.click(view.getByRole("button", { name: "段长度对照" }));
      fireEvent.change(view.getByLabelText("比较范围"), { target: { value: "A" } });
      const material = materialCard(view);
      await waitFor(() => expect(material.textContent).toContain(
        "当前图表暂不能记录：CHN 中国 与 USA 美国共有 9 个段长度无法计算（这些段没有对应的生产活动，相关增加值为 0，不是缺少数据）；请换一个行业或国家。",
      ));
      expect(material.textContent).not.toContain("后向纯国内段长度无法计算");
      expect(materialChip(view)).toBe(MATERIAL_STATE_LABELS.blocked);
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
      fireEvent.click(view.getByRole("button", { name: "前后向位置" }));
      fireEvent.click(view.getByRole("button", { name: "全球参照" }));
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
      expect(view.getByText("沿用步骤 3 的国家，可以更换。")).toBeTruthy();
      // Another view is not another set of countries.
      fireEvent.click(view.getByRole("button", { name: "定位图" }));
      expect(view.queryByText("沿用步骤 3 的国家，可以更换。")).toBeTruthy();
      fireEvent.change(view.getByLabelText("国家 A"), { target: { value: "CHN" } });
      expect(view.queryByText("沿用步骤 3 的国家，可以更换。")).toBeNull();
      cleanup();
      // The step's own selection (not the carried set) has no line.
      const own = render(<TradeVizStep meta={wide} step={step} state={stateOf({ compared: ["LUX", "USA"], browse_selection: { first: "BRN", second: "", others: [], industry: "", metric: "FVA_share", start: 2019, end: 2021, year: 2021, view: "trend", limit: 10 } }, [], { carriedFrom: 3 })} />);
      expect(own.queryByText(/沿用步骤/)).toBeNull();
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
