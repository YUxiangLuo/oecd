import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "./api";
import {
  exampleEffect, RegressionRequestError, RegressionRequestLoading,
  RegressionRunLab, scrollRegressionVerdict,
} from "./regression";
import type { RegressionDesignInfo, RegressionOutcome, Step, StepStateApi, TeachingGroupsResponse, TeachingPanelResponse } from "./types";

afterEach(() => { cleanup(); mock.restore(); });

const step: Step = {
  n: 11, stage: 4, lab: "reg", regression_outcome: "trade", status: "demo", title: "回归",
  goal: "", tasks: ["一", "二", "三"], concept: "", tip: "", deps: [],
  handoff: { input: "", action: "", output: "" },
};
const state: StepStateApi = {
  data: undefined, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {},
};
const meta = { countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
const series = (taxed: number) => [2016, 2017, 2018, 2019, 2020].map((year, index) => ({ year, change: index < 2 ? 0 : taxed }));
const groups: TeachingGroupsResponse = {
  version: "v", years: [2016, 2017, 2018, 2019, 2020], policy_year: 2018,
  sample: { rows: 16220, entities: 3244, countries: 76, industries: 44, taxed_countries: 44, untaxed_countries: 32 },
  outcomes: {
    trade: { taxed: series(-0.004), untaxed: series(0.003) },
    production: { taxed: series(-0.003), untaxed: series(0.002) },
    length: { taxed: series(-0.01), untaxed: series(0.01) },
    network: { taxed: series(-40), untaxed: series(30) },
  },
};

describe("simple regression workbench", () => {
  test("before data arrives: one action and fixed X/Y, with no exercises, comparisons or cross-step summary", () => {
    for (const outcome of ["trade", "production", "length", "network"] as RegressionOutcome[]) {
      const html = renderToStaticMarkup(<RegressionRunLab step={{ ...step, regression_outcome: outcome }} meta={meta} state={state} />);
      const dom = new DOMParser().parseFromString(html, "text/html");
      expect(dom.querySelectorAll(".reg-run-card > button")).toHaveLength(1);
      expect(dom.querySelector(".metric-facts")?.textContent).toContain("解释变量（X）模拟关税暴露强度");
      expect(dom.querySelector(".metric-facts")?.textContent).not.toContain("teaching_tariff_exposure");
      expect(dom.querySelector(".reg-step-focus")?.textContent).toMatch(/^本步重点(读数|读区间|读单位|比单位)：/);
      expect(html.includes("方法与步骤 11 相同")).toBe(outcome !== "trade");
      expect(dom.querySelectorAll("select, details, table")).toHaveLength(0);
      expect(html).not.toMatch(/五年示例|可选趋势对照|可选小练习|四步结果汇总|计算方法说明|先用眼睛看/);
    }
  });

  test("shows the taxed vs untaxed comparison before the run and names the full sample on the button", async () => {
    spyOn(api, "regressionDesign").mockResolvedValue({} as RegressionDesignInfo);
    spyOn(api, "teachingGroups").mockResolvedValue(groups);
    spyOn(api, "teachingSeries").mockResolvedValue({ version: "v", disclaimer: "", rows: [], total: 0, years: [] } as TeachingPanelResponse);
    render(<RegressionRunLab step={step} meta={meta} state={state} />);
    const figure = await screen.findByRole("img", { name: /加税前后：两组外国增加值项占比的平均变化/ });
    expect(figure.getAttribute("aria-label")).toContain("2018 年起模拟加税");
    expect(figure.textContent).toContain("加税国家组");
    expect(figure.textContent).toContain("未加税国家组");
    await waitFor(() => expect(screen.getByRole("button", { name: "用全部 16,220 条记录估计这个差距" })).toBeTruthy());
    expect(api.teachingSeries).toHaveBeenCalledWith(["CAN", "MEX"], "C29");
  });

  test("converts the estimate to the example's X in each step's own units", () => {
    expect(exampleEffect("trade", -0.55, 0.0932)).toBe("5.13 个百分点");
    expect(exampleEffect("length", -1.8, 0.0932)).toBe("0.168 个长度单位");
    expect(exampleEffect("network", -6000, 0.0932)).toBe("559.2 个中心性原始单位");
  });

  test("keeps request states accessible", () => {
    expect(renderToStaticMarkup(<RegressionRequestLoading designLoading />)).toContain('role="status"');
    expect(renderToStaticMarkup(<RegressionRequestError label="回归选项" error="Failed to fetch" onRetry={() => {}} />)).toContain('role="alert"');
  });

  test("scrolls only nested course content", () => {
    const calls: ScrollToOptions[] = [];
    const scroller = { scrollTop: 10, getBoundingClientRect: () => ({ top: 20 }), scrollTo: (x: ScrollToOptions) => calls.push(x) };
    const target = { closest: () => scroller, getBoundingClientRect: () => ({ top: 50 }) } as unknown as HTMLElement;
    scrollRegressionVerdict(target, "smooth");
    expect(calls).toEqual([{ top: 40, left: 0, behavior: "smooth" }]);
  });
});
