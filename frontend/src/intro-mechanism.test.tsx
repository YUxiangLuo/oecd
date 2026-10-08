import { expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { IntroOverlay } from "./intro";

test("mechanism preview follows the example, the group gap and the regression", () => {
  try {
    const view = render(<IntroOverlay
      user={{ username: "student", name: "学生", role: "student" }}
      meta={{ countries: ["CHN", "USA"], sectors: ["C26"], years: [2016, 2017, 2018, 2019, 2020] }}
      stepsData={{ stages: {}, steps: [] }}
      onDone={() => {}}
    />);
    fireEvent.click(view.getByRole("button", { name: "介绍页 4" }));
    expect(view.getByRole("heading", { name: "先看加税前后的差距，再用回归量化" })).toBeTruthy();
    expect(view.getAllByText("在步骤 10 选择")).toHaveLength(3);
    expect(view.queryByText(/中国|美国|计算机电子光学/)).toBeNull();
    expect(view.getByText("01 · 你的例子：X 只在加税后出现")).toBeTruthy();
    const chart = view.getByRole("img", { name: /五年关税暴露 X 趋势界面示意/ });
    expect(chart.textContent).toContain("2016");
    expect(chart.textContent).toContain("2020");
    expect(chart.textContent).toContain("X 示意强弱");
    expect(view.getByText(/回归用的是全部国家×行业，结果会换算到你的例子上/)).toBeTruthy();
    // The example is one of the taxed countries; no default pair is named here (step 10 shows the whole sample).
    expect(view.getByText(/它是 44 个加税国家之一/)).toBeTruthy();
    expect(view.queryByText(/默认是加拿大和墨西哥|加拿大|墨西哥/)).toBeNull();
    // Country A is taxed (zero for two years, then positive); country B is untaxed (always zero).
    for (const [series, expected] of [["a", [0, 0, 1, 1, 1]], ["b", [0, 0, 0, 0, 0]]] as const) {
      const circles = [...chart.querySelectorAll(`circle.country-${series}`)];
      const ys = circles.map((circle) => Number(circle.getAttribute("cy")));
      expect(ys.map((y) => (120 - y) / 80)).toEqual([...expected]);
      // Annual data drawn as a step, as on step 10: A stays at 0 through 2017 and jumps in 2018.
      const path = series === "a"
        ? "M50 120L270 120L270 40L490 40"
        : circles.map((circle, index) => `${index ? "L" : "M"}${circle.getAttribute("cx")} ${circle.getAttribute("cy")}`).join("");
      expect(chart.querySelector(`path.country-${series}`)?.getAttribute("d")).toBe(path);
    }
    expect(view.getByText("关税暴露")).toBeTruthy();
    expect(view.getByText("指标结果")).toBeTruthy();
    expect(view.getByRole("dialog").textContent).not.toContain("模拟");
    expect(view.getByLabelText("四项结果都要汇总").querySelectorAll("span")).toHaveLength(4);
    expect(view.getByText(/方向不确定或没算出估计值，也要如实报告/)).toBeTruthy();
    expect(view.queryByRole("slider")).toBeNull();
    expect(view.queryByText(/贸易转移|跨境收缩|替代性扩张/)).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "介绍页 5" }));
    expect(view.getByText(/步骤 1–10 打开页面即自动记录；步骤 11–14 点“计算…回归”按钮后自动保存/)).toBeTruthy();
    expect(view.queryByText(/主动保存/)).toBeNull();
    expect(view.getByText(/只生成草稿不算提交/)).toBeTruthy();
    expect(view.getByText(/保存成功后更新/)).toBeTruthy();
  } finally {
    cleanup();
  }
});
