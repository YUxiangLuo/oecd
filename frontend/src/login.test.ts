import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginPage, LOGIN_DATA_LABEL, LOGIN_FLOW } from "./login";

describe("login course map", () => {
  test("shows all five current course stages", () => {
    expect(LOGIN_FLOW).toEqual(["数据接入", "指标计算", "可视化分析", "回归设计与建模", "实验闭环"]);
  });

  test("does not claim an unverified source or coverage before login", () => {
    expect(LOGIN_DATA_LABEL).toBe("数据来源与范围以登录后的课程数据说明为准");
    const html = renderToStaticMarkup(createElement(LoginPage, { onLogin: () => {} }));
    expect(html).toContain("从投入产出数据出发");
    expect(html).not.toContain("真实指标");
    expect(html).not.toContain("76 个具名经济体");
    expect(html).not.toContain("OECD ICIO 2023 版");
  });
});
