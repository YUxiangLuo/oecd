import { expect, test, type Page, type Route } from "@playwright/test";

const user = { username: "student", name: "学生", role: "student" };

function steps() {
  const titles: Record<number, [number, string, "db" | "shock" | "qc" | "ind" | "viz" | "rgd" | "reg" | "rep"]> = {
    1: [1, "数据库介绍", "db"],
    2: [1, "政策冲击数据", "shock"],
    3: [1, "数据质检", "qc"],
    4: [2, "GVC 贸易流分解", "ind"],
    5: [2, "GVC 生产分解", "ind"],
    6: [2, "GVC 长度分解", "ind"],
    7: [2, "网络指标", "ind"],
    8: [3, "GVC 定位图", "viz"],
    9: [3, "生产分解可视化", "viz"],
    10: [3, "长度可视化", "viz"],
    11: [3, "枢纽地图", "viz"],
    12: [4, "回归设计确认", "rgd"],
    13: [4, "GVC 贸易流真实回归", "reg"],
    14: [4, "GVC 生产真实回归", "reg"],
    15: [4, "GVC 长度真实回归", "reg"],
    16: [4, "网络指标真实回归", "reg"],
    17: [5, "实验报告", "rep"],
  };
  return Object.entries(titles).map(([n, [stage, title, lab]]) => ({
    n: Number(n),
    stage,
    lab,
    status: lab === "reg" ? "demo" : "done",
    title,
    goal: `${title}目标`,
    concept: `${title}概念`,
    tip: `${title}提示`,
    deps: ["mock"],
  }));
}

const regressionOptions = {
  granularities: ["国家–行业级", "国家级"],
  shock_types: ["关税冲击", "制裁清单", "出口管制"],
  methods: ["双重差分 (DID)", "双向固定效应", "事件研究"],
  control_modes: ["不加控制变量", "ICIO 派生控制变量", "模拟宏观控制"],
  price_modes: ["名义值", "实际值(2016=1)"],
  scenarios: ["clean", "noisy", "confounded"],
  scenario_labels: { clean: "基准场景(clean)", noisy: "测量误差场景", confounded: "前趋势混杂场景" },
  steps: { "13": "FVA 份额", "14": "复杂 GVC 生产", "15": "上游度", "16": "网络中心性" },
};

const design = {
  step: 13,
  depvar: "share_trade_fva",
  depvar_label: "外国增加值份额",
  granularity: "国家–行业级",
  shock_type: "关税冲击",
  shock_col: "tariff_shock",
  treated_col: "treated",
  method: "双重差分 (DID)",
  control_mode: "不加控制变量",
  interaction: false,
  price_mode: "名义值",
  scenario: "clean",
  scenario_label: "基准场景(clean)",
  sample_filter: "排除 ROW(世界其他地区聚合账户)",
  exclude_row: true,
  controls: [],
  control_labels: {},
  equation: "Y_it = β·treated_i×post_it + α_i + λ_t + ε_it",
  panel_file: "panel_sector.csv",
  entity: "entity_id",
  cluster: "country",
};

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/auth/login" && method === "POST") {
      return route.fulfill({ json: { token: "e2e-token", user, expires_at: 4_102_444_800 } });
    }
    if (path === "/api/auth/me") return route.fulfill({ json: user });
    if (path === "/api/steps") {
      return route.fulfill({
        json: { stages: { "1": "数据接入", "2": "指标计算", "3": "可视化分析", "4": "回归设计与建模", "5": "实验闭环" }, steps: steps() },
      });
    }
    if (path === "/api/meta") return route.fulfill({ json: { years: [2019, 2020], countries: ["CHN", "USA"], sectors: ["C", "G"] } });
    if (path === "/api/shocks/events") return route.fulfill({ json: { events: [], disclaimer: "mock" } });
    if (path === "/api/regression/options") return route.fulfill({ json: regressionOptions });
    if (path === "/api/regression/design") return route.fulfill({ json: { ...design, step: Number(url.searchParams.get("step") ?? 13) } });
    if (path === "/api/regression/run" && method === "POST") {
      return route.fulfill({
        json: {
          design,
          result: {
            coefs: [{ name: "treated×post", coef: -0.0123, se: 0.0041, t: -3.0, p: 0.01, stars: "**" }],
            n_obs: 120,
            n_entities: 24,
            n_times: 5,
            n_clusters: 8,
            r2_within: 0.42,
            notes: ["e2e mock"],
          },
          benchmark: {
            backend: "linearmodels.PanelOLS",
            policy_coefs: [],
            max_abs_coef_diff: 1e-12,
            max_abs_se_diff: 0.02,
            coef_check_passed: true,
            se_check_mode: "informational",
            notes: ["标准误仅作参考"],
          },
          disclaimer: "mock",
        },
      });
    }
    if (path === "/api/report" && method === "POST") {
      return route.fulfill({
        json: {
          path: "reports/experiment_report_2020.md",
          markdown: "# 实验报告\n\nPanelOLS 政策系数对照:通过;标准误最大差异仅作参考。",
        },
      });
    }
    return route.fulfill({ status: 404, json: { detail: `No E2E mock for ${method} ${path}` } });
  });
}

test("登录、进入步骤、跑回归并生成报告", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();

  await page.getByText("GVC 贸易流真实回归", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "GVC 贸易流真实回归" })).toBeVisible();

  await page.getByRole("button", { name: "▶ 运行回归" }).click();
  await expect(page.getByRole("cell", { name: "treated×post" })).toBeVisible();
  await expect(page.getByText("政策系数对照通过")).toBeVisible();
  await expect(page.getByText("仅作参考")).toBeVisible();

  await page.getByText("实验报告", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "实验报告" })).toBeVisible();
  await page.getByRole("button", { name: "生成报告" }).click();
  await expect(page.getByText("已写入 reports/experiment_report_2020.md")).toBeVisible();
  await expect(page.getByText("PanelOLS 政策系数对照")).toBeVisible();
});
