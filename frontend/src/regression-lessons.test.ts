import { describe, expect, test } from "bun:test";
import {
  comparisonExplanation,
  familyDirectionLabel,
  lessonQuestion,
  REGRESSION_FAMILIES,
  REGRESSION_LESSONS,
} from "./regression-lessons";

describe("regression lessons", () => {
  test("defines one beginner lesson for every stable outcome", () => {
    expect(Object.keys(REGRESSION_LESSONS)).toEqual(["trade", "production", "length", "network"]);
    expect([
      REGRESSION_LESSONS.trade.priorStep,
      REGRESSION_LESSONS.production.priorStep,
      REGRESSION_LESSONS.length.priorStep,
      REGRESSION_LESSONS.network.priorStep,
    ]).toEqual([2, 3, 4, 5]);
  });

  test("each step teaches one distinct beginner move", () => {
    expect(REGRESSION_FAMILIES.map((item) => item.step)).toEqual([11, 12, 13, 14]);
    // 负向守卫：这些“不要写成”的说法会误导学生，只禁止错误说法、不锁定措辞。
    expect(REGRESSION_LESSONS.trade.dontClaim).not.toContain("客户");
  });

  test("production share copy forbids expansion/contraction overstatement", () => {
    const productionCopy = [
      REGRESSION_LESSONS.production.downMeaning,
      REGRESSION_LESSONS.production.upMeaning,
    ].join(" ");
    expect(productionCopy).toContain("构成占比变化");
    expect(productionCopy).not.toMatch(/与.*(?:扩张|收缩)一致/);
  });

  test("reading starts with inference eligibility and keeps blocked distinct from uncertain", () => {
    expect(REGRESSION_LESSONS.trade.howToRead).toContain("先看结果状态");
    expect(REGRESSION_LESSONS.production.writeDown).toContain("构成变化");
    expect(familyDirectionLabel("suppressed")).not.toBe(familyDirectionLabel("insufficient"));
  });

  test("family summaries distinguish all five evidence states", () => {
    expect(familyDirectionLabel("positive")).toBe("上升");
    expect(familyDirectionLabel("negative")).toBe("下降");
    expect(familyDirectionLabel("suppressed")).toBe("无法评估");
    expect(familyDirectionLabel("insufficient")).toBe("看不出");
    expect(familyDirectionLabel("pretrend")).toBe("冲击前已有差异");
  });

  test("research question stays on the fixed teaching X", () => {
    const network = lessonQuestion("network", "tariff", "did");
    const sanctions = lessonQuestion("network", "sanctions", "event_study");
    const exportControl = lessonQuestion("network", "export_control", "twfe_intensity");
    expect(network).toContain("教学关税暴露 X 增加 1 个百分点");
    expect(sanctions).toBe(network);
    expect(exportControl).toBe(network);
    expect(lessonQuestion("trade", "tariff", "did")).not.toMatch(/cohort|处理组|对照组/);
  });

  test("comparison copy explains the selected method without claiming proof", () => {
    const did = comparisonExplanation("did");
    const eventStudy = comparisonExplanation("event_study");
    const intensity = comparisonExplanation("twfe_intensity");
    expect(did).toContain("处理后−处理前");
    expect(new Set([did, eventStudy, intensity]).size).toBe(3);
  });
});
