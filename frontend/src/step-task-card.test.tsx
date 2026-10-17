import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StepTaskCard,
  STEP_MATERIAL_ACTION_ID,
  focusStepPrimaryAction,
  materialStatusForStep,
  reportMaterialStatus,
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
      <StepTaskCard step={step} complete materialStatus="missing" />,
    );
    expect(html).toContain("先运行，再判断。");
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain("理解题：已完成");
    expect(html).toContain("报告材料：未齐全");
    // No caveat line, jump button, rationale fold, concept, handoff or deps: only goal, tasks and status.
    expect(html).not.toContain("注意：");
    expect(html).not.toContain("区间跨零就是看不出。");
    expect(html).not.toContain("为什么做这一步");
    expect(html).not.toContain("开始本步");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("同一问题只换指标。");
    expect(html).not.toContain("rail-chips");
    expect(html).toContain(`id="${stepTaskTitleId(step.n)}" tabindex="-1"`);
    expect(stepPrimaryActionLabel(step)).toBe("贸易流回归 · 操作区");

    const saving = renderToStaticMarkup(
      <StepTaskCard step={step} complete materialStatus="saving" />,
    );
    expect(saving).toContain('class="saving"');
    expect(saving).toContain("报告材料：保存中");
    const failed = renderToStaticMarkup(
      <StepTaskCard step={step} complete materialStatus="unsynced" />,
    );
    expect(failed).toContain("报告材料：未保存");
    expect(failed).not.toContain("保存中");
  });

  for (const [index, outcome] of (["trade", "production", "length", "network"] as const).entries()) {
    test(`step ${11 + index} shows its goal, short tasks and truthful statuses, without a second start button`, () => {
      const step: Step = {
        n: 11 + index, stage: 4, lab: "reg", regression_outcome: outcome, status: "demo",
        title: "回归", goal: "原来很长的任务目标", tasks: ["旧任务一", "旧任务二", "旧任务三"],
        concept: "原来单独展开的说明", tip: "边界", deps: [], handoff: { input: "输入", action: "运行", output: "结果" },
      };
      for (const [status, label] of [
        ["checking", "检查中"], ["saving", "保存中"], ["unsynced", "未保存"], ["ready", "已齐全"], ["missing", "未齐全"],
      ] as const) {
        const html = renderToStaticMarkup(<StepTaskCard step={step} complete={false} materialStatus={status} />);
        const dom = new DOMParser().parseFromString(html, "text/html");
        expect(dom.querySelector(".step-task-card.compact")).not.toBeNull();
        expect(dom.querySelector("button, details")).toBeNull();
        expect(html).toContain("原来很长的任务目标");
        // The short task lines show here too (step 12 tells the student to hover, not click, the grey bar).
        expect(html).toContain("旧任务一");
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
     
    />);
    expect(html).toContain("报告：未生成");
    expect(html).not.toContain("理解题：未完成");
    const generated = renderToStaticMarkup(<StepTaskCard
      step={reportStep} complete materialStatus="ready" reportExists reportCurrent
    />);
    expect(generated).toContain("报告：已生成");
    expect(generated).not.toContain("报告：已完成");
    expect(generated).not.toContain("已提交");
    // A report that no longer matches saved material needs updating, not generating.
    const outdated = renderToStaticMarkup(<StepTaskCard
      step={reportStep} complete={false} materialStatus="ready" reportExists reportCurrent={false}
    />);
    expect(outdated).toContain("报告：需更新");
    expect(outdated).not.toContain("未生成");
    // Handed in, then the record changed: the step still counts as done (green), and the report reads 需更新.
    const handedInOutdated = renderToStaticMarkup(<StepTaskCard
      step={reportStep} complete materialStatus="ready" reportExists reportState="graded" reportCurrent={false}
    />);
    expect(handedInOutdated).toContain('class="done">报告：需更新');
    // A current report says where it stands with the teacher: generating is not submitting.
    // As the server sends it, a draft is not complete.
    const label = (reportState: "draft" | "pending" | "graded") => renderToStaticMarkup(<StepTaskCard
      step={reportStep} complete={reportState !== "draft"} materialStatus="ready" reportExists reportState={reportState}
    />);
    expect(label("draft")).toContain('class="todo">报告：草稿（未提交）');
    expect(label("pending")).toContain('class="done">报告：待评阅');
    expect(label("graded")).toContain('class="done">报告：已评阅');
  });

  test("step 15's status names what it counts, the analysis answers, and ignores steps 1–14", () => {
    const reportStep: Step = {
      n: 15, stage: 5, lab: "rep", status: "demo", title: "生成实验报告",
      goal: "形成闭环。", tasks: ["检查", "生成", "提交"], concept: "", tip: "", deps: [],
      handoff: { input: "", action: "", output: "" },
    };
    // Steps 1–14 complete, the analysis missing: 你的分析 未完成, never 报告材料 未齐全.
    expect(reportMaterialStatus([{ step: 15 }])).toBe("missing");
    // Steps 1–14 missing, the analysis written: the step-15 chip is done; the gate card lists the rest.
    expect(reportMaterialStatus([{ step: 8 }, { step: 0 }])).toBe("ready");
    expect(reportMaterialStatus(null)).toBe("checking");
    const missing = renderToStaticMarkup(<StepTaskCard step={reportStep} complete={false} materialStatus="missing" />);
    expect(missing).toContain("你的分析：未完成");
    expect(missing).not.toContain("报告材料");
    const ready = renderToStaticMarkup(<StepTaskCard step={reportStep} complete={false} materialStatus="ready" />);
    expect(ready).toContain("你的分析：已完成");
    expect(renderToStaticMarkup(<StepTaskCard step={reportStep} complete={false} materialStatus="saving" />)).toContain("你的分析：保存中");
  });

  test("after submission the task card carries no banner: each step's material card says it once", () => {
    const step = (n: number, lab: Step["lab"] = "viz"): Step => ({
      n, stage: 3, lab, status: "demo", title: `步骤${n}`, goal: "目标",
      tasks: ["在图下点“记为本步报告材料”", "比较", "答题"], concept: "", tip: "", deps: [],
      handoff: { input: "", action: "", output: "" },
    });
    for (const [n, reportState] of [[1, "pending"], [6, "pending"], [7, "graded"], [10, "pending"], [15, "pending"]] as const) {
      const html = renderToStaticMarkup(<StepTaskCard step={step(n, n === 15 ? "rep" : "viz")} complete materialStatus="ready" reportExists reportState={reportState} />);
      expect(html).not.toContain("自动记录已暂停");
      expect(html).not.toContain("step-task-locked");
    }
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
