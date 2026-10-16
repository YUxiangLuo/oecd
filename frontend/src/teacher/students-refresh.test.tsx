import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api";
import { FieldModal, StudentModal, StudentsTab, studentFieldError } from "./students";
import { SemestersTab } from "./semesters";
import type { AcademicSemester, StudentRow } from "../types";

afterEach(cleanup);
const semester: AcademicSemester = { id: 1, name: "测试学期", is_active: true, created_at: "2026-10-15", student_count: 1,
  classes: [{ id: 2, term_id: 1, name: "一班", is_active: true, created_at: "2026-10-15", student_count: 1 }] };
const student: StudentRow = { id: 3, username: "s3", display_name: "学生三", student_no: "03", demo_seed: false,
  last_login_at: null, created_at: "2026-10-15", report_state: null, report_outdated: false, score: null, submitted_at: null,
  verified_completed_count: 0, verified_total_steps: 15, verified_completed_steps: [], completion_missing: [], last_valid_activity: null,
  enrollments: [{ term_id: 1, term_name: "测试学期", class_id: 2, class_name: "一班" }] };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

for (const failed of [false, true]) {
  test(`student draft survives an earlier list refresh, rejected=${failed}`, async () => {
    const pending = deferred<{ students: StudentRow[] }>();
    const students = spyOn(api.classroom, "students").mockResolvedValueOnce({ students: [student] }).mockImplementationOnce(() => pending.promise).mockResolvedValue({ students: [student] });
    const semesters = spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [semester] });
    const confirm = spyOn(window, "confirm").mockReturnValue(false);
    try {
      render(<StudentsTab />); await screen.findByText("学生三");
      fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
      fireEvent.click(screen.getByRole("button", { name: "+ 添加学生" }));
      fireEvent.change(screen.getByLabelText("用户名（登录用）"), { target: { value: "draft01" } });
      fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "待保存学生" } });
      const dialog = screen.getByRole("dialog");
      const input = screen.getByLabelText("姓名");
      input.focus();
      await act(async () => { if (failed) pending.reject(new TypeError("Failed to fetch")); else pending.resolve({ students: [student] }); });
      expect(confirm).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(document.activeElement).toBe(input);
      expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("待保存学生");
      expect(screen.getByText("学生三")).not.toBeNull();
      if (failed) {
        expect(within(dialog).getByRole("alert").textContent).toContain("学生列表加载失败");
        fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
        expect(screen.getByLabelText("姓名")).toBe(input);
        expect((input as HTMLInputElement).value).toBe("待保存学生");
        expect(document.activeElement).toBe(input);
      }
    } finally { students.mockRestore(); semesters.mockRestore(); confirm.mockRestore(); }
  });
}

test("a failed academic refresh preserves the pasted roster and download preview", async () => {
  const pending = deferred<{ semesters: AcademicSemester[] }>();
  const students = spyOn(api.classroom, "students").mockResolvedValue({ students: [student] });
  const semesters = spyOn(api.classroom, "semesters").mockResolvedValueOnce({ semesters: [semester] }).mockImplementationOnce(() => pending.promise);
  const batch = spyOn(api.classroom, "createStudentBatch").mockResolvedValue({ existing: [], created: 0 });
  try {
    render(<StudentsTab />); await screen.findByText("学生三");
    fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
    fireEvent.click(screen.getByRole("button", { name: "批量导入学生" }));
    fireEvent.change(screen.getByLabelText("所属班级"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("学生名单"), { target: { value: "draft01\t待保存学生" } });
    fireEvent.click(screen.getByRole("button", { name: "预览名单" }));
    await screen.findByRole("button", { name: "下载账号清单" });
    await act(async () => { pending.reject(new TypeError("Failed to fetch")); });
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "下载账号清单" })).not.toBeNull();
    expect((screen.getByLabelText("所属班级") as HTMLSelectElement).selectedOptions[0].textContent).toBe("测试学期 · 一班");
    expect(screen.getByRole("alert").closest('[role="dialog"]')).not.toBeNull();
    expect(screen.getByText(/列表暂未更新/)).not.toBeNull();
    expect(batch).toHaveBeenCalledTimes(1);
  } finally { students.mockRestore(); semesters.mockRestore(); batch.mockRestore(); }
});

