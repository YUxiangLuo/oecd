import { describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { api } from "./api";
import { LoginPage } from "./login";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("login failure presentation", () => {
  test("localizes a browser network failure and announces it as an alert", async () => {
    const original = api.login;
    api.login = async () => { throw new TypeError("Failed to fetch"); };
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<LoginPage onLogin={() => {}} />);
      });
      await act(async () => {
        await renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
      });

      const alert = renderer!.root.findByProps({ role: "alert" });
      expect(alert.children.join("")).toContain("登录失败：网络连接中断，请检查连接后重试。");
      expect(renderer!.root.findByProps({ type: "submit" }).props.disabled).toBe(false);
    } finally {
      api.login = original;
      if (renderer) await act(async () => renderer?.unmount());
    }
  });
});
