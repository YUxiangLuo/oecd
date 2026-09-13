import { expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { IntroOverlay } from "./intro";

test("data boundaries remain visible and both technical cards can expand independently", async () => {
  try {
    const view = render(<IntroOverlay user={{ username: "student", name: "学生", role: "student" }} meta={null} stepsData={{ stages: {}, steps: [] }} onDone={() => {}} />);
    fireEvent.click(view.getByRole("button", { name: "介绍页 2" }));
    const icio = view.getByRole("button", { name: /投入产出数据（来源待确认）/ });
    const shock = view.getByRole("button", { name: /教学模拟关税/ });
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
    expect(view.getByText(/这里没有真实事件目录、现实税率或现实政策效果/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "介绍页 5" }));
    expect(view.getByText(/关闭不会改变当前实验步骤/).textContent).toBeTruthy();
    expect(view.queryByText(/建议从阶段一开始/) === null).toBe(true);
  } finally { cleanup(); }
});
