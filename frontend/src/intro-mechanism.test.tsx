import { expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { IntroOverlay } from "./intro";

test("trade rerouting is selected by default and the enabled slider drives distinct illustrative paths", async () => {
  try {
    const view = render(<IntroOverlay user={{ username: "student", name: "学生", role: "student" }} meta={null} stepsData={{ stages: {}, steps: [] }} onDone={() => {}} />);
    fireEvent.click(view.getByRole("button", { name: "介绍页 4" }));
    const slider = view.getByRole("slider", { name: "假设加征税率" }) as HTMLInputElement;
    expect(slider.disabled).toBe(false);
    expect(slider.value).toBe("0");
    expect(view.getByRole("button", { name: /贸易转移/ }).getAttribute("aria-pressed")).toBe("true");
    const chart = () => view.getByRole("img");
    const paths = (flow: string) => chart().querySelectorAll(`path[data-flow='${flow}']`);
    const width = (flow: string) => Number(paths(flow)[0]?.getAttribute("stroke-width"));
    expect(paths("alternate").length).toBe(2);
    expect(paths("domestic").length).toBe(0);
    expect(paths("alternate")[0].getAttribute("stroke-dasharray")).toBe("5 5");
    expect(chart().textContent).toContain("第三国制造枢纽");
    for (const path of [...paths("original"), ...paths("alternate")]) {
      const marker = path.getAttribute("marker-end");
      expect(marker?.startsWith("url(#")).toBe(true);
      expect(document.getElementById(marker!.slice(5, -1))?.tagName.toLowerCase()).toBe("marker");
    }
    const original = width("original");
    const alternate = width("alternate");
    fireEvent.change(slider, { target: { value: "25" } });
    expect(slider.value).toBe("25");
    expect(width("original")).toBeLessThan(original);
    expect(width("alternate")).toBeGreaterThan(alternate);
    expect(paths("alternate")[0].hasAttribute("stroke-dasharray")).toBe(false);
    expect(view.queryByText("12.0%") === null).toBe(true);
    expect(view.getByText(/本图不计算 GVC 份额，也不预测政策效果/).textContent).toBeTruthy();
    expect(slider.getAttribute("aria-valuetext")).toBe("假设加征税率 25%");
    expect(view.getByText(/当前假设：部分生产改经第三国/).textContent).toBeTruthy();
    expect(view.getByRole("dialog").querySelectorAll(".intro-tau").length).toBe(1);
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(view.queryAllByRole("slider").length).toBe(1);

    fireEvent.click(view.getByRole("button", { name: /跨境收缩/ }));
    expect(paths("alternate").length).toBe(0);
    expect(paths("domestic").length).toBe(1);
    expect(chart().textContent).toContain("假设：国内替代增强");
    fireEvent.click(view.getByRole("button", { name: /替代性扩张/ }));
    expect(paths("domestic").length).toBe(0);
    expect(paths("alternate").length).toBe(2);
    expect(chart().textContent).toContain("新增境外供应商");
    expect(width("original")).toBeGreaterThan(original);
    fireEvent.change(slider, { target: { value: "0" } });
    expect(view.queryByText("12.0%") === null).toBe(true);
    expect(view.getByText(/尚未加征关税/).textContent).toBeTruthy();
  } finally {
    cleanup();
  }
});
