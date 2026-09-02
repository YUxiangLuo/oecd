import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldModal, StudentModal, settleModalSubmission, studentFieldError } from "./students";

describe("teacher student modal submission", () => {
  test("uses native forms so Enter submits create and edit operations", () => {
    const student = renderToStaticMarkup(createElement(StudentModal, {
      onClose: () => {},
      onSubmit: async () => {},
    }));
    const field = renderToStaticMarkup(createElement(FieldModal, {
      title: "修改姓名",
      label: "姓名",
      initial: "测试学生",
      onClose: () => {},
      onSubmit: async () => {},
    }));

    for (const html of [student, field]) {
      expect(html).toContain('<form class="modal-form">');
      expect(html).toContain('type="submit"');
      expect(html).toContain('type="button"');
    }
  });

  test("makes asynchronous modal errors programmatically focusable", async () => {
    const source = await Bun.file(new URL("./students.tsx", import.meta.url)).text();
    expect(source).toContain('role="alert" tabIndex={-1}');
    expect(source).toContain("errorRef.current?.focus()");
  });

  test("keeps fixed demo-pool passwords out of the editable password modal", async () => {
    const source = await Bun.file(new URL("./students.tsx", import.meta.url)).text();
    expect(source).toContain("disabled={student.demo_seed}");
    expect(source).toContain("固定演示口令");
    expect(source).toContain("请新建普通学生账号演示改密");
  });

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
