import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "./api";
import { RegressionRunLab, TEACHING_MODEL_VERSION, type RegressionStepState } from "./regression";
import { DEFAULT_BASELINES, lessonFor } from "./regression-lessons";
import type { RegressionOutcome, RegressionResponse, Step, StepStateApi, TeachingPanelResponse } from "./types";
import workbenchOptions from "./regression-workbench-options.fixture.json";

afterEach(() => { cleanup(); mock.restore(); });

const meta = { countries: ["CAN", "MEX"], sectors: ["C29"] };
const outcomes: RegressionOutcome[] = ["trade", "production", "length", "network"];
const years = [2016, 2020];
const group = {
  taxed: years.map((year) => ({ year, change: year === 2016 ? 0 : -0.01 })),
  untaxed: years.map((year) => ({ year, change: 0 })),
};
const panel: TeachingPanelResponse = {
  version: "v", disclaimer: "教学数据", total: 2, years,
  rows: meta.countries.map((country) => ({
    country, industry: "C29", year: 2020, teaching_export_share_w: 0.8,
    teaching_tariff_rate_tau: country === "CAN" ? 0.25 : 0,
    teaching_tariff_exposure: country === "CAN" ? 0.2 : 0,
    teaching_y_trade: 0, teaching_y_production: 0, teaching_y_length: 0, teaching_y_network: 0,
  })),
};

function response(outcome: RegressionOutcome): RegressionResponse {
  const baseline = DEFAULT_BASELINES[outcome];
  const label = lessonFor(outcome, baseline).shortMetric;
  return {
    design: {
      outcome, baseline, baseline_label: label, depvar: "y", depvar_label: label,
      depvar_kind: outcome === "trade" || outcome === "production" ? "share" : outcome,
      granularity: "country_industry", shock_type: "tariff", shock_col: "teaching_tariff_exposure",
      treated_col: "teaching_treated", method: "twfe_intensity", control_mode: "none", interaction: false,
      price_mode: "nominal", scenario: "clean", scenario_label: "基准", sample_filter: "排除 ROW", exclude_row: true,
      controls: [], control_labels: {}, equation: "Y = beta X", equation_parts: [], panel_file: "teaching.csv",
      entity: "entity_id", cluster: "country",
    },
    result: {
      depvar: "y", coefs: [{ name: "teaching_tariff_exposure", coef: -0.55, se: 0.05, t: -11, p: 0.001, stars: "***", ci_low: -0.65, ci_high: -0.45 }],
      n_obs: 100, n_entities: 20, n_times: 5, n_clusters: 10, r2_within: 0.2, depvar_mean: 0.3,
      depvar_std: 0.1, depvar_within_std: 0.1, diagnostics: {}, notes: [], status: "ok", status_reasons: [], support: null,
    },
    benchmark: { backend: "test", policy_coefs: [], max_abs_coef_diff: 0, max_abs_se_diff: 0, coef_check_passed: true, se_check_mode: "test", notes: [] },
    model_snapshot: { version: TEACHING_MODEL_VERSION, x_columns: ["teaching_tariff_exposure"], y_column: "y", entity: "entity_id", time: "year", fixed_effects: ["entity", "year"], controls: [], interactions: [], seed: 1, beta: -0.55, tariff_path: [], disclaimer: "教学" },
    variable_catalog: [], disclaimer: "教学",
  };
}

