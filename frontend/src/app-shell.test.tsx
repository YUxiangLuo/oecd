import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { CourseSidebar, NarrowWindowNotice, StepFooter, StepHeader, StudentTopbar } from "./app-shell";
import type { StepsResponse } from "./types";

afterEach(cleanup);

const stepsData: StepsResponse = {
  stages: { "1": "测试阶段" },
  steps: Array.from({ length: 15 }, (_, index) => ({
    n: index + 1, title: `步骤${index + 1}`, stage: 1, lab: "ind", status: "done",
    goal: "", tasks: ["one", "two", "three"], concept: "", tip: "", deps: [],
    handoff: { input: "", action: "", output: "" },
  })),
};

test("navigation reveals the active outline row but saving progress does not undo manual scrolling or steal focus", () => {
  const view = (current: number, completed: number[] = []) => <>
    <button>下一步测试</button>
    <CourseSidebar stepsData={stepsData} current={current}
      completion={{ steps: [], completed, completed_count: completed.length, total: 15 }}
      materialGate={null} onNavigate={() => {}} />
  </>;
  const { container, rerender } = render(view(1));
  const list = container.querySelector<HTMLElement>(".sidebar-list")!;
  const last = container.querySelector<HTMLElement>('[aria-label^="步骤 15："]')!;
  const first = container.querySelector<HTMLElement>('[aria-label^="步骤 1："]')!;
  list.getBoundingClientRect = () => ({ top: 100, bottom: 500 }) as DOMRect;
  last.getBoundingClientRect = () => ({ top: 800 - list.scrollTop, bottom: 850 - list.scrollTop }) as DOMRect;
  first.getBoundingClientRect = () => ({ top: 120 - list.scrollTop, bottom: 170 - list.scrollTop }) as DOMRect;
  const next = screen.getByRole("button", { name: "下一步测试" });
  next.focus();

  rerender(view(15));
  expect(list.scrollTop).toBe(350);
  expect(document.activeElement).toBe(next);
  expect(last.getAttribute("aria-current")).toBe("step");

  list.scrollTop = 0; // Student deliberately browses earlier steps.
  rerender(view(15, [1]));
  expect(list.scrollTop).toBe(0);
  expect(document.activeElement).toBe(next);

  list.scrollTop = 300;
  rerender(view(1, [1]));
  expect(list.scrollTop).toBe(20);
  expect(first.getAttribute("aria-current")).toBe("step");
  expect(document.activeElement).toBe(next);
});

test("a draft report is not shown as a finished step 15, a submitted one is", () => {
  const steps = { ...stepsData, steps: stepsData.steps.map((step) => step.n === 15 ? { ...step, lab: "rep" as const } : step) };
  const completed = Array.from({ length: 15 }, (_, index) => index + 1);
  const view = (reportState: "draft" | "pending") => <CourseSidebar stepsData={steps} current={1}
    completion={{ steps: [], completed, completed_count: 15, total: 15 }}
    materialGate={null} onNavigate={() => {}} reportExists reportState={reportState} />;
  const { container, rerender } = render(view("draft"));
  const badge = () => container.querySelector('[aria-label^="步骤 15："] .step-badge')!;
  expect(badge().textContent).toBe("15");
  expect(badge().className).not.toContain("done");
  expect(container.querySelector('[aria-label^="步骤 15："]')!.getAttribute("aria-label")).toContain("报告草稿（未提交）");
  // The progress count agrees with the badge: a draft does not make 15/15.
  expect(container.textContent).toContain("完成进度 14/15");
  rerender(view("pending"));
  expect(badge().textContent).toBe("✓");
  expect(badge().className).toContain("done");
  expect(container.textContent).toContain("完成进度 15/15");
});

test("the sidebar and the task card share one status vocabulary", () => {
  const { container } = render(<CourseSidebar stepsData={stepsData} current={2}
    completion={{ steps: [], completed: [1], completed_count: 1, total: 15 }}
    materialGate={[{ step: 3 }] as never} onNavigate={() => {}} currentMaterialStatus="saving" />);
  const status = (n: number) => container.querySelector(`[aria-label^="步骤 ${n}："] .step-row-status`)!.textContent;
  expect(status(1)).toBe("理解题已完成 · 报告材料已齐全");
  expect(status(2)).toBe("理解题未完成 · 报告材料保存中");
  expect(status(3)).toBe("理解题未完成 · 报告材料未齐全");
  expect(container.querySelector(".sidebar-steps")!.textContent).toBe("共 15 步");
  expect(container.querySelector(".sidebar-sub")!.textContent).toBe("完成进度 1/15");
});

test("header and footer name steps as 步骤 n, and every footer dot has a visible label", () => {
  const steps = stepsData.steps;
  const { container } = render(<>
    <StepHeader step={steps[1]} previous={steps[0]} next={steps[2]} stageName="测试阶段" totalSteps={15} onNavigate={() => {}} />
    <StepFooter steps={steps} step={steps[1]} next={steps[2]} stageName="测试阶段" current={2} completedSteps={new Set([1])} onNavigate={() => {}} />
  </>);
  expect(container.querySelector(".step-count")!.textContent).toBe("步骤 2 / 15");
  const dots = [...container.querySelectorAll<HTMLButtonElement>(".fdot")];
  expect(dots).toHaveLength(15);
  expect(dots[2].title).toBe("步骤 3：步骤3");
});

test("a demo student's password button keeps its name and explains why it cannot be used", () => {
  const previous = process.env.VITE_DEMO_MODE;
  process.env.VITE_DEMO_MODE = "1";
  try {
    const ref = { current: null };
    render(<StudentTopbar user={{ username: "student07", name: "学生", role: "student", account_id: 7 }} meta={null}
      introTriggerRef={ref} passwordTriggerRef={ref} onShowIntro={() => {}} onRequestPasswordChange={() => {}} onLogout={() => {}} />);
    const password = screen.getByRole("button", { name: "修改密码" });
    expect(password.getAttribute("aria-disabled")).toBe("true");
    expect(password.title).toBe("演示账号不能修改密码");
    expect(screen.getByRole("button", { name: "退出登录" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("口令");
  } finally {
    if (previous === undefined) delete process.env.VITE_DEMO_MODE;
    else process.env.VITE_DEMO_MODE = previous;
  }
});

test("the narrow-window notice says what to do in one line", () => {
  render(<NarrowWindowNotice />);
  expect(screen.getByRole("note").textContent).toBe("窗口较窄，部分内容需要横向滚动；请放宽窗口或缩小浏览器缩放");
});
