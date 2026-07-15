import { describe, expect, test } from "bun:test";
import { comparisonExplanation, lessonQuestion, REGRESSION_LESSONS } from "./regression-lessons";

describe("regression lessons", () => {
  test("defines one beginner lesson for every stable outcome", () => {
    expect(Object.keys(REGRESSION_LESSONS)).toEqual(["trade", "production", "length", "network"]);
    expect(REGRESSION_LESSONS.trade.unit).toContain("百分点");
    expect(REGRESSION_LESSONS.length.focus).toContain("事件研究");
    expect(REGRESSION_LESSONS.network.focus).toContain("安慰剂");
  });

  test("research question follows the selected shock and estimand", () => {
    expect(lessonQuestion("network", "关税冲击", "双重差分 (DID)")).toContain("处理组");
    expect(lessonQuestion("network", "制裁清单", "事件研究")).toContain("制裁暴露");
    const fe = lessonQuestion("network", "出口管制", "双向固定效应");
    expect(fe).toContain("出口管制暴露强度增加");
    expect(fe).not.toContain("处理组");
  });

  test("comparison copy explains the selected method without claiming proof", () => {
    expect(comparisonExplanation("双重差分 (DID)")).toContain("处理后−处理前");
    expect(comparisonExplanation("事件研究")).toContain("逐期比较");
    expect(comparisonExplanation("双向固定效应")).toContain("连续冲击强度");
  });
});