for (const source of ["students", "academic", "semester-tab", "success"] as const) {
  test(`a successful batch import keeps its receipt across follow-up list refresh: ${source}`, async () => {
    const students = spyOn(api.classroom, "students").mockResolvedValue({ students: [student] });
    const semesters = spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [semester] });
    const batch = spyOn(api.classroom, "createStudentBatch").mockImplementation(async body => ({ existing: [], created: body.preview ? 0 : body.students.length }));
    const originalUrl = URL.createObjectURL; const originalClick = HTMLAnchorElement.prototype.click;
    const downloads: Blob[] = [];
    URL.createObjectURL = (blob: Blob) => { downloads.push(blob); return "blob:test"; }; HTMLAnchorElement.prototype.click = () => {};
    try {
      render(source === "semester-tab" ? <SemestersTab /> : <StudentsTab />);
      await screen.findByText(source === "semester-tab" ? "一班" : "学生三");
      fireEvent.click(screen.getByRole("button", { name: source === "semester-tab" ? "批量导入学生：测试学期 · 一班" : "批量导入学生" }));
      fireEvent.change(screen.getByLabelText("所属班级"), { target: { value: "2" } });
      fireEvent.change(screen.getByLabelText("学生名单"), { target: { value: "draft01\t待保存学生" } });
      fireEvent.click(screen.getByRole("button", { name: "预览名单" }));
      await screen.findByRole("button", { name: "下载账号清单" });
      fireEvent.click(screen.getByRole("button", { name: "下载账号清单" }));
      const dialog = screen.getByRole("dialog");
      if (source === "students") students.mockRejectedValue(new TypeError("Failed to fetch"));
      if (source === "academic" || source === "semester-tab") semesters.mockRejectedValue(new TypeError("Failed to fetch"));
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "创建 1 个账号" })); });
      expect(batch.mock.calls.filter(([body]) => !body.preview)).toHaveLength(1);
      if (source !== "success") {
        await screen.findByRole("alert");
        expect(screen.getByRole("dialog")).toBe(dialog);
        expect(within(dialog).getByRole("alert").textContent).toContain("加载失败");
        expect(within(dialog).getByRole("button", { name: "再次下载账号清单" })).not.toBeNull();
        // A repeated refresh failure leaves the successful creation and its exact passwords intact.
        await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "重试" })); });
        expect(within(dialog).getByRole("alert")).not.toBeNull();
        fireEvent.click(within(dialog).getByRole("button", { name: "再次下载账号清单" }));
        students.mockResolvedValue({ students: [student] }); semesters.mockResolvedValue({ semesters: [semester] });
        await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重试" })); });
      }
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(screen.queryByRole("button", { name: "再次下载账号清单" })).not.toBeNull();
      expect(screen.queryByText("已添加 1 名学生。请按最后一次下载的账号清单逐人发放账号，并提醒学生登录后修改密码。")).not.toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "再次下载账号清单" }));
      const content = await Promise.all(downloads.map(blob => blob.text()));
      expect(content.length).toBeGreaterThan(1);
      expect(new Set(content).size).toBe(1);
      expect(content[0]).toContain("测试学期 · 一班");
      expect(batch.mock.calls.filter(([body]) => !body.preview)).toHaveLength(1);
      expect(batch.mock.calls.filter(([body]) => body.preview)).toHaveLength(1);
      expect(within(dialog).queryByRole("button", { name: "创建 1 个账号" })).toBeNull();
    } finally { students.mockRestore(); semesters.mockRestore(); batch.mockRestore(); URL.createObjectURL = originalUrl; HTMLAnchorElement.prototype.click = originalClick; }
  });
}

test("single student forms accept the same 60-codepoint name as batch import and backend", () => {
  expect(studentFieldError("𠮷".repeat(31), { label: "姓名", maxLength: 60 })).toBeNull();
});

for (const field of ["姓名", "学号", "密码", "班级"] as const) {
  test(`a pending academic refresh preserves the ${field} editor, its focus and choices on failure`, async () => {
    const pending = deferred<{ semesters: AcademicSemester[] }>();
    const students = spyOn(api.classroom, "students").mockResolvedValue({ students: [student] });
    const semesters = spyOn(api.classroom, "semesters").mockResolvedValueOnce({ semesters: [semester] })
      .mockImplementationOnce(() => pending.promise).mockResolvedValue({ semesters: [semester] });
    try {
      render(<StudentsTab />); await screen.findByText("学生三");
      fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
      const action = field === "密码" ? "重置密码" : field === "班级" ? "调整班级" : `修改${field}`;
      fireEvent.click(screen.getByRole("button", { name: `${action}：学生三（s3）` }));
      const dialog = screen.getByRole("dialog");
      const control = within(dialog).getByLabelText(field === "密码" ? "新密码（至少 12 个字符）" : field) as HTMLInputElement;
      const value = field === "班级" ? "" : "  尚未保存的内容𠮷  ";
      fireEvent.change(control, { target: { value } });
      control.focus();
      await act(async () => pending.reject(new TypeError("Failed to fetch")));
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(document.activeElement).toBe(control);
      expect(control.value).toBe(value);
      expect(within(dialog).getByRole("alert").textContent).toContain("学期列表加载失败");
      expect(within(dialog).getByText(/列表暂未更新/)).not.toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
      await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(control.value).toBe(value);
      if (field === "班级") expect(within(dialog).getByRole("option", { name: "一班" })).not.toBeNull();
    } finally { students.mockRestore(); semesters.mockRestore(); }
  });
}

