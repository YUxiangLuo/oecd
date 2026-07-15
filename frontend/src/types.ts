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

export interface StepsResponse {
  stages: Record<string, string>;
  steps: Step[];
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

export interface CoefStat {
  name: string;
  coef: number;
  se: number;
  t: number;
  p: number;
  stars: string;
  ci_low: number;
  ci_high: number;
}

export interface RegressionOptions {
  granularities: string[];
  granularities_by_outcome: Record<RegressionOutcome, string[]>;
  shock_types: string[];
  methods: string[];
  control_modes: string[];
  price_modes: string[];
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
  design: Record<string, unknown>;
  markdown: string;
  feedback: string;
}

export interface ClassOverview {
  student_count: number;
  disabled_count: number;
  submitted: number;
  graded: number;
  avg_score: number | null;
  score_buckets: { label: string; count: number }[];
  step_completion: { step: number; reached: number }[];
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
