import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEMO_PASSWORD_HINT, EnrollmentModal, enrollmentToast, FieldModal, StudentModal, StudentRowMenu, newStudentError, newStudentProblem, nextStudentSort,
  settleModalSubmission, sortStudents, studentFieldError, summarizeStudents,
} from "./students";
import type { AcademicSemester, StudentRow } from "../types";

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
    expect(source).toContain("useModalErrorFocus(error)");
    const ui = await Bun.file(new URL("./ui.tsx", import.meta.url)).text();
    expect(ui).toContain("errorRef.current?.focus()");
  });

  test("keeps fixed demo-pool passwords out of the editable password modal", async () => {
    const source = await Bun.file(new URL("./students.tsx", import.meta.url)).text();
    // aria-disabled, not disabled: a click explains why instead of doing nothing.
    expect(source).toContain("aria-disabled={student.demo_seed || undefined}");
    expect(source).toContain("if (!student.demo_seed) { pick(event, \"password\"); return; }");
    expect(source).toContain("title={student.demo_seed ? DEMO_PASSWORD_HINT : undefined}");
    expect(DEMO_PASSWORD_HINT).toBe("演示账号不能修改密码。要演示改密码，请新建一个学生账号。");
  });

  test("allows clearing an optional student number but not a display name", () => {
    expect(studentFieldError("", { label: "学号", required: false })).toBeNull();
    expect(studentFieldError("  ", { label: "姓名" })).toBe("姓名不能为空");
    expect(studentFieldError("short", { label: "新密码", password: true })).toBe("密码至少 12 个字符");
    expect(studentFieldError("x".repeat(257), { label: "新密码", password: true })).toBe("密码不能超过 256 个字符");
    expect(studentFieldError("x".repeat(256), { label: "新密码", password: true })).toBeNull();
    expect(studentFieldError(" ".repeat(12), { label: "新密码", password: true })).toBe("密码不能全是空格");
    expect(studentFieldError("9".repeat(41), { label: "学号", required: false, maxLength: 40 })).toBe("学号不能超过 40 个字符");
    const student = { username: "df-a", display_name: "学生", password: "long-password-1", student_no: "" };
    expect(newStudentError(student)).toBeNull();
    expect(newStudentError({ ...student, username: "a" })).toContain("2–40 位");
    expect(newStudentError({ ...student, display_name: "名".repeat(61) })).toBe("姓名不能超过 60 个字符");
    expect(newStudentError({ ...student, student_no: "9".repeat(300) })).toBe("学号不能超过 40 个字符");
  });

  test("checks names and numbers in the form the server stores them", () => {
    // Invisible-only names are blank; zero-width characters around a username are not an error.
    expect(studentFieldError("​‍", { label: "姓名" })).toBe("姓名不能为空");
    // 61 characters as typed but 60 once the double space collapses, as on the server.
    expect(studentFieldError(`名  ${"字".repeat(58)}`, { label: "姓名", maxLength: 60 })).toBeNull();
    const student = { username: "﻿df-a​", display_name: "学生", password: "long-password-1", student_no: "" };
    expect(newStudentError(student)).toBeNull();
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

  test("offers only active groups for new assignments but preserves an archived existing assignment", () => {
    const semesters: AcademicSemester[] = [
      {
        id: 1,
        name: "2026 秋",
        is_active: true,
        created_at: "2026-09-01T00:00:00Z",
        student_count: 0,
        classes: [
          { id: 11, term_id: 1, name: "使用中班", is_active: true, created_at: "2026-09-01T00:00:00Z", student_count: 0 },
          { id: 12, term_id: 1, name: "归档班", is_active: false, created_at: "2026-09-01T00:00:00Z", student_count: 1 },
        ],
      },
      {
        id: 2,
        name: "2025 秋",
        is_active: false,
        created_at: "2025-09-01T00:00:00Z",
        student_count: 1,
        classes: [
          { id: 21, term_id: 2, name: "历史班", is_active: true, created_at: "2025-09-01T00:00:00Z", student_count: 1 },
        ],
      },
    ];
    const createHtml = renderToStaticMarkup(createElement(StudentModal, {
      semesters,
      onClose: () => {},
      onSubmit: async () => {},
    }));
    expect(createHtml).toContain("使用中班");
    expect(createHtml).not.toContain("归档班");
    expect(createHtml).not.toContain("历史班");

    const archivedStudent: StudentRow = {
      id: 7,
      username: "student07",
      display_name: "演示学生 07",
      student_no: "2026007",
      demo_seed: false,
      last_login_at: null,
      created_at: "2026-09-01T00:00:00Z",
      report_state: null,
      score: null,
      submitted_at: null,
      verified_completed_count: 0,
      verified_total_steps: 15,
      verified_completed_steps: [],
      completion_missing: [],
      last_valid_activity: null,
      enrollments: [{ term_id: 2, term_name: "2025 秋", class_id: 21, class_name: "历史班" }],
    };
    const editHtml = renderToStaticMarkup(createElement(EnrollmentModal, {
      student: archivedStudent,
      semesters: [semesters[1]],
      onClose: () => {},
      onSubmit: async () => {},
    }));
    expect(editHtml).toContain("2025 秋（已归档）");
    expect(editHtml).toContain("历史班（已归档）");
    expect(editHtml).toContain(">不分班<");
    expect(editHtml).toContain("已归档的学期或班级只能保留现有分班或移出");
  });
});

