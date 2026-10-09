import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QcCheck } from "../../types";
import { QcChecksTable, qcResultLabel } from "./qc-checks-table";

const check = (passed: boolean, severity: QcCheck["severity"]): QcCheck => ({
  name: "test",
  kind: "数值",
  passed,
  detail: "",
  warnings: [],
  severity,
});

describe("QC result labels", () => {
  test("does not render a warning as fatal", () => {
    expect(qcResultLabel(check(false, "warning")).text).toBe("⚠ 提醒");
    expect(qcResultLabel(check(false, "fatal")).text).toBe("✗ Fatal");
  });

  test("keeps passed disclosures visible", () => {
    expect(qcResultLabel(check(true, "disclosure")).text).toBe("✓ 通过·需披露");
    expect(qcResultLabel(check(true, "ok")).text).toBe("✓ 通过");
  });

  test("renders an explicit fail-closed terminal row for empty results", () => {
    const html = renderToStaticMarkup(createElement(QcChecksTable, {
      rows: [],
      label: "OECD ICIO 数据质检结果表，可横向滚动",
      emptyState: "invalid",
      emptyMessage: "核心质检不完整",
    }));
    expect(html).toContain("核心质检不完整");
    expect(html).toContain("colSpan=\"4\"");
    expect(html).toContain("qc-fail");
  });

  test("offers an explicit contextual retry only for a recoverable request error", () => {
    const retryable = renderToStaticMarkup(createElement(QcChecksTable, {
      rows: [],
      label: "OECD ICIO 数据质检结果表，可横向滚动",
      emptyState: "invalid",
      emptyMessage: "质检读取失败：网络连接中断，请检查连接后重试。",
      onRetry: () => {},
      retryLabel: "重试 2018 年质检",
    }));
    expect(retryable).toContain("重试 2018 年质检");
    expect(retryable).toContain('type="button"');

    const nonRetryable = renderToStaticMarkup(createElement(QcChecksTable, {
      rows: [],
      label: "OECD ICIO 数据质检结果表，可横向滚动",
      emptyState: "invalid",
      emptyMessage: "核心质检不完整",
    }));
    expect(nonRetryable).not.toContain("重试质检");
  });

  test("uses the caller's contextual accessible region label", () => {
    const html = renderToStaticMarkup(createElement(QcChecksTable, {
      rows: [check(true, "ok")],
      label: "冲击面板质检结果表，可横向滚动",
    }));
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="冲击面板质检结果表，可横向滚动"');
    expect(html).not.toContain('aria-label="数据质检结果表，可横向滚动"');
  });
});

describe("QC disclosure accessible names", () => {
  test("names each per-check disclosure with its check, not a bare identical label", () => {
    const rows: QcCheck[] = [
      { name: "冲击面板维度对齐", kind: "结构", passed: true, detail: "ok", warnings: ["w1", "w2", "w3", "w4"], severity: "ok" },
      { name: "冲击强度值域", kind: "数值", passed: true, detail: "ok", warnings: [], severity: "ok" },
    ];
    const html = renderToStaticMarkup(createElement(QcChecksTable, {
      rows,
      label: "冲击数据质检",
      emptyMessage: "",
    }));

    // 同一页里多个“为什么检查？”必须能区分是哪一项检查。
    expect(html).toContain('aria-label="冲击面板维度对齐：为什么检查？"');
    expect(html).toContain('aria-label="冲击强度值域：为什么检查？"');
    expect(html).toContain('aria-label="冲击面板维度对齐：还有 2 条明细"');
    expect(html.match(/：为什么检查？"/g)).toHaveLength(2);
  });

  test("每个自定义可访问名都包含它自己的可见文字（WCAG 2.5.3 Label in Name）", () => {
    const rows: QcCheck[] = [
      { name: "冲击面板维度对齐", kind: "结构", passed: true, detail: "ok", warnings: ["w1", "w2", "w3", "w4"], severity: "ok" },
    ];
    const html = renderToStaticMarkup(createElement(QcChecksTable, {
      rows,
      label: "冲击数据质检",
      emptyMessage: "",
    }));

    // 逐个比对：<summary aria-label="…">可见文字</summary> 中的可见文字必须出现在 aria-label 里。
    const pairs = [...html.matchAll(/<summary[^>]*aria-label="([^"]*)"[^>]*>(.*?)<\/summary>/g)];
    expect(pairs.length).toBeGreaterThan(0);
    for (const [, name, visible] of pairs) {
      expect(name).toContain(visible);
    }
  });
});
