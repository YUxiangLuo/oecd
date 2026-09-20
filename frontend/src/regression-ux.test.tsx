import { afterEach, describe, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_REGRESSION_SETTINGS, RegressionRequestError, RegressionRequestLoading,
  RegressionRunLab, scrollRegressionVerdict, type RegressionHistory,
} from "./regression";
import type { Step, StepStateApi } from "./types";

afterEach(cleanup);

const step: Step = {
  n: 11, stage: 4, lab: "reg", regression_outcome: "trade", status: "demo", title: "回归",
  goal: "", tasks: ["一", "二", "三"], concept: "", tip: "", deps: [],
  handoff: { input: "", action: "", output: "" },
};
const state: StepStateApi = {
  data: undefined, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {},
};
const meta = { years: [2016, 2017, 2018, 2019, 2020], countries: ["CHN", "USA"], sectors: ["C26"] };

describe("simple regression workbench", () => {
  test("shows one action, fixed X/Y/model, and no advanced, placebo, or history UI", () => {
    const html = renderToStaticMarkup(<RegressionRunLab
      step={step} meta={meta} state={state} settings={{ ...DEFAULT_REGRESSION_SETTINGS, method: "did" }}
      onSettingsChange={() => {}} history={{} as RegressionHistory} onHistoryChange={() => {}} />);
    const dom = new DOMParser().parseFromString(html, "text/html");
    expect(dom.querySelectorAll(".reg-run-card > button")).toHaveLength(1);
    expect(dom.querySelector(".metric-facts")?.textContent).toContain("拿来比较的因素（X）模拟关税暴露强度");
    expect(dom.querySelector(".metric-facts")?.textContent).toContain("想观察的结果（Y）教学模拟：外国增加值项占比");
    expect(dom.querySelector(".metric-facts")?.textContent).not.toContain("teaching_tariff_exposure");
    expect(dom.querySelector(".metric-facts")?.textContent).toContain("学生无需选择计算方法");
    expect(dom.querySelector(".technical-details > summary")?.textContent).toBe("计算方法说明（可选）");
    expect(html).not.toMatch(/advanced-settings|实体置换|运行历史|四格数字示例/);
  });

  test("keeps request states accessible", () => {
    expect(renderToStaticMarkup(<RegressionRequestLoading optionsLoading designLoading />)).toContain('role="status"');
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
