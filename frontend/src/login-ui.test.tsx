import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "./api";
import { LoginPage } from "./login";

afterEach(cleanup);

describe("demo-mode login UI source behavior", () => {
  // 这里只验证交互。production/demo 的 Vite 常量替换、定制口令与 tree-shaking
  // 由 scripts/verify-build-modes.ts 对真实 bundle 验证。
  // DEMO_PASSWORD 是模块级常量，本组固定断言默认值 gvclab2026；运行单测的
  // 进程不得设置 VITE_DEMO_PASSWORD。
  const DEMO_ENV = "VITE_DEMO_MODE";

  function withDemoEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
    const previous = process.env[DEMO_ENV];
    if (value === undefined) delete process.env[DEMO_ENV];
    else process.env[DEMO_ENV] = value;
    return run().finally(() => {
      if (previous === undefined) delete process.env[DEMO_ENV];
      else process.env[DEMO_ENV] = previous;
    });
  }

  const inputValue = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

  test("default build keeps the form empty and hides quick-role buttons", async () => {
    await withDemoEnv(undefined, async () => {
      render(<LoginPage onLogin={() => {}} />);
      expect(inputValue("login-user")).toBe("");
      expect(inputValue("login-pass")).toBe("");
      expect(screen.queryByRole("group", { name: "开发演示快捷账号" })).toBeNull();
    });
  });

  test("demo build prefills student credentials and switches to teacher in one click", async () => {
    await withDemoEnv("1", async () => {
      const logins: { username: string; password: string }[] = [];
      const original = api.login;
      api.login = async (username: string, password: string) => {
        logins.push({ username, password });
        throw new Error("stop after capture");
      };
      try {
        render(<LoginPage onLogin={() => {}} />);
        // 默认落在学生身份并预填演示口令,打开即可直接登录。
        expect(inputValue("login-user")).toBe("student");
        expect(inputValue("login-pass")).toBe("gvclab2026");

        expect(screen.getByRole("group", { name: "开发演示快捷账号" })).toBeDefined();
        fireEvent.click(screen.getByRole("button", { name: /教师身份/ }));
        expect(inputValue("login-user")).toBe("teacher");
        expect(inputValue("login-pass")).toBe("gvclab2026");

        // 提交会把预填的教师凭证原样发给真实登录 API。
        fireEvent.submit(document.querySelector("form")!);
        await waitFor(() => expect(logins).toEqual([{ username: "teacher", password: "gvclab2026" }]));
        // 演示提示向课堂公开口令,并说明可一键切换身份。
        expect(document.querySelector(".login-hint")?.textContent).toContain("gvclab2026");
      } finally {
        api.login = original;
      }
    });
  });
});

describe("login failure presentation", () => {
  test("contains the public login experience in one main landmark", async () => {
    render(<LoginPage onLogin={() => {}} />);
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  test("localizes a browser network failure and announces it as an alert", async () => {
    const original = api.login;
    api.login = async () => { throw new TypeError("Failed to fetch"); };
    try {
      render(<LoginPage onLogin={() => {}} />);
      fireEvent.submit(document.querySelector("form")!);

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("登录失败：网络连接中断，请检查连接后重试。");
      expect((screen.getByRole("button", { name: "登录" }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      api.login = original;
    }
  });
});
