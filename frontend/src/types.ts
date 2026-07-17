export type RegressionOutcome = "trade" | "production" | "length" | "network";

export interface Step {
  n: number;
  stage: number;
  lab: "db" | "shock" | "qc" | "ind" | "viz" | "reg" | "rep";
  regression_outcome?: RegressionOutcome;
  status: "done" | "demo";
  title: string;
  goal: string;
  concept: string;
  tip: string;
  deps: string[];
}

/** 证据规则:唯一来源是服务端 gvcsim/evidence.py,前端只据此显示提示与计数。 */
export interface EvidenceRules {
  min_judgment_chars: number;
  required_shock_types: string[];
}

export interface StepsResponse {
  stages: Record<string, string>;
  steps: Step[];
  evidence_rules: EvidenceRules;
}

export interface AuthUser {
  username: string;
  name: string;
  role: string;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
  expires_at: number;
}

export interface Meta {
  years: number[];
  countries: string[];
  sectors: string[];
  artifact_contract?: {
    schema_version: number;
    network_algorithm: string;
  };
  /** 当前产物集合的标识;实验会话绑定它以判定结果是否过期。 */
  manifest_id?: string | null;
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
}

interface ShockSummaryYear {
  year: number;
  treated_countries: number;
  treated_pairs: number;
  mean_shock_treated: number;
  max_shock: number;
  max_shock_target: string;
}

export interface ShockSummary {
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
}

interface CrosswalkSummary {
  n_hs_chapters: number;
  n_crosswalk_rows: number;
  n_icio_sectors: number;
  demo_list_value_coverage: number;
}

export interface CrosswalkHsRow {
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
  total: number;
  page: number;
  page_size: number;
  rows: Record<string, string | number | null>[];
}

export type IndustryPage = PagedRows;

/** 实验会话:逐步实验状态的可恢复模型(契约见 gvcsim/session.py)。 */
/** v2:回归设定改用稳定英文键;旧会话整份作废(不做历史格式兼容)。 */
export const SESSION_VERSION = "experiment-session-v2";

export interface SessionRecord<T = unknown> {
  data: T;
  /** 记录级时间戳;并发写入时服务端按它逐步合并,而不是整份覆盖。 */
  updated_at: string;
}

/** 确实跨步骤共享的实验状态(白名单,与 gvcsim/session.py 的 SHARED_KEYS 一致)。 */
export type SharedSessionKey = "regression_settings" | "regression_history";

export interface ExperimentSession {
  version: string;
  /** 产出该会话的数据产物标识;变化即意味着里面的结果已过期。 */
  manifest_id: string;
  steps: Record<string, SessionRecord>;
  shared: Partial<Record<SharedSessionKey, SessionRecord>>;
}

/**
 * 一步实验台读写自己那份学习证据的接口。
 *
 * `missing` 与 `complete` 一律来自服务端判定,实验台不自行推断是否完成——
 * 界面只负责收集证据,判定权在 gvcsim/evidence.py。
 */
export interface StepEvidenceApi<T = Record<string, unknown>> {
  data: T | undefined;
  /** 合并写入(与该步已有证据合并,不整份覆盖)。 */
  save: (patch: Partial<T>) => void;
  missing: string[];
  complete: boolean;
}

/** 单步完成判定。由服务端从会话重算(gvcsim/evidence.py),客户端不参与判定。 */
export interface StepEvidence {
  step: number;
  complete: boolean;
  /** 未完成时还差什么;直接展示给学生。 */
  missing: string[];
}

export interface CompletionSummary {
  steps: StepEvidence[];
  completed: number[];
  completed_count: number;
  total: number;
}

/** 第 16 步门槛:还差哪一步的什么证据(由服务端判定)。 */
export interface ReportGateItem {
  step: number;
  title: string;
  missing: string[];
}

export interface ReportGate {
  blocked: ReportGateItem[];
}

/** 服务端生成的实验报告:正文与溯源都由服务端产出,客户端不提供任何内容。 */
export interface GeneratedReport {
  report_key: string;
  markdown: string;
  /** 「另存为」时的建议文件名(带 report_key,便于把文件对回具体那份报告)。 */
  suggested_filename?: string;
  provenance: {
    report_key: string;
    manifest_id: string;
    session_revision: number;
    session_version: string;
    generated_at: string;
    artifact: { schema_version: number; network_algorithm: string; years: number[] };
    runs: ReportRun[];
  };
  created_at?: string;
}

/** 报告里一步回归的摘要:服务端复估后写入 provenance.runs,提交时随 design 一起冻结。 */
export interface ReportRun {
  step: number;
  outcome: string;
  design: string;
  status: string | null;
}

