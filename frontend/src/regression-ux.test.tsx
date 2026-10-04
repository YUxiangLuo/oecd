import { afterEach, describe, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RegressionRequestError, RegressionRequestLoading,
  RegressionRunLab, scrollRegressionVerdict,
} from "./regression";
import type { RegressionOutcome, Step, StepStateApi } from "./types";

afterEach(cleanup);

const step: Step = {
  n: 11, stage: 4, lab: "reg", regression_outcome: "trade", status: "demo", title: "回归",
  goal: "", tasks: ["一", "二", "三"], concept: "", tip: "", deps: [],
  handoff: { input: "", action: "", output: "" },
};
const state: StepStateApi = {
  data: undefined, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {},
};

describe("simple regression workbench", () => {
  test("shows one action and fixed X/Y, with no example charts, exercises or cross-step summary", () => {
    for (const outcome of ["trade", "production", "length", "network"] as RegressionOutcome[]) {
      const html = renderToStaticMarkup(<RegressionRunLab step={{ ...step, regression_outcome: outcome }} state={state} />);
      const dom = new DOMParser().parseFromString(html, "text/html");
      expect(dom.querySelectorAll(".reg-run-card > button")).toHaveLength(1);
      expect(dom.querySelector(".metric-facts")?.textContent).toContain("解释变量（X）模拟关税暴露强度");
      expect(dom.querySelector(".metric-facts")?.textContent).not.toContain("teaching_tariff_exposure");
      // Before a run there is nothing else on the page: no trend example, optional comparison,
      // interval exercise, four-step summary or method fold.
      expect(dom.querySelectorAll("select, details, table, svg")).toHaveLength(0);
      expect(html).not.toMatch(/五年示例|可选趋势对照|可选小练习|四步结果汇总|计算方法说明/);
    }
    const trade = renderToStaticMarkup(<RegressionRunLab step={step} state={state} />);
    expect(trade).toContain("结果变量（Y）</b>教学模拟：外国增加值项占比");
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
