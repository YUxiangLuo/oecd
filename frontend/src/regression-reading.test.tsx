import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "./api";
import {
  DEFAULT_REGRESSION_SETTINGS, RegressionResultCard, RegressionRunLab,
  regressionRunSnapshotIdentity, type SavedRegressionRun,
} from "./regression";
import type { RegressionReadingCheckState } from "./regression-teach";
import { buildRegressionVerdict } from "./regression-verdict";
import type { RegressionOutcome, RegressionResponse, Step, StepStateApi } from "./types";

type RegressionStepState = { run: SavedRegressionRun; reading_check?: RegressionReadingCheckState };

afterEach(cleanup);

function response(outcome: RegressionOutcome = "trade"): RegressionResponse {
  return {
    design: {
      outcome, depvar: "y", depvar_label: "测试指标", granularity: "country_industry",
      shock_type: "tariff", shock_col: "tariff_shock", treated_col: "treated", method: "did",
      control_mode: "none", interaction: false, price_mode: "nominal", scenario: "clean",
      weight_mode: "fixed_pretreatment", scenario_label: "基准教学面板", sample_filter: "排除 ROW",
      exclude_row: true, controls: [], control_labels: {}, equation: "y=x", equation_parts: [],
      panel_file: "panel.csv", entity: "entity_id", cluster: "country",
    },
    result: {
      depvar: "y", coefs: [{ name: "treated×post", coef: 0.02, se: 0.005, t: 4, p: 0.001,
        stars: "***", ci_low: 0.01, ci_high: 0.03 }],
      n_obs: 200, n_entities: 40, n_times: 5, n_clusters: 20, r2_within: null,
      depvar_mean: 0.3, depvar_std: 0.1, diagnostics: {}, notes: [], status: "ok", status_reasons: [],
      support: {
        treated_clusters: 14, untreated_clusters: 6, paired_control_clusters: 6,
        treated_entities: 28, untreated_entities: 12, total_entities: 40,
        reversal_entities: [], reversal_share: 0, absorbing: true, status: "ok", reasons: [],
        min_treated_clusters: 12, max_reversal_share: 0, suppress_inference: false,
      },
    },
    benchmark: { backend: "saved", policy_coefs: [], max_abs_coef_diff: 0, max_abs_se_diff: 0,
      coef_check_passed: true, se_check_mode: "informational", notes: [] },
    disclaimer: "test fixture",
  };
}

function stopped(outcome: RegressionOutcome = "trade") {
  const value = response(outcome);
  value.result.status = "invalid_design";
  value.result.status_reasons = ["测试诊断：存在处理撤销"];
  Object.assign(value.result.support!, {
    status: "invalid_design", suppress_inference: true, reasons: value.result.status_reasons,
  });
  // Keep seeded stale inference to verify that presentation still fails closed.
  return value;
}

const markup = (value: RegressionResponse) => renderToStaticMarkup(
  <RegressionResultCard outcome={value.design.outcome} response={value} stale={false} />,
);

function saved(value: RegressionResponse): SavedRegressionRun {
  return { settings: { ...DEFAULT_REGRESSION_SETTINGS, method: value.design.method },
    design: value.design, result: value.result };
}

function step(outcome: RegressionOutcome): Step {
  return {
    n: { trade: 11, production: 12, length: 13, network: 14 }[outcome],
    stage: 4, lab: "reg", regression_outcome: outcome, status: "demo", title: "测试回归",
    goal: "", tasks: ["一", "二", "三"], concept: "", tip: "", deps: [],
    handoff: { input: "", action: "", output: "" },
  };
}

function Harness({ initial, onSave = () => {} }: {
  initial: RegressionStepState;
  onSave?: (patch: Partial<RegressionStepState>) => void;
}) {
  const [data, setData] = useState(initial);
  const state: StepStateApi = {
    data, complete: false, syncing: false, syncError: null, syncNow: () => {},
    save: (patch) => { onSave(patch); setData((current) => ({ ...current, ...patch })); },
  };
  const outcome = initial.run!.design.outcome;
  return <RegressionRunLab step={step(outcome)} state={state}
    settings={initial.run!.settings} onSettingsChange={() => {}}
    history={{}} onHistoryChange={() => {}} />;
}

