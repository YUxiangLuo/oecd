import { describe, expect, test } from "bun:test";
import type { ReportGateItem } from "../../types";
import { reportGenerationReady, submissionToastMessage } from "./step16-report";

const blocked: ReportGateItem[] = [{ step: 3, title: "理解检查", missing: ["尚未答题通过"] }];

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
  test("reports an already graded response without inventing a new queue state", () => {
    expect(submissionToastMessage("graded", "graded"))
      .toBe("报告已评阅");
  });

  test("distinguishes a real revision from the initial submission", () => {
    expect(submissionToastMessage("none", "pending")).toBe("报告已提交，等待教师评阅");
    expect(submissionToastMessage("graded", "pending")).toBe("已重新提交，等待教师重新评阅");
  });
});