describe("enrollment toast", () => {
  const semesters: AcademicSemester[] = [{
    id: 1, name: "2026 秋季学期", is_active: true, created_at: "2026-09-01T00:00:00Z", student_count: 1,
    classes: [
      { id: 11, term_id: 1, name: "国贸 2401 班", is_active: true, created_at: "2026-09-01T00:00:00Z", student_count: 1 },
      { id: 12, term_id: 1, name: "国贸 2402 班", is_active: true, created_at: "2026-09-01T00:00:00Z", student_count: 0 },
    ],
  }];
  const base = {
    id: 5, username: "student05", display_name: "演示学生 05 李明", student_no: "2026005", demo_seed: false,
    last_login_at: null, created_at: "2026-09-01T00:00:00Z", report_state: null, score: null, submitted_at: null,
    verified_completed_count: 0, verified_total_steps: 15, verified_completed_steps: [], completion_missing: [],
    last_valid_activity: null,
  } satisfies Omit<StudentRow, "enrollments">;
  const unassigned: StudentRow = { ...base, enrollments: [] };
  const enrolled: StudentRow = { ...base, enrollments: [{ term_id: 1, term_name: "2026 秋季学期", class_id: 11, class_name: "国贸 2401 班" }] };

  test("不分班 for a student never in a class says nothing changed, not that they were moved out", () => {
    expect(enrollmentToast(unassigned, semesters, 1, null)).toBe("演示学生 05 李明 在“2026 秋季学期”仍未分班，没有改动");
    expect(enrollmentToast(enrolled, semesters, 1, null)).toBe("已把 演示学生 05 李明 移出“2026 秋季学期”的班级");
  });

  test("saving the same class says nothing changed; a new class names it", () => {
    expect(enrollmentToast(enrolled, semesters, 1, 11)).toBe("演示学生 05 李明 仍在“2026 秋季学期 · 国贸 2401 班”，没有改动");
    expect(enrollmentToast(enrolled, semesters, 1, 12)).toBe("已把 演示学生 05 李明 分到“2026 秋季学期 · 国贸 2402 班”");
    expect(enrollmentToast(unassigned, semesters, 1, 11)).toBe("已把 演示学生 05 李明 分到“2026 秋季学期 · 国贸 2401 班”");
  });
});

describe("teacher student row menu accessible names", () => {
  const student: StudentRow = {
    id: 7,
    username: "student07",
    display_name: "演示学生 07",
    student_no: "2026007",
    demo_seed: false,
    last_login_at: null,
    created_at: "2026-09-01T00:00:00Z",
    report_state: "draft",
    score: null,
    submitted_at: null,
    verified_completed_count: 3,
    verified_total_steps: 15,
    verified_completed_steps: [1, 2, 3],
    completion_missing: [],
    last_valid_activity: null,
    enrollments: [],
  };

  test("carries the student identity so repeated menus stay distinguishable", () => {
    const html = renderToStaticMarkup(createElement(StudentRowMenu, { student, onPick: () => {} }));

    expect(html).toContain('aria-label="操作：演示学生 07（student07）"');
    expect(html).toContain('aria-label="修改姓名：演示学生 07（student07）"');
    expect(html).toContain('aria-label="修改学号：演示学生 07（student07）"');
    expect(html).toContain('aria-label="调整班级：演示学生 07（student07）"');
    expect(html).toContain('aria-label="重置密码：演示学生 07（student07）"');
    // 可见文字不变
    expect(html).toContain(">修改姓名<");
    expect(html).toContain(">重置密码<");
  });

  test("a demo account's reset item is disabled, says why and still names the row", () => {
    const seeded = { ...student, username: "student08", display_name: "演示学生 08", demo_seed: true };
    const html = renderToStaticMarkup(createElement(StudentRowMenu, { student: seeded, onPick: () => {} }));

    expect(html).toContain('aria-label="重置密码：演示学生 08（student08）"');
    expect(html).toMatch(/<button aria-disabled="true"[^>]*>重置密码</);
    expect(html).toContain(`title="${DEMO_PASSWORD_HINT}"`);
    expect(html).toContain('title="更多操作"');
  });

  test("每个自定义可访问名都包含可见文字（WCAG 2.5.3）", () => {
    const html = renderToStaticMarkup(createElement(StudentRowMenu, { student, onPick: () => {} }));
    // 只检查以文字作为可见标签的按钮；"⋯" 是装饰字形，其含义由列头的 sr-only "操作" 提供。
    const pairs = [...html.matchAll(/<button[^>]*aria-label="([^"]*)"[^>]*>(.*?)<\/button>/g)];
    expect(pairs.length).toBe(4);
    for (const [, name, visible] of pairs) {
      expect(name).toContain(visible);
    }
  });
});

