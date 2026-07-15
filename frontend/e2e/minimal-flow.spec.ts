import { expect, test, type Page, type Route } from "@playwright/test";

const user = { username: "student", name: "学生", role: "student" };
const teacher = { username: "teacher", name: "老师", role: "teacher" };

const announcement = {
  id: 1,
  class_id: null,
  class_name: null,
  title: "e2e 公告:报告周五截止",
  body: "",
  author: "teacher",
  created_at: "2026-07-08T10:00:00Z",
};

const shockEvent301 = {
  name: "美国301对华关税(四批清单)",
  shock_type: "关税冲击",
  imposer: "USA",
  targets: "CHN",
  exempt: "",
  announced: "2018-06-15",
  effective: "2018-07-06",
  n_sectors: 3,
  top_sectors: ["C29", "C24"],
  peak_rate: 0.24,
  target_codes: ["CHN"],
  sector_codes: ["A01_02", "C24", "C29"],
  all_targets: false,
};

const submissionRow = {
  id: 1,
  title: "步骤16实验报告 · 2020",
  year: 2020,
  state: "pending",
  score: null,
  graded_by: null,
  graded_at: null,
  submitted_at: "2026-07-08T11:00:00Z",
  username: "student",
  display_name: "学生",
  student_no: "2026001",
  class_name: "GVC 实验演示班",
};

