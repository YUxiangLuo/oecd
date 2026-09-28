import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StepTaskCard,
  STEP_MATERIAL_ACTION_ID,
  focusStepPrimaryAction,
  materialStatusForStep,
  stepPrimaryActionLabel,
  stepTaskTitleId,
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
    expect(materialStatusForStep(12, [{ step: 12 }], true)).toBe("saving");
    expect(materialStatusForStep(12, [{ step: 13 }], true)).toBe("saving");
    expect(materialStatusForStep(12, [{ step: 12 }])).toBe("missing");
    expect(materialStatusForStep(12, [{ step: 13 }])).toBe("ready");
    expect(materialStatusForStep(12, [], true, true)).toBe("unsynced");
    expect(materialStatusForStep(12, [], false, true)).toBe("unsynced");
  });

  test("keeps application navigation and task chrome out of the step-15 printed report", async () => {
    const styles = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    const printRules = styles.slice(styles.indexOf("@media print"));
    expect(printRules).toMatch(/\.step-task-card,?\s*[\s\S]*?display:\s*none\s*!important/);
    expect(printRules).toMatch(/\.skip-to-step-content,?\s*[\s\S]*?display:\s*none\s*!important/);
  });

  test("renders one goal, exactly three actions, and two independent statuses", () => {
    const step: Step = {
      n: 6,
      stage: 3,
      lab: "viz",
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
    expect(html).toContain(`aria-controls="step-primary-action"`);
    expect(html).toContain(`id="${stepTaskTitleId(step.n)}" tabindex="-1"`);
    expect(html).toContain('class="rail-chips" role="group" aria-label="关联数据与依赖"');
    expect(stepPrimaryActionLabel(step)).toBe("贸易流回归 · 操作区");

    const saving = renderToStaticMarkup(
      <StepTaskCard step={step} complete materialStatus="saving" contentRef={{ current: null }} />,
    );
    expect(saving).toContain('class="saving"');
    expect(saving).toContain("报告材料：正在保存");
    const failed = renderToStaticMarkup(
      <StepTaskCard step={step} complete materialStatus="unsynced" contentRef={{ current: null }} />,
    );
    expect(failed).toContain("报告材料：尚未保存");
    expect(failed).not.toContain("正在保存");
  });

  for (const [index, outcome] of (["trade", "production", "length", "network"] as const).entries()) {
    test(`step ${11 + index} has a single-line task and truthful statuses, without a second start button`, () => {
      const step: Step = {
        n: 11 + index, stage: 4, lab: "reg", regression_outcome: outcome, status: "demo",
        title: "回归", goal: "原来很长的任务目标", tasks: ["旧任务一", "旧任务二", "旧任务三"],
        concept: "原来单独展开的说明", tip: "边界", deps: [], handoff: { input: "输入", action: "运行", output: "结果" },
      };
      for (const [status, label] of [
        ["checking", "正在检查"], ["saving", "正在保存"], ["unsynced", "尚未保存"], ["ready", "已齐全"], ["missing", "尚未齐全"],
      ] as const) {
        const html = renderToStaticMarkup(<StepTaskCard step={step} complete={false} materialStatus={status} contentRef={{ current: null }} />);
        const dom = new DOMParser().parseFromString(html, "text/html");
        expect(dom.querySelector(".step-task-card.compact")).not.toBeNull();
        expect(dom.querySelector("button, details, ol")).toBeNull();
        expect(html).toContain("原来很长的任务目标");
        expect(html).not.toContain("先运行回归，再看结果、完成理解题");
        expect(html).toContain("理解题：未完成");
        expect(html).toContain(`报告材料：${label}`);
        expect(dom.querySelector("h3")?.id).toBe(stepTaskTitleId(step.n));
      }
    });
  }

  test("labels the final completion state as report rather than a nonexistent quiz", () => {
    const reportStep: Step = {
      n: 15, stage: 5, lab: "rep", status: "demo", title: "生成实验报告",
      goal: "形成闭环。", tasks: ["检查", "生成", "提交"], concept: "汇总证据。",
      tip: "复核后提交。", deps: ["保存的材料"],
      handoff: { input: "证据", action: "汇总", output: "报告" },
    };
    const html = renderToStaticMarkup(<StepTaskCard
      step={reportStep}
      complete={false}
      materialStatus="missing"
      contentRef={{ current: null }}
    />);
    expect(html).toContain("报告：未生成");
    expect(html).not.toContain("理解题：未完成");
    const generated = renderToStaticMarkup(<StepTaskCard
      step={reportStep} complete materialStatus="ready" contentRef={{ current: null }}
    />);
    expect(generated).toContain("报告：已生成");
    expect(generated).not.toContain("已完成");
    expect(generated).not.toContain("已提交");
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

  test("opens collapsed material collection before positioning and focusing it", () => {
    runtime.window = { matchMedia: () => ({ matches: true }) as MediaQueryList };
    const content = document.createElement("div");
    const details = document.createElement("details");
    details.id = STEP_MATERIAL_ACTION_ID;
    details.tabIndex = -1;
    content.append(details);
    document.body.append(content);
    let scrolled: ScrollToOptions | undefined;
    details.getBoundingClientRect = () => {
      expect(details.open).toBe(true);
      return { top: 700 } as DOMRect;
    };
    content.getBoundingClientRect = () => ({ top: 150 }) as DOMRect;
    content.scrollTo = ((options: ScrollToOptions) => { scrolled = options; }) as typeof content.scrollTo;
    try {
      expect(focusStepPrimaryAction(content, STEP_MATERIAL_ACTION_ID)).toBe(true);
      expect(document.activeElement).toBe(details);
      expect(scrolled?.top).toBe(538);
    } finally { content.remove(); }
  });
});
