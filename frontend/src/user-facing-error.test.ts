import { describe, expect, test } from "bun:test";
import { studentFacingTechnicalTerms, userFacingRequestError } from "./user-facing-error";

describe("userFacingRequestError", () => {
  test("localizes browser fetch failures and gives a recovery action", () => {
    expect(userFacingRequestError(new TypeError("Failed to fetch"), "回归运行失败"))
      .toBe("回归运行失败：网络连接中断，请检查连接后重试。");
  });

  test("localizes Firefox's complete fetch failure message", () => {
    expect(userFacingRequestError(
      new TypeError("NetworkError when attempting to fetch resource."),
      "回归运行失败",
    )).toBe("回归运行失败：网络连接中断，请检查连接后重试。");
  });

  test("keeps useful server detail under a contextual heading", () => {
    expect(userFacingRequestError(new Error("当前作业已截止"), "报告提交失败"))
      .toBe("报告提交失败：当前作业已截止");
  });

  test("translates machine vocabulary without changing API contracts", () => {
    expect(studentFacingTechnicalTerms("artifact / manifest_id / assignment / attempt / report_key / mock schema"))
      .toBe("课程数据 / 数据版本 / 作业 / 实验轮次 / 报告编号 / 拟真教学数据 字段结构");
  });
});
