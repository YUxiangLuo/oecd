import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IndicatorSchema, Meta, Step, StepStateApi } from "../../../types";
import type { VizStepState } from "./scaffold";
import { finiteIndustryLengthRows, gvcPositionRankRows, LENGTH_AXIS_FALLBACK, lengthAxisDefinitions, lengthIndustryRequestKey, restoreLengthDrill, Step10Length } from "./step10";

describe("step 9 production-length operational definitions", () => {
  test("fallback states the average-stage unit and rejects border/country counts", () => {
    for (const definition of Object.values(LENGTH_AXIS_FALLBACK)) {
      expect(definition).toContain("累计总产出");
      expect(definition).toContain("关联增加值");
      expect(definition).toContain("增加值加权平均生产阶段数");
      expect(definition).toContain("不是跨境次数、经过国家数或网络边数");
      expect(definition).not.toContain("跨境环节");
    }
  });

  test("restores only an explicit valid drill country and keys it to release/year/country", () => {
    const countries = ["USA", "CHN", "DEU"];
    expect(restoreLengthDrill(countries, { drill: "DEU" })).toBe("DEU");
    expect(restoreLengthDrill(countries, { drill: "OLD", compared: ["USA"] })).toBe("USA");
    expect(restoreLengthDrill(["USA"], { drill: "OLD" })).toBe("USA");
    const meta = { dataset: { years: [2020], release_id: "a".repeat(32) } };
    expect(lengthIndustryRequestKey(meta, 2020, "DEU")).toBe(`${"a".repeat(32)}:2020:country-industry:DEU`);
    expect(lengthIndustryRequestKey(meta, 2020, "")).toBeNull();
  });

  test("industry drill admits only rows with finite forward and backward GVC length", () => {
    const rows = finiteIndustryLengthRows({ total: 4, page: 1, page_size: 200, rows: [
      { country: "CHN", industry: "A", PLv_GVC: 2, PLy_GVC: 3 },
      { country: "CHN", industry: "B", PLv_GVC: null, PLy_GVC: 3 },
      { country: "CHN", industry: "C", PLv_GVC: 2, PLy_GVC: null },
      { country: "CHN", industry: "D", PLv_GVC: Number.POSITIVE_INFINITY, PLy_GVC: 3 },
    ] });
    expect(rows.map((row) => row.industry)).toEqual(["A"]);
  });

  test("GVCPs ranking appends a selected country outside Top 20 once", () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      country: `C${String(index).padStart(2, "0")}`,
      GVCPs: 30 - index,
    }));
    expect(gvcPositionRankRows([...rows, { ...rows[20] }], ["C20", "C20"]).map((row) => row.country))
      .toEqual(rows.map((row) => row.country));
  });

  test("industry lens renders a native explicit-country control and current-key loading state", () => {
    const meta: Meta = {
      years: [2019, 2020], countries: ["CHN", "USA"], sectors: [],
      dataset: { years: [2019, 2020], release_id: "b".repeat(32) },
    };
    const step: Step = {
      n: 9, stage: 3, lab: "viz", topic: "length", status: "done", title: "长度",
      goal: "", concept: "长度定义", tip: "", deps: [],
    };
    const state: StepStateApi<VizStepState> = {
      data: { chart: "industry", year: 2019, drill: "USA", compared: [] },
      save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {},
    };
    const html = renderToStaticMarkup(createElement(Step10Length, { meta, step, state }));
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("行业下钻");
    expect(html).toContain("<label");
    expect(html).toContain("下钻国家");
    expect(html).toContain('<option value="USA" selected="">USA 美国</option>');
    expect(html).toContain("加载 2019 年 USA 美国 行业长度指标中…");
    expect(html).toContain("不是跨境次数、经过国家数或网络边数");
  });

  test("uses the operational descriptions supplied by indicator schema metadata", () => {
    const schema: IndicatorSchema = {
      groups: [],
      fields: {
        PLv_GVC: { label: "前向", format: "number", desc: "schema-forward-operational-definition" },
        PLy_GVC: { label: "后向", format: "number", desc: "schema-backward-operational-definition" },
      },
    };
    expect(lengthAxisDefinitions(schema)).toEqual({
      forward: "schema-forward-operational-definition",
      backward: "schema-backward-operational-definition",
    });
  });
});
