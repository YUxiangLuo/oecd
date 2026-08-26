import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { VizWorkbench } from "./scaffold";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<WorkbenchHarness />);
      });

      const checkboxes = () => renderer!.root.findAll((node) => node.type === "input" && node.props.type === "checkbox");
      await act(async () => checkboxes()[0].props.onChange());
      await act(async () => checkboxes()[1].props.onChange());

      expect(checkboxes().filter((node) => node.props.checked)).toHaveLength(2);
      expect(renderer!.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
      expect(renderer!.root.findAll((node) => node.props["aria-label"] === "全屏探索：贸易流指标对比")).toHaveLength(1);
    } finally {
      if (renderer) await act(async () => renderer?.unmount());
    }
  });
});
