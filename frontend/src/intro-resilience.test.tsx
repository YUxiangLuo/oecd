import { expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { api } from "./api";
import { IntroOverlay } from "./intro";
import type { ShockEvent } from "./types";

const user = { username: "student", name: "学生", role: "student" as const };
const stepsData = { stages: { "1": "数据接入" }, steps: [] };
const empty = { events: [], disclaimer: "", source_disclosure: "" };
const event: ShockEvent = {
  name: "测试事件", imposer: "USA", targets: "CHN", exempt: "", announced: "2018-01-01",
  effective: "2018-02-01", n_sectors: 1, top_sectors: [], peak_rate: 0.1,
  source_status: "teaching_encoding_no_event_source", source_disclosure: "教学设定", source_urls: [],
};

const open = () => render(<IntroOverlay user={user} meta={null} stepsData={stepsData} onDone={() => {}} />);

test("event loading, failure, retry and success remain distinct from a valid empty directory", async () => {
  let reject!: (reason: Error) => void;
  let resolveRetry!: (value: Awaited<ReturnType<typeof api.shockEvents>>) => void;
  const first = new Promise<Awaited<ReturnType<typeof api.shockEvents>>>((_, fail) => { reject = fail; });
  const retry = new Promise<Awaited<ReturnType<typeof api.shockEvents>>>((resolve) => { resolveRetry = resolve; });
  const request = spyOn(api, "shockEvents").mockReturnValueOnce(first).mockReturnValueOnce(retry);
  try {
    const view = open();
    fireEvent.click(view.getByRole("button", { name: "介绍页 2" }));
    fireEvent.click(view.getByRole("button", { name: /贸易政策冲击面板/ }));
    expect(view.getByRole("status").textContent).toBe("正在加载事件信息…");
    await act(async () => { reject(new Error("offline")); });
    expect(view.getByRole("alert").textContent).toContain("暂时无法加载");
    expect(view.queryByText(/共 0 组事件/) === null).toBe(true);
    expect(view.queryByText("当前事件目录为空。") === null).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "重试加载事件" }));
    expect(document.activeElement).toBe(view.getByRole("button", { name: /贸易政策冲击面板/ }));
    expect(view.queryAllByRole("alert").length).toBe(0);
    expect(view.getByRole("status").textContent).toBe("正在加载事件信息…");
    await act(async () => { resolveRetry({ ...empty, events: [event] }); });
    fireEvent.click(view.getByText("查看完整事件目录"));
    expect(view.getByText(/测试事件/).textContent).toContain("2018-02-01");
    expect(view.getByText(/共 1 组事件/).textContent).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(2);
  } finally { cleanup(); request.mockRestore(); }
});

test("a successfully loaded empty event directory is explicitly labelled empty", async () => {
  const request = spyOn(api, "shockEvents").mockResolvedValue(empty);
  try {
    const view = open();
    fireEvent.click(view.getByRole("button", { name: "介绍页 2" }));
    fireEvent.click(view.getByRole("button", { name: /贸易政策冲击面板/ }));
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("当前事件目录为空。"));
    expect(view.queryAllByRole("alert").length).toBe(0);
    expect(view.queryByRole("button", { name: "重试加载事件" }) === null).toBe(true);
  } finally { cleanup(); request.mockRestore(); }
});

test("scene headings receive focus and local controls never trigger global arrow navigation", async () => {
  const request = spyOn(api, "shockEvents").mockResolvedValue(empty);
  try {
    const view = open();
    await waitFor(() => expect(document.activeElement?.textContent).toBe("供应链仿真系统"));
    const heading = () => document.activeElement as HTMLElement;
    fireEvent.keyDown(heading(), { key: "ArrowRight", ctrlKey: true });
    expect(heading().textContent).toBe("供应链仿真系统");
    fireEvent.keyDown(heading(), { key: "ArrowRight" });
    expect(heading().textContent).toBe("数据来源与教学设定");
    fireEvent.keyDown(view.getByRole("button", { name: /贸易政策冲击面板/ }), { key: "ArrowRight" });
    expect(view.queryAllByRole("button", { name: /贸易政策冲击面板/ }).length).toBe(1);
    fireEvent.click(view.getByRole("button", { name: "介绍页 3" }));
    fireEvent.keyDown(view.getByRole("button", { name: "1. 数据接入" }), { key: "ArrowRight" });
    expect(view.queryAllByRole("button", { name: "1. 数据接入" }).length).toBe(1);
    fireEvent.click(view.getByRole("button", { name: "介绍页 4" }));
    fireEvent.keyDown(view.getByRole("button", { name: /贸易转移/ }), { key: "ArrowRight" });
    fireEvent.keyDown(view.getByRole("slider"), { key: "ArrowRight" });
    expect(view.queryAllByRole("slider").length).toBe(1);
    fireEvent.click(view.getByRole("button", { name: "下一页" }));
    expect(heading().textContent).toBe("实验台已就绪");
    expect(view.getByRole("dialog").contains(heading())).toBe(true);
    fireEvent.keyDown(heading(), { key: "ArrowLeft" });
    expect(view.queryAllByRole("slider").length).toBe(1);
  } finally { cleanup(); request.mockRestore(); }
});