function steps() {
  const titles: Record<number, [number, string, "db" | "shock" | "qc" | "ind" | "viz" | "reg" | "rep", "trade" | "production" | "length" | "network" | null]> = {
    1: [1, "数据库介绍与选型", "db", null],
    2: [1, "贸易政策冲击数据接入", "shock", null],
    3: [1, "数据质检与清洗", "qc", null],
    4: [2, "GVC 总贸易流分解指标", "ind", null],
    5: [2, "GVC 生产分解指标", "ind", null],
    6: [2, "GVC 长度分解指标", "ind", null],
    7: [2, "全球生产网络指标", "ind", null],
    8: [3, "GVC 贸易流指标可视化", "viz", null],
    9: [3, "GVC 生产指标可视化", "viz", null],
    10: [3, "GVC 长度指标可视化", "viz", null],
    11: [3, "网络指标可视化", "viz", null],
    12: [4, "GVC 贸易流教学实证回归", "reg", "trade"],
    13: [4, "GVC 生产教学实证回归", "reg", "production"],
    14: [4, "GVC 长度教学实证回归", "reg", "length"],
    15: [4, "网络指标教学实证回归", "reg", "network"],
    16: [5, "生成实验报告", "rep", null],
  };
  return Object.entries(titles).map(([n, [stage, title, lab, outcome]]) => ({
    n: Number(n),
    stage,
    lab,
    ...(outcome ? { regression_outcome: outcome } : {}),
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
  outcomes: { trade: "FVA 份额", production: "复杂 GVC 生产", length: "GVC 生产长度", network: "网络中心性" },
};

const design = {
  outcome: "trade",
  depvar: "FVA_share",
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
  equation_parts: [{ text: "Y_it = " }, { text: "β·treated_i×post_it", term: "policy", description: "政策效应", meta_key: "policy" }],
  panel_file: "panel_industry.csv",
  entity: "entity_id",
  cluster: "country",
};

async function mockApi(
  page: Page,
  who = user,
  currentStep: number | null = null,
  hooks: { placeboGate?: Promise<void>; runGate?: (runNumber: number) => Promise<void> } = {},
) {
  // 学生提交后 report/mine 由 none → pending(闭包保存跨请求状态)
  let mine: Record<string, unknown> = { state: "none" };
  let regressionRunCount = 0;
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/auth/login" && method === "POST") {
      return route.fulfill({ json: { token: "e2e-token", user: who, expires_at: 4_102_444_800 } });
    }
    if (path === "/api/auth/me") return route.fulfill({ json: who });
    if (path === "/api/classroom/announcements") return route.fulfill({ json: { announcements: [announcement] } });
    if (path === "/api/classroom/progress" && method === "GET") {
      return route.fulfill({ json: { current_step: currentStep, max_step: currentStep, updated_at: null } });
    }
    if (path === "/api/classroom/progress" && method === "POST") return route.fulfill({ json: { ok: true } });
    if (path === "/api/classroom/report/mine") return route.fulfill({ json: mine });
    if (path === "/api/classroom/report/submit" && method === "POST") {
      mine = { state: "pending", id: 1, title: "步骤16实验报告 · 2020 · 双重差分 (DID)", year: 2020, submitted_at: "2026-07-08T11:00:00Z" };
      return route.fulfill({ json: { id: 1, state: "pending", submitted_at: "2026-07-08T11:00:00Z" } });
    }
    if (path === "/api/classroom/overview") {
      return route.fulfill({
        json: {
          student_count: 2, disabled_count: 0, submitted: 1, graded: 0, avg_score: null,
          score_buckets: [{ label: "<60", count: 0 }, { label: "60-69", count: 0 }, { label: "70-79", count: 0 }, { label: "80-89", count: 0 }, { label: "90+", count: 0 }],
          step_completion: Array.from({ length: 16 }, (_, i) => ({ step: i + 1, reached: i < 9 ? 1 : 0 })),
          active_7d: 1,
          submission_trend: Array.from({ length: 14 }, (_, i) => ({ date: `07-${String(i + 1).padStart(2, "0")}`, submitted: i === 13 ? 1 : 0, graded: 0 })),
          class_breakdown: [{ class_id: 1, name: "GVC 实验演示班", student_count: 2, submitted: 1, graded: 0, avg_score: null }],
        },
      });
    }
    if (path === "/api/classroom/classes") {
      return route.fulfill({ json: { classes: [{ id: 1, name: "GVC 实验演示班", code: "GVC-DEMO", semester: "2026 春", note: "", archived: false, created_at: "2026-07-01T00:00:00Z", student_count: 2 }] } });
    }
    if (path === "/api/classroom/students" && method === "GET") {
      return route.fulfill({
        json: { students: [{ id: 2, username: "student", display_name: "学生", class_id: 1, class_name: "GVC 实验演示班", student_no: "2026001", active: true, last_login_at: null, created_at: "2026-07-01T00:00:00Z", current_step: 9, max_step: 9, progress_at: null, submission_id: 1, submission_state: "pending", score: null, submitted_at: "2026-07-08T11:00:00Z" }] },
      });
    }
    if (path === "/api/classroom/students" && method === "POST") {
      return route.fulfill({ json: { id: 3, username: "new", display_name: "新同学", class_id: 1 } });
    }
    if (path === "/api/classroom/submissions") return route.fulfill({ json: { submissions: [submissionRow] } });
    if (path === "/api/classroom/submissions/1" && method === "GET") {
      return route.fulfill({ json: { ...submissionRow, design: { method: "双重差分 (DID)" }, markdown: "# 实验报告\n\ne2e 正文", feedback: "" } });
    }
    if (path === "/api/classroom/submissions/1/grade" && method === "POST") {
      return route.fulfill({ json: { ...submissionRow, state: "graded", score: 90, feedback: "很好", graded_by: "teacher", graded_at: "2026-07-08T12:00:00Z" } });
    }
    if (path === "/api/steps") {
      return route.fulfill({
        json: { stages: { "1": "数据接入", "2": "指标计算", "3": "可视化分析", "4": "回归设计与建模", "5": "实验闭环" }, steps: steps() },
      });
    }
    if (path === "/api/meta") return route.fulfill({ json: { years: [2018, 2019, 2020], countries: ["CHN", "USA"], sectors: ["A01_02", "C24", "C29"] } });
    if (path === "/api/shocks/events") return route.fulfill({ json: { events: [shockEvent301], disclaimer: "mock" } });
    if (path === "/api/shocks/summary") {
      return route.fulfill({
        json: {
          n_countries: 2,
          n_sectors: 3,
          years: [
            { year: 2018, treated_countries: 1, treated_pairs: 1, mean_shock_treated: 0.02, max_shock: 0.02, max_shock_target: "CHN-C29" },
            { year: 2019, treated_countries: 1, treated_pairs: 1, mean_shock_treated: 0.03, max_shock: 0.03, max_shock_target: "CHN-C29" },
            { year: 2020, treated_countries: 1, treated_pairs: 1, mean_shock_treated: 0.04, max_shock: 0.04, max_shock_target: "CHN-C29" },
          ],
        },
      });
    }
    if (path === "/api/shocks/panel") {
      const sector = url.searchParams.get("sector") || "C29";
      const country = url.searchParams.get("country") || "CHN";
      const year = Number(url.searchParams.get("year") || 2020);
      return route.fulfill({
        json: {
          total: 1,
          page: 1,
          page_size: 25,
          rows: [{
            country,
            sector,
            year,
            tariff_shock: 0.02,
            main_imposer: "USA",
            export_exposure: 0.18,
            treated: 1,
            announced_date: "2018-06-15",
            effective_date: "2018-07-06",
            note: shockEvent301.name,
          }],
        },
      });
    }
    if (path === "/api/crosswalk/demo") {
      return route.fulfill({
        json: {
          year: Number(url.searchParams.get("year") || 2019),
          summary: { n_hs_chapters: 2, n_crosswalk_rows: 3, n_icio_sectors: 2, demo_list_value_coverage: 0.58 },
          checks: [{ name: "映射覆盖", kind: "coverage", passed: true, detail: "覆盖完整", warnings: [] }],
          hs_rows: [{ hs_chapter: "87", list_name: "301", value_weight: 0.6, coverage: 0.5, rate_2018: 0.1, rate_2019: 0.2, rate_2020: 0.2, note: "车辆" }],
          mapped_rows: [{ icio_sector: "C29", mapped_value_weight: 0.6, affected_value_weight: 0.3, tariff_contribution: 0.06, avg_tariff: 0.1, top_hs_chapters: "87" }],
          crosswalk_rows: [],
          disclaimer: "拟真 mock 映射。",
        },
      });
    }
    if (path === "/api/regression/options") return route.fulfill({ json: regressionOptions });
    if (path === "/api/regression/design") {
      const outcome = url.searchParams.get("outcome");
      if (!outcome || url.searchParams.has("step")) return route.fulfill({ status: 422, json: { detail: "outcome required" } });
      const selectedMethod = url.searchParams.get("method") ?? design.method;
      return route.fulfill({
        json: {
          ...design,
          outcome,
          method: selectedMethod,
          shock_type: url.searchParams.get("shock_type") ?? design.shock_type,
          equation: selectedMethod === "双向固定效应" ? "Y_it = β·tariff_shock_it + α_i + λ_t + ε_it" : design.equation,
          equation_parts: selectedMethod === "双向固定效应"
            ? [{ text: "Y_it = β·tariff_shock_it + α_i + λ_t + ε_it", description: "连续强度" }]
            : design.equation_parts,
        },
      });
    }
    if (path === "/api/regression/run" && method === "POST") {
      const payload = request.postDataJSON();
      if (!payload.outcome || Object.hasOwn(payload, "step")) return route.fulfill({ status: 422, json: { detail: "outcome required" } });
      regressionRunCount += 1;
      if (hooks.runGate) await hooks.runGate(regressionRunCount);
      const selectedMethod = payload.method ?? design.method;
      const coefName = selectedMethod === "双向固定效应" ? "tariff_shock" : "treated×post";
      return route.fulfill({
        json: {
          design: {
            ...design,
            outcome: payload.outcome,
            method: selectedMethod,
            shock_type: payload.shock_type ?? design.shock_type,
            equation: selectedMethod === "双向固定效应" ? "Y_it = β·tariff_shock_it + α_i + λ_t + ε_it" : design.equation,
            equation_parts: selectedMethod === "双向固定效应"
              ? [{ text: "Y_it = β·tariff_shock_it + α_i + λ_t + ε_it", description: "连续强度" }]
              : design.equation_parts,
          },
          result: {
            coefs: [{ name: coefName, coef: -0.0123, se: 0.0041, t: -3.0, p: 0.01, stars: "**", ci_low: -0.022, ci_high: -0.0026 }],
            n_obs: 120,
            n_entities: 24,
            n_times: 5,
            n_clusters: 8,
            r2_within: 0.42,
            depvar_mean: 0.2,
            depvar_std: 0.08,
            diagnostics: {},
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
    if (path === "/api/regression/placebo" && method === "POST") {
      if (hooks.placeboGate) await hooks.placeboGate;
      const payload = request.postDataJSON();
      return route.fulfill({
        json: {
          design: { ...design, outcome: payload.outcome },
          placebo: {
            policy_name: "treated×post",
            true_coef: -0.0123,
            placebo_coefs: [-0.002, 0.001, 0.003],
            empirical_p: 0.25,
            n_draws: 3,
            requested_draws: 3,
            seed: 2026,
            treated_entities: 8,
            total_entities: 24,
            cohorts: { "2018": 8 },
            note: "e2e placebo",
          },
          disclaimer: "mock",
        },
      });
    }
    if (path === "/api/report" && method === "POST") {
      return route.fulfill({
        json: {
          suggested_filename: "experiment_report_2020.md",
          markdown: [
            "# 实验报告",
            "",
            "| 检查 | 结果 |",
            "|---|---|",
            "| PanelOLS 政策系数对照 | 通过;标准误最大差异仅作参考 |",
            "",
            "```gvcsim-chart",
            JSON.stringify({ version: 1, type: "bar", title: "FVA Top 5", items: [{ label: "CHN", value: 0.42 }] }),
            "```",
          ].join("\n"),
        },
      });
    }
    return route.fulfill({ status: 404, json: { detail: `No E2E mock for ${method} ${path}` } });
  });
}

test("登录、进入步骤、跑回归并生成报告", async ({ page }) => {
  let reportRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/report") reportRequests += 1;
  });
  await mockApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();

  await page.getByText("GVC 贸易流教学实证回归", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "GVC 贸易流教学实证回归" })).toBeVisible();

  await page.getByRole("button", { name: "运行基准回归" }).click();
  await expect(page.getByRole("heading", { name: "发现负向变化证据" })).toBeVisible();
  await expect(page.getByText("-1.23 个百分点", { exact: false })).toBeVisible();
  await expect(page.getByText("不构成现实政策结论", { exact: false }).first()).toBeVisible();

  await page.getByText("生成实验报告", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "生成实验报告" })).toBeVisible();
  expect(reportRequests).toBe(0);
  await page.getByRole("button", { name: "生成报告" }).click();
  await expect(page.getByText("PanelOLS 政策系数对照")).toBeVisible();
  await expect(page.getByRole("img", { name: "FVA Top 5" })).toBeVisible();
  expect(reportRequests).toBe(1);

  // 学生看到公告横幅,并能把报告提交给老师(提交卡片更新状态 + 成功 toast)
  await expect(page.getByText("e2e 公告:报告周五截止")).toBeVisible();
  await page.getByRole("button", { name: "提交报告给老师" }).click();
  await expect(page.locator(".submit-card").getByText("等待教师评阅", { exact: false })).toBeVisible();
  await expect(page.locator(".toast-item")).toContainText("报告已提交");
});

