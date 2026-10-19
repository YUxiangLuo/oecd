import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { api } from "./api";
import { IntroOverlay } from "./intro";
import type { Meta, StepsResponse } from "./types";

const user = { username: "student", name: "学生", role: "student" as const };
const stages = { "1": "数据接入", "2": "指标计算", "3": "可视化分析", "4": "回归设计与建模", "5": "实验闭环" };
const steps: StepsResponse = {
  stages,
  steps: Array.from({ length: 15 }, (_, index) => ({
    n: index + 1, stage: index === 0 ? 1 : index < 5 ? 2 : index < 9 ? 3 : index < 14 ? 4 : 5,
    lab: "db", status: "done", title: `实验步骤${index + 1}`, goal: `步骤${index + 1}的教学目标`,
    tasks: ["", "", ""], concept: "", tip: "", deps: [], handoff: { input: "", action: "", output: "" },
  })),
};
const open = (meta: Meta | null = null, stepsData = steps, onDone = () => {}) => render(<IntroOverlay user={user} meta={meta} stepsData={stepsData} onDone={onDone} />);
const next = (view: ReturnType<typeof open>) => fireEvent.click(view.getByRole("button", { name: /下一页/ }));
afterEach(() => { cleanup(); mock.restore(); });

test("five display-only scenes expose all content without extra controls or experiment navigation", () => {
  const stepsRequest = spyOn(api, "steps");
  const shockRequest = spyOn(api, "shockEvents");
  const onDone = mock(() => {});
  const view = open(null, steps, onDone);
  for (let scene = 1; scene <= 5; scene++) {
    const content = view.getByRole("dialog").querySelector(".intro-scene")!;
    expect(content.querySelectorAll("button, a, input, select, textarea, summary, details, [role=tab], [role=slider], [aria-expanded]")).toHaveLength(0);
    expect(view.getByText(new RegExp(`介绍 ${scene} / 5`))).toBeTruthy();
    expect(view.getAllByRole("button")).toHaveLength(3);
    expect(view.getByRole("dialog").querySelectorAll(".intro-progress .on")).toHaveLength(1);
    if (scene < 5) next(view);
  }
  for (const name of Object.values(stages)) expect(view.getByRole("heading", { name })).toBeTruthy();
  expect(view.getByRole("dialog").querySelectorAll(".intro-route small")).toHaveLength(5);
  expect(stepsRequest).not.toHaveBeenCalled();
  expect(shockRequest).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: /进入实验/ }));
  expect(onDone.mock.calls).toEqual([[]]);
});

test("navigation focuses each heading, respects bounds and preserves button key semantics", async () => {
  const view = open();
  await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
  expect((view.getByRole("button", { name: /上一页/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  expect(document.activeElement?.tagName).toBe("H1");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(document.activeElement?.textContent).toBe("从投入产出联系到价值链指标");
  fireEvent.keyDown(view.getByRole("button", { name: /下一页/ }), { key: "ArrowRight" });
  expect(document.activeElement?.textContent).toBe("从投入产出联系到价值链指标");
  for (let i = 0; i < 5; i++) fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(document.activeElement?.textContent).toBe("实验流程与报告成果");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  expect(document.activeElement?.textContent).toBe("从图表比较到回归分析");
});

test("skip and Escape close without changing the current experiment step", () => {
  const onDone = mock(() => {});
  const view = open(null, steps, onDone);
  fireEvent.click(view.getByRole("button", { name: /跳过介绍/ }));
  fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
  expect(onDone.mock.calls).toEqual([[], []]);
});

test("unknown metadata and missing routes do not invent coverage", () => {
  const view = open(null, { stages: {}, steps: [] });
  expect(view.getByText("课程数据范围暂不可用。")).toBeTruthy();
  expect(view.queryByText(/OECD ICIO 2023|76 个|45 个|2016/)).toBeNull();
  next(view);
  expect(view.getByRole("heading", { name: "投入产出数据（来源待确认）" })).toBeTruthy();
  for (let i = 0; i < 3; i++) next(view);
  expect(view.getByRole("status").textContent).toBe("当前课程暂无实验路线信息。");
  expect(view.getByRole("dialog").querySelectorAll(".intro-route li")).toHaveLength(0);
});

test("synthetic data, ROW and actual course metadata remain explicit", () => {
  const meta: Meta = { countries: ["CHN", "USA"], sectors: ["A"], years: [2020], dataset: { years: [2020], data_sources: { ci_synthetic_icio: { production_data: false } } } };
  const view = open(meta);
  expect(view.getByText("2 个经济体 · 1 个行业 · 2020")).toBeTruthy();
  view.rerender(<IntroOverlay user={user} meta={{ ...meta, countries: [...meta.countries, "ROW"] }} stepsData={steps} onDone={() => {}} />);
  expect(view.getByText("2 个经济体 + 世界其他地区 · 1 个行业 · 2020")).toBeTruthy();
  next(view);
  expect(view.getByRole("heading", { name: "模拟投入产出数据（教学用）" })).toBeTruthy();
  expect(view.getByRole("dialog").textContent).not.toMatch(/真实投入产出数据|投入产出数据来自 OECD/);
});
