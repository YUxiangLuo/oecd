export type RegressionOutcome = "trade" | "production" | "length" | "network";

interface QuizOption {
  id: string;
  label: string;
}

interface QuizQuestion {
  id: string;
  prompt: string;
  options: QuizOption[];
}

interface StepQuiz {
  version: string;
  questions: QuizQuestion[];
}

export interface Step {
  n: number;
  stage: number;
  lab: "db" | "shock" | "ind" | "viz" | "reg" | "rep";
  regression_outcome?: RegressionOutcome;
  /** 指标(ind)与可视化(viz)步的主题,用于按主题路由到定制组件,不依赖步号。 */
  topic?: RegressionOutcome;
  status: "done" | "demo";
  title: string;
  goal: string;
  /** Concrete student actions rendered in the shared first-screen task card (three; two on steps 11–14). */
  tasks: [string, string, string] | [string, string];
  concept: string;
  tip: string;
  deps: string[];
  /** Fixed three-part bridge shown on every existing course step. */
  handoff: {
    input: string;
    action: string;
    output: string;
  };
  /** 步骤 1–14 的固定理解检查；第 15 步以报告生成作为完成条件。 */
  quiz?: StepQuiz;
}

export interface StepsResponse {
  stages: Record<string, string>;
  steps: Step[];
}

export interface AuthUser {
  /** Stable database identity. Usernames are editable and must not scope cached work. */
  account_id?: number;
  username: string;
  name: string;
  role: string;
  /** A teacher still on the password the deployment set (never changed or reset): the workspace asks them to change it. */
  initial_password?: boolean;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
  expires_at: number;
}

export interface QcContractCheck {
  name: string;
  failure_severity: "warning" | "fatal";
}

export interface QcContract {
  version: number;
  scopes: Record<"icio" | "controls" | "shocks", QcContractCheck[]>;
}

export interface ShockContractTypeFields {
  shock_field: string;
  treated_field: string;
  announced_date_field: string;
  effective_date_field: string;
  note_field: string;
}

export interface ShockContract {
  version: number;
  treated_threshold: number;
  treated_operator: string;
  types: Record<"tariff" | "sanctions" | "export_control", ShockContractTypeFields>;
  tariff_exposure: {
    source_field: string;
    mode_field: string;
    disclosure_field: string;
    allowed_sources: string[];
    allowed_modes: string[];
  };
}

export interface TeachingSourceFilter {
  source_baseline_rows: number;
  published_entities: number;
  excluded_source_baseline_rows: number;
}

export interface Meta {
  years: number[];
  countries: string[];
  sectors: string[];
  dataset?: {
    years: number[];
    /** Canonical immutable identity of the validated release backing this session. */
    release_id?: string;
    artifact_contract_version?: number;
    generated_at?: string;
    network_algorithm?: string;
    simulation_contract?: {
      source_filter_disclosure: TeachingSourceFilter;
    };
    data_sources?: Record<string, unknown>;
    qc_contract?: QcContract;
    shock_contract?: ShockContract;
    qc?: unknown;
    output_qc?: unknown;
    regression_input_qc?: unknown;
    publication_policy?: {
      mode: "integrity-and-mathematics-v2";
      blocking_kinds: Record<string, string[]>;
      nonblocking_policy: string;
    };
    integrity?: {
      status: "passed" | "failed";
      scopes: {
        years: Record<string, IntegrityCheckSummary>;
        controls: IntegrityCheckSummary;
        shocks: IntegrityCheckSummary;
        outputs: Record<string, IntegrityCheckSummary>;
        regression_inputs: IntegrityCheckSummary;
      };
    };
  } | null;
}

export interface IntegrityCheckSummary {
  passed: boolean;
  checked: string[];
  failures: string[];
}

export interface QuizCompletionState {
  quiz?: {
    version: string;
    answers: Record<string, string>;
  };
}

export type DbTableKind = "z" | "y" | "accounts";

interface DbFile {
  year: number;
  file: string;
  size_bytes: number;
}

export interface DbMeta {
  years: number[];
  default_year: number | null;
  countries: string[];
  sectors: string[];
  final_demand_categories: string[];
  account_rows: string[];
  files: DbFile[];
  n_rows: number;
  n_columns: number;
}

