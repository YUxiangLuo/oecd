import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "./api";
import {
  DEFAULT_REGRESSION_SETTINGS,
  QualifiedRegressionRunCard,
  RegressionRequestError,
  RegressionRequestLoading,
  RegressionRunLab,
  regressionDesignRequestKey,
  regressionOptionsRequestKey,
  regressionSettingsFromSavedDesign,
  scrollRegressionVerdict,
  type RegressionHistory,
  type SavedRegressionRun,
} from "./regression";
import { FamilyMap } from "./regression-teach";
import type { Step, StepStateApi } from "./types";

afterEach(cleanup);

const savedRun: SavedRegressionRun = {
  settings: { ...DEFAULT_REGRESSION_SETTINGS },
  design: {
    outcome: "production",
    depvar: "3b_VA_GVC_C_share",
    depvar_label: "复杂 GVC 生产份额",
    granularity: "country_industry",
    shock_type: "tariff",
    shock_col: "tariff_shock",
    treated_col: "treated",
    method: "did",
    control_mode: "none",
    interaction: false,
    price_mode: "nominal",
    scenario: "clean",
    weight_mode: "fixed_pretreatment",
    scenario_label: "基准教学面板",
    sample_filter: "排除 ROW",
    exclude_row: true,
    controls: [],
    control_labels: {},
    equation: "y = treated × post + FE",
    equation_parts: [],
    panel_file: "panel_industry.csv",
    entity: "entity_id",
    cluster: "country",
  },
  result: {
    depvar: "3b_VA_GVC_C_share",
    coefs: [{
      name: "treated×post", coef: 0.012, se: 0.004, t: 3, p: 0.003,
      stars: "**", ci_low: 0.004, ci_high: 0.02,
    }],
    n_obs: 100,
    n_entities: 20,
    n_times: 5,
    n_clusters: 10,
    r2_within: 0.2,
    depvar_mean: 0.3,
    depvar_std: 0.08,
    diagnostics: {},
    notes: [],
    status: "ok",
    status_reasons: [],
    support: {
      treated_clusters: 6,
      untreated_clusters: 4,
      treated_entities: 12,
      untreated_entities: 8,
      total_entities: 20,
      reversal_entities: [],
      reversal_share: 0,
      absorbing: true,
      status: "ok",
      reasons: [],
      min_treated_clusters: 5,
      max_reversal_share: 0.05,
      suppress_inference: false,
    },
  },
};

const regressionStep: Step = {
  n: 13,
  stage: 4,
  lab: "reg",
  regression_outcome: "production",
  status: "done",
  title: "生产回归",
  goal: "",
  tasks: ["one", "two", "three"],
  concept: "",
  tip: "",
  deps: [],
  handoff: { input: "input", action: "action", output: "output" },
};

function regressionState(data?: { run?: SavedRegressionRun; qualified_run?: SavedRegressionRun }): StepStateApi {
  return {
    data,
    save: () => {},
    complete: false,
    syncing: false,
    syncError: null,
    syncNow: () => {},
  };
}

function labProps(state: StepStateApi, confirmed?: { run?: SavedRegressionRun; qualified_run?: SavedRegressionRun }) {
  return {
    step: regressionStep,
    settings: DEFAULT_REGRESSION_SETTINGS,
    onSettingsChange: () => {},
    history: {} as RegressionHistory,
    onHistoryChange: () => {},
    state,
    getConfirmedStep: <T,>() => confirmed as T | undefined,
  };
}

function relativeLuminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((part) => Number.parseInt(part, 16) / 255) ?? [];
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first: string, second: string): number {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("regression verdict scrolling", () => {
  test("scrolls only the nested course content container", () => {
    const calls: ScrollToOptions[] = [];
    let fallbackCalls = 0;
    const scroller = {
      scrollTop: 320,
      getBoundingClientRect: () => ({ top: 180 }),
      scrollTo: (options: ScrollToOptions) => calls.push(options),
    };
    const target = {
      closest: (selector: string) => selector === ".content" ? scroller : null,
      getBoundingClientRect: () => ({ top: 540 }),
      scrollIntoView: () => { fallbackCalls += 1; },
    } as unknown as HTMLElement;

    scrollRegressionVerdict(target, "smooth");

    expect(calls).toEqual([{ top: 680, left: 0, behavior: "smooth" }]);
    expect(fallbackCalls).toBe(0);
  });
});

describe("regression request identity and accessible request states", () => {
  test("keys options and every design by the current settings identity", () => {
    const first = regressionDesignRequestKey("production", DEFAULT_REGRESSION_SETTINGS);
    const changed = regressionDesignRequestKey("production", {
      ...DEFAULT_REGRESSION_SETTINGS,
      method: "event_study",
    });
    expect(regressionOptionsRequestKey("production")).toBe("regression-options:production");
    expect(first).not.toBe(changed);
    expect(changed).toContain("event_study");
  });

  test("announces only genuinely pending option and design requests", () => {
    const loading = renderToStaticMarkup(
      <RegressionRequestLoading optionsLoading designLoading />,
    );
    expect(loading.match(/role="status"/g)).toHaveLength(1);
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("回归选项与当前模型设计");

    const optionsLoading = renderToStaticMarkup(
      <RegressionRequestLoading optionsLoading designLoading={false} />,
    );
    expect(optionsLoading).toContain("正在读取回归选项");
    expect(optionsLoading).toContain('role="status"');

    const designLoading = renderToStaticMarkup(
      <RegressionRequestLoading optionsLoading={false} designLoading />,
    );
    expect(designLoading).toContain("正在生成当前模型设计");
    expect(designLoading).toContain('role="status"');
  });

  test("options error with an idle disabled design has retry but no loading announcement", () => {
    const failed = renderToStaticMarkup(
      <>
        <RegressionRequestLoading optionsLoading={false} designLoading={false} />
        <RegressionRequestError label="回归选项" error="Failed to fetch" onRetry={() => {}} />
      </>,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("网络连接中断，请检查连接后重试");
    expect(failed).toContain("重试回归选项");
    expect(failed).not.toContain('role="status"');
    expect(failed).not.toContain("aria-busy");
    expect(failed).not.toContain("正在读取");
    expect(failed).not.toContain("正在生成");
  });

  test("full lab follows the options-error/design-idle state in run card and technical details", async () => {
    const originalOptions = api.regressionOptions;
    const originalDesign = api.regressionDesign;
    let designCalls = 0;
    api.regressionOptions = async () => { throw new Error("Failed to fetch"); };
    api.regressionDesign = async () => {
      designCalls += 1;
      return savedRun.design;
    };
    try {
      const { container } = render(<RegressionRunLab {...labProps(regressionState())} />);
      expect((await screen.findByRole("alert")).textContent).toContain("网络连接中断，请检查连接后重试");
      await waitFor(() => expect(designCalls).toBe(0));
      const tree = container.textContent ?? "";
      expect(designCalls).toBe(0);
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
      expect(tree).toContain("网络连接中断，请检查连接后重试");
      expect(tree).toContain("当前方程不可用；请先在上方重试回归选项");
      expect(tree).not.toContain("正在生成当前方程");
      expect(tree).not.toContain("正在生成当前模型设计");
      expect(tree).not.toContain("正在读取回归选项");
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.querySelector("[aria-busy]")).toBeNull();
    } finally {
      api.regressionOptions = originalOptions;
      api.regressionDesign = originalDesign;
    }
  });
});

describe("cross-step comparison guidance", () => {
  for (const previousMethod of ["did", "twfe_intensity", "event_study"] as const) {
    for (const [index, outcome] of (["production", "length", "network"] as const).entries()) {
      test(`${outcome} ATT does not claim to match step 11 ${previousMethod}`, () => {
        const previousRun: SavedRegressionRun = {
          ...savedRun,
          settings: { ...savedRun.settings, method: previousMethod },
          design: { ...savedRun.design, outcome: "trade", method: previousMethod },
        };
        const html = renderToStaticMarkup(
          <RegressionRunLab
            {...labProps(regressionState())}
            step={{ ...regressionStep, n: 12 + index, regression_outcome: outcome }}
            getStep={<T,>(n: number) => n === 11 ? { run: previousRun } as T : undefined}
          />,
        );
        expect(html).toContain("用四格理解当前 ATT 比较（选做复习）");
        expect(html).toContain("跨步骤并读前，请核对各步实际保存的比较方法与设定");
        expect(html).not.toContain("比较方法与步骤 11 相同");
        expect(html).not.toContain("和步骤 11 同一套比较");
        expect(html).toContain("相对变化 =（B−A）−（D−C）");
      });
    }
  }

  test("step 11 retains its numerical four-cell teaching example", () => {
    const html = renderToStaticMarkup(
      <RegressionRunLab
        {...labProps(regressionState())}
        step={{ ...regressionStep, n: 11, regression_outcome: "trade" }}
      />,
    );
    expect(html).toContain("步骤 11 · 用四格数字理解比较");
    expect(html).toContain("这组数字只用来讲清四格，不是本步估计结果");
    const dom = new DOMParser().parseFromString(html, "text/html");
    expect(dom.querySelectorAll(".reg-family-map").length).toBe(1);
    expect(dom.querySelector(".reg-workbench")?.firstElementChild?.className).toBe("reg-family-map");
    expect(dom.querySelector(".metric-facts")?.textContent).toContain("外国增加值项占比");
    expect(dom.querySelector(".reg-run-card")?.textContent).not.toMatch(/课程 FVA|EXGR_FVASH|真实 OECD/);
    expect(dom.querySelector(".reg-family-map")?.textContent).toContain("网络（探索性）");
    // Detailed accounting definitions remain available in the existing collapsed explanation.
    expect(dom.querySelector(".reg-question-card")?.hasAttribute("open")).toBe(false);
    expect(dom.querySelector(".reg-question-card")?.textContent).toContain("FVA+FDC");
    expect(dom.querySelector(".reg-question-card")?.textContent).toContain("EXGR_FVASH");
  });
});

describe("task-first regression setup", () => {
  for (const outcome of ["trade", "production", "length", "network"] as const) {
    test(`${outcome} keeps optional controls in one existing disclosure`, () => {
      const html = renderToStaticMarkup(<RegressionRunLab {...labProps(regressionState())}
        step={{ ...regressionStep, regression_outcome: outcome }} />);
      const dom = new DOMParser().parseFromString(html, "text/html");
      const run = dom.querySelector(".reg-run-card")!;
      const advanced = run.querySelector(".advanced-settings")!;
      const focus = run.querySelector(".reg-lesson-focus")!;
      expect(advanced.hasAttribute("open")).toBe(false);
      expect(advanced.querySelector('[aria-label="政策冲击"]')).not.toBeNull();
      expect(advanced.querySelector('[aria-label="控制变量"]')).toBeNull();
      expect(advanced.querySelector('input[type="checkbox"]')).toBeNull();
      expect(advanced.textContent).toContain("控制变量不开放");
      expect(advanced.textContent).toContain("当前分批处理方法不开放交互项");
      expect(run.querySelectorAll(":scope > button")).toHaveLength(1);
      expect(run.querySelectorAll("details")).toHaveLength(1);
      const summary = run.querySelector(":scope > .run-summary")!.textContent!;
      expect(summary).toContain("tariff");
      expect(summary).toContain("country_industry");
      expect(summary).toContain("固定处理前权重");
      expect(summary).not.toMatch(/无交互|基准教学面板|cohort/);
      expect(advanced.textContent).toContain("完整设定");
      expect(advanced.textContent).toContain("无交互");
      expect(focus.textContent).toContain({ trade: "四格例子", production: "生产规模", length: "不是百分点", network: "探索性拓扑" }[outcome]);
      expect(dom.querySelector(".reg-compare-card")?.hasAttribute("open")).toBe(outcome === "trade");
    });
  }

  test("a restored nondefault scenario and interaction remain visible without opening settings", () => {
    const settings = { ...DEFAULT_REGRESSION_SETTINGS, shockType: "sanctions", method: "twfe_intensity", scenario: "noisy", interaction: true };
    const html = renderToStaticMarkup(<RegressionRunLab {...labProps(regressionState())}
      step={{ ...regressionStep, regression_outcome: "trade" }} settings={settings} />);
    const dom = new DOMParser().parseFromString(html, "text/html");
    const run = dom.querySelector(".reg-run-card")!;
    const summary = run.querySelector(":scope > .run-summary")!.textContent!;
    expect(run.querySelector(".metric-facts")?.textContent).toContain("TWFE（描述性）");
    const focus = run.querySelector(".reg-lesson-focus")!.textContent!;
    expect(focus).toContain("看冲击强度变大时");
    expect(focus).not.toMatch(/逐批次|从未处理|四格例子/);
    expect(summary).toContain("sanctions");
    expect(summary).toContain("含交互");
    expect(summary).toContain("人为加入测量噪声");
    expect(run.querySelector('input[type="checkbox"]')?.hasAttribute("checked")).toBe(true);
    expect(run.querySelector(".reg-compare-card")).toBeNull();
  });
});

test("restored dynamic ATT guidance describes event time, not an absent four-cell example", () => {
  const settings = { ...DEFAULT_REGRESSION_SETTINGS, method: "event_study" };
  const html = renderToStaticMarkup(<RegressionRunLab {...labProps(regressionState())}
    step={{ ...regressionStep, regression_outcome: "trade" }} settings={settings} />);
  const dom = new DOMParser().parseFromString(html, "text/html");
  const focus = dom.querySelector(".reg-lesson-focus")!.textContent!;
  expect(focus).toContain("逐事件时间汇总各批次的 ATT");
  expect(focus).toContain("冲击前看不出差别不能证明趋势可比");
  expect(focus).not.toContain("四格例子");
  expect(dom.querySelector(".reg-compare-card")).toBeNull();
});

describe("preserved qualified regression result", () => {
  test("renders the saved design/result rather than a current invalid run", () => {
    const restored = structuredClone(savedRun);
    restored.settings = { ...restored.settings, shockType: "sanctions", method: "event_study" };
    expect(regressionSettingsFromSavedDesign(restored.design)).toMatchObject({
      shockType: "tariff",
      method: "did",
      granularity: "country_industry",
    });
    const html = renderToStaticMarkup(
      <QualifiedRegressionRunCard
        saved={restored}
        confirmedSaved={structuredClone(restored)}
        options={null}
        currentSettings={{ ...DEFAULT_REGRESSION_SETTINGS, method: "event_study" }}
        sessionUnsynced
        onSwitch={() => {}}
      />,
    );
    expect(html).toContain("已由服务器确认");
    expect(html).toContain("已保留一份对照快照");
    expect(html).toContain("已保留的可推断回归快照");
    expect(html).not.toContain("正在等待自动保存");
    expect(html).toContain("tariff");
    expect(html).toContain("country_industry");
    expect(html).toContain("处理后相对变化");
    expect(html).toContain("+1.20 个百分点");
    expect(html).toContain("[+0.40, +2.00] 个百分点");
    expect(html).toContain("6 个处理聚类");
    expect(html).toContain("状态=ok");
    expect(html).toContain("切换到这套设定");
    expect(html).not.toContain("当前无效运行");
  });

  test("distinguishes pending, failed, and server-confirmed candidate wording", () => {
    const pending = structuredClone(savedRun);

    const pendingHtml = renderToStaticMarkup(
      <QualifiedRegressionRunCard
        saved={pending}
        options={null}
        currentSettings={DEFAULT_REGRESSION_SETTINGS}
        sessionUnsynced
        onSwitch={() => {}}
      />,
    );
    expect(pendingHtml).toContain("估计完成，正在保存到第 15 步");
    expect(pendingHtml).toContain("正在等待自动保存");
    expect(pendingHtml).toContain("尚未由服务器确认");
    expect(pendingHtml).not.toContain("已保留一份");
    expect(pendingHtml).not.toContain("已由服务器确认");
    expect(pendingHtml).not.toContain("已保留的可推断回归快照");

    const syncingHtml = renderToStaticMarkup(
      <QualifiedRegressionRunCard
        saved={pending}
        options={null}
        currentSettings={DEFAULT_REGRESSION_SETTINGS}
        sessionSyncing
        sessionUnsynced
        onSwitch={() => {}}
      />,
    );
    expect(syncingHtml).toContain("系统正在把完全相同的结果保存到服务器");

    const failedHtml = renderToStaticMarkup(
      <QualifiedRegressionRunCard
        saved={pending}
        options={null}
        currentSettings={DEFAULT_REGRESSION_SETTINGS}
        sessionUnsynced
        sessionSyncError="offline"
        onSwitch={() => {}}
      />,
    );
    expect(failedHtml).toContain('role="alert"');
    expect(failedHtml).toContain("尚未由服务器确认");
    expect(failedHtml).not.toContain("已保留一份");
    expect(failedHtml).toContain("同步失败；第15步不会在服务器确认前使用");
    expect(failedHtml).not.toContain("已保留的可推断回归快照");
  });

  test("keeps the compact card inside the supported 1200px workarea", async () => {
    const css = await Bun.file(new URL("./workbench.css", import.meta.url)).text();
    expect(css).toMatch(/\.reg-workbench > \*[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.qualified-run-card\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.qualified-run-facts\s*\{[^}]*repeat\(4, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/\.qualified-run-settings\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

});

describe("active regression-family contrast", () => {
  test("keeps visible current semantics and at least 4.5:1 step-text contrast", async () => {
    const css = await Bun.file(new URL("./workbench.css", import.meta.url)).text();
    const activeColor = css.match(/\.reg-family-item\.current \.reg-family-step\s*\{\s*color:\s*(#[0-9a-f]{6})/i)?.[1];
    const activeBackground = css.match(/\.reg-family-item\.current \.reg-family-btn\s*\{[^}]*background:\s*(#[0-9a-f]{6})/i)?.[1];
    expect(activeColor).toBeDefined();
    expect(activeBackground).toBe("#eef0ff");
    expect(contrast(activeColor!, activeBackground!)).toBeGreaterThanOrEqual(4.5);

    const html = renderToStaticMarkup(
      <FamilyMap current="production" history={{}} onNavigateStep={() => {}} />,
    );
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain("当前");
  });
});
