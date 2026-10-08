import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, ApiError } from "../api";
import { parseRoster, StudentBatchModal } from "./student-batch";

afterEach(cleanup);

test("Excel roster preserves leading zeros, Unicode and spaces within names", () => {
  expect(parseRoster("\uFEFF学号\t姓名\r\n0012\t 张 三 \r\n\r\n0098\t李四")).toEqual([
    { username: "0012", display_name: "张 三" }, { username: "0098", display_name: "李四" },
  ]);
});

test("rejects duplicates, missing cells, extra columns and oversized rosters", () => {
  for (const input of ["", "12\t张三\n12\t李四", "12\t", "\t李四", "12 张三", "12\t张三\t第三列", "非法\t姓名"])
    expect(() => parseRoster(input)).toThrow();
  expect(parseRoster(Array.from({ length: 200 }, (_, i) => `s${i}\t姓名`).join("\n"))).toHaveLength(200);
  expect(() => parseRoster(Array.from({ length: 201 }, (_, i) => `s${i}\t姓名`).join("\n"))).toThrow();
});

test("existing accounts prevent creation and editing invalidates preview", async () => {
  const original = api.classroom.createStudentBatch;
  const calls: boolean[] = [];
  api.classroom.createStudentBatch = async (body) => {
    calls.push(body.preview);
    return { existing: ["0012"], created: 0 };
  };
  try {
    render(<StudentBatchModal semesters={[]} initialClassId={1} onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText("学生名单"), { target: { value: "0012\t张三" } });
    fireEvent.click(screen.getByText("预览名单"));
    await waitFor(() => expect(screen.getByText("学号已被使用")).toBeTruthy());
    expect((screen.getByText("确认创建") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("下载账号清单")).toBeNull();
    fireEvent.click(screen.getByText("返回修改"));
    expect((screen.getByLabelText("学生名单") as HTMLTextAreaElement).value).toBe("0012\t张三");
    expect(calls).toEqual([true]);
  } finally { api.classroom.createStudentBatch = original; }
});

test("download precedes creation and response-loss retry preserves the same credentials", async () => {
  const original = api.classroom.createStudentBatch;
  const originalUrl = URL.createObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  const submissions: unknown[] = [];
  let created = 0;
  URL.createObjectURL = () => "blob:test";
  HTMLAnchorElement.prototype.click = () => {};
  api.classroom.createStudentBatch = async (body) => {
    if (body.preview) return { existing: [], created: 0 };
    submissions.push(body.students);
    if (submissions.length === 1) throw new Error("网络中断");
    return { existing: [], created: 1 };
  };
  try {
    render(<StudentBatchModal semesters={[]} initialClassId={1} onClose={() => {}} onCreated={() => { created++; }} />);
    fireEvent.change(screen.getByLabelText("学生名单"), { target: { value: "0012\t张三" } });
    fireEvent.click(screen.getByText("预览名单"));
    await waitFor(() => expect(screen.getByText("下载账号清单")).toBeTruthy());
    expect((screen.getByText("确认创建") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("下载账号清单"));
    fireEvent.click(screen.getByText("确认创建"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("网络中断"));
    expect(screen.queryByText("返回修改")).toBeNull();
    expect(created).toBe(0);
    fireEvent.click(screen.getByText("确认创建"));
    await waitFor(() => expect(created).toBe(1));
    expect(submissions).toHaveLength(2);
    expect(submissions[0]).toEqual(submissions[1]);
    expect(screen.getByText("已创建")).toBeTruthy();
  } finally {
    api.classroom.createStudentBatch = original;
    URL.createObjectURL = originalUrl;
    HTMLAnchorElement.prototype.click = originalClick;
  }
});

test("reports every problem with line numbers as pasted, header included", () => {
  const roster = "学号\t姓名\n0261001\t王小明\n0261002\t李华\n0261002\t重复\n0261003\t\n";
  expect(() => parseRoster(roster)).toThrow(
    "第 4 行：学号 0261002 与第 3 行重复\n第 5 行：请保留学号、姓名两列（用制表符分隔，从 Excel 直接复制即可），姓名为 1–60 字",
  );
  const many = Array.from({ length: 12 }, (_, i) => `坏学号${i}\t姓名`).join("\n");
  expect(() => parseRoster(many)).toThrow(/第 10 行[^\n]*\n另有 2 处问题$/);
});

test("says how many rows were pasted when the roster is too long", () => {
  expect(() => parseRoster(Array.from({ length: 201 }, (_, i) => `s${i}\t姓名`).join("\n")))
    .toThrow("每次最多 200 名学生，当前粘贴了 201 行；请分批导入");
});

test("strips zero-width characters the server would strip instead of rejecting the row", () => {
  expect(parseRoster("​0012​\t张​三﻿\n0013 \t李　　四")).toEqual([
    { username: "0012", display_name: "张三" }, { username: "0013", display_name: "李 四" },
  ]);
  // A name of only invisible characters is blank.
  expect(() => parseRoster("0012\t​‍")).toThrow("第 1 行");
});

test("a refused creation can be edited again; preview and back-to-edit move focus", async () => {
  const original = api.classroom.createStudentBatch;
  const originalUrl = URL.createObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = () => "blob:test";
  HTMLAnchorElement.prototype.click = () => {};
  api.classroom.createStudentBatch = async (body) => {
    if (body.preview) return { existing: [], created: 0 };
    throw new ApiError(409, "账号已存在，本次未添加任何学生；请返回修改名单并重新预览", "409");
  };
  try {
    render(<StudentBatchModal semesters={[]} initialClassId={1} onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText("学生名单"), { target: { value: "0012\t张三" } });
    fireEvent.click(screen.getByText("预览名单"));
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("status"));
    expect(screen.getByText(/清单是用制表符分隔的文本文件/)).toBeTruthy();
    fireEvent.click(screen.getByText("下载账号清单"));
    fireEvent.click(screen.getByText("确认创建"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("创建失败：账号已存在，本次未添加任何学生；请返回修改名单并重新预览\n刚才下载的账号清单作废；返回修改后重新预览会生成新的初始密码，请重新下载。");
    expect(document.activeElement).toBe(alert);
    fireEvent.click(screen.getByText("返回修改"));
    expect(document.activeElement).toBe(screen.getByLabelText("学生名单"));
  } finally {
    api.classroom.createStudentBatch = original;
    URL.createObjectURL = originalUrl;
    HTMLAnchorElement.prototype.click = originalClick;
  }
});