export interface DbSlice {
  year: number;
  table: DbTableKind;
  total: number;
  page: number;
  page_size: number;
  columns: string[];
  rows: Record<string, string | number | null>[];
  row_summaries: {
    row: string;
    slice_total: number;
    out: number | null;
  }[];
}

export interface ShockEvent {
  name: string;
  shock_type?: string;
  imposer: string;
  targets: string;
  exempt: string;
  announced: string;
  effective: string;
  removal?: string | null;
  n_sectors: number;
  top_sectors: string[];
  peak_rate: number;
  entities?: string;
  /** 供时间线点击联动使用；展示文案仍使用 targets/top_sectors。 */
  target_codes?: string[];
  sector_codes?: string[];
  all_targets?: boolean;
  /** 复合处理或教学映射的时间线边界。 */
  timeline_note?: string | null;
  source_status: "official_event_source_complete" | "partial_official_event_source" | "teaching_encoding_no_event_source";
  source_disclosure: string;
  /** 支持事件/日期的 URL；空数组表示没有逐项事件来源。 */
  source_urls: string[];
}

export interface ShockTypeMetadata {
  key: "tariff" | "sanctions" | "export_control";
  label: string;
  definition: string;
  treated_definition: string;
  treated_threshold: number;
  treated_operator: ">";
}

interface ShockSummaryYear {
  year: number;
  treated_countries: number;
  treated_pairs: number;
  nonzero_countries: number;
  nonzero_pairs: number;
  mean_shock_treated: number;
  mean_shock_nonzero: number;
  max_shock: number;
  max_shock_target: string;
}

export interface ShockSummary {
  type: ShockTypeMetadata;
  years: ShockSummaryYear[];
  n_countries: number;
  n_sectors: number;
}

export interface TeachingPanelRow {
  [key: string]: string | number;
  country: string;
  industry: string;
  year: number;
  teaching_export_share_w: number;
  teaching_tariff_rate_tau: number;
  teaching_tariff_exposure: number;
  teaching_y_trade: number;
  teaching_y_production: number;
  teaching_y_length: number;
  teaching_y_network: number;
}

export interface TeachingPanelResponse {
  version: string;
  disclaimer: string;
  rows: TeachingPanelRow[];
  total: number;
  years: number[];
}

export interface TeachingGroupPoint { year: number; change: number }

/** Each group's mean change of a Y: `taxed` pools both waves; `first`/`second` are the waves (teaching data v10). */
export interface TeachingGroupSeries {
  taxed: TeachingGroupPoint[];
  untaxed: TeachingGroupPoint[];
  first?: TeachingGroupPoint[];
  second?: TeachingGroupPoint[];
}

/** Taxed vs untaxed mean change of each simulated Y, relative to each group's pre-policy mean. */
/** Step 10: every sample country's exposure X in the last year (the imposing market is not in the sample). */
export interface TeachingCountriesResponse {
  version: string;
  year: number;
  market: string;
  tariff_rate: number;
  policy_year: number | null;
  taxed_countries: number;
  untaxed_countries: number;
  /** The data rule that picks the taxed countries: a goods trade surplus with the market of at least
   * `min_million_usd` (million USD) in `year`. Servers before teaching data v7 omit it. */
  taxed_rule?: {
    basis?: string; min_million_usd: number; year?: number; scope?: string; rate?: number;
    /** Teaching data v10: the tariff starts in waves, by the size of the goods surplus. */
    waves?: { wave: number; min_million_usd: number; start_year_offset: number }[];
  } | null;
  /** Teaching data v10: the start year of each wave present (the first is `policy_year`). */
  policy_years?: number[];
  waves?: { wave: number; start_year: number; min_million_usd: number; countries: number }[];
  entities: number;
  /** Sorted from the highest mean exposure down; X is a fraction (0.23 = 23 percentage points). */
  countries: {
    country: string;
    taxed: boolean;
    /** Mean and max X over the country's goods industries in the sample (the tariff falls on goods, v8). */
    mean_exposure: number;
    max_exposure: number;
    /** All the country's industries in the sample, services included (their X is always 0). */
    industries: number;
    /** Its goods industries (ICIO A–C) in the sample; absent before v8. */
    goods_industries?: number;
    exposed_industries: number;
    /** Goods trade balance with the market in the rule's year, million USD (negative = deficit); absent before v7. */
    market_goods_surplus?: number | null;
    /** Teaching data v10: 0 untaxed, 1 first wave, 2 second wave; and the year its tariff starts. */
    wave?: number;
    start_year?: number | null;
  }[];
}

