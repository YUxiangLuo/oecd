import { describe, expect, test } from "bun:test";
import { comparisonExplanation, lessonQuestion, REGRESSION_LESSONS } from "./regression-lessons";

describe("regression lessons", () => {
  test("defines one beginner lesson for every stable outcome", () => {
    expect(Object.keys(REGRESSION_LESSONS)).toEqual(["trade", "production", "length", "network"]);
    expect(REGRESSION_LESSONS.trade.unit).toContain("百分点");
    expect(REGRESSION_LESSONS.length.focus).toContain("链条");
    expect(REGRESSION_LESSONS.network.focus).toContain("网络");
    expect([
      REGRESSION_LESSONS.trade.priorStep,
      REGRESSION_LESSONS.production.priorStep,
      REGRESSION_LESSONS.length.priorStep,
      REGRESSION_LESSONS.network.priorStep,
    ]).toEqual([3, 4, 5, 6]);
  });

  test("research question follows the selected shock and estimand", () => {
    expect(lessonQuestion("network", "tariff", "did")).toContain("处理组");
    expect(lessonQuestion("network", "sanctions", "event_study")).toContain("制裁暴露");
    const fe = lessonQuestion("network", "export_control", "twfe_intensity");
    expect(fe).toContain("出口管制暴露变强");
    expect(fe).not.toContain("处理组");
  });

  test("comparison copy explains the selected method without claiming proof", () => {
    expect(comparisonExplanation("did")).toContain("处理后−处理前");
    expect(comparisonExplanation("event_study")).toContain("冲击前后各年");
    expect(comparisonExplanation("twfe_intensity")).toContain("冲击强度");
  });
});
