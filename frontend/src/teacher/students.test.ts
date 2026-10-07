import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnrollmentModal, FieldModal, StudentModal, StudentRowMenu, newStudentError, settleModalSubmission, studentFieldError } from "./students";
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
    expect(source).toContain("errorRef.current?.focus()");
  });

  test("keeps fixed demo-pool passwords out of the editable password modal", async () => {
    const source = await Bun.file(new URL("./students.tsx", import.meta.url)).text();
    expect(source).toContain("disabled={student.demo_seed}");
    expect(source).toContain("固定演示口令");
    expect(source).toContain("如需演示改密，请新建普通学生账号");
  });

  test("allows clearing an optional student number but not a display name", () => {
    expect(studentFieldError("", { label: "学号", required: false })).toBeNull();
    expect(studentFieldError("  ", { label: "姓名" })).toBe("姓名不能为空");
    expect(studentFieldError("short", { label: "新密码", password: true })).toBe("密码至少 12 位");
    expect(studentFieldError(" ".repeat(12), { label: "新密码", password: true })).toBe("密码不能全是空格");
    expect(studentFieldError("9".repeat(41), { label: "学号", required: false, maxLength: 40 })).toBe("学号不能超过 40 个字符");
    const student = { username: "df-a", display_name: "学生", password: "long-password-1", student_no: "" };
    expect(newStudentError(student)).toBeNull();
    expect(newStudentError({ ...student, username: "a" })).toContain("2–40 位");
    expect(newStudentError({ ...student, display_name: "名".repeat(61) })).toBe("姓名不能超过 60 个字符");
    expect(newStudentError({ ...student, student_no: "9".repeat(300) })).toBe("学号不能超过 40 个字符");
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
    expect(editHtml).toContain("2025 秋（已归档，仅可移出）");
    expect(editHtml).toContain("历史班（已归档，仅保留现有归属）");
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

  test("keeps the fixed-demo wording and still names the row", () => {
    const seeded = { ...student, username: "student08", display_name: "演示学生 08", demo_seed: true };
    const html = renderToStaticMarkup(createElement(StudentRowMenu, { student: seeded, onPick: () => {} }));

    expect(html).toContain('aria-label="固定演示口令：演示学生 08（student08）"');
    expect(html).toContain(">固定演示口令<");
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