/** One Y's estimate, as the run endpoint would save it (coef per unit of X, i.e. per 100 percentage points). */
export interface TeachingEstimate {
  key: string;
  label: string;
  kind: "share" | "length" | "position" | "network" | string;
  default: boolean;
  coef: number | null;
  ci_low: number | null;
  ci_high: number | null;
  p: number | null;
  status: string | null;
  suppress_inference: boolean;
  depvar_std: number | null;
  /** SD of Y after removing each country×industry's level and each year's common change: the 个标准差 scale. */
  depvar_within_std?: number | null;
  depvar_mean: number | null;
  n_obs: number | null;
}

/** Steps 11–14: every Y's estimate of every family, computed once per release (the bar chart). */
export interface TeachingOverviewResponse {
  version: string;
  disclaimer: string;
  outcomes: Record<"trade" | "production" | "length" | "network", TeachingEstimate[]>;
}

export interface TeachingGroupsResponse {
  version: string;
  years: number[];
  policy_year: number;
  /** Teaching data v10: the start year of each tariff wave. */
  policy_years?: number[];
  sample: {
    rows: number;
    entities: number;
    countries: number;
    industries: number;
    taxed_countries: number;
    untaxed_countries: number;
    first_wave_countries?: number;
    second_wave_countries?: number;
  };
  /** Industries with at least one unit in the teaching panel (older servers omit it). */
  industries?: string[];
  /** Mean X of taxed-country units in the policy years (a proportion); β × it is the implied group gap. */
  mean_exposure_taxed?: number;
  outcomes: Record<RegressionOutcome, TeachingGroupSeries>;
  /** Same-family Y choices per step (the default first); older servers omit it. */
  baselines?: Record<RegressionOutcome, TeachingBaselineOption[]>;
  /** Group trends of every baseline's Y, keyed by outcome then baseline key. */
  series?: Record<RegressionOutcome, Record<string, TeachingGroupSeries>>;
}

export interface TeachingBaselineOption {
  key: string;
  label: string;
  kind: DepvarKind;
  unit: string;
  default: boolean;
  column: string;
  source: string;
}

export interface QcCheck {
  name: string;
  kind: string;
  passed: boolean;
  detail: string;
  warnings: string[];
  /** 服务端发布门禁：通过但带 warning 的检查也可能要求持续披露。 */
  severity?: "ok" | "disclosure" | "warning" | "fatal";
}

interface CrosswalkSummary {
  n_hs_products: number;
  n_hs_chapters: number;
  n_crosswalk_rows: number;
  n_icio_sectors: number;
  demo_list_value_coverage: number;
}

export interface CrosswalkHsRow {
  hs_code: string;
  source_url: string;
  hs_chapter: string;
  list_name: string;
  value_weight: number;
  coverage: number;
  rate_2018: number;
  rate_2019: number;
  rate_2020: number;
  note: string;
}

interface CrosswalkMappedRow {
  icio_sector: string;
  mapped_value_weight: number;
  affected_value_weight: number;
  tariff_contribution: number;
  avg_tariff: number;
  top_hs_chapters: string;
}

interface CrosswalkRow {
  hs_code: string;
  isic_division: string;
  source_url: string;
  industry_source_url: string;
  hs_chapter: string;
  hs_description: string;
  icio_sector: string;
  weight: number;
  note: string;
}

export interface CrosswalkPayload {
  year: number;
  summary: CrosswalkSummary;
  checks: QcCheck[];
  hs_rows: CrosswalkHsRow[];
  mapped_rows: CrosswalkMappedRow[];
  crosswalk_rows: CrosswalkRow[];
  disclaimer: string;
}

