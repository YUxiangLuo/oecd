import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
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
  type RegressionHistory,
  type SavedRegressionRun,
} from "./regression";
import { FamilyMap } from "./regression-teach";
import type { Step, StepStateApi } from "./types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function rendererText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
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
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<RegressionRunLab {...labProps(regressionState())} />);
        await Promise.resolve();
      });
      const tree = rendererText(renderer!);
      expect(designCalls).toBe(0);
      expect(tree.match(/\"role\":\"alert\"/g)).toHaveLength(1);
      expect(tree).toContain("网络连接中断，请检查连接后重试");
      expect(tree).toContain("当前方程不可用；请先在上方重试回归选项");
      expect(tree).not.toContain("正在生成当前方程");
      expect(tree).not.toContain("正在生成当前模型设计");
      expect(tree).not.toContain("正在读取回归选项");
      expect(tree).not.toContain('\"role\":\"status\"');
      expect(tree).not.toContain("aria-busy");
    } finally {
      if (renderer) await act(async () => renderer?.unmount());
      api.regressionOptions = originalOptions;
      api.regressionDesign = originalDesign;
    }
  });
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
    expect(html).toContain("第 16 步将使用的回归结果");
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
    expect(pendingHtml).toContain("估计完成，正在保存到第 16 步");
    expect(pendingHtml).toContain("正在等待自动保存");
    expect(pendingHtml).not.toContain("已由服务器确认");
    expect(pendingHtml).not.toContain("第 16 步将使用的回归结果");

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
    expect(failedHtml).toContain("同步失败；第16步不会在服务器确认前使用");
    expect(failedHtml).not.toContain("第 16 步将使用的回归结果");
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
