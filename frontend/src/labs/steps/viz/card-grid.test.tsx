import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CardGrid, CARDS_IN_VIEW } from "./card-grid";

afterEach(cleanup);

test("two cards stay in view; the rest open and close with 更多读数", () => {
  const view = render(
    <CardGrid label="对比读数">
      <div>本国</div>
      <div>排名</div>
      {false}
      <div>中位数</div>
      <div>对比国</div>
    </CardGrid>,
  );
  const grid = screen.getByRole("group", { name: "对比读数" });
  expect(CARDS_IN_VIEW).toBe(2);
  expect(grid.classList.contains("folded")).toBe(true);
  expect(grid.children).toHaveLength(4);
  const toggle = screen.getByRole("button", { name: "更多读数（2）" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(grid.classList.contains("folded")).toBe(false);
  expect(screen.getByRole("button", { name: "收起读数" }).getAttribute("aria-expanded")).toBe("true");
  view.unmount();
  // Two cards or fewer: no button, nothing folded.
  render(<CardGrid label="趋势读数"><div>a</div><div>b</div></CardGrid>);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByRole("group", { name: "趋势读数" }).classList.contains("folded")).toBe(false);
});
