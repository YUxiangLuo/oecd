import { expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { api } from "./api";
import { IntroOverlay } from "./intro";
import type { Meta, StepsResponse } from "./types";

const user = { username: "student", name: "学生", role: "student" as const };
const empty: StepsResponse = { stages: {}, steps: [] };
const onDone = () => {};

test("missing metadata and empty routes never fabricate coverage or stage output", () => {
  const request = spyOn(api, "shockEvents").mockResolvedValue({ events: [], disclaimer: "", source_disclosure: "" });
  try {
    const view = render(<IntroOverlay user={user} meta={null} stepsData={empty} onDone={onDone} />);
    expect([...view.getByRole("dialog").querySelectorAll(".intro-stat-v")].map(e => e.textContent)).toEqual(["—", "—", "—"]);
    fireEvent.click(view.getByRole("button", { name: "介绍页 2" }));
    fireEvent.click(view.getByRole("button", { name: /OECD ICIO/ }));
    expect(view.getByRole("status").textContent).toBe("课程数据范围暂不可用。");
    expect(view.queryByText(/中间品方阵约/) === null).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "介绍页 3" }));
    expect(view.getByRole("status").textContent).toBe("当前课程暂无实验路线信息。");
    expect(view.getByRole("dialog").querySelectorAll(".intro-stage-output").length).toBe(0);
  } finally { cleanup(); request.mockRestore(); }
});

test("coverage follows actual ROW membership and available route stages", () => {
  const request = spyOn(api, "shockEvents").mockResolvedValue({ events: [], disclaimer: "", source_disclosure: "" });
  try {
    const meta: Meta = { countries: ["CHN", "USA"], sectors: ["A"], years: [2020] };
    const stepsData: StepsResponse = { stages: { "2": "指标计算" }, steps: [] };
    const view = render(<IntroOverlay user={user} meta={meta} stepsData={stepsData} onDone={onDone} />);
    const stats = () => [...view.getByRole("dialog").querySelectorAll(".intro-stat-v")].map(e => e.textContent);
    expect(stats()).toEqual(["2", "1", "2020–2020"]);
    view.rerender(<IntroOverlay user={user} meta={{ ...meta, countries: [...meta.countries, "ROW"] }} stepsData={stepsData} onDone={onDone} />);
    expect(stats()).toEqual(["2 + ROW", "1", "2020–2020"]);
    fireEvent.click(view.getByRole("button", { name: "介绍页 3" }));
    expect(view.getByRole("button", { name: "2. 指标计算" }).getAttribute("aria-pressed")).toBe("true");
    expect(view.getByText(/计算并保存不同对象的价值链指标/).textContent).toBeTruthy();
  } finally { cleanup(); request.mockRestore(); }
});