test("步骤2事件选择会立即反馈并联动代表行业", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();
  await page.locator(".step-row").filter({ hasText: "贸易政策冲击数据接入" }).click();

  await expect(page.getByRole("heading", { name: "贸易政策冲击数据接入" })).toBeVisible();
  await expect(page.locator("details.event-catalog")).not.toHaveAttribute("open", "");
  await expect(page.locator("details.crosswalk-details")).not.toHaveAttribute("open", "");
  await expect(page.locator(".shock-workbench table:visible")).toHaveCount(1);

  const eventButton = page.getByRole("button", { name: /美国301对华关税.*宣布 2018-06-15/ });
  await eventButton.click();
  await expect(eventButton).toHaveAttribute("aria-pressed", "true");
  await eventButton.press("Space");
  await expect(eventButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".selected-event-card")).toContainText("已同步冲击面板");
  await expect(page.locator(".selected-event-card")).toContainText("2018 · 关税冲击 · CHN 中国 · C29 汽车及零部件");

  const filters = page.locator(".shock-panel-controls select");
  await expect(filters.nth(0)).toHaveValue("关税冲击");
  await expect(filters.nth(1)).toHaveValue("2018");
  await expect(filters.nth(2)).toHaveValue("CHN");
  await expect(filters.nth(3)).toHaveValue("C29");
  await expect(page.locator(".shock-panel-table")).toContainText("C29 汽车及零部件");

  await page.locator("details.event-catalog > summary").click();
  await expect(page.locator(".shock-event-table")).toBeVisible();
  await page.locator("details.crosswalk-details > summary").click();
  const summaryTab = page.getByRole("tab", { name: "映射摘要" });
  await expect(summaryTab).toBeVisible();
  await expect(page.locator(".crosswalk-content table:visible")).toHaveCount(1);
  await summaryTab.focus();
  await summaryTab.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "HS 清单样本" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("columnheader", { name: "HS章" })).toBeVisible();
  await expect(page.locator(".crosswalk-content table:visible")).toHaveCount(1);
});

