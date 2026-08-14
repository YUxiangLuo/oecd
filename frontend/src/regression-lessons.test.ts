import { describe, expect, test } from "bun:test";
import {
  comparisonExplanation,
  familyDirectionLabel,
  lessonQuestion,
  nextRegressionFamily,
  REGRESSION_FAMILIES,
  REGRESSION_LESSONS,
  reportTakeaway,
} from "./regression-lessons";

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

  test("each step teaches one distinct beginner move", () => {
    expect(REGRESSION_FAMILIES.map((item) => item.step)).toEqual([12, 13, 14, 15]);
    expect(REGRESSION_LESSONS.trade.learnThis).toContain("处理组相对对照组");
    expect(REGRESSION_LESSONS.production.learnThis).toContain("比较方式");
    expect(REGRESSION_LESSONS.length.learnThis).toContain("不是百分点");
    expect(REGRESSION_LESSONS.network.learnThis).toContain("拓扑");
    expect(REGRESSION_LESSONS.trade.dontClaim).not.toContain("客户");
    expect(nextRegressionFamily("trade")?.outcome).toBe("production");
    expect(nextRegressionFamily("network")).toBeNull();
  });

  test("report takeaway is a copyable sentence without causal proof", () => {
    expect(reportTakeaway("trade", "negative", "−1.20 个百分点")).toContain("相对下降");
    expect(reportTakeaway("length", "insufficient", "—")).toContain("看不出方向");
    expect(reportTakeaway("network", "suppressed", "—")).toContain("不要把点估计当成方向");
    expect(reportTakeaway("production", "positive", "+0.40 个百分点")).not.toContain("证明");
    expect(familyDirectionLabel("insufficient")).toBe("看不出");
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
