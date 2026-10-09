import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Meta, Step, StepStateApi } from "../../types";
import { NetworkIndicatorStep } from "./indicator/network";
import type { IndicatorStepState } from "./indicator/indicator-table";
import { ChartStory } from "./viz/scaffold";

const meta: Meta = {
  years: [2020], countries: ["CHN", "USA"], sectors: ["A01_02", "C26"],
  dataset: { years: [2020], release_id: "a".repeat(32) },
};
const step: Step = {
  n: 5, stage: 2, lab: "ind", topic: "network", status: "done", title: "网络",
  goal: "", tasks: ["观察", "比较", "记录"], concept: "", tip: "", deps: [],
  handoff: { input: "", action: "", output: "" },
};
const state: StepStateApi<IndicatorStepState> = {
  data: {}, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {},
};

describe("student-facing chart copy", () => {
  test("network instructions do not invent source provenance or a fixed industry count", () => {
    const html = renderToStaticMarkup(<NetworkIndicatorStep meta={meta} step={step} state={state} />);
    expect(html).toContain("当前数据网络");
    expect(html).toContain("该国全部行业");
    // The demo covers all three measures it lets the student switch between (round 21).
    expect(html).toContain("可选：用小型网络演示度、介数与接近中心性的计算");
    expect(html).toContain("介数把很小和很大的流量一视同仁");
    expect(html).not.toMatch(/真实全球图|真实图|45 个行业|原生排序选择器/);
  });

  test("chart prompts invite observation rather than prescribe a discovery", () => {
    const html = renderToStaticMarkup(<ChartStory title="比较" what="构成" read="占比" find="两国有什么差异？">图</ChartStory>);
    expect(html).toContain("试着观察");
    expect(html).not.toContain("该发现");
  });
});

test("steps 2–5 compare economies only: ROW is not offered and a saved ROW falls back", async () => {
  const { IndicatorLab } = await import("./indicator-lab");
  const withRow: Meta = { ...meta, countries: ["CHN", "ROW", "USA"] };
  const saved: StepStateApi<IndicatorStepState> = { ...state, data: { country: "ROW", compared: ["ROW", "USA"] } as IndicatorStepState };
  for (const topic of ["trade", "network"] as const) {
    const html = renderToStaticMarkup(<IndicatorLab meta={withRow} step={{ ...step, topic }} state={saved} />);
    expect(html).not.toContain('value="ROW"');
    expect(html).not.toContain("ROW 世界其他地区");
  }
});