export interface SessionResponse {
  revision: number;
  manifest_id: string;
  session: ExperimentSession;
  stale: boolean;
  updated_at?: string | null;
  /** 非 null 表示本次写入与另一处改动做了合并,应改用返回的会话。 */
  merged_from?: number | null;
  completion: CompletionSummary;
}

export interface CoefStat {
  name: string;
  coef: number;
  se: number;
  t: number;
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
  treated_entities: number;
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

export interface PretrendDiagnostic {
  available: boolean;
  reason: string | null;
  terms: string[];
  statistic: number | null;
  df_num: number;
  df_denom: number;
  p: number | null;
  interpretation: string;
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
    r2_within: number;
    depvar_mean: number;
    depvar_std: number;
    diagnostics: { pretrend?: PretrendDiagnostic };
    notes: string[];
    status: RegressionStatus | null;
    status_reasons: string[];
    support: TreatmentSupport | null;
  };
  benchmark: {
    backend: string;
    policy_coefs: {
      name: string;
      own_coef: number;
      panelols_coef: number;
      coef_diff: number;
      own_se: number;
      panelols_se: number;
      se_diff: number;
    }[];
    max_abs_coef_diff: number;
    max_abs_se_diff: number;
    coef_check_passed: boolean;
    se_check_mode: "informational";
    notes: string[];
  };
  disclaimer: string;
}

export interface PlaceboResponse {
  design: RegressionDesignInfo;
  placebo: {
    policy_name: string;
    true_coef: number;
    placebo_coefs: number[];
    empirical_p: number;
    n_draws: number;
    requested_draws: number;
    seed: number;
    treated_entities: number;
    total_entities: number;
    cohorts: Record<string, number>;
    note: string;
  };
  disclaimer: string;
}

export interface ReportRequest {
  year: number;
  granularity: string;
  shock_type: string;
  method: string;
  control_mode: string;
  interaction: boolean;
  price_mode: string;
  exclude_row?: boolean;
}

export interface ReportResponse {
  markdown: string;
  suggested_filename: string;
}

export interface ProgressResponse {
  current_step: number | null;
  max_step: number | null;
  updated_at: string | null;
}

// ---------------------------------------------------------------- 教学面板

export interface Announcement {
  id: number;
  class_id: number | null;
  class_name: string | null;
  title: string;
  body: string;
  author: string;
  created_at: string;
}

export interface ClassInfo {
  id: number;
  name: string;
  code: string;
  semester: string;
  note: string;
  archived: boolean;
  created_at: string;
  student_count?: number;
}

export interface StudentRow {
  id: number;
  username: string;
  display_name: string;
  class_id: number | null;
  class_name: string | null;
  student_no: string;
  active: boolean;
  last_login_at: string | null;
  created_at: string;
  current_step: number | null;
  max_step: number | null;
  progress_at: string | null;
  submission_id: number | null;
  submission_state: string | null;
  score: number | null;
  submitted_at: string | null;
}

/** 学生本人的提交/评阅状态;state === "none" 表示尚未提交 */
export interface MySubmission {
  state: "none" | "pending" | "graded";
  id?: number;
  title?: string;
  year?: number;
  score?: number | null;
  feedback?: string;
  graded_by?: string | null;
  graded_at?: string | null;
  submitted_at?: string;
}

export interface SubmissionRow {
  id: number;
  title: string;
  year: number;
  state: "pending" | "graded";
  score: number | null;
  graded_by: string | null;
  graded_at: string | null;
  submitted_at: string;
  username: string;
  display_name: string;
  student_no: string;
  class_name: string | null;
}

export interface SubmissionDetail extends SubmissionRow {
  design: SubmissionDesign;
  markdown: string;
  feedback: string;
}

/** submissions.design:提交时冻结的溯源标量 + 各步回归摘要
 * (由 gvcsim/classroom/db.py 的 submit_report 用 jsonb_build_object 组装)。
 * 曾是 Record<string, unknown>,于是把 runs 数组 String() 成 "[object Object]" 也能过类型检查。 */
export interface SubmissionDesign {
  report_key: string;
  manifest_id: string;
  session_revision: number;
  runs: ReportRun[];
}

export interface ClassOverview {
  student_count: number;
  disabled_count: number;
  submitted: number;
  graded: number;
  avg_score: number | null;
  score_buckets: { label: string; count: number }[];
  step_reach: { step: number; reached: number }[];
  active_7d: number;
  submission_trend: { date: string; submitted: number; graded: number }[];
  class_breakdown: ClassBreakdown[];
}
interface ClassBreakdown {
  class_id: number;
  name: string;
  student_count: number;
  submitted: number;
  graded: number;
  avg_score: number | null;
}
