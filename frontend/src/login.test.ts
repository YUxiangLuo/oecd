import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginPage, LOGIN_DATA_LABEL, LOGIN_FLOW } from "./login";

describe("login course map", () => {
  test("shows all five current course stages", () => {
    expect(LOGIN_FLOW).toEqual(["数据接入", "指标计算", "图表比较", "关税回归", "实验报告"]);
  });

  test("does not claim an unverified source or coverage before login", () => {
    expect(LOGIN_DATA_LABEL).toBe("登录后可查看数据来源与年份");
    const html = renderToStaticMarkup(createElement(LoginPage, { onLogin: () => {} }));
    expect(html).toContain("全球价值链结构分析");
    expect(html).not.toContain("真实指标");
    expect(html).not.toContain("76 个具名经济体");
    expect(html).not.toContain("OECD ICIO 2023 版");
    // Outside the demo build there is no demo account to remember or offer again.
    expect(html).not.toContain("这台电脑");
    expect(html).not.toContain("演示学生账号");
  });
});