export interface NetworkData {
  nodes: Record<string, string | number | null>[];
  edges: Record<string, string | number | null>[];
}

interface IndicatorFieldMeta {
  label: string;
  /** count: path counts and degrees, read as whole numbers. */
  format: "amount" | "pct" | "number" | "count";
  desc: string;
  /** 国家级贸易图是完全图 → 该(无权)网络中心性对所有国家恒为常数,只在国家–行业级有区分度;前端在国家级隐藏。 */
  country_degenerate?: boolean;
}

interface IndicatorGroup {
  key: string;
  label: string;
  fields: string[];
}

export interface IndicatorSchema {
  groups: IndicatorGroup[];
  fields: Record<string, IndicatorFieldMeta>;
}

export interface PagedRows {
  type?: ShockTypeMetadata;
  filter?: "treated" | "nonzero" | "all";
  sort?: "intensity_desc" | "intensity_asc" | "country_asc" | "industry_asc";
  total: number;
  page: number;
  page_size: number;
  rows: Record<string, string | number | null>[];
  /** Shock panel responses bind this disclosure to the validated release source. */
  disclaimer?: string;
}

/** Step 9 global reference: one industry's spread of a metric across all economies in one year. */
export interface IndustryDistributionRow {
  year: number;
  industry: string;
  n: number;
  p25: number;
  median: number;
  p75: number;
  /** Ranks (1 = highest) of the requested countries only. */
  ranks: Record<string, number>;
  /** How many economies share each requested country's reading (1 = no tie). */
  ties?: Record<string, number>;
  /** Requested countries whose industry has no output that year (SVA and 加权总度 both 0): flagged, not ranked. */
  no_output?: string[];
}

export type IndustryPage = PagedRows;

/** 实验会话:逐步实验状态的可恢复模型(契约见 gvcsim/session.py)。 */
/** 当前学期只接受 simple-v2；其它会话版本一律拒绝。 */
export const SESSION_VERSION = "experiment-session-simple-v3";

export interface SessionRecord<T = unknown> {
  data: T;
}

/** 确实跨步骤共享的实验状态(白名单,与 gvcsim/session.py 的 SHARED_KEYS 一致)。 */
export type SharedSessionKey = "regression_settings";

export interface ExperimentSession {
  version: string;
  steps: Record<string, SessionRecord>;
  shared: Partial<Record<SharedSessionKey, SessionRecord>>;
}

/**
 * 一步实验台读写自己的自动保存状态。
 *
 * `complete` 一律来自服务端判定,实验台不自行推断是否完成——实验操作不参与
 * 完成判定；步骤 1–14 只由答题结果决定。第 15 步的报告门槛另行检查关键操作与原创分析。
 */
export interface StepStateApi<T = Record<string, unknown>> {
  data: T | undefined;
  /** 合并写入（与该步已有状态合并，不整份覆盖）。 */
  save: (patch: Partial<T>) => void;
  /**
   * Saves browsing state that is not report material (the selected countries and view of an exploration-only
   * chart), so leaving the step and coming back keeps it. The server leaves these keys out of the report
   * fingerprint, so this also works after the report is submitted.
   */
  saveView?: (patch: Partial<T>) => void;
  complete: boolean;
  syncing: boolean;
  syncError: string | null;
  /** Another tab saved a newer record: retrying cannot help until the server version is loaded. */
  syncConflict?: boolean;
  syncNow: () => void;
  /**
   * Adopt the server's record as this page's base (another tab saved newer content), keeping this page's edits the
   * server did not touch. Step 15 uses it for "这三段是本页的旧文字 → 载入服务器版本".
   */
  /** Resolves true once the server's record is this page's; false when it did not load (the notice stays). */
  loadServerVersion?: () => Promise<boolean>;
  /**
   * The report has been submitted (or graded): browsing must no longer rewrite report material
   * automatically; a step records its current view only when the student explicitly asks.
   */
  materialLocked?: boolean;
  /**
   * The step opened on a country carried over from this earlier step (its first visit, before it saved its own),
   * so it can say where the country came from.
   */
  carriedFrom?: number;
}

