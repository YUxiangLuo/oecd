import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountPasswordModal, validatePasswordChange } from "./account-password";

test("the form skips native validation so the Chinese messages are shown, not the browser's minLength bubble", () => {
  const html = renderToStaticMarkup(createElement(AccountPasswordModal, { onClose: () => {}, onChanged: () => {} }));
  expect(html).toMatch(/<form[^>]*novalidate/i);
  expect(validatePasswordChange("old-password", "x".repeat(257), "x".repeat(257))).toBe("新密码不能超过 256 个字符");
});

describe("account password change", () => {
  test("requires the current password and a distinct 12-character replacement", () => {
    expect(validatePasswordChange("", "long-new-password", "long-new-password")).toBe("请输入当前密码");
    expect(validatePasswordChange("old-password", "too-short", "too-short")).toBe("新密码至少需要 12 个字符");
    expect(validatePasswordChange("old-password", " ".repeat(12), " ".repeat(12))).toBe("新密码不能全是空格");
    expect(validatePasswordChange("same-password", "same-password", "same-password")).toBe("新密码不能与当前密码相同");
  });

  test("requires matching confirmation and accepts a valid replacement", () => {
    expect(validatePasswordChange("old-password", "new-private-password", "different-password")).toBe("两次输入的新密码不一致");
    expect(validatePasswordChange("old-password", "new-private-password", "new-private-password")).toBeNull();
  });
});
