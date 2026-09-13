import { afterEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { api } from "./api";
import { IntroOverlay } from "./intro";
import type { StepsResponse } from "./types";

const stages = { "1": "数据接入", "2": "指标计算", "3": "可视化分析", "4": "回归设计与建模", "5": "实验闭环" };
const steps: StepsResponse = {
  stages,
  steps: Array.from({ length: 15 }, (_, index) => ({
    n: index + 1, stage: index === 0 ? 1 : index < 5 ? 2 : index < 9 ? 3 : index < 14 ? 4 : 5,
    lab: "db", status: "done", title: `实验步骤${index + 1}`, goal: `步骤${index + 1}的教学目标`,
    tasks: ["", "", ""], concept: "", tip: "", deps: [], handoff: { input: "", action: "", output: "" },
  })),
};

afterEach(cleanup);

test("intro previews every stage without providing experiment-step navigation", async () => {
  const stepsMock = spyOn(api, "steps").mockResolvedValue(steps);
  const calls: unknown[][] = [];
  try {
    const view = render(<IntroOverlay user={{ username: "student", name: "学生", role: "student" }} meta={null} stepsData={steps} onDone={(...args) => { calls.push(args); }} />);
    expect(stepsMock).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "介绍页 3" }));
    await waitFor(() => expect(view.getByText("实验步骤1")).toBeTruthy());
    for (const [number, name] of Object.entries(stages)) {
      fireEvent.click(view.getByRole("button", { name: `${number}. ${name}` }));
      const rows = view.getByRole("dialog").querySelectorAll(".intro-step-row");
      expect(rows.length).toBe(steps.steps.filter(step => step.stage === Number(number)).length);
      for (const row of rows) expect(row.querySelectorAll("a, button, [role='link'], [role='button'], [tabindex]").length).toBe(0);
      expect(view.queryByText("自由浏览此步") === null).toBe(true);
      fireEvent.click(view.getByText("查看本阶段完整教学目标"));
      expect(view.getByRole("dialog").querySelectorAll(".intro-step-goal").length).toBe(rows.length);
      for (const step of steps.steps.filter(s => s.stage === Number(number))) {
        expect(view.getByText(step.goal).textContent).toBe(step.goal);
      }
    }
    for (let scene = 1; scene <= 5; scene++) {
      fireEvent.click(view.getByRole("button", { name: `介绍页 ${scene}` }));
      expect(view.getByRole("dialog").querySelectorAll("a[href], [role='link']").length).toBe(0);
      expect(view.queryByRole("button", { name: /从第.*步|自由浏览/ }) === null).toBe(true);
      expect(view.getByRole("button", { name: `介绍页 ${scene}` }).getAttribute("aria-current")).toBe("page");
      expect(view.getByRole("dialog").querySelectorAll("[aria-current='page']").length).toBe(1);
    }
    expect(calls).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: "关闭介绍" }));
    expect(calls).toEqual([[]]);
  } finally {
    cleanup(); stepsMock.mockRestore();
  }
});

test("skip and Escape only dismiss the introduction without a step argument", async () => {
  const stepsMock = spyOn(api, "steps").mockResolvedValue(steps);
  const calls: unknown[][] = [];
  try {
    const view = render(<IntroOverlay user={{ username: "student", name: "学生", role: "student" }} meta={null} stepsData={steps} onDone={(...args) => { calls.push(args); }} />);
    fireEvent.click(view.getByRole("button", { name: "跳过介绍" }));
    fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
    expect(calls).toEqual([[], []]);
  } finally {
    cleanup(); stepsMock.mockRestore();
  }
});
