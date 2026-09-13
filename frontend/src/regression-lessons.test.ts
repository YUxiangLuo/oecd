import { describe, expect, test } from "bun:test";
import {
  comparisonExplanation,
  familyDirectionLabel,
  lessonQuestion,
  nextRegressionFamily,
  REGRESSION_FAMILIES,
  REGRESSION_LESSONS,
} from "./regression-lessons";

describe("regression lessons", () => {
  test("defines one beginner lesson for every stable outcome", () => {
    expect(Object.keys(REGRESSION_LESSONS)).toEqual(["trade", "production", "length", "network"]);
    expect(REGRESSION_LESSONS.trade.unit).toContain("百分点");
    expect(REGRESSION_LESSONS.length.focus).toContain("链条");
    expect(REGRESSION_LESSONS.network.focus).toContain("全正边二值");
    expect([
      REGRESSION_LESSONS.trade.priorStep,
      REGRESSION_LESSONS.production.priorStep,
      REGRESSION_LESSONS.length.priorStep,
      REGRESSION_LESSONS.network.priorStep,
    ]).toEqual([2, 3, 4, 5]);
  });

  test("each step teaches one distinct beginner move", () => {
    expect(REGRESSION_FAMILIES.map((item) => item.step)).toEqual([11, 12, 13, 14]);
    expect(REGRESSION_LESSONS.trade.learnThis).toContain("逐批次");
    expect(REGRESSION_LESSONS.trade.learnThis).toContain("从未处理或截至比较期尚未处理");
    expect(REGRESSION_LESSONS.production.learnThis).toContain("比较方式");
    expect(REGRESSION_LESSONS.length.learnThis).toContain("不是百分点");
    expect(REGRESSION_LESSONS.network.learnThis).toContain("拓扑");
    expect(REGRESSION_LESSONS.trade.dontClaim).not.toContain("客户");
    expect(nextRegressionFamily("trade")?.outcome).toBe("production");
    expect(nextRegressionFamily("network")).toBeNull();
  });

  test("production share copy forbids expansion/contraction overstatement", () => {
    const productionCopy = [
      REGRESSION_LESSONS.production.downMeaning,
      REGRESSION_LESSONS.production.upMeaning,
    ].join(" ");
    expect(productionCopy).toContain("SVA 中复杂 GVC 增加值份额降低");
    expect(productionCopy).toContain("SVA 中复杂 GVC 增加值份额提高");
    expect(productionCopy).toContain("这是构成占比变化，不能单凭该比例判断生产规模扩张/收缩");
    expect(productionCopy).not.toMatch(/与.*(?:扩张|收缩)一致/);
  });

  test("reading starts with inference eligibility and keeps blocked distinct from uncertain", () => {
    expect(REGRESSION_LESSONS.trade.howToRead).toContain("先看结果状态");
    expect(REGRESSION_LESSONS.trade.howToRead).toContain("区间跨 0 是「看不出方向」");
    expect(REGRESSION_LESSONS.trade.howToRead).toContain("停止推断则记「无法评估」");
    expect(REGRESSION_LESSONS.production.writeDown).toContain("不能把构成变化解释为产量变化");
    expect(REGRESSION_LESSONS.production.guidedExperiment).toContain("冲击 × 基期GVC");
    expect(familyDirectionLabel("suppressed")).not.toBe(familyDirectionLabel("insufficient"));
  });

  test("cohort-weight exploration requires running the supported ATT method", () => {
    const hint = REGRESSION_LESSONS.trade.guidedExperiment;
    expect(hint).toContain("使用“分批处理 cohort-time ATT”并运行后");
    expect(hint).toContain("可用的批次权重");
    expect(hint).toContain("不能自动证明对照可比");
    expect(hint).toContain("投入链外溢");
  });

  test("entity-permutation exploration names its method prerequisite and scientific limits", () => {
    const hint = REGRESSION_LESSONS.network.guidedExperiment;
    expect(hint).toContain("使用“分批处理 cohort-time ATT”并运行后");
    expect(hint).toContain("运行实体置换");
    expect(hint).toContain("不是 p 值");
    expect(hint).toContain("不能恢复因果识别");
  });

  test("family summaries distinguish all five evidence states", () => {
    expect(familyDirectionLabel("positive")).toBe("上升");
    expect(familyDirectionLabel("negative")).toBe("下降");
    expect(familyDirectionLabel("suppressed")).toBe("无法评估");
    expect(familyDirectionLabel("insufficient")).toBe("看不出");
    expect(familyDirectionLabel("pretrend")).toBe("冲击前已有差异");
  });

  test("research question follows the selected shock and estimand", () => {
    expect(lessonQuestion("network", "tariff", "did")).toContain("从未或尚未受冲击的对象");
    expect(lessonQuestion("trade", "tariff", "did")).not.toMatch(/cohort|课程 FVA|EXGR_FVASH/);
    expect(lessonQuestion("network", "sanctions", "event_study")).toContain("制裁暴露");
    const fe = lessonQuestion("network", "export_control", "twfe_intensity");
    expect(fe).toContain("出口管制暴露变强");
    expect(fe).not.toContain("处理组");
  });

  test("comparison copy explains the selected method without claiming proof", () => {
    expect(comparisonExplanation("did")).toContain("处理后−处理前");
    expect(comparisonExplanation("event_study")).toContain("逐事件时间");
    expect(comparisonExplanation("twfe_intensity")).toContain("冲击强度");
  });
});
