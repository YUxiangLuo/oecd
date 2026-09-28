import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api";
import type { AcademicSemester } from "../types";
import { SemestersTab } from "./semesters";

afterEach(cleanup);

test("class import selects its class and is unavailable for archived groups", async () => {
  const semester: AcademicSemester = {
    id: 1, name: "秋季", is_active: true, student_count: 0, created_at: "2026-09-24",
    classes: [2, 3, 4].map((id) => ({ id, term_id: 1, name: `${id}班`, is_active: id !== 4,
      student_count: 0, created_at: "2026-09-24" })),
  };
  const list = spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [semester,
    { ...semester, id: 5, name: "旧学期", is_active: false,
      classes: [{ ...semester.classes[0], id: 6, term_id: 5 }] },
  ] });
  try {
    render(<SemestersTab />);
    await screen.findByText("3班");
    expect(screen.getAllByRole("button", { name: /^导入学生：/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "导入学生：秋季 · 3班" }));
    expect((screen.getByLabelText("所属班级") as HTMLSelectElement).value).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally { list.mockRestore(); }
});

for (const target of ["semester", "class"] as const) {
  for (const active of [true, false]) {
    test(`${target} ${active ? "archive" : "restore"} blocks duplicates, reports failure and allows retry`, async () => {
      const semester: AcademicSemester = {
        id: 1, name: "测试学期", is_active: target === "semester" ? active : true,
        student_count: 0, created_at: "2026-09-24",
        classes: [{ id: 2, term_id: 1, name: "测试班级", is_active: active,
          student_count: 0, created_at: "2026-09-24" }],
      };
      const list = spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [semester] });
      let reject!: (error: Error) => void;
      const method = target === "semester" ? "updateSemester" : "updateClass";
      const update = spyOn(api.classroom, method).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
      try {
        const { container } = render(<SemestersTab />);
        await screen.findByText("测试班级");
        const scope = within(container.querySelector(target === "semester" ? ".semester-card-head" : ".class-row") as HTMLElement);
        const button = scope.getByRole("button", { name: active ? "归档" : "恢复" }) as HTMLButtonElement;
        fireEvent.click(button);
        expect(button.disabled).toBe(true);
        fireEvent.click(button);
        expect(update).toHaveBeenCalledTimes(1);
        await act(async () => { reject(new Error("Failed to fetch")); });
        expect((await scope.findByRole("alert")).textContent).toContain("网络连接中断");
        expect(button.disabled).toBe(false);
        expect(button.textContent).toBe(active ? "归档" : "恢复");
        const changed = structuredClone(semester);
        if (target === "semester") changed.is_active = !active;
        else changed.classes[0].is_active = !active;
        list.mockResolvedValue({ semesters: [changed] });
        update.mockResolvedValue(target === "semester" ? changed : changed.classes[0]);
        await act(async () => { fireEvent.click(button); });
        expect(update).toHaveBeenLastCalledWith(target === "semester" ? 1 : 2, { is_active: !active });
        await waitFor(() => {
          const refreshed = container.querySelector(target === "semester" ? ".semester-card-head" : ".class-row");
          expect(refreshed).not.toBeNull();
          const controls = within(refreshed as HTMLElement);
          expect(controls.getByRole("button", { name: active ? "恢复" : "归档" })).toBeTruthy();
          expect(controls.queryByRole("alert")).toBeNull();
        });
      } finally {
        update.mockRestore();
        list.mockRestore();
      }
    });
  }
}
