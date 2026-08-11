import { describe, expect, test } from "bun:test";
import { userFacingRequestError } from "./user-facing-error";

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
    expect(userFacingRequestError(new Error("当前数据版本不可用"), "报告提交失败"))
      .toBe("报告提交失败：当前数据版本不可用");
  });
});