/** 单步完成判定。由服务端从会话重算，客户端不参与判定。 */
interface StepCompletion {
  step: number;
  complete: boolean;
  /** 未完成时还差什么;直接展示给学生。 */
  missing: string[];
}

export interface CompletionSummary {
  steps: StepCompletion[];
  completed: number[];
  completed_count: number;
  total: number;
}

/** 第 15 步门槛：还差哪项理解检查、关键操作或原创分析。 */
export interface ReportGateItem {
  step: number;
  title: string;
  missing: string[];
  /** Only the step's quiz is missing (report_gate.check_gate): its link goes to the quiz. Absent from the material gate. */
  quiz_only?: boolean;
}

/** 服务端生成的实验报告:正文与溯源由服务端从会话快照产出；客户端只保存学生原创文字和实验操作。 */
export interface ClassroomReport {
  markdown: string;
  suggested_filename?: string;
  provenance: {
    release_id?: string;
    session_version: string;
    quiz_version?: string;
    course_release?: string;
    generated_at: string;
    years: number[];
    session_fingerprint: string;
    runs: ReportRun[];
    /** The workbench models the report printed (自己设计模型 marked 放入报告); absent on older reports. */
    custom_results?: ReportedCustomResult[];
  };
  state: "draft" | "pending" | "graded";
  score: number | null;
  feedback: string;
  graded_by: string | null;
  generated_at: string;
  updated_at: string;
  submitted_at: string | null;
  graded_at: string | null;
}

/** 报告里一步回归的冻结快照：生成报告时把保存的 design/result 一起写入 provenance。 */
interface ReportRun {
  step: number;
  outcome: string;
  design: RegressionDesignInfo;
  result: RegressionResponse["result"];
}

export interface SessionResponse {
  /** Data release authenticated by the server for this workspace. */
  release_id: string;
  session: ExperimentSession;
  updated_at?: string | null;
  completion: CompletionSummary;
  /** Whether the latest report was generated from this record (absent from older servers). */
  report_current?: boolean;
  report_gate: ReportGateItem[];
  material_gate: ReportGateItem[];
  report: ClassroomReport | null;
}

export interface SessionSaveResponse {
  /** Exact server-normalized snapshot persisted by this PUT. */
  session: ExperimentSession;
  updated_at: string;
  completion: CompletionSummary;
  /** Whether the latest report was generated from this record (absent from older servers). */
  report_current?: boolean;
  report_gate: ReportGateItem[];
  material_gate: ReportGateItem[];
}

export interface ReportMutationResponse {
  report: ClassroomReport;
  completion: CompletionSummary;
  /** Whether the latest report was generated from this record (absent from older servers). */
  report_current?: boolean;
  report_gate: ReportGateItem[];
  material_gate: ReportGateItem[];
}

export interface CoefStat {
  name: string;
  coef: number;
  // 完整诊断可能缺少可用推断量，缺失值不能按零显示。
  se: number | null;
  t: number | null;
  // 推断量在设计无效/支持度不足时为 null,表示“不可评估”,不是“不显著”。
  p: number | null;
  stars: string;
  ci_low: number | null;
  ci_high: number | null;
}

/** 设计有效性:ok 可解释 / warning 可展示但需披露 / insufficient 支持度不足 / invalid_design 估计量与处理路径不相容。 */
export type RegressionStatus = "ok" | "warning" | "insufficient" | "invalid_design";

export interface TreatmentSupport {
  treated_clusters: number;
  untreated_clusters: number;
  paired_control_clusters?: number | null;
  support_basis?: string;
  treated_entities: number;
  /** 旧会话保存的回归快照可能没有这两个实体级字段。 */
  untreated_entities?: number;
  total_entities?: number;
  reversal_entities: string[];
  reversal_share: number;
  absorbing: boolean;
  status: RegressionStatus;
  reasons: string[];
  min_treated_clusters: number;
  max_reversal_share: number;
  suppress_inference: boolean;
}

export type DepvarKind = "share" | "length" | "position" | "network";

