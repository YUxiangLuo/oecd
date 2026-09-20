import { expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { IntroOverlay } from "./intro";

test("mechanism preview follows the actual two-country five-year X/Y evidence chain", () => {
  try {
    const view = render(<IntroOverlay
      user={{ username: "student", name: "学生", role: "student" }}
      meta={{ countries: ["CHN", "USA"], sectors: ["C26"], years: [2016, 2017, 2018, 2019, 2020] }}
      stepsData={{ stages: {}, steps: [] }}
      onDone={() => {}}
    />);
    fireEvent.click(view.getByRole("button", { name: "介绍页 4" }));
    expect(view.getByRole("heading", { name: "先比较趋势，再读 X 与 Y 的关系" })).toBeTruthy();
    expect(view.getAllByText("由你选择")).toHaveLength(3);
    expect(view.queryByText(/中国|美国|计算机电子光学/)).toBeNull();
    expect(view.getByText("01 · 比较五年模拟关税暴露（X）")).toBeTruthy();
    const chart = view.getByRole("img", { name: /五年模拟关税暴露 X 趋势界面示意/ });
    expect(chart.textContent).toContain("2016");
    expect(chart.textContent).toContain("2020");
    expect(chart.textContent).toContain("X 示意强弱");
    expect(view.getByText("模拟关税暴露")).toBeTruthy();
    expect(view.getByText("模拟指标结果")).toBeTruthy();
    expect(view.getByLabelText("四项结果都要汇总").querySelectorAll("span")).toHaveLength(4);
    expect(view.getByText(/关系不显著或无法推断也要如实报告/)).toBeTruthy();
    expect(view.queryByRole("slider")).toBeNull();
    expect(view.queryByText(/贸易转移|跨境收缩|替代性扩张/)).toBeNull();
  } finally {
    cleanup();
  }
});
