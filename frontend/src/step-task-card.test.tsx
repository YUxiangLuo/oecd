import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StepTaskCard,
  focusStepPrimaryAction,
  materialStatusForStep,
} from "./step-task-card";
import type { Step } from "./types";

const runtime = globalThis as unknown as { window?: Pick<Window, "matchMedia"> };
const originalWindow = runtime.window;

afterEach(() => {
  if (originalWindow) runtime.window = originalWindow;
  else runtime.window = undefined;
});

describe("shared step task card", () => {
  test("distinguishes material-gate loading, missing, and ready states independently", () => {
    expect(materialStatusForStep(12, null)).toBe("checking");
    expect(materialStatusForStep(12, [{ step: 12 }])).toBe("missing");
    expect(materialStatusForStep(12, [{ step: 13 }])).toBe("ready");
  });

  test("keeps application navigation and task chrome out of the step-16 printed report", async () => {
    const styles = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    const printRules = styles.slice(styles.indexOf("@media print"));
    expect(printRules).toMatch(/\.step-task-card,?\s*[\s\S]*?display:\s*none\s*!important/);
    expect(printRules).toMatch(/\.skip-to-step-content,?\s*[\s\S]*?display:\s*none\s*!important/);
  });

  test("renders one goal, exactly three actions, and two independent statuses", () => {
    const step: Step = {
      n: 12,
      stage: 4,
      lab: "reg",
      regression_outcome: "trade",
      status: "demo",
      title: "贸易流回归",
      goal: "先运行，再判断。",
      tasks: ["确认指标", "运行回归", "自己判断"],
      concept: "同一问题只换指标。",
      tip: "区间跨零就是看不出。",
      deps: ["step11"],
      handoff: { input: "冲击", action: "估计", output: "证据" },
    };
    const html = renderToStaticMarkup(
      <StepTaskCard step={step} complete materialStatus="missing" contentRef={{ current: null }} />,
    );
    expect(html).toContain("先运行，再判断。");
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain("理解题：已完成");
    expect(html).toContain("报告材料：尚未齐全");
    expect(html).toContain("为什么做这一步");
    expect(html).toContain('class="rail-chips" role="group" aria-label="关联数据与依赖"');
  });

  test("focuses the real workbench and scrolls only its nested course container", () => {
    let focused = 0;
    let received: ScrollToOptions | undefined;
    runtime.window = { matchMedia: () => ({ matches: true }) as MediaQueryList };
    const target = {
      getBoundingClientRect: () => ({ top: 450 }),
      focus: (options: FocusOptions) => {
        focused += 1;
        expect(options).toEqual({ preventScroll: true });
      },
    };
    const content = {
      scrollTop: 100,
      querySelector: () => target,
      getBoundingClientRect: () => ({ top: 200 }),
      scrollTo: (options: ScrollToOptions) => { received = options; },
    };

    expect(focusStepPrimaryAction(content as unknown as HTMLElement)).toBe(true);
    expect(focused).toBe(1);
    expect(received).toEqual({ top: 338, left: 0, behavior: "auto" });
    expect(focusStepPrimaryAction(null)).toBe(false);
  });
});