export interface RegressionDesignInfo {
  outcome: RegressionOutcome;
  /** Same-family generation baseline of Y (absent on runs saved before v4, which the pages reject anyway). */
  baseline?: string;
  baseline_label?: string;
  depvar: string;
  depvar_label: string;
  /** How Y is read: shares in percentage points, the others in their own units. */
  depvar_kind?: DepvarKind;
  depvar_unit?: string;
  granularity: string;
  shock_type: string;
  shock_col: string;
  treated_col: string;
  method: string;
  control_mode: string;
  interaction: boolean;
  price_mode: string;
  scenario: string;
  /** Optional only for readable regression snapshots saved before the typed HTTP contract. */
  weight_mode?: string;
  granularity_label?: string;
  shock_type_label?: string;
  method_label?: string;
  control_mode_label?: string;
  price_mode_label?: string;
  scenario_label: string;
  sample_filter: string;
  exclude_row: boolean;
  controls: string[];
  control_labels: Record<string, string>;
  equation: string;
  equation_parts: EquationPart[];
  /** The model: X lags, controls (with lags) and fixed effects (teaching data v10; absent on older runs). */
  spec?: ModelSpec | null;
  panel_file: string;
  entity: string;
  cluster: string;
}

interface EquationPart {
  text: string;
  term?: string;
  description?: string;
  meta_key?: string;
}

export interface RegressionSampleFlow {
  input_rows: number;
  row_excluded_rows: number;
  complete_case_input_rows: number;
  estimation_rows: number;
  dropped_rows_total: number;
  missing_by_field: Record<string, number>;
  missing_by_field_counts_overlap: boolean;
  // Mutually exclusive: ROW first, then first missing field in Y, X, treated order.
  dropped_by_reason: { code: string; field: string; rows: number }[];
  /** First and last year in the sample (a model's spec; a lagged control starts it a year later). */
  years?: [number, number];
}

export interface RegressionPreflight {
  status: string;
  can_infer: boolean;
  checks: { code: string; severity: string; message: string }[];
}

export interface RegressionResponse {
  design: RegressionDesignInfo;
  result: {
    depvar: string;
    coefs: CoefStat[];
    n_obs: number;
    n_entities: number;
    n_times: number;
    n_clusters: number;
    r2_within: number | null;
    depvar_mean: number | null;
    depvar_std: number | null;
    /** SD of Y after removing each country×industry's level and each year's common change: the 个标准差 scale. */
    depvar_within_std?: number | null;
    diagnostics: {
      study_contract?: string;
      diagnostic_only?: boolean;
      estimator?: string;
    };
    notes: string[];
    status: RegressionStatus | null;
    status_reasons: string[];
    support: TreatmentSupport | null;
    sample_flow?: RegressionSampleFlow | null;
    /** Binned scatter of the within-transformed Y against X; absent on older saved runs. */
    binscatter?: { bins: { x: number; y: number; n: number }[]; slope: number; transform: string } | null;
    /** The X terms' summed coefficient (X + L1.X in the course model, teaching data v10): the step's headline. */
    cumulative?: CoefStat | null;
    /** The constant of a model without fixed effects. */
    constant?: CoefStat | null;
    /** Regressors left out: absorbed by a fixed effect, duplicating another, or all zero. */
    omitted?: { name: string; reason: string; by: string | null }[];
    r2?: number | null;
    r2_adj?: number | null;
    f_stat?: number | null;
    f_df?: number[] | null;
    f_p?: number | null;
  };
  benchmark: {
    backend: string;
    policy_coefs: {
      name: string;
      own_coef: number;
      panelols_coef?: number;
      audit_coef?: number;
      coef_diff: number;
      own_se: number | null;
      panelols_se?: number;
      audit_se?: number | null;
      se_diff?: number | null;
    }[];
    max_abs_coef_diff: number;
    max_abs_se_diff: number;
    coef_check_passed: boolean;
    se_check_passed?: boolean;
    benchmark_passed?: boolean;
    se_check_mode: string;
    notes: string[];
  };
  variable_catalog?: { name: string; unit: string; source: string; role: string }[];
  model_snapshot?: {
    version: string;
    x_columns: string[];
    y_column: string;
    entity: string;
    time: string;
    fixed_effects: string[];
    controls: string[];
    interactions: string[];
    seed: number;
    beta: number;
    tariff_path: number[];
    disclaimer: string;
    baseline?: string;
    baseline_label?: string;
    baseline_source?: string;
    baseline_kind?: DepvarKind;
  };
  /** Missing only on a restored legacy session snapshot; every current API response includes it. */
  preflight?: RegressionPreflight;
  disclaimer: string;
}

