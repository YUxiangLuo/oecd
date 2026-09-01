import { describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { api } from "./api";
import { LoginPage } from "./login";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("demo mode build (VITE_DEMO_MODE=1)", () => {
  // demoMode 是 LoginPage 渲染期读取的,可用进程 env 控制;DEMO_PASSWORD 是 login.tsx
  // 模块级常量(import 时求值),本组测试固定断言代码默认值 gvclab2026——
  // 运行测试的进程环境不得设置 VITE_DEMO_PASSWORD(它只是构建期变量)。
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

  const inputValue = (renderer: ReactTestRenderer, id: string) =>
    renderer.root.findByProps({ id }).props.value as string;

  test("default build keeps the form empty and hides quick-role buttons", async () => {
    await withDemoEnv(undefined, async () => {
      let renderer: ReactTestRenderer | undefined;
      try {
        await act(async () => {
          renderer = create(<LoginPage onLogin={() => {}} />);
        });
        expect(inputValue(renderer!, "login-user")).toBe("");
        expect(inputValue(renderer!, "login-pass")).toBe("");
        expect(renderer!.root.findAllByProps({ role: "group" })).toHaveLength(0);
      } finally {
        if (renderer) await act(async () => renderer?.unmount());
      }
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
      let renderer: ReactTestRenderer | undefined;
      try {
        await act(async () => {
          renderer = create(<LoginPage onLogin={() => {}} />);
        });
        // 默认落在学生身份并预填演示口令,打开即可直接登录。
        expect(inputValue(renderer!, "login-user")).toBe("student");
        expect(inputValue(renderer!, "login-pass")).toBe("gvclab2026");

        const roleButtons = renderer!.root.findAllByProps({ role: "group" });
        expect(roleButtons).toHaveLength(1);
        const teacherButton = renderer!.root.findAllByType("button").find(
          (b) => b.findAllByType("span").some((s) => s.children.includes("教师身份")),
        )!;
        await act(async () => teacherButton.props.onClick());
        expect(inputValue(renderer!, "login-user")).toBe("teacher");
        expect(inputValue(renderer!, "login-pass")).toBe("gvclab2026");

        // 提交会把预填的教师凭证原样发给真实登录 API。
        await act(async () => {
          await renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
        });
        expect(logins).toEqual([{ username: "teacher", password: "gvclab2026" }]);
        // 演示提示向课堂公开口令,并说明可一键切换身份。
        const hint = renderer!.root.findByProps({ className: "login-hint" });
        const textOf = (node: unknown): string => {
          if (typeof node === "string") return node;
          if (Array.isArray(node)) return node.map(textOf).join("");
          if (node && typeof node === "object" && "children" in node) {
            return textOf((node as { children: unknown }).children);
          }
          return "";
        };
        expect(textOf(hint)).toContain("gvclab2026");
      } finally {
        api.login = original;
        if (renderer) await act(async () => renderer?.unmount());
      }
    });
  });
});

describe("login failure presentation", () => {
  test("contains the public login experience in one main landmark", async () => {
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<LoginPage onLogin={() => {}} />);
      });
      expect(renderer!.root.findAllByType("main")).toHaveLength(1);
    } finally {
      if (renderer) await act(async () => renderer?.unmount());
    }
  });

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
