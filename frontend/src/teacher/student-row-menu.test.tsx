import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StudentRowMenu } from "./students";
import type { StudentRow } from "../types";

afterEach(cleanup);

const student = (id: number): StudentRow => ({
  id, username: `s${id}`, display_name: `学生 ${id}`, student_no: "", demo_seed: false, last_login_at: null,
  created_at: "2026-09-01T00:00:00Z", report_state: null, score: null, submitted_at: null,
  verified_completed_count: 0, verified_total_steps: 15, verified_completed_steps: [], completion_missing: [],
  last_valid_activity: null, enrollments: [],
});

test("a pick closes the menu and leaves focus on its ⋯ for the modal to return to", () => {
  let picked = "";
  const view = render(<StudentRowMenu student={student(1)} onPick={(type) => { picked = type; }} />);
  const menu = view.container.querySelector("details")!;
  menu.open = true;
  fireEvent.click(screen.getByRole("button", { name: "修改学号：学生 1（s1）" }));
  expect(picked).toBe("student_no");
  expect(menu.open).toBe(false);
  expect(document.activeElement).toBe(menu.querySelector("summary"));
});

test("Escape closes the menu, and opening one menu closes the others", () => {
  const view = render(<><StudentRowMenu student={student(1)} onPick={() => {}} /><StudentRowMenu student={student(2)} onPick={() => {}} /></>);
  const [first, second] = [...view.container.querySelectorAll("details")];
  first.open = true;
  fireEvent.keyDown(first, { key: "Escape" });
  expect(first.open).toBe(false);
  first.open = true;
  second.open = true;
  fireEvent(second, new Event("toggle"));
  expect(first.open).toBe(false);
  expect(second.open).toBe(true);
});

test("tabbing out of an open menu closes it; a blur without a new focus target leaves it to the click handler", () => {
  const view = render(<><StudentRowMenu student={student(1)} onPick={() => {}} /><button>下一个</button></>);
  const menu = view.container.querySelector("details")!;
  const item = screen.getByRole("button", { name: "修改姓名：学生 1（s1）" });
  menu.open = true;
  fireEvent.blur(item, { relatedTarget: null });
  expect(menu.open).toBe(true);
  fireEvent.blur(item, { relatedTarget: menu.querySelector("summary") });
  expect(menu.open).toBe(true);
  fireEvent.blur(item, { relatedTarget: screen.getByRole("button", { name: "下一个" }) });
  expect(menu.open).toBe(false);
});
