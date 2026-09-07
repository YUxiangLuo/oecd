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
  /** Three concrete student actions rendered in the shared first-screen task card. */
  tasks: [string, string, string];
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
    data_sources?: Record<string, unknown>;
    qc_contract?: QcContract;
    shock_contract?: ShockContract;
    qc?: unknown;
    output_qc?: unknown;
    regression_input_qc?: unknown;
    publication_policy?: {
      mode: "integrity-only-v1";
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
  format: "amount" | "pct" | "number";
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
  complete: boolean;
  syncing: boolean;
  syncError: string | null;
  syncNow: () => void;
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
  report_gate: ReportGateItem[];
  material_gate: ReportGateItem[];
  report: ClassroomReport | null;
}

export interface SessionSaveResponse {
  /** Exact server-normalized snapshot persisted by this PUT. */
  session: ExperimentSession;
  updated_at: string;
  completion: CompletionSummary;
  report_gate: ReportGateItem[];
  material_gate: ReportGateItem[];
}

export interface ReportMutationResponse {
  report: ClassroomReport;
  completion: CompletionSummary;
  report_gate: ReportGateItem[];
  material_gate: ReportGateItem[];
}

export interface CoefStat {
  name: string;
  coef: number;
  // 整体门禁可能只保留 cohort-time 点估计，此时 SE/t 也不可评估。
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

/** 回归选项:键是稳定 API 契约,*_labels 是与之配对的展示文案。
 *  界面渲染 labels、请求回传 keys——改文案不再是破坏性 API 变更。 */
export interface RegressionOptions {
  granularities: string[];
  granularity_labels: Record<string, string>;
  granularities_by_outcome: Record<RegressionOutcome, string[]>;
  shock_types: string[];
  shock_type_labels: Record<string, string>;
  methods: string[];
  method_labels: Record<string, string>;
  control_modes: string[];
  control_mode_labels: Record<string, string>;
  price_modes: string[];
  price_mode_labels: Record<string, string>;
  scenarios: string[];
  scenario_labels: Record<string, string>;
  weight_modes: string[];
  weight_mode_labels: Record<string, string>;
  method_constraints: {
    cohort_aware_methods: string[];
    controls_publicly_disabled: boolean;
    cohort_aware_interaction_supported: boolean;
  };
  outcomes: Record<RegressionOutcome, string>;
}

export interface RegressionDesignInfo {
  outcome: RegressionOutcome;
  depvar: string;
  depvar_label: string;
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

export type PretrendScope = "main" | "interaction" | "joint";

export interface PretrendDiagnostic {
  /** Present on v7 diagnostics; omitted only by readable legacy snapshots. */
  scope?: PretrendScope;
  available: boolean;
  reason: string | null;
  terms: string[];
  /** Additive in REG-01; unsupported leads excluded from the joint test. */
  excluded_terms?: { term: string; reasons: string[] }[];
  /** REG-02 provenance when the whole-run gate prevents the joint test. */
  support_status?: RegressionStatus;
  support_reasons?: string[];
  statistic: number | null;
  df_num: number;
  df_denom: number;
  p: number | null;
  interpretation: string;
}

export interface EventPeriodSupport {
  term: string;
  event_time: number;
  is_reference: boolean;
  estimated: boolean;
  contributing_rows: number;
  contributing_entities: number;
  contributing_clusters: number;
  /** 实际基期—目标期配对中的贡献对照聚类。 */
  control_clusters?: number;
  cohorts: Record<string, number>;
  period_supported: boolean;
  inference_supported: boolean;
  suppress_inference: boolean;
  reason_codes: string[];
  reasons: string[];
}

export interface EventSupport {
  policy: "teaching_min_contributing_clusters_per_event_period";
  policy_is_statistical_theorem: false;
  cluster: string;
  /** Exact omitted event period; v7 requires a true negative base. */
  base_k: number;
  reference_term: string;
  min_contributing_clusters: number;
  periods: EventPeriodSupport[];
}

export interface MarginalEffect {
  policy_term: string;
  interaction_term: string;
  level: "low" | "mean" | "high";
  label: string;
  reference: "p25" | "mean" | "p75";
  baseline_gvc_centered: number;
  effect: number;
  se: number;
  t: number;
  p: number | null;
  ci_low: number | null;
  ci_high: number | null;
}

export interface RegressionSampleFlow {
  input_rows: number;
  structural_eligible_rows: number;
  structural_excluded_rows: number;
  timing_source_rows: number;
  timing_entities: number;
  timing_clusters: number;
  timing_treated_entities: number;
  timing_cohorts: Record<string, number>;
  timing_policy: "full_shock_history_before_complete_case" | null;
  estimation_rows: number;
  estimation_entities: number;
  estimation_clusters: number;
  dropped_rows_total: number;
  missing_by_field: Record<string, number>;
  missing_by_field_counts_overlap: boolean;
  dropped_by_reason: { code: string; field: string; rows: number }[];
  retained_treated_entities?: number;
  retained_never_treated_entities?: number;
  treated_entities_without_post_rows?: number;
  contributing_treated_entities?: number;
  contributing_treated_clusters?: number;
  retained_cohorts?: Record<string, number>;
  contributing_cohorts?: Record<string, number>;
}

export interface RegressionPreflight {
  status: string;
  can_infer: boolean;
  checks: { code: string; severity: string; message: string }[];
}

export interface CohortTimeCell {
  cohort: number;
  time: number;
  event_time: number;
  term: string;
  att: number;
  treated_entities: number;
  control_entities: number;
  treated_clusters: number;
  control_clusters: number;
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
    diagnostics: {
      study_contract?: string;
      diagnostic_only?: boolean;
      pretrend?: PretrendDiagnostic;
      pretrend_tests?: Partial<Record<PretrendScope, PretrendDiagnostic>>;
      estimator?: string;
      cohort_time_cells?: CohortTimeCell[];
    };
    marginal_effects?: MarginalEffect[];
    notes: string[];
    status: RegressionStatus | null;
    status_reasons: string[];
    support: TreatmentSupport | null;
    /** Additive in REG-01; optional keeps legacy snapshots structurally readable but inference fails closed. */
    event_support?: EventSupport | null;
    /** Additive in REG-04; optional keeps legacy saved results renderable. */
    sample_flow?: RegressionSampleFlow | null;
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

export interface PlaceboResponse {
  design: CurrentRegressionDesignInfo;
  placebo: {
    policy_name: string;
    true_coef: number;
    placebo_coefs: number[];
    /** 抽样系数中至少和原始估计一样极端的实际占比。 */
    tail_share: number;
    extreme_count: number;
    /** 加一修正后的有限次 Monte Carlo 统计量；置换机制未校准，不能作为 p 值。 */
    adjusted_tail_share: number;
    /** @deprecated adjusted_tail_share 的旧字段别名，不得作 p 值解释。 */
    empirical_p: number;
    n_draws: number;
    requested_draws: number;
    seed: number;
    treated_entities: number;
    total_entities: number;
    cohorts: Record<string, number>;
    calibrated_inference: false;
    assignment_preserved: string[];
    assignment_not_preserved: string[];
    note: string;
  };
  disclaimer: string;
}

// ---------------------------------------------------------------- 教学面板

export interface StudentRow {
  id: number;
  username: string;
  display_name: string;
  student_no: string;
  demo_seed: boolean;
  last_login_at: string | null;
  created_at: string;
  report_state: "draft" | "pending" | "graded" | null;
  score: number | null;
  submitted_at: string | null;
  /** Server-verified completion; never inferred from max_step. */
  verified_completed_count: number;
  verified_total_steps: number;
  verified_completed_steps: number[];
  completion_missing: number[];
  last_valid_activity: string | null;
}

export interface TeacherReport extends ClassroomReport {
  account_id: number;
  state: "pending" | "graded";
  username: string;
  display_name: string;
  student_no: string;
}
