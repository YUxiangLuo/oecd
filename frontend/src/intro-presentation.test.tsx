import { expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { IntroOverlay } from "./intro";

test("data boundaries remain visible and both technical cards can expand independently", async () => {
  try {
    const view = render(<IntroOverlay user={{ username: "student", name: "学生", role: "student" }} meta={null} stepsData={{ stages: {}, steps: [] }} onDone={() => {}} />);
    fireEvent.click(view.getByRole("button", { name: "介绍页 2" }));
    const icio = view.getByRole("button", { name: /投入产出数据（来源待确认）/ });
    const shock = view.getByRole("button", { name: /关税数据/ });
    expect(icio.getAttribute("aria-expanded")).toBe("false");
    expect(shock.getAttribute("aria-expanded")).toBe("false");
    expect(view.getByRole("dialog").querySelectorAll(".intro-card-facts li").length).toBe(5);
    fireEvent.click(icio);
    fireEvent.click(shock);
    expect(icio.getAttribute("aria-expanded")).toBe("true");
    expect(shock.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByRole("dialog").querySelectorAll(".intro-card.open").length).toBe(2);
    fireEvent.click(icio);
    expect(shock.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByText(/暴露强度 X 等于首年销往美国的出口份额乘以税率/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "介绍页 5" }));
    expect(view.getByText(/进入实验台不会改变当前实验步骤/).textContent).toBeTruthy();
    expect(view.queryByText(/建议从阶段一开始/) === null).toBe(true);
  } finally { cleanup(); }
});