describe("student table sorting and summary", () => {
  const row = (id: number, overrides: Partial<StudentRow>): StudentRow => ({
    id, username: `s${id}`, display_name: `学生${id}`, student_no: "", demo_seed: false, last_login_at: null,
    created_at: "2026-09-01T00:00:00Z", report_state: null, score: null, submitted_at: null,
    verified_completed_count: 0, verified_total_steps: 15, verified_completed_steps: [], completion_missing: [],
    last_valid_activity: null, enrollments: [], ...overrides,
  });
  const rows = [
    row(1, { display_name: "王五", verified_completed_count: 15, report_state: "graded", score: 90, last_login_at: "2026-10-02T09:00:00" }),
    row(2, { display_name: "张三", verified_completed_count: 0, last_login_at: null }),
    row(3, { display_name: "李四", verified_completed_count: 6, report_state: "draft", last_valid_activity: "2026-10-01T08:00:00", last_login_at: "2026-10-01T08:00:00" }),
    row(4, { display_name: "赵六", verified_completed_count: 15, report_state: "pending", student_no: "2026010", last_login_at: "2026-10-03T10:00:00" }),
    row(5, { display_name: "钱七", verified_completed_count: 15, report_state: "graded", score: 75, student_no: "2026002" }),
  ];
  const names = (sorted: StudentRow[]) => sorted.map((student) => student.display_name);

  test("each column sorts both ways; missing values stay last", () => {
    expect(names(sortStudents(rows, null))).toEqual(["王五", "张三", "李四", "赵六", "钱七"]);
    expect(names(sortStudents(rows, { key: "name", direction: "ascending" }))).toEqual(["李四", "钱七", "王五", "张三", "赵六"]);
    expect(names(sortStudents(rows, { key: "progress", direction: "ascending" }))).toEqual(["张三", "李四", "钱七", "王五", "赵六"]);
    expect(names(sortStudents(rows, { key: "report", direction: "ascending" }))).toEqual(["张三", "李四", "赵六", "钱七", "王五"]);
    expect(names(sortStudents(rows, { key: "score", direction: "descending" }))).toEqual(["王五", "钱七", "李四", "张三", "赵六"]);
    expect(names(sortStudents(rows, { key: "score", direction: "ascending" }))).toEqual(["钱七", "王五", "李四", "张三", "赵六"]);
    expect(names(sortStudents(rows, { key: "student_no", direction: "ascending" }))).toEqual(["钱七", "赵六", "李四", "王五", "张三"]);
    expect(names(sortStudents(rows, { key: "login", direction: "descending" }))).toEqual(["赵六", "王五", "李四", "钱七", "张三"]);
    expect(names(sortStudents(rows, { key: "activity", direction: "ascending" }))).toEqual(["李四", "钱七", "王五", "张三", "赵六"]);
  });

  test("a header click starts ascending and flips on the same column", () => {
    expect(nextStudentSort(null, "score")).toEqual({ key: "score", direction: "ascending" });
    expect(nextStudentSort({ key: "score", direction: "ascending" }, "score")).toEqual({ key: "score", direction: "descending" });
    expect(nextStudentSort({ key: "score", direction: "descending" }, "name")).toEqual({ key: "name", direction: "ascending" });
  });

  test("the summary puts every student in one bucket and averages the scores", () => {
    expect(summarizeStudents(rows)).toEqual({ total: 5, notStarted: 1, inProgress: 1, pending: 1, graded: 2, averageScore: 82.5 });
    expect(summarizeStudents(rows.slice(1, 3))).toEqual({ total: 2, notStarted: 1, inProgress: 1, pending: 0, graded: 0, averageScore: null });
    expect(summarizeStudents([])).toEqual({ total: 0, notStarted: 0, inProgress: 0, pending: 0, graded: 0, averageScore: null });
  });

  test("a create-form problem names the field it is about", () => {
    const student = { username: "df-a", display_name: "学生", password: "long-password-1", student_no: "" };
    expect(newStudentProblem({ ...student, username: "a" })?.field).toBe("username");
    expect(newStudentProblem({ ...student, display_name: " " })?.field).toBe("display_name");
    expect(newStudentProblem({ ...student, student_no: "9".repeat(41) })?.field).toBe("student_no");
    expect(newStudentProblem({ ...student, password: "short" })).toEqual({ field: "password", message: "密码至少 12 个字符" });
  });
});