test("旧结果的技术细节不会混入当前未运行的新方程", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();
  await page.getByText("GVC 贸易流教学实证回归", { exact: true }).click();

  await page.getByRole("button", { name: "运行基准回归" }).click();
  await expect(page.locator(".verdict-card")).toBeVisible();
  await page.getByRole("group", { name: "估计方法" }).getByRole("button", { name: "连续冲击强度" }).click();

  const details = page.locator(".technical-details");
  await details.locator("summary").click();
  await expect(details.locator(".stale-result")).toContainText("上一次运行");
  await expect(details.locator(".model-eq")).toContainText("treated_i×post_it");
  await expect(details.locator(".model-eq")).not.toContainText("tariff_shock");
});

test("旧安慰剂响应不会覆盖新设定的主回归", async ({ page }) => {
  let releasePlacebo!: () => void;
  const placeboGate = new Promise<void>((resolve) => { releasePlacebo = resolve; });
  await mockApi(page, user, null, { placeboGate });
  await page.goto("/");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();
  await page.getByText("GVC 贸易流教学实证回归", { exact: true }).click();

  await page.getByRole("button", { name: "运行基准回归" }).click();
  await page.getByRole("button", { name: "运行安慰剂检验" }).click();
  await expect(page.getByRole("button", { name: "随机化中…" })).toBeVisible();

  await page.getByRole("group", { name: "估计方法" }).getByRole("button", { name: "连续冲击强度" }).click();
  await page.getByRole("button", { name: "重新运行当前设定" }).click();
  await expect(page.locator(".verdict-metrics span").filter({ hasText: "冲击强度每增加 1 个百分点" })).toBeVisible();

  const finished = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/regression/placebo");
  releasePlacebo();
  await finished;
  await expect(page.locator(".placebo-verdict")).toHaveCount(0);
  await expect(page.getByText("经验 p=", { exact: false })).toHaveCount(0);
});