for (const failing of ["students", "academic", "both"] as const) {
  test(`a cold ${failing} failure remains an error and retries only failed lists`, async () => {
    const students = spyOn(api.classroom, "students").mockResolvedValue({ students: [student] });
    const semesters = spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [semester] });
    if (failing !== "academic") students.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    if (failing !== "students") semesters.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    try {
      render(<StudentsTab />); await screen.findByRole("alert");
      expect(screen.queryByText("暂无学生")).toBeNull();
      expect(screen.queryByText(/列表暂未更新/)).toBeNull();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重试" })); });
      await screen.findByText("学生三");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(students).toHaveBeenCalledTimes(failing === "academic" ? 1 : 2);
      expect(semesters).toHaveBeenCalledTimes(failing === "students" ? 1 : 2);
    } finally { students.mockRestore(); semesters.mockRestore(); }
  });
}

test("an academic refresh failure preserves a newly opened semester editor", async () => {
  const pending = deferred<{ semesters: AcademicSemester[] }>();
  const semesters = spyOn(api.classroom, "semesters").mockResolvedValueOnce({ semesters: [semester] })
    .mockImplementationOnce(() => pending.promise).mockResolvedValue({ semesters: [semester] });
  const update = spyOn(api.classroom, "updateClass").mockResolvedValue(semester.classes[0]);
  try {
    render(<SemestersTab />); await screen.findByText("一班");
    fireEvent.click(screen.getByRole("button", { name: "归档班级：测试学期 · 一班" }));
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "归档" })); });
    fireEvent.click(screen.getByRole("button", { name: "+ 新建学期" }));
    const dialog = screen.getByRole("dialog");
    const input = screen.getByLabelText("学期名称") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "明年秋季" } }); input.focus();
    await act(async () => pending.reject(new TypeError("Failed to fetch")));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(document.activeElement).toBe(input);
    expect(within(dialog).getByRole("alert")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
    expect(input.value).toBe("明年秋季");
    expect(screen.getByText("一班")).not.toBeNull();
  } finally { semesters.mockRestore(); update.mockRestore(); }
});

test("name and student number limits count normalized Unicode code points", () => {
  for (const [label, limit] of [["姓名", 60], ["学号", 40]] as const) {
    const options = { label, maxLength: limit };
    for (const character of ["名", "𠮷", "😀"]) {
      expect(studentFieldError(character.repeat(limit), options)).toBeNull();
      expect(studentFieldError(character.repeat(limit + 1), options)).toBe(`${label}不能超过 ${limit} 个字符`);
    }
    // Spaces, invisible edges and NFKC composition are normalized before counting.
    expect(studentFieldError(`\u200b${"𠮷".repeat(limit - 2)}  Ａ\u200b`, options)).toBeNull();
    expect(studentFieldError("e\u0301".repeat(limit), options)).toBeNull();
    // This compatibility character expands to three code points, matching the API's stored form.
    expect(studentFieldError("ﬃ".repeat(Math.floor(limit / 3) + 1), options)).toBe(`${label}不能超过 ${limit} 个字符`);
  }
});

test("password limits count the unchanged code points, including astral characters and spaces", () => {
  const options = { label: "密码", password: true };
  for (const character of ["x", "𠮷", "😀"]) {
    expect(studentFieldError(character.repeat(11), options)).toBe("密码至少 12 个字符");
    expect(studentFieldError(character.repeat(12), options)).toBeNull();
    expect(studentFieldError(character.repeat(256), options)).toBeNull();
    expect(studentFieldError(character.repeat(257), options)).toBe("密码不能超过 256 个字符");
  }
  expect(studentFieldError("😀".repeat(6), options)).toBe("密码至少 12 个字符");
  expect(studentFieldError(` ${"😀".repeat(10)} `, options)).toBeNull();
  expect(studentFieldError("e\u0301".repeat(6), options)).toBeNull();
});

test("creating a student submits long Unicode labels with the exact untrimmed password", async () => {
  const submit = mock(async () => {});
  const name = "𠮷".repeat(60);
  const number = "😀".repeat(40);
  const password = ` ${"😀".repeat(10)} `;
  render(<StudentModal onClose={() => {}} onSubmit={submit} />);
  fireEvent.change(screen.getByLabelText("用户名（登录用）"), { target: { value: "unicode01" } });
  fireEvent.change(screen.getByLabelText("姓名"), { target: { value: ` ${name} ` } });
  fireEvent.change(screen.getByLabelText("学号（选填）"), { target: { value: ` ${number} ` } });
  fireEvent.change(screen.getByLabelText("初始密码（至少 12 个字符）"), { target: { value: password } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "创建账号" })); });
  expect(submit).toHaveBeenCalledWith({ username: "unicode01", display_name: name, student_no: number, password });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("resetting a Unicode password rejects fewer than twelve code points and preserves the valid raw value", async () => {
  const submit = mock(async () => {});
  render(<FieldModal title="重置密码" label="新密码" initial="" password onClose={() => {}} onSubmit={submit} />);
  const input = screen.getByLabelText("新密码");
  fireEvent.change(input, { target: { value: "😀".repeat(6) } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe("密码至少 12 个字符");
  expect(document.activeElement).toBe(input);
  const password = ` ${"😀".repeat(254)} `;
  fireEvent.change(input, { target: { value: password } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存" })); });
  expect(submit).toHaveBeenCalledWith(password);
});
