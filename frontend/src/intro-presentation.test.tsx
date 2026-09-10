import { expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { api } from "./api";
import { IntroOverlay } from "./intro";

test("data boundaries remain visible and both technical cards can expand independently", async () => {
  const request = spyOn(api, "shockEvents").mockResolvedValue({ events: [], disclaimer: "", source_disclosure: "" });
  try {
    const view = render(<IntroOverlay user={{ username: "student", name: "学生", role: "student" }} meta={null} stepsData={{ stages: {}, steps: [] }} onDone={() => {}} />);
    fireEvent.click(view.getByRole("button", { name: "介绍页 2" }));
    const icio = view.getByRole("button", { name: /OECD ICIO/ });
    const shock = view.getByRole("button", { name: /贸易政策冲击面板/ });
    expect(icio.getAttribute("aria-expanded")).toBe("false");
    expect(shock.getAttribute("aria-expanded")).toBe("false");
    expect(view.getByRole("dialog").querySelectorAll(".intro-card-facts li").length).toBe(6);
    fireEvent.click(icio);
    fireEvent.click(shock);
    expect(icio.getAttribute("aria-expanded")).toBe("true");
    expect(shock.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByRole("dialog").querySelectorAll(".intro-card.open").length).toBe(2);
    fireEvent.click(icio);
    expect(shock.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("当前事件目录为空。"));
    fireEvent.click(view.getByRole("button", { name: "介绍页 5" }));
    expect(view.getByText(/关闭不会改变当前实验步骤/).textContent).toBeTruthy();
    expect(view.queryByText(/建议从阶段一开始/) === null).toBe(true);
  } finally { cleanup(); request.mockRestore(); }
});
