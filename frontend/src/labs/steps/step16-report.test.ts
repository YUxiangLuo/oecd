import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReportGateItem } from "../../types";
import {
  ReportGateLoadError,
  reportActionLabel,
  reportGenerationReady,
  submissionActionState,
  submissionToastMessage,
} from "./step16-report";

const blocked: ReportGateItem[] = [{ step: 3, title: "理解检查", missing: ["尚未答题通过"] }];

describe("report generation readiness", () => {
  test("stays closed until initial session restoration finishes", () => {
    expect(reportGenerationReady("loading", [], false, false)).toBe(false);
    expect(reportGenerationReady("unavailable", [], false, false)).toBe(false);
    expect(reportGenerationReady("ready", null, false, false)).toBe(false);
  });

  test("a failed gate check explains the disabled state and offers retry", () => {
    const markup = renderToStaticMarkup(createElement(ReportGateLoadError, {
      error: "请求超时",
      onRetry: () => {},
    }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("请求超时");
    expect(markup).toContain("重试检查");
  });

  test("requires an open server gate and a fully flushed session", () => {
    expect(reportGenerationReady("ready", blocked, false, false)).toBe(false);
    expect(reportGenerationReady("ready", [], true, false)).toBe(false);
    expect(reportGenerationReady("ready", [], false, true)).toBe(false);
    expect(reportGenerationReady("ready", [], false, false)).toBe(true);
  });

  test("reports pending session saves before gate loading", () => {
    expect(reportActionLabel({
      sessionStatus: "ready",
      sessionUnsynced: true,
      sessionSyncing: false,
      gateError: null,
      blocked: null,
      generating: false,
      hasReport: false,
    })).toBe("等待最新记录保存…");
  });

});

describe("report submission feedback", () => {
  test("keeps submission closed until its state is known and while regenerating", () => {
    expect(submissionActionState("none", "loading", false, false)).toEqual({
      disabled: true,
      label: "正在恢复提交状态…",
    });
    expect(submissionActionState("graded", "error", false, false).disabled).toBe(true);
    expect(submissionActionState("graded", "success", false, true)).toEqual({
      disabled: true,
      label: "正在生成新报告…",
    });
    expect(submissionActionState("graded", "success", false, false).disabled).toBe(false);
  });

  test("reports an already graded response without inventing a new queue state", () => {
    expect(submissionToastMessage("graded", "graded"))
      .toBe("报告已评阅");
  });

  test("distinguishes a real revision from the initial submission", () => {
    expect(submissionToastMessage("none", "pending")).toBe("报告已提交，等待教师评阅");
    expect(submissionToastMessage("graded", "pending")).toBe("已重新提交，等待教师重新评阅");
  });
});
