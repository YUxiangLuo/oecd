import { describe, expect, test } from "bun:test";
import {
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

  test("reading starts with inference eligibility and keeps blocked distinct from uncertain", () => {
    expect(familyDirectionLabel("suppressed")).not.toBe(familyDirectionLabel("insufficient"));
  });

  test("family summaries distinguish the published evidence states", () => {
    expect(familyDirectionLabel("positive")).toBe("方向明确：X 越高，Y 越高");
    expect(familyDirectionLabel("negative")).toBe("方向明确：X 越高，Y 越低");
    expect(familyDirectionLabel("suppressed")).toBe("方向不确定（不显示区间）");
    expect(familyDirectionLabel("insufficient")).toBe("方向不确定");
  });

  test("research question stays on the fixed teaching X", () => {
    const network = lessonQuestion("network");
    expect(network).toContain("关税暴露（X）持续高 1 个百分点时，从第二年起");
    expect(network).not.toContain("模拟");
    expect(lessonQuestion("trade")).not.toMatch(/cohort|处理组|对照组/);
  });
});
