import { describe, expect, test } from "bun:test";
import type { ReportGateItem } from "../../types";
import {
  reportGateDetail,
  reportGenerationReady,
  splitStudentReport,
  submissionToastMessage,
} from "./step16-report";

const blocked: ReportGateItem[] = [{ step: 3, title: "理解检查", missing: ["尚未答题通过"] }];
const gateItem = (missing: string[], step = 3): ReportGateItem => ({
  step,
  title: "出口价值来源分解（WWZ）",
  missing,
});

describe("report generation readiness", () => {
  test("stays closed until initial session restoration finishes", () => {
    expect(reportGenerationReady("loading", [], false, false)).toBe(false);
    expect(reportGenerationReady("unavailable", [], false, false)).toBe(false);
    expect(reportGenerationReady("ready", null, false, false)).toBe(false);
  });

  test("requires an open server gate and a fully flushed session", () => {
    expect(reportGenerationReady("ready", blocked, false, false)).toBe(false);
    expect(reportGenerationReady("ready", [], true, false)).toBe(false);
    expect(reportGenerationReady("ready", [], false, true)).toBe(false);
    expect(reportGenerationReady("ready", [], false, false)).toBe(true);
  });
});

describe("report submission feedback", () => {
  test("does not claim a duplicate graded report is awaiting review", () => {
    expect(submissionToastMessage("graded", "graded"))
      .toBe("报告内容未变化，原评分已保留");
  });

  test("distinguishes a real revision from the initial submission", () => {
    expect(submissionToastMessage("none", "pending")).toBe("报告已提交，等待教师评阅");
    expect(submissionToastMessage("graded", "pending")).toBe("已重新提交，等待教师重新评阅");
  });
});

describe("student report copy", () => {
  test("does not repeat the routine quiz instruction for every blocked step", () => {
    expect(reportGateDetail(gateItem(["请完成本步理解检查并答对全部选择题"]))).toBe("");
    expect(reportGateDetail(gateItem(["本步理解检查尚未全部答对"]))).toBe("");
    expect(reportGateDetail(gateItem(["理解检查答案已变化或完成凭证无效，请重新提交"])))
      .toBe("理解检查答案已变化或完成凭证无效，请重新提交");
  });

  test("keeps a data-version gate reason visible", () => {
    expect(reportGateDetail(gateItem(["当前实验记录对应的是旧数据版本"], 0)))
      .toBe("当前实验记录对应的是旧数据版本");
  });

  test("separates machine provenance for a collapsed student-only detail", () => {
    const report = "# 报告\n\n## 6. 结论与限制\n\n正文\n\n## 7. 技术溯源（供核验）\n\n| 项 | 值 |\n|---|---|";
    expect(splitStudentReport(report)).toEqual({
      main: "# 报告\n\n## 6. 结论与限制\n\n正文",
      technical: "| 项 | 值 |\n|---|---|",
    });
  });

  test("also collapses provenance in persisted reports from the previous format", () => {
    const report = "# 旧报告\n\n## 6. 溯源与状态\n\nmanifest_id\n\n## 7. 结论与限制\n\n限制正文";
    expect(splitStudentReport(report)).toEqual({
      main: "# 旧报告\n\n## 7. 结论与限制\n\n限制正文",
      technical: "manifest_id",
    });
  });
});
