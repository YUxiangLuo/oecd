import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api, ApiError } from "../api";
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
    expect(screen.getAllByRole("button", { name: /^批量导入学生：/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "批量导入学生：秋季 · 3班" }));
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
        const button = scope.getByRole("button", { name: active ? /^归档/ : /^恢复/ }) as HTMLButtonElement;
        // Archiving a semester or a class asks first; restoring does not.
        const asks = active;
        const press = () => {
          fireEvent.click(button);
          if (!asks) return;
          const dialog = screen.getByRole("dialog");
          expect(dialog.textContent).toContain("实验记录都会保留，随时可以恢复");
          fireEvent.click(within(dialog).getByRole("button", { name: "归档" }));
        };
        press();
        expect(screen.queryByRole("dialog")).toBeNull();
        // aria-disabled keeps keyboard focus on the button while saving; a second press is ignored.
        expect(button.getAttribute("aria-disabled")).toBe("true");
        expect(button.disabled).toBe(false);
        fireEvent.click(button);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(update).toHaveBeenCalledTimes(1);
        await act(async () => { reject(new Error("Failed to fetch")); });
        expect((await scope.findByRole("alert")).textContent).toContain("网络连接中断");
        expect(button.getAttribute("aria-disabled")).toBeNull();
        expect(button.textContent).toBe(active ? "归档" : "恢复");
        const changed = structuredClone(semester);
        if (target === "semester") changed.is_active = !active;
        else changed.classes[0].is_active = !active;
        list.mockResolvedValue({ semesters: [changed] });
        update.mockResolvedValue(target === "semester" ? changed : changed.classes[0]);
        press();
        await act(async () => {});
        expect(update).toHaveBeenLastCalledWith(target === "semester" ? 1 : 2, { is_active: !active });
        await waitFor(() => {
          const refreshed = container.querySelector(target === "semester" ? ".semester-card-head" : ".class-row");
          expect(refreshed).not.toBeNull();
          const controls = within(refreshed as HTMLElement);
          expect(controls.getByRole("button", { name: active ? /^恢复/ : /^归档/ })).toBeTruthy();
          expect(controls.queryByRole("alert")).toBeNull();
        });
      } finally {
        update.mockRestore();
        list.mockRestore();
      }
    });
  }
}

test("an archived semester shows no class archive buttons", async () => {
  const semester: AcademicSemester = {
    id: 1, name: "旧学期", is_active: false, student_count: 0, created_at: "2026-09-24",
    classes: [{ id: 2, term_id: 1, name: "旧班级", is_active: true, student_count: 0, created_at: "2026-09-24" }],
  };
  const list = spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [semester] });
  try {
    const { container } = render(<SemestersTab />);
    await screen.findByText("旧班级");
    const row = within(container.querySelector(".class-row") as HTMLElement);
    expect(row.queryByRole("button", { name: /^归档/ })).toBeNull();
    expect(row.getByRole("button", { name: "重命名班级：旧学期 · 旧班级" })).toBeTruthy();
    expect(within(container.querySelector(".semester-card-head") as HTMLElement).getByRole("button", { name: /^恢复/ })).toBeTruthy();
  } finally { list.mockRestore(); }
});

test("archived semesters sit in a 历史学期 section after the active ones, closed while others are in use", async () => {
  const make = (id: number, name: string, isActive: boolean): AcademicSemester => ({
    id, name, is_active: isActive, student_count: 0, created_at: "2026-09-24", classes: [],
  });
  const list = spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [
    make(1, "旧学期甲", false), make(2, "2026 秋", true), make(3, "旧学期乙", false),
  ] });
  try {
    const { container } = render(<SemestersTab />);
    await screen.findByText("2026 秋");
    const history = container.querySelector("details.semester-history") as HTMLDetailsElement;
    expect(history.open).toBe(false);
    expect(history.querySelector("summary")?.textContent).toBe("历史学期（2）");
    expect([...container.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual(["2026 秋", "旧学期甲", "旧学期乙"]);
    expect(history.contains(screen.getByText("2026 秋"))).toBe(false);
    expect(screen.getByText("旧学期甲").getAttribute("title")).toBe("旧学期甲");
  } finally { list.mockRestore(); }
});

test("creating, renaming, archiving and restoring each say so in a toast", async () => {
  const semester: AcademicSemester = {
    id: 1, name: "秋季", is_active: true, student_count: 0, created_at: "2026-09-24",
    classes: [{ id: 2, term_id: 1, name: "一班", is_active: true, student_count: 0, created_at: "2026-09-24" }],
  };
  const list = spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [semester] });
  const spies = [
    spyOn(api.classroom, "createSemester").mockResolvedValue({ id: 3, name: "春季", is_active: true, created_at: "2026-09-24" }),
    spyOn(api.classroom, "updateClass").mockResolvedValue(semester.classes[0]),
  ];
  const toasts: string[] = [];
  const listener = (event: Event) => toasts.push(String((event as CustomEvent<{ message: string }>).detail.message));
  window.addEventListener("gvcsim-toast", listener);
  try {
    render(<SemestersTab />);
    await screen.findByText("一班");
    fireEvent.click(screen.getByRole("button", { name: "+ 新建学期" }));
    fireEvent.change(screen.getByLabelText("学期名称"), { target: { value: "春季" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存" })); });
    fireEvent.click(screen.getByRole("button", { name: "重命名班级：秋季 · 一班" }));
    fireEvent.change(screen.getByLabelText("班级名称"), { target: { value: "二班" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存" })); });
    fireEvent.click(screen.getByRole("button", { name: "归档班级：秋季 · 一班" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("归档班级“一班”？");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "归档" })); });
    expect(toasts).toEqual(["已新建学期“春季”", "已把班级重命名为“二班”", "已归档班级“一班”（可随时恢复）"]);
  } finally {
    window.removeEventListener("gvcsim-toast", listener);
    spies.forEach((spy) => spy.mockRestore());
    list.mockRestore();
  }
});

test("the name dialog normalizes the name, focuses its error and returns focus to its opener", async () => {
  const list = spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] });
  const create = spyOn(api.classroom, "createSemester")
    .mockRejectedValueOnce(new ApiError(409, "学期 2026 秋 已存在", "409"))
    .mockResolvedValue({ id: 1, name: "2026 秋", is_active: true, created_at: "2026-09-24" });
  try {
    render(<SemestersTab />);
    await screen.findByText("还没有学期");
    const opener = screen.getByRole("button", { name: "+ 新建学期" });
    opener.focus();
    fireEvent.click(opener);
    const input = screen.getByLabelText("学期名称");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: " ２０２６​　 秋 " } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存" })); });
    expect(create).toHaveBeenLastCalledWith("2026 秋");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("保存失败：学期 2026 秋 已存在");
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => {});
    expect(document.activeElement).toBe(opener);
  } finally {
    create.mockRestore();
    list.mockRestore();
  }
});

test("a failed load reads as Chinese and can be retried", async () => {
  const list = spyOn(api.classroom, "semesters").mockRejectedValue(new TypeError("Failed to fetch"));
  try {
    render(<SemestersTab />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("学期与班级加载失败：网络连接中断");
    list.mockResolvedValue({ semesters: [] });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("还没有学期")).toBeTruthy();
  } finally { list.mockRestore(); }
});
