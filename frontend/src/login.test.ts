import { describe, expect, test } from "bun:test";
import { LOGIN_DATA_LABEL, LOGIN_FLOW } from "./login";

describe("login course map", () => {
  test("shows all five current course stages", () => {
    expect(LOGIN_FLOW).toEqual(["数据接入", "指标计算", "可视化分析", "回归设计与建模", "实验闭环"]);
  });

  test("separates the ICIO release edition from the covered data years", () => {
    expect(LOGIN_DATA_LABEL).toBe("OECD ICIO 2023 版 · 数据期 2016–2020");
  });
});
