import { afterEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RootErrorBoundary, StepErrorBoundary } from "./error-boundary";

afterEach(() => { cleanup(); });

const state = { broken: true };
function Step({ label }: { label: string }) {
  if (state.broken) throw new Error("draw failed");
  return <p>{label}</p>;
}

test("a step that fails to draw shows a message; another step, or 再试一次 once fixed, draws again", () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  state.broken = true;
  const view = render(<StepErrorBoundary resetKey="11"><Step label="步骤 11" /></StepErrorBoundary>);
  expect(screen.getByRole("alert").textContent).toContain("本步没能显示出来");

  state.broken = false;
  view.rerender(<StepErrorBoundary resetKey="12"><Step label="步骤 12" /></StepErrorBoundary>);
  expect(screen.getByText("步骤 12")).toBeTruthy();

  state.broken = true;
  view.rerender(<StepErrorBoundary resetKey="13"><Step label="步骤 13" /></StepErrorBoundary>);
  expect(screen.getByRole("alert")).toBeTruthy();
  state.broken = false;
  fireEvent.click(screen.getByRole("button", { name: "再试一次" }));
  expect(screen.getByText("步骤 13")).toBeTruthy();
  quiet.mockRestore();
});

test("the root boundary replaces an empty page with a message and a reload button", () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  state.broken = true;
  render(<RootErrorBoundary><Step label="页面" /></RootErrorBoundary>);
  expect(screen.getByRole("alert").textContent).toContain("已保存到服务器的实验记录不受影响");
  expect(screen.getByRole("button", { name: "刷新页面" })).toBeTruthy();
  quiet.mockRestore();
});
