import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "./api";
import {
  chooseDemoStudent,
  demoStudentCredentials,
  DEMO_STUDENT_COUNT,
  isDemoStudentUsername,
  LoginPage,
} from "./login";

afterEach(cleanup);
beforeEach(() => sessionStorage.clear());

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

  test("defines 50 unique pairs and exhausts one no-repeat cycle before starting another", () => {
    const students = demoStudentCredentials("gvclab2026");
    expect(students).toHaveLength(DEMO_STUDENT_COUNT);
    expect(new Set(students.map((student) => student.username)).size).toBe(DEMO_STUDENT_COUNT);
    expect(new Set(students.map((student) => student.password)).size).toBe(DEMO_STUDENT_COUNT);
    expect(students[0]).toEqual({ username: "student", password: "gvclab2026" });
    expect(students.at(-1)).toEqual({ username: "student50", password: "gvclab2026-50" });
    expect(isDemoStudentUsername("student")).toBe(true);
    expect(isDemoStudentUsername("student50")).toBe(true);
    expect(isDemoStudentUsername("student01")).toBe(false);
    expect(isDemoStudentUsername("student51")).toBe(false);
    let seen: string[] = [];
    const cycle: string[] = [];
    for (let index = 0; index < DEMO_STUDENT_COUNT; index += 1) {
      const selected = chooseDemoStudent(students, seen, 0);
      cycle.push(selected.student.username);
      seen = selected.nextSeen;
    }
    expect(new Set(cycle).size).toBe(DEMO_STUDENT_COUNT);
    const nextCycle = chooseDemoStudent(students, seen, 0);
    expect(nextCycle.student.username).not.toBe(cycle.at(-1));
    expect(nextCycle.nextSeen).toEqual([nextCycle.student.username]);
  });

  test("default build keeps the form empty and hides quick-role buttons", async () => {
    await withDemoEnv(undefined, async () => {
      render(<LoginPage onLogin={() => {}} />);
      expect(inputValue("login-user")).toBe("");
      expect(inputValue("login-pass")).toBe("");
      expect(screen.queryByRole("group", { name: "开发演示快捷账号" })).toBeNull();
    });
  });

  test("demo build prefills one valid student pair and switches to teacher in one click", async () => {
    await withDemoEnv("1", async () => {
      const students = demoStudentCredentials("gvclab2026");
      const logins: { username: string; password: string }[] = [];
      const original = api.login;
      api.login = async (username: string, password: string) => {
        logins.push({ username, password });
        throw new Error("stop after capture");
      };
      try {
        render(<LoginPage onLogin={() => {}} />);
        // 默认落在 50 组有效学生凭证之一,打开即可直接登录。
        const initialStudent = students.find((student) => student.username === inputValue("login-user"));
        expect(initialStudent).toBeDefined();
        expect(inputValue("login-pass")).toBe(initialStudent!.password);

        expect(screen.getByRole("group", { name: "开发演示快捷账号" })).toBeDefined();
        expect(screen.getByRole("button", { name: /50 个种子学生/ })).toBeDefined();
        fireEvent.click(screen.getByRole("button", { name: /教师身份/ }));
        expect(inputValue("login-user")).toBe("teacher");
        expect(inputValue("login-pass")).toBe("gvclab2026");

        // 提交会把预填的教师凭证原样发给真实登录 API。
        fireEvent.submit(document.querySelector("form")!);
        await waitFor(() => expect(logins).toEqual([{ username: "teacher", password: "gvclab2026" }]));
        expect(document.querySelector(".login-hint")?.textContent).toContain("近 1 小时无人使用的种子学生账号");
      } finally {
        api.login = original;
      }
    });
  });

  test("a same-tab refresh selects a different student username and password", async () => {
    await withDemoEnv("1", async () => {
      render(<LoginPage onLogin={() => {}} />);
      const first = { username: inputValue("login-user"), password: inputValue("login-pass") };
      cleanup();

      render(<LoginPage onLogin={() => {}} />);
      const second = { username: inputValue("login-user"), password: inputValue("login-pass") };
      expect(second.username).not.toBe(first.username);
      expect(second.password).not.toBe(first.password);
    });
  });

  test("the server's least-used demo account replaces the local random pick", async () => {
    const suggestion = spyOn(api, "demoStudent").mockResolvedValue({ username: "student07" });
    try {
      await withDemoEnv("1", async () => {
        render(<LoginPage onLogin={() => {}} />);
        await waitFor(() => expect(inputValue("login-user")).toBe("student07"));
        expect(inputValue("login-pass")).toBe("gvclab2026-07");
      });
    } finally { suggestion.mockRestore(); }
  });

  test("with every demo student in use the form is not prefilled with someone else's account", async () => {
    const suggestion = spyOn(api, "demoStudent").mockResolvedValue({ username: null });
    try {
      await withDemoEnv("1", async () => {
        render(<LoginPage onLogin={() => {}} />);
        await waitFor(() => expect(inputValue("login-user")).toBe(""));
        expect(inputValue("login-pass")).toBe("");
        expect(screen.getByText(/暂无空闲演示账号/)).toBeDefined();
        // The teacher shortcut is still offered.
        expect(screen.getByRole("button", { name: /教师身份/ })).toBeDefined();
      });
    } finally { suggestion.mockRestore(); }
  });

  test("a reload asks the server for the tab's earlier suggestion back", async () => {
    sessionStorage.setItem("gvcsim_demo_suggestion", "student09");
    const suggestion = spyOn(api, "demoStudent").mockResolvedValue({ username: "student09" });
    try {
      await withDemoEnv("1", async () => {
        render(<LoginPage onLogin={() => {}} />);
        await waitFor(() => expect(inputValue("login-user")).toBe("student09"));
        expect(suggestion).toHaveBeenCalledWith("student09");
      });
    } finally {
      suggestion.mockRestore();
      sessionStorage.removeItem("gvcsim_demo_suggestion");
    }
  });

  test("choosing the teacher identity before the suggestion arrives keeps the teacher credentials", async () => {
    let resolve: (value: { username: string | null }) => void = () => {};
    const suggestion = spyOn(api, "demoStudent").mockImplementation(() => new Promise((done) => { resolve = done; }));
    try {
      await withDemoEnv("1", async () => {
        render(<LoginPage onLogin={() => {}} />);
        const teacher = screen.getByRole("button", { name: /教师身份/ });
        fireEvent.click(teacher);
        expect(teacher.getAttribute("aria-pressed")).toBe("true");
        resolve({ username: "student07" });
        await new Promise((done) => setTimeout(done, 0));
        expect(inputValue("login-user")).toBe("teacher");
      });
    } finally { suggestion.mockRestore(); }
  });

  test("after 退出 the tab gets back the demo account it used, without asking the server", async () => {
    const suggestion = spyOn(api, "demoStudent").mockResolvedValue({ username: "student07" });
    sessionStorage.setItem("gvcsim_signed_in_username", "student12");
    try {
      await withDemoEnv("1", async () => {
        render(<LoginPage onLogin={() => {}} />);
        expect(inputValue("login-user")).toBe("student12");
        expect(inputValue("login-pass")).toBe("gvclab2026-12");
        expect(suggestion).not.toHaveBeenCalled();
      });
    } finally {
      suggestion.mockRestore();
      sessionStorage.removeItem("gvcsim_signed_in_username");
    }
  });

  test("after an expired session the form returns to that account, not another demo credential", async () => {
    await withDemoEnv("1", async () => {
      render(<LoginPage notice="登录已失效，请重新登录。" username="dogfood_r5" onLogin={() => {}} />);
      expect(inputValue("login-user")).toBe("dogfood_r5");
      expect(inputValue("login-pass")).toBe("");
      // An expiry is a warning, not a success.
      expect(screen.getByRole("status").className).toContain("tipbox");
      // No quick-login buttons are offered here, so their (empty) group is not rendered either.
      expect(screen.queryByRole("group", { name: "开发演示快捷账号" })).toBeNull();
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