export interface CurrentRegressionDesignInfo extends RegressionDesignInfo {
  weight_mode: string;
  granularity_label: string;
  shock_type_label: string;
  method_label: string;
  control_mode_label: string;
  price_mode_label: string;
}

export interface CurrentRegressionResponse extends RegressionResponse {
  design: CurrentRegressionDesignInfo;
  preflight: RegressionPreflight;
}

// ---------------------------------------------------------------- 教学面板

export interface ClassEnrollment {
  term_id: number;
  term_name: string;
  class_id: number;
  class_name: string;
}

export interface ClassGroup {
  id: number;
  term_id: number;
  name: string;
  is_active: boolean;
  created_at: string;
  student_count: number;
}

export interface AcademicSemester {
  id: number;
  name: string;
  is_active: boolean;
  created_at: string;
  student_count: number;
  classes: ClassGroup[];
}

export interface StudentRow {
  id: number;
  username: string;
  display_name: string;
  student_no: string;
  demo_seed: boolean;
  last_login_at: string | null;
  created_at: string;
  report_state: "draft" | "pending" | "graded" | null;
  /** Handed in, then the record changed (the teacher holds the submitted version); absent from older servers. */
  report_outdated?: boolean;
  score: number | null;
  submitted_at: string | null;
  /** Server-verified completion; never inferred from max_step. */
  verified_completed_count: number;
  verified_total_steps: number;
  verified_completed_steps: number[];
  completion_missing: number[];
  last_valid_activity: string | null;
  enrollments: ClassEnrollment[];
}

export interface TeacherReport extends ClassroomReport {
  account_id: number;
  state: "pending" | "graded";
  username: string;
  display_name: string;
  student_no: string;
  enrollments: ClassEnrollment[];
}

/** A regression model: which X terms (lags of X), which controls at which lag, which fixed effects. */
export interface ModelSpec {
  x_lags: number[];
  controls: { name: string; lag: number }[];
  fixed_effects: string[];
}

/** GET /api/regression/options: what the workbench (自己设计模型) offers, in page order. */
export interface WorkbenchOptions {
  version: string;
  default_spec: ModelSpec;
  x_lags: { lag: number; label: string; description: string }[];
  x_lag_note: string;
  controls: { name: string; label: string; definition: string; source: string }[];
  control_lags: { lag: number; label: string }[];
  control_lag_note: string;
  fixed_effects: { key: string; label: string; description: string; includes: string[] }[];
  no_fixed_effects_note: string;
  limits: { saved: number; in_report: number; compared: number; name_length: number; runs_per_minute: number };
  /** "试一试": one change at a time, each a contrast the course data were built to show. */
  tries: string[];
  hints: string[];
  footnote: string;
  sample_differs_note: string;
  suppressed_note: string;
}

/** What a saved model keeps to show its table again (the report recomputes it from the spec). */
export interface CustomResultSnapshot {
  depvar_label: string;
  depvar_kind: string;
  result: Pick<RegressionResponse["result"],
    "coefs" | "cumulative" | "constant" | "omitted" | "r2" | "r2_adj" | "r2_within" | "f_stat" | "f_df" | "f_p"
    | "n_obs" | "n_entities" | "n_times" | "n_clusters" | "status"> & {
    years: [number, number] | null;
    suppressed: boolean;
  };
}

/** steps[11–14].data.custom_results[]: one saved workbench model. */
export interface CustomResult {
  id: string;
  name: string;
  outcome: RegressionOutcome;
  baseline: string;
  spec: ModelSpec;
  in_report: boolean;
  saved_at: string;
  snapshot: CustomResultSnapshot;
}

export interface ReportedCustomResult {
  step: number;
  name: string;
  outcome: string;
  baseline: string;
  spec: ModelSpec;
}