function setup(outcome: RegressionOutcome, restored = true) {
  const run = response(outcome);
  spyOn(api, "teachingGroups").mockResolvedValue({
    version: "v", years, policy_year: 2018,
    sample: { rows: 100, entities: 20, countries: 10, industries: 2, taxed_countries: 5, untaxed_countries: 5 },
    outcomes: { trade: group, production: group, length: group, network: group },
  });
  spyOn(api, "regressionDesign").mockResolvedValue(run.design);
  spyOn(api, "regressionOptions").mockResolvedValue(workbenchOptions as never);
  spyOn(api, "teachingOverview").mockResolvedValue({
    version: "v", disclaimer: "教学", outcomes: { trade: [], production: [], length: [], network: [] },
  });
  const runCall = spyOn(api, "runRegression").mockResolvedValue(run as never);
  const save = mock(() => {});
  const state: StepStateApi<RegressionStepState> = {
    data: restored ? { run, material_label: "已保存的默认回归结果" } : undefined,
    save, complete: false, syncing: false, syncError: null, syncNow: () => {},
  };
  const step: Step = {
    n: 11 + outcomes.indexOf(outcome), stage: 4, lab: "reg", regression_outcome: outcome, status: "demo",
    title: "测试回归：例子换算", goal: "", tasks: ["计算", "阅读"], concept: "", tip: "", deps: [],
    handoff: { input: "", action: "", output: "" },
  };
  return { runCall, save, state, step };
}

describe("step 10 example recovery on regression pages", () => {
  test.each(outcomes)("%s: a failed example retries independently and preserves the restored result and material", async (outcome) => {
    const { runCall, save, state, step } = setup(outcome);
    let finishRetry!: (data: TeachingPanelResponse) => void;
    const series = spyOn(api, "teachingSeries")
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockImplementationOnce(() => new Promise((resolve) => { finishRetry = resolve; }));
    const { container } = render(<RegressionRunLab step={step} meta={meta} state={state} />);
    expect((await screen.findByRole("alert")).textContent).toContain("步骤 10 例子换算加载失败：网络连接中断");
    const headline = container.querySelector(".reg-plain-verdict")!.textContent;
    const material = screen.getByRole("region", { name: "本步报告材料" });
    const materialText = material.textContent;
    expect(material.classList.contains("material-card--recorded")).toBe(true);
    expect(materialText).toContain("已保存的默认回归结果");
    expect(container.querySelector(".reg-example-effect")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重新加载步骤 10 例子换算" }));
    expect(screen.getByText("正在读取步骤 10 例子，准备换算…").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "重新加载步骤 10 例子换算" })).toBeNull();
    expect(container.querySelector(".reg-plain-verdict")!.textContent).toBe(headline);
    expect(material.textContent).toBe(materialText);

    await act(async () => { finishRetry(panel); });
    await waitFor(() => expect(container.querySelector(".reg-example-effect")?.textContent).toContain("20.00 个百分点"));
    expect(container.querySelector(".reg-example-effect")!.textContent).toContain("2020 年的 X");
    expect(screen.queryByText("正在读取步骤 10 例子，准备换算…")).toBeNull();
    expect(container.querySelector(".reg-plain-verdict")!.textContent).toBe(headline);
    expect(material.textContent).toBe(materialText);
    expect(series.mock.calls).toEqual([[["CAN", "MEX"], "C29"], [["CAN", "MEX"], "C29"]]);
    expect(runCall).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  test("an example failure does not prevent a new regression from being calculated and saved", async () => {
    const { runCall, save, state, step } = setup("trade", false);
    const series = spyOn(api, "teachingSeries").mockRejectedValueOnce(new Error("服务暂时不可用")).mockResolvedValueOnce(panel);
    const { container } = render(<RegressionRunLab step={step} meta={meta} state={state} />);
    fireEvent.click(await screen.findByRole("button", { name: /^计算测试回归/ }));
    await screen.findByRole("alert");
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "本步报告材料" }).classList.contains("material-card--recorded")).toBe(true);
    const headline = container.querySelector(".reg-plain-verdict")!.textContent;
    fireEvent.click(screen.getByRole("button", { name: "重新加载步骤 10 例子换算" }));
    await waitFor(() => expect(container.querySelector(".reg-example-effect")?.textContent).toContain("-11.00 个百分点"));
    expect(container.querySelector(".reg-plain-verdict")!.textContent).toBe(headline);
    expect(series).toHaveBeenCalledTimes(2);
    expect(runCall).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
