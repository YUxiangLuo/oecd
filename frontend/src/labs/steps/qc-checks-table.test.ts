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
    expect(qcResultLabel(check(false, "warning")).text).toBe("⚠ Warning");
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
