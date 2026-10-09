import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, ApiError } from "../api";
import type { AcademicSemester } from "../types";
import {
  batchClassOptions, detectRosterSeparator, parseRoster, ROSTER_COLUMNS_MISSING, rosterFileContent, rosterFileName, StudentBatchModal,
} from "./student-batch";

afterEach(cleanup);

test("Excel roster preserves leading zeros, Unicode and spaces within names", () => {
  expect(parseRoster("\uFEFF学号\t姓名\r\n0012\t 张 三 \r\n\r\n0098\t李四")).toEqual([
    { username: "0012", display_name: "张 三" }, { username: "0098", display_name: "李四" },
  ]);
});

test("rejects duplicates, missing cells, extra columns and oversized rosters", () => {
  for (const input of ["", "12\t张三\n12\t李四", "12\t", "\t李四", "12 张 三", "12\t张三\t第三列", "非法\t姓名"])
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
    // Nothing can be created: the disabled button says why instead of promising an account.
    expect((screen.getByText("1 个学号已被使用，无法创建") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("创建 1 个账号")).toBeNull();
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
    expect((screen.getByText("创建 1 个账号") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("下载账号清单"));
    fireEvent.click(screen.getByText("创建 1 个账号"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("网络中断"));
    expect(screen.queryByText("返回修改")).toBeNull();
    expect(created).toBe(0);
    fireEvent.click(screen.getByText("创建 1 个账号"));
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
    "第 4 行：学号 0261002 与第 3 行重复\n第 5 行：需要学号和姓名两列",
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
    throw new ApiError(409, "部分学号已有账号，本次没有创建任何学生", "409");
  };
  try {
    render(<StudentBatchModal semesters={[]} initialClassId={1} onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText("学生名单"), { target: { value: "0012\t张三" } });
    fireEvent.click(screen.getByText("预览名单"));
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("status"));
    expect(screen.getByText(/用 Excel 打开时，请把学号列设为“文本”/)).toBeTruthy();
    fireEvent.click(screen.getByText("下载账号清单"));
    fireEvent.click(screen.getByText("创建 1 个账号"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("创建失败：部分学号已有账号，本次没有创建任何学生。\n刚下载的清单已作废。请点“返回修改”，重新预览后再下载新清单。");
    expect(document.activeElement).toBe(alert);
    expect((screen.getByText("没有创建，请返回修改") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("返回修改"));
    expect(document.activeElement).toBe(screen.getByLabelText("学生名单"));
  } finally {
    api.classroom.createStudentBatch = original;
    URL.createObjectURL = originalUrl;
    HTMLAnchorElement.prototype.click = originalClick;
  }
});

test("detects tab, comma, full-width comma and space separators", () => {
  expect(detectRosterSeparator(["0012\t张三"])).toBe("tab");
  expect(detectRosterSeparator(["0012,张三"])).toBe("comma");
  expect(detectRosterSeparator(["0012，张三"])).toBe("comma");
  expect(detectRosterSeparator(["0012   张三"])).toBe("spaces");
  // A single space counts only when every line is exactly two words; otherwise a name may hold the space.
  expect(detectRosterSeparator(["0012 张三", "0013 李四"])).toBe("space");
  expect(detectRosterSeparator(["0012 张三", "0013 Li Si"])).toBeNull();
  expect(parseRoster("学号 姓名\n0012 张三\n0013 李四")).toEqual([
    { username: "0012", display_name: "张三" }, { username: "0013", display_name: "李四" },
  ]);
  // A tab anywhere wins: names with commas or spaces stay whole.
  expect(detectRosterSeparator(["0012\t张 三", "0013\t李,四"])).toBe("tab");
  const expected = [{ username: "0012", display_name: "张三" }, { username: "0013", display_name: "李 四" }];
  expect(parseRoster("学号,姓名\n0012,张三\n0013,李 四")).toEqual(expected);
  expect(parseRoster("0012，张三\n0013，李 四")).toEqual(expected);
  expect(parseRoster("0012  张三\n0013    李 四")).toEqual(expected);
  expect(parseRoster("\"0012\",\"张三\"\n\"0013\",\"李 四\"")).toEqual(expected);
  // Excel copied one empty column too many.
  expect(parseRoster("0012\t张三\t\n0013\t李 四\t")).toEqual(expected);
});

test("each line falls back to its own separator when the shared one does not split it", () => {
  // Line 1 copied from Excel (tab), line 2 typed by hand (space).
  expect(parseRoster("0012\t张三\n0013 李四")).toEqual([
    { username: "0012", display_name: "张三" }, { username: "0013", display_name: "李四" },
  ]);
  expect(parseRoster("学号,姓名\n0012,张三\n0013\t李 四\n0014  王五")).toEqual([
    { username: "0012", display_name: "张三" }, { username: "0013", display_name: "李 四" }, { username: "0014", display_name: "王五" },
  ]);
});

test("any line naming 学号 and 姓名 is a header, and 姓名 first swaps the columns", () => {
  expect(parseRoster("班级名单 学号 姓名\n0012\t张三")).toEqual([{ username: "0012", display_name: "张三" }]);
  expect(parseRoster("姓名,学号\n张三,0012")).toEqual([{ username: "0012", display_name: "张三" }]);
  expect(() => parseRoster("学号\t姓名")).toThrow("请先粘贴学生名单（每次最多 200 人）");
});

test("one message when every line lacks its two columns, line numbers otherwise", () => {
  expect(() => parseRoster("学号 姓名\n0012 张 三\n0013 李 四\n0014 王 五")).toThrow(new Error(ROSTER_COLUMNS_MISSING));
  // A line still unreadable on its own (three single-spaced words) is named by its number.
  expect(() => parseRoster("0012\t张三\n0013 Li Si")).toThrow(new Error("第 2 行：需要学号和姓名两列（姓名含空格时，请用制表符或逗号分隔学号和姓名）"));
  expect(() => parseRoster(`0012\t${"名".repeat(61)}`)).toThrow(new Error("第 1 行：姓名不能超过 60 字"));
});

test("the account list file is named after semester, class and day, and lists the class", () => {
  expect(rosterFileName("2026 秋", "一班", new Date(2026, 9, 8))).toBe("2026 秋-一班-学生账号清单-20261008.txt");
  expect(rosterFileName("2026/秋", "A:1", new Date(2026, 0, 5))).toBe("2026_秋-A_1-学生账号清单-20260105.txt");
  expect(rosterFileContent([{ username: "0012", display_name: "张三", password: "p" }], "2026 秋 · 一班"))
    .toBe("学号（用户名）\t姓名\t初始密码\t班级\n0012\t张三\tp\t2026 秋 · 一班");
});

test("class options read 学期 · 班级, active only; the download carries that name", async () => {
  const semesters: AcademicSemester[] = [
    { id: 1, name: "2026 秋", is_active: true, student_count: 0, created_at: "2026-09-01", classes: [
      { id: 2, term_id: 1, name: "一班", is_active: true, student_count: 0, created_at: "2026-09-01" },
      { id: 3, term_id: 1, name: "旧班", is_active: false, student_count: 0, created_at: "2026-09-01" },
    ] },
    { id: 4, name: "2025 秋", is_active: false, student_count: 0, created_at: "2025-09-01", classes: [
      { id: 5, term_id: 4, name: "一班", is_active: true, student_count: 0, created_at: "2025-09-01" },
    ] },
  ];
  expect(batchClassOptions(semesters).map((option) => option.label)).toEqual(["2026 秋 · 一班"]);
  const original = api.classroom.createStudentBatch;
  const originalUrl = URL.createObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  let blob: Blob | null = null;
  let fileName = "";
  URL.createObjectURL = (value: Blob | MediaSource) => { blob = value as Blob; return "blob:test"; };
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { fileName = this.download; };
  api.classroom.createStudentBatch = async () => ({ existing: [], created: 0 });
  try {
    render(<StudentBatchModal semesters={semesters} initialClassId={2} onClose={() => {}} onCreated={() => {}} />);
    expect((screen.getByRole("option", { name: "2026 秋 · 一班" }) as HTMLOptionElement).selected).toBe(true);
    fireEvent.change(screen.getByLabelText("学生名单"), { target: { value: "0012,张三" } });
    fireEvent.click(screen.getByText("预览名单"));
    fireEvent.click(await screen.findByText("下载账号清单"));
    expect(fileName).toMatch(/^2026 秋-一班-学生账号清单-\d{8}\.txt$/);
    expect(await (blob as Blob | null)!.text()).toContain("\t2026 秋 · 一班");
  } finally {
    api.classroom.createStudentBatch = original;
    URL.createObjectURL = originalUrl;
    HTMLAnchorElement.prototype.click = originalClick;
  }
});

test("a preview conflict is a pill on a tinted row, and the summary names the 学号", async () => {
  const original = api.classroom.createStudentBatch;
  api.classroom.createStudentBatch = async () => ({ existing: ["0012"], created: 0 });
  try {
    const view = render(<StudentBatchModal semesters={[]} initialClassId={1} onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText("学生名单"), { target: { value: "0012\t张三\n0013\t李四" } });
    fireEvent.click(screen.getByText("预览名单"));
    const pill = await screen.findByText("学号已被使用");
    expect(pill.className).toContain("status-pill warn");
    expect(pill.closest("tr")?.className).toBe("batch-row-conflict");
    expect(view.container.querySelector("thead th")?.textContent).toBe("状态");
    expect(screen.getByRole("status").textContent).toBe("共 2 人，其中 1 个学号已有账号（0012），请返回修改名单。");
  } finally { api.classroom.createStudentBatch = original; }
});