// Restored results must remain readable even offline. Do not contact any API/DB.
async function offline(check: () => Promise<void>) {
  const original = api.regressionOptions;
  api.regressionOptions = async () => { throw new Error("test offline"); };
  try { await check(); } finally { api.regressionOptions = original; }
}

describe("one status-first regression result", () => {
  for (const outcome of ["trade", "production", "length", "network"] as const) {
    test(`${outcome}: one estimate and one interpretation, with status first`, () => {
      const value = response(outcome);
      const html = markup(value);
      const verdict = buildRegressionVerdict(outcome, value);
      expect(html.split(verdict.effect)).toHaveLength(2);
      expect(html.split(verdict.interpretation)).toHaveLength(2);
      expect(html.indexOf("结果状态")).toBeLessThan(html.indexOf("verdict-metrics"));
      expect(html).toContain("留到第 15 步");
      expect(html).not.toContain("老师带读");
      if (outcome === "network") {
        expect(html).toContain("只作探索性证据");
        expect(html).toContain("未做边阈值敏感性");
      }
    });
  }

  test("a zero-crossing interval is still shown, not treated as stopped inference", () => {
    const value = response();
    value.result.coefs[0].ci_low = -0.01;
    const html = markup(value);
    expect(html).toContain("[-1.00, +3.00] 个百分点");
    expect(html).toContain("这不等于“没有效应”");
    expect(html).not.toContain("请记录无法判断的原因");
  });

  test("stopped inference shows its reason once, not a prominent estimate or stale interval", () => {
    const html = markup(stopped());
    expect(html.split("测试诊断：存在处理撤销")).toHaveLength(2);
    expect(html).toContain("当前设计无法评估");
    expect(html).toContain("模型与技术细节");
    expect(html).not.toContain("verdict-metrics");
    expect(html).not.toContain("+2.00");
    expect(html).not.toContain("+3.00");
  });

  test("a diagnostic-only run remains readable without a coefficient", () => {
    const value = stopped();
    value.result.coefs = [];
    value.result.diagnostics = { study_contract: "economics-v2", diagnostic_only: true, cohort_time_cells: [] };
    const html = markup(value);
    expect(html).toContain("没有可解读的处理后政策系数");
    expect(html).toContain("测试诊断：存在处理撤销");
    expect(html).not.toContain("verdict-metrics");
  });

  test("thin controls and warning reasons stay beside the result", () => {
    const value = response();
    value.result.status = "warning";
    Object.assign(value.result.support!, { status: "warning", untreated_clusters: 2, reasons: ["测试设计警告"] });
    const html = markup(value);
    expect(html).toContain("对照基础很薄");
    expect(html).toContain("测试设计警告");
    expect(html).toContain("verdict-metrics");
  });

  test("TWFE is explicitly descriptive even when a directional interval exists", () => {
    const value = response();
    value.design.method = "twfe_intensity";
    const html = markup(value);
    expect(html).toContain("TWFE 描述性关联");
    expect(html).toContain("不自动恢复因果识别");
    expect(html).toContain("冲击强度每增加 1 个百分点");
    expect(html).toContain("+0.02 个百分点");
  });

  test("a missing event contract cannot reveal a seeded direction or interval", () => {
    const value = response();
    value.design.method = "event_study";
    value.result.coefs[0].name = "k=0";
    const html = markup(value);
    expect(html).toContain("处理支持度未知");
    expect(html).not.toContain("verdict-metrics");
    expect(html).not.toContain("发现正向变化");
    expect(html).not.toContain("+3.00");
  });
});

