import { describe, expect, test } from "bun:test";
import { validatePasswordChange } from "./account-password";

describe("account password change", () => {
  test("requires the current password and a distinct 12-character replacement", () => {
    expect(validatePasswordChange("", "long-new-password", "long-new-password")).toBe("请输入当前密码");
    expect(validatePasswordChange("old-password", "too-short", "too-short")).toBe("新密码至少需要 12 个字符");
    expect(validatePasswordChange("same-password", "same-password", "same-password")).toBe("新密码不能与当前密码相同");
  });

  test("requires matching confirmation and accepts a valid replacement", () => {
    expect(validatePasswordChange("old-password", "new-private-password", "different-password")).toBe("两次输入的新密码不一致");
    expect(validatePasswordChange("old-password", "new-private-password", "new-private-password")).toBeNull();
  });
});
