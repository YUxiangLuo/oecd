import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api";
import type { AcademicSemester } from "../types";
import { SemestersTab } from "./semesters";

afterEach(cleanup);

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
