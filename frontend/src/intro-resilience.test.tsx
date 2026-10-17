import { expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { api } from "./api";
import { IntroOverlay } from "./intro";

const user = { username: "student", name: "学生", role: "student" as const };
const stepsData = { stages: { "1": "数据接入" }, steps: [] };
const open = () => render(<IntroOverlay user={user} meta={null} stepsData={stepsData} onDone={() => {}} />);

test("intro uses the self-contained teaching simulation and never requests shock events", () => {
  const request = spyOn(api, "shockEvents");
  try {
    const view = open();
    fireEvent.click(view.getByRole("button", { name: "介绍页 2" }));
    fireEvent.click(view.getByRole("button", { name: /关税数据/ }));
    // The scenario is the course's simulation, not history (as step 10 says); both waves are 25%.
    expect(view.getByText(/课程模拟情景（不是真实政策）：美国分两批加税，第一批 2018 年起、第二批 2019 年起，税率都是 25%，此前为 0/)).toBeTruthy();
    expect(view.getByText(/关税暴露 X 等于首年对美出口份额 w 乘以加征税率 τ/)).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  } finally { cleanup(); request.mockRestore(); }
});

test("scene headings receive focus and local controls never trigger global arrow navigation", async () => {
  const view = open();
  try {
    await waitFor(() => expect(document.activeElement?.textContent).toBe("供应链仿真系统"));
    const heading = () => document.activeElement as HTMLElement;
    fireEvent.keyDown(heading(), { key: "ArrowRight" });
    await waitFor(() => expect(heading().textContent).toBe("数据来源与教学设定"));
    fireEvent.keyDown(view.getByRole("button", { name: /关税数据/ }), { key: "ArrowRight" });
    expect(heading().textContent).toBe("数据来源与教学设定");
    fireEvent.click(view.getByRole("button", { name: "介绍页 4" }));
    expect(heading().textContent).toBe("先看加税前后的差距，再用回归量化");
    fireEvent.click(view.getByRole("button", { name: "下一页" }));
    expect(heading().textContent).toBe("实验台已就绪");
  } finally { cleanup(); }
});
