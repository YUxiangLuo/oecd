import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QcRequestRetryActions } from "./qc-lab";

describe("QC request recovery", () => {
  test("puts year-specific retry controls on the fail-closed decision, not only in the table", () => {
    const html = renderToStaticMarkup(createElement(QcRequestRetryActions, {
      year: 2017,
      icioError: "Failed to fetch",
      controlError: null,
      onRetryIcio: () => {},
      onRetryControls: () => {},
    }));
    expect(html).toContain("重试 2017 年 OECD ICIO 质检");
    expect(html).not.toContain("重试控制变量质检");
  });

  test("omits retry actions when both QC requests succeeded", () => {
    const html = renderToStaticMarkup(createElement(QcRequestRetryActions, {
      year: 2020,
      icioError: null,
      controlError: null,
      onRetryIcio: () => {},
      onRetryControls: () => {},
    }));
    expect(html).toBe("");
  });

  test("offers both retries when ICIO and control requests failed", () => {
    const html = renderToStaticMarkup(createElement(QcRequestRetryActions, {
      year: 2018,
      icioError: "boom",
      controlError: "boom",
      onRetryIcio: () => {},
      onRetryControls: () => {},
    }));
    expect(html).toContain("重试 2018 年 OECD ICIO 质检");
    expect(html).toContain("重试国家-年份控制变量质检");
    expect(html).not.toContain(">重试控制变量质检<");
  });
});
