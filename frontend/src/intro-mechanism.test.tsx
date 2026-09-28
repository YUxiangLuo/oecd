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
    expect(view.getByText(/正式回归使用完整国家×行业面板，不限于所选两国/)).toBeTruthy();
    // Two pre-policy years, followed by three equal positive tariff rates.
    for (const [series, amplitude] of [["a", 80], ["b", 40]] as const) {
      const circles = [...chart.querySelectorAll(`circle.country-${series}`)];
      const ys = circles.map((circle) => Number(circle.getAttribute("cy")));
      expect(ys.map((y) => (120 - y) / amplitude)).toEqual([0, 0, 1, 1, 1]);
      const path = circles.map((circle, index) => `${index ? "L" : "M"}${circle.getAttribute("cx")} ${circle.getAttribute("cy")}`).join("");
      expect(chart.querySelector(`path.country-${series}`)?.getAttribute("d")).toBe(path);
    }
    expect(view.getByText("模拟关税暴露")).toBeTruthy();
    expect(view.getByText("模拟指标结果")).toBeTruthy();
    expect(view.getByLabelText("四项结果都要汇总").querySelectorAll("span")).toHaveLength(4);
    expect(view.getByText(/关系不显著或无法推断也要如实报告/)).toBeTruthy();
    expect(view.queryByRole("slider")).toBeNull();
    expect(view.queryByText(/贸易转移|跨境收缩|替代性扩张/)).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "介绍页 5" }));
    expect(view.getByText(/第 2–9 步须主动保存两国比较/)).toBeTruthy();
    expect(view.getByText(/生成草稿不等于提交/)).toBeTruthy();
    expect(view.getByText(/等待同步成功/)).toBeTruthy();
  } finally {
    cleanup();
  }
});
