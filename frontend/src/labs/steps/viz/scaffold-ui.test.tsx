import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { VizWorkbench } from "./scaffold";

afterEach(cleanup);

function WorkbenchHarness() {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <VizWorkbench
      title="贸易流指标对比"
      toolbar={<div>镜头</div>}
      years={[2020]}
      year={2020}
      onYearChange={() => {}}
      countries={["CHN", "USA"]}
      picked={picked}
      onPick={setPicked}
    >
      <div>图表</div>
    </VizWorkbench>
  );
}

describe("visualization workbench country selection", () => {
  test("keeps the page inline after reaching the suggested two-country comparison", async () => {
    render(<WorkbenchHarness />);
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);

    expect(checkboxes.filter((node) => node.checked)).toHaveLength(2);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("全屏探索：贸易流指标对比")).toBeDefined();
  });
});