test("同设定主回归运行中不能启动基于旧结果的新安慰剂", async ({ page }) => {
  let releasePlacebo!: () => void;
  let releaseSecondRun!: () => void;
  const placeboGate = new Promise<void>((resolve) => { releasePlacebo = resolve; });
  const secondRunGate = new Promise<void>((resolve) => { releaseSecondRun = resolve; });
  let placeboRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/regression/placebo") placeboRequests += 1;
  });
  await mockApi(page, user, null, {
    placeboGate,
    runGate: async (runNumber) => { if (runNumber === 2) await secondRunGate; },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();
  await page.getByText("GVC 贸易流教学实证回归", { exact: true }).click();

  await page.getByRole("button", { name: "运行基准回归" }).click();
  await page.getByRole("button", { name: "运行安慰剂检验" }).click();
  await page.getByRole("button", { name: "重新运行当前设定" }).click();
  const placeboButton = page.getByRole("button", { name: "运行安慰剂检验" });
  await expect(placeboButton).toBeDisabled();
  await placeboButton.click({ force: true });
  expect(placeboRequests).toBe(1);

  const secondFinished = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/regression/run" && response.request().postDataJSON().method === "双重差分 (DID)"
  ));
  releaseSecondRun();
  await secondFinished;
  const placeboFinished = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/regression/placebo");
  releasePlacebo();
  await placeboFinished;
  await expect(page.locator(".placebo-verdict")).toHaveCount(0);
});

test("正常退出会清空上一位学生的回归设置与历史", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();
  await page.getByText("GVC 贸易流教学实证回归", { exact: true }).click();

  await page.getByRole("button", { name: "运行基准回归" }).click();
  await page.getByRole("group", { name: "估计方法" }).getByRole("button", { name: "连续冲击强度" }).click();
  await page.getByRole("button", { name: "重新运行当前设定" }).click();
  await expect(page.getByRole("heading", { name: "改变设定后，结论变化了吗？" })).toBeVisible();

  await page.getByRole("button", { name: "退出" }).click();
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();
  await page.getByText("GVC 贸易流教学实证回归", { exact: true }).click();

  await expect(page.getByRole("heading", { name: "改变设定后，结论变化了吗？" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "估计方法" }).getByRole("button", { name: "二元处理 DID" })).toHaveAttribute("aria-pressed", "true");
});

