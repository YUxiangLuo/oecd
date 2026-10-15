import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { api } from "../../../api";
import type { IndicatorSchema, Meta, Step, StepStateApi } from "../../../types";
import { IndicatorLab } from "../indicator-lab";
import { AutoMaterialStatus, indicatorMaterialLabel } from "./auto-comparison";
import { COUNTRY_METRIC, indicatorMaterialPatch, type IndicatorGroupKey, type IndicatorStepState } from "./indicator-table";

const meta = {
  countries: ["CHN", "DEU"], years: [2019, 2020], sectors: ["C26"],
  dataset: { release_id: "a".repeat(32) },
} as Meta;
const schema: IndicatorSchema = {
  groups: [{ key: "network", label: "生产网络", fields: ["weighted degree", "betweenesscentrality"] }],
  fields: {
    FVA_share: { label: "外国增加值项占比", format: "pct", desc: "" },
    "3b_VA_GVC_C_share": { label: "复杂 GVC 占比", format: "pct", desc: "" },
    GVCPs: { label: "GVC 位置指数", format: "number", desc: "" },
    "weighted degree": { label: "加权总度", format: "amount", desc: "" },
    betweenesscentrality: { label: "介数", format: "count", desc: "" },
  },
};
const cases = [[2, "trade"], [3, "production"], [4, "length"], [5, "network"]] as const;
function row(country = "CHN", year = 2020) {
  return {
    country, industry: "C26", year, gross_exports: 100, FVA: 20, FVA_share: country === "DEU" ? 0.3 : 0.2,
    DVAex: 50, DVArt: 10, DDC: 5, FDC: 10, taxsub: 5, SVA: 100,
    "1_VA_D": 50, "2_VA_RT": 25, "3a_VA_GVC_S": 10, "3b_VA_GVC_C": 15, "3_VA_GVC": 25,
    "3b_VA_GVC_C_share": country === "DEU" ? 0.25 : 0.15,
    PLv: 2, PLv_D: 2, PLv_RT: 2, PLv_GVC: 2, PLy_GVC: 2, GVCPs: country === "DEU" ? 1.2 : 1,
    "weighted degree": country === "DEU" ? 400 : 300, betweenesscentrality: 2,
  };
}
const countryRows = (year: number) => meta.countries.map((country) => ({ ...row(country, year), industry: "" }));
const page = (year: number, country: string) => ({ rows: [row(country || "CHN", year)], total: 1, page: 1, page_size: 200 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockData() {
  const countries = spyOn(api, "countryIndicators").mockImplementation(async (year) => countryRows(year) as never);
  const country = spyOn(api, "countryIndicatorsForCountry").mockImplementation(async (year, code) => [row(code, year)] as never);
  const allIndustries = spyOn(api, "industryIndicatorsAll").mockImplementation(async (year, code) => page(year, code));
  const industries = spyOn(api, "industryIndicators").mockImplementation(async (year, code) => page(year, code));
  return { countries, industries, restore: () => [countries, country, allIndustries, industries].forEach((mock) => mock.mockRestore()) };
}

function renderStep(n: number, topic: IndicatorGroupKey, initial?: IndicatorStepState, materialLocked = false) {
  const materialSaves: Partial<IndicatorStepState>[] = [];
  let saved = initial;
  function Harness() {
    const [data, setData] = useState(initial);
    saved = data;
    const state: StepStateApi<IndicatorStepState> = {
      data, complete: false, syncing: false, syncError: null, syncNow: () => {}, materialLocked,
      save: (patch) => {
        if (patch.observations) materialSaves.push(patch);
        setData((previous) => ({ ...previous, ...patch }));
      },
    };
    return <IndicatorLab meta={meta} step={{ n, topic } as Step} state={state} />;
  }
  return { ...render(<Harness />), materialSaves, saved: () => saved };
}

function oldMaterial(topic: IndicatorGroupKey) {
  const metric = COUNTRY_METRIC[topic];
  const unit = schema.fields[metric].format === "pct" ? "%" : topic === "network" ? "百万美元" : "无量纲";
  const patch = indicatorMaterialPatch(countryRows(2020), "CHN", 2020, metric, unit, meta.dataset!.release_id!)!;
  return { ...patch, material_label: indicatorMaterialLabel(patch.observations!, schema) };
}

afterEach(cleanup);

describe("steps 2–5 recover missing indicator metadata", () => {
  for (const [n, topic] of cases) {
    test(`step ${n} reports metadata failure, retries it alone and records the latest country/year`, async () => {
      const nextSchema = deferred<IndicatorSchema>();
      const metadata = spyOn(api, "indicatorSchema").mockRejectedValueOnce(new Error("Failed to fetch"))
        .mockImplementation(() => nextSchema.promise);
      const data = mockData();
      try {
        const view = renderStep(n, topic);
        await waitFor(() => expect(view.getByRole("alert").textContent).toContain("指标说明加载失败"));
        expect(view.getByRole("alert").textContent).toContain("网络连接中断");
        expect(view.container.querySelector(".material-card")?.textContent).toContain("当前选择尚未记录");
        expect(view.materialSaves).toHaveLength(0);
        if (n === 5) expect(view.container.querySelector(".indicator-data-table")).toBeNull();

        fireEvent.click(view.getByRole("button", { name: "重试" }));
        await waitFor(() => expect(metadata).toHaveBeenCalledTimes(2));
        expect(view.queryByRole("alert")).toBeNull();
        expect(view.container.querySelector(".material-card")?.textContent).toContain("正在加载当前选择的报告材料");
        // The country request already succeeded; schema retry must not restart it.
        expect(data.countries).toHaveBeenCalledTimes(1);
        fireEvent.change(view.getByLabelText("国家", { exact: true }), { target: { value: "DEU" } });
        fireEvent.change(view.getByLabelText("年份", { exact: true }), { target: { value: "2019" } });
        await waitFor(() => expect(data.countries).toHaveBeenCalledTimes(2));
        expect(view.materialSaves).toHaveLength(0);
        const tableCalls = data.industries.mock.calls.length;
        if (n === 5) expect(view.container.querySelector(".indicator-data-table")).toBeNull();

        await act(async () => nextSchema.resolve(schema));
        await waitFor(() => expect(view.materialSaves).toHaveLength(1));
        const observation = view.materialSaves[0].observations![0];
        expect(observation).toMatchObject({ country: "DEU", year: 2019, metric: COUNTRY_METRIC[topic] });
        expect(observation.value).toBe({ trade: 0.3, production: 0.25, length: 1.2, network: 400 }[topic]);
        expect(view.container.querySelector(".material-card-summary")?.textContent).toContain("2019 年");
        expect(view.container.querySelector(".material-card-summary")?.textContent).toContain("DEU 德国");
        expect(view.queryByRole("alert")).toBeNull();
        expect(data.countries).toHaveBeenCalledTimes(2);
        if (n === 5) {
          expect(view.container.querySelectorAll(".indicator-data-table th[scope=col]")).toHaveLength(5);
          expect(data.industries).toHaveBeenCalledTimes(tableCalls);
        }
      } finally {
        cleanup();
        metadata.mockRestore();
        data.restore();
      }
    });

    test(`step ${n} keeps submitted material visible and unchanged throughout failure and recovery`, async () => {
      const nextSchema = deferred<IndicatorSchema>();
      const metadata = spyOn(api, "indicatorSchema").mockRejectedValueOnce(new Error("request failed: 503"))
        .mockImplementation(() => nextSchema.promise);
      const data = mockData();
      const initial = oldMaterial(topic);
      const original = structuredClone(initial);
      try {
        const view = renderStep(n, topic, initial, true);
        await waitFor(() => expect(view.getByRole("alert").textContent).toContain("指标说明加载失败"));
        expect(view.container.querySelector(".material-card-summary")?.textContent).toBe(initial.material_label);
        fireEvent.click(view.getByRole("button", { name: "重试" }));
        fireEvent.change(view.getByLabelText("国家", { exact: true }), { target: { value: "DEU" } });
        fireEvent.change(view.getByLabelText("年份", { exact: true }), { target: { value: "2019" } });
        expect(view.container.querySelector(".material-card-summary")?.textContent).toBe(initial.material_label);
        expect(view.container.querySelector(".material-card-extra")?.textContent).toContain("此处保留已记录材料");
        await act(async () => nextSchema.resolve(schema));
        await waitFor(() => expect(view.getByRole("button", { name: /改用当前选择作为报告材料/ })).toBeTruthy());
        expect(view.materialSaves).toHaveLength(0);
        expect(view.saved()?.observations).toEqual(original.observations);
        expect(view.saved()?.material_label).toBe(original.material_label);
        expect(view.container.querySelector(".material-card-summary")?.textContent).toBe(initial.material_label);
        expect(initial).toEqual(original);
      } finally {
        cleanup();
        metadata.mockRestore();
        data.restore();
      }
    });
  }

  test("an unsubmitted saved reading survives metadata failure until the current selection is ready", async () => {
    const nextSchema = deferred<IndicatorSchema>();
    const metadata = spyOn(api, "indicatorSchema").mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockImplementation(() => nextSchema.promise);
    const data = mockData();
    const initial = oldMaterial("trade");
    try {
      const view = renderStep(2, "trade", initial);
      await waitFor(() => expect(view.getByRole("alert").textContent).toContain("指标说明加载失败"));
      fireEvent.change(view.getByLabelText("国家", { exact: true }), { target: { value: "DEU" } });
      expect(view.container.querySelector(".material-card-summary")?.textContent).toBe(initial.material_label);
      expect(view.container.querySelector(".material-card-extra")?.textContent).toContain("当前选择的数据加载失败；此处保留已记录材料");
      expect(view.saved()?.observations).toEqual(initial.observations);
      fireEvent.click(view.getByRole("button", { name: "重试" }));
      expect(view.materialSaves).toHaveLength(0);
      await act(async () => nextSchema.resolve(schema));
      await waitFor(() => expect(view.materialSaves).toHaveLength(1));
      expect(view.materialSaves[0].observations![0].country).toBe("DEU");
      expect(view.container.querySelector(".material-card-summary")?.textContent).toContain("DEU 德国 30.000%");
    } finally {
      cleanup();
      metadata.mockRestore();
      data.restore();
    }
  });

  test("simultaneous metadata and country failures retry both, then only the remaining failure", async () => {
    const metadata = spyOn(api, "indicatorSchema").mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValue(schema);
    const data = mockData();
    data.countries.mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockRejectedValueOnce(new Error("request failed: 503"));
    try {
      const view = renderStep(2, "trade");
      await waitFor(() => {
        expect(view.getByRole("alert").textContent).toContain("指标说明加载失败");
        expect(view.getByRole("alert").textContent).toContain("国家整体数据加载失败");
      });
      expect(view.materialSaves).toHaveLength(0);
      fireEvent.click(view.getByRole("button", { name: "重试" }));
      await waitFor(() => expect(view.getByRole("alert").textContent).toContain("国家整体数据加载失败"));
      expect(view.getByRole("alert").textContent).not.toContain("指标说明加载失败");
      expect(metadata).toHaveBeenCalledTimes(2);
      expect(data.countries).toHaveBeenCalledTimes(2);
      fireEvent.click(view.getByRole("button", { name: "重试" }));
      await waitFor(() => expect(view.materialSaves).toHaveLength(1));
      expect(metadata).toHaveBeenCalledTimes(2);
      expect(data.countries).toHaveBeenCalledTimes(3);
      expect(view.queryByRole("alert")).toBeNull();
    } finally {
      cleanup();
      metadata.mockRestore();
      data.restore();
    }
  });
});

test.each([
  ["trade", "CHN 中国 20.000%"],
  ["length", "CHN 中国 1"],
  ["network", "CHN 中国 300 百万美元"],
] as const)("legacy %s material without a saved label retains its unit while metadata is unavailable", (topic, expected) => {
  const initial = oldMaterial(topic);
  delete (initial as Partial<typeof initial>).material_label;
  const observations = structuredClone(initial.observations);
  const view = render(<AutoMaterialStatus state={{
    data: initial, complete: false, syncing: false, syncError: null, syncNow: () => {}, save: () => {}, materialLocked: true,
  }} schema={null} current={false} loadFailed={true} loadError="指标说明加载失败" onRetryLoad={() => {}} where="上方所选国家" />);
  expect(view.container.querySelector(".material-card-summary")?.textContent).toContain(expected);
  expect(initial.observations).toEqual(observations);
  expect(view.getByRole("alert").textContent).toContain("指标说明加载失败");
});
