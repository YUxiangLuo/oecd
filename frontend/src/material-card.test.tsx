import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AUTO_RECORD_HOW, MaterialCard } from "./material-card";
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
  expect(screen.getByText("核对已记录的读数 · 2 条").tagName).toBe("SUMMARY");
  view.rerender(<MaterialCard state="recorded" summary="已记" locked rechosen action={{ label: "已记录为本步报告材料", disabled: true }} />);
  const how = document.querySelector(".material-card-how")?.textContent ?? "";
  expect(how).toContain(MATERIAL_LOCKED_NOTE);
  expect(how).toContain(MATERIAL_RECHOSEN_NEXT);
  expect((screen.getByRole("button", { name: "已记录为本步报告材料" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<MaterialCard state="blocked" summary="这张图没有可记录的读数条目。" syncError="失败" onRetrySync={() => {}} />);
  expect(document.querySelector(".material-chip")?.textContent).toBe("暂不能记录");
  expect(screen.getByRole("alert").textContent).toContain("材料还没保存成功");
  expect(screen.getByRole("button", { name: "重试同步" })).toBeTruthy();
});