describe("exercises never unlock scientific evidence", () => {
  for (const outcome of ["trade", "production", "length", "network"] as const) {
    test(`${outcome}: unanswered, wrong and correct readings all keep results and technical table`, async () => {
      await offline(async () => {
        const run = saved(stopped(outcome));
        const writes: Partial<RegressionStepState>[] = [];
        const { container } = render(<Harness initial={{ run }} onSave={(patch) => writes.push(patch)} />);
        await screen.findByRole("heading", { name: "这个设计不能用于统计推断" });
        const assertReadable = () => {
          expect(container.querySelectorAll(".verdict-card")).toHaveLength(1);
          expect(container.querySelector(".reg-evidence-card, .reg-guide-card")).toBeNull();
          expect(container.textContent).toContain("图表复核");
          expect(container.querySelector(".technical-details table")).not.toBeNull();
          expect(container.querySelector(".reg-family-map")?.textContent).toContain("当前 · 无法评估");
          expect(container.querySelector(".verdict-card .verdict-metrics")).toBeNull();
          expect(container.querySelector(".technical-details")?.textContent).toContain("0.0200");
          expect(container.querySelector(".technical-details")?.textContent).not.toContain("[0.0100, 0.0300]");
        };
        assertReadable();
        expect(writes).toHaveLength(0);
        fireEvent.click(screen.getByRole("button", { name: /相对上升 点估计/ }));
        await waitFor(() => expect(container.querySelector(".reg-reading-feedback")?.textContent).toContain("再试一次"));
        assertReadable();
        fireEvent.click(screen.getByRole("button", { name: /当前不能判断 支持度/ }));
        await waitFor(() => expect(container.querySelector(".reg-reading-feedback")?.textContent).toContain("判断正确"));
        assertReadable();
        expect(writes).toEqual([
          { reading_check: { run_identity: regressionRunSnapshotIdentity(run), answer: "positive" } },
          { reading_check: { run_identity: regressionRunSnapshotIdentity(run), answer: "blocked" } },
        ]);
      });
    });
  }

  test("dominant cohort stays visible while complete weights move to existing technical details", async () => {
    await offline(async () => {
      const value = response();
      value.result.diagnostics.cohort_time_cells = [2018, 2019].map((cohort, index) => ({
        cohort, time: 2020, event_time: 2020 - cohort, term: "treated×post", att: 0.02,
        treated_entities: index === 0 ? 80 : 20, control_entities: 12, treated_clusters: 14, control_clusters: 6,
      }));
      const { container } = render(<Harness initial={{ run: saved(value) }} />);
      await screen.findByRole("heading", { name: "发现正向变化证据" });
      const card = container.querySelector(".verdict-card")!;
      const details = container.querySelector(".technical-details")!;
      expect(card.textContent).toContain("主导提醒");
      expect(card.textContent).toContain("80.0%");
      expect(card.textContent).not.toContain("20.0%");
      expect(details.hasAttribute("open")).toBe(false);
      expect(details.textContent).toContain("不是各批次等权");
      expect(details.textContent).toContain("20.0%");
      expect(details.textContent).toContain("同一对象可能多次贡献权重");
    });
  });

  test("an old answer cannot apply to a new run, but never hides the new evidence", async () => {
    await offline(async () => {
      const old = saved(stopped());
      const current = saved(response());
      const { container } = render(<Harness initial={{ run: current,
        reading_check: { run_identity: regressionRunSnapshotIdentity(old), answer: "blocked" },
      }} />);
      await screen.findByRole("heading", { name: "发现正向变化证据" });
      expect(container.querySelectorAll('.reg-reading-options [aria-pressed="true"]')).toHaveLength(0);
      expect(container.querySelector(".reg-reading-feedback")).toBeNull();
      expect(container.querySelector(".verdict-metrics")?.textContent).toContain("+2.00 个百分点");
      expect(container.querySelector(".technical-details table")).not.toBeNull();
    });
  });
});
