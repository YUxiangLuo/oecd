import { describe, expect, test } from "bun:test";
import { settleModalSubmission, studentFieldError } from "./students";

describe("teacher student modal submission", () => {
  test("allows clearing an optional student number but not a display name", () => {
    expect(studentFieldError("", { label: "学号", required: false })).toBeNull();
    expect(studentFieldError("  ", { label: "姓名" })).toBe("姓名不能为空");
    expect(studentFieldError("short", { label: "新密码", password: true })).toBe("密码至少 12 位");
  });

  test("closes only after a successful request", async () => {
    const events: string[] = [];
    const result = await settleModalSubmission(
      async () => { events.push("request"); },
      () => events.push("close"),
      (value) => events.push(`error:${value}`),
      (value) => events.push(`saving:${value}`),
    );

    expect(result).toBe(true);
    expect(events).toEqual(["saving:true", "error:null", "request", "close", "saving:false"]);
  });

  test("keeps the modal open and exposes the server error on failure", async () => {
    let closed = false;
    let error: string | null = null;
    const saving: boolean[] = [];
    const result = await settleModalSubmission(
      async () => { throw new Error("用户名 duplicate 已存在"); },
      () => { closed = true; },
      (value) => { error = value; },
      (value) => saving.push(value),
    );

    expect(result).toBe(false);
    expect(closed).toBe(false);
    expect(String(error)).toContain("已存在");
    expect(saving).toEqual([true, false]);
  });
});