test("退出期间返回的旧主回归不会写入下一位学生的历史", async ({ page }) => {
  let releaseRun!: () => void;
  const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  await mockApi(page, user, null, { runGate: async () => runGate });
  await page.goto("/");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();
  await page.getByText("GVC 贸易流教学实证回归", { exact: true }).click();

  await page.getByRole("button", { name: "运行基准回归" }).click();
  await expect(page.getByRole("button", { name: "估计中…" })).toBeVisible();
  const oldFinished = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/regression/run");
  await page.getByRole("button", { name: "退出" }).click();

  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();
  await page.getByText("GVC 贸易流教学实证回归", { exact: true }).click();
  releaseRun();
  await oldFinished;

  await page.getByRole("button", { name: "运行基准回归" }).click();
  await expect(page.locator(".verdict-card")).toBeVisible();
  await expect(page.getByRole("heading", { name: "改变设定后，结论变化了吗？" })).toHaveCount(0);
});

test("教师面板:概览、学生名单、评阅报告", async ({ page }) => {
  await mockApi(page, teacher);
  await page.goto("/");

  // 教师登录不弹学生向导，直达教师面板；教师端没有任何进入学生 16 步实验的入口
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("学生人数")).toBeVisible();
  await expect(page.getByText("已提交报告")).toBeVisible();
  await expect(page.getByText("课程大纲")).toHaveCount(0);
  await expect(page.getByText("生成实验报告")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "返回实验" })).toHaveCount(0);

  await page.getByRole("button", { name: "班级与学生" }).click();
  await expect(page.getByRole("cell", { name: "2026001" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "待评阅" })).toBeVisible();

  // “全部班级”下不再静默落入第一个班级，必须显式选择班级或暂不分班。
  await page.getByRole("button", { name: "+ 添加学生" }).click();
  const studentDialog = page.getByRole("dialog", { name: "添加学生账号" });
  await expect(studentDialog.locator("select")).toHaveValue("");
  await studentDialog.locator("select").selectOption("1");
  await expect(studentDialog.locator("select")).toHaveValue("1");
  await studentDialog.getByRole("button", { name: "取消" }).click();

  await page.getByRole("button", { name: "报告评阅" }).click();
  await page.getByRole("button", { name: "评阅", exact: true }).click();
  await expect(page.getByText("e2e 正文")).toBeVisible();
  await page.getByLabel("快捷分值").getByRole("button", { name: "90" }).click();
  await expect(page.locator('input[type="number"]')).toHaveValue("90");
  await page.getByLabel("评语模板").getByRole("button", { name: "结构完整" }).click();
  await expect(page.locator("textarea")).toHaveValue("结构完整");
  await page.getByRole("button", { name: "提交评阅" }).click();
  await expect(page.getByRole("cell", { name: "待评阅" })).toBeVisible(); // 回到列表(mock 状态不回写)
});

test("学生恢复服务端进度，切步后深链同步到 URL", async ({ page }) => {
  await mockApi(page, user, 14);
  await page.goto("/");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();

  await expect(page.getByRole("heading", { name: "GVC 长度教学实证回归" })).toBeVisible();
  await page.locator(".step-row").filter({ hasText: "网络指标教学实证回归" }).click();
  await expect(page).toHaveURL(/\?step=15$/);
});

test("有效 step 深链优先于服务端保存进度", async ({ page }) => {
  await mockApi(page, user, 14);
  await page.goto("/?step=12");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();

  await expect(page.getByRole("heading", { name: "GVC 贸易流教学实证回归" })).toBeVisible();
  await expect(page).toHaveURL(/\?step=12$/);
});

test("旧步骤 17 深链无效并安全回退到默认步骤", async ({ page }) => {
  await mockApi(page, user, null);
  await page.goto("/?step=17");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();

  await expect(page.getByRole("heading", { name: "GVC 总贸易流分解指标" })).toBeVisible();
  await expect(page).toHaveURL(/\?step=4$/);
});

test("小数 step 深链无效并安全回退到默认步骤", async ({ page }) => {
  await mockApi(page, user, null);
  await page.goto("/?step=1.5");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();

  await expect(page.getByRole("heading", { name: "GVC 总贸易流分解指标" })).toBeVisible();
  await expect(page).toHaveURL(/\?step=4$/);
});
