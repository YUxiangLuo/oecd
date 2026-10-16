import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AUTO_RECORD_HOW, MATERIAL_CONFLICT_NOTE, MaterialCard } from "./material-card";
import { MATERIAL_LOCKED_NOTE, MATERIAL_RECHOSEN_NEXT } from "./step-task-card";

afterEach(cleanup);

test("the card names itself the same on every step, with a chip for its state and the one summary sentence", () => {
  render(<MaterialCard state="recorded" summary="2020 年 外国增加值项占比：CHN 中国 11.730%" how={AUTO_RECORD_HOW} />);
  const card = screen.getByRole("region", { name: "本步报告材料" });
  expect(card.id).toBe("step-material-action");
  expect(card.className).toContain("material-card--recorded");
  expect(card.querySelector(".material-chip")?.textContent).toBe("已记录");
  expect(screen.getByRole("status").textContent).toBe("2020 年 外国增加值项占比：CHN 中国 11.730%");
  expect(card.querySelector(".material-card-how")?.textContent).toBe(AUTO_RECORD_HOW);
  expect(card.querySelector("button")).toBeNull();
  expect(card.querySelector("details")).toBeNull();
});

test("a step that records on request shows one button; locked and re-recorded states add their sentences; the check fold is the only one", () => {
  let clicks = 0;
  const view = render(<MaterialCard state="missing" summary="尚未记录" how="每步记一张图" action={{ label: "把这张图记为本步报告材料", onClick: () => { clicks += 1; } }} check={{ label: "核对已记录的读数 · 2 条", content: <table><tbody><tr><td>x</td></tr></tbody></table> }} />);
  expect(screen.getByRole("region", { name: "本步报告材料" }).querySelector(".material-chip")?.textContent).toBe("尚未记录");
  fireEvent.click(screen.getByRole("button", { name: "把这张图记为本步报告材料" }));
  expect(clicks).toBe(1);
  expect(document.activeElement).toBe(document.body);
  screen.getByRole("button", { name: "把这张图记为本步报告材料" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "把这张图记为本步报告材料" }));
  expect(clicks).toBe(2);
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "本步报告材料" }));
  expect(screen.getByText("核对已记录的读数 · 2 条").tagName).toBe("SUMMARY");
  view.rerender(<MaterialCard state="recorded" summary="已记" locked rechosen action={{ label: "已记录为本步报告材料", disabled: true }} />);
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "本步报告材料" }));
  const how = document.querySelector(".material-card-how")?.textContent ?? "";
  expect(how).toContain(MATERIAL_LOCKED_NOTE);
  expect(how).toContain(MATERIAL_RECHOSEN_NEXT);
  expect((screen.getByRole("button", { name: "已记录为本步报告材料" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<MaterialCard state="blocked" summary="这张图没有可记录的读数条目。" syncError="失败" onRetrySync={() => {}} />);
  expect(document.querySelector(".material-chip")?.textContent).toBe("暂不能记录");
  expect(screen.getByRole("alert").textContent).toContain("材料还没保存成功");
  expect(screen.getByRole("button", { name: "重试同步" })).toBeTruthy();
});

test("an unsaved material is not called recorded; a conflict says where to act instead of offering a retry that cannot help", () => {
  let retries = 0;
  const view = render(<MaterialCard state="recorded" summary="JPN 9.891%" syncError="网络错误" onRetrySync={() => { retries += 1; }} />);
  const card = screen.getByRole("region", { name: "本步报告材料" });
  expect(card.querySelector(".material-chip")?.textContent).toBe("未保存");
  fireEvent.click(screen.getByRole("button", { name: "重试同步" }));
  expect(retries).toBe(1);
  view.rerender(<MaterialCard state="recorded" summary="JPN 9.891%" how="当前例子就是已记录的材料；换国家或行业后自动更新。" syncError="冲突" syncConflict onRetrySync={() => { retries += 1; }} />);
  expect(screen.getByRole("alert").textContent).toBe(MATERIAL_CONFLICT_NOTE);
  // Neither the "already recorded" line nor the recorded colour while it is not saved.
  expect(card.querySelector(".material-card-how")).toBeNull();
  expect(card.className).toContain("material-card--missing");
  expect(screen.queryByRole("button", { name: "重试同步" })).toBeNull();
  // Without an error for this step (another step's edit failed), the card reads as recorded.
  view.rerender(<MaterialCard state="recorded" summary="JPN 9.891%" how="当前例子就是已记录的材料；换国家或行业后自动更新。" syncError={null} />);
  expect(card.querySelector(".material-chip")?.textContent).toBe("已记录");
  expect(card.querySelector(".material-card-how")?.textContent).toContain("已记录的材料");
  expect(card.className).toContain("material-card--recorded");
  expect(screen.queryByRole("alert")).toBeNull();
});
