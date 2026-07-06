export interface Step {
  n: number;
  stage: number;
  lab: "db" | "shock" | "qc" | "ind" | "viz" | "rgd" | "reg" | "rep";
  status: "done" | "demo" | "partial" | "planned";
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
}

export type DbTableKind = "z" | "y" | "accounts";

export interface DbFile {
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
}

export interface ShockEvent {
  name: string;
  shock_type?: string;
  imposer: string;
  targets: string;
  exempt: string;
  announced: string;
  effective: string;
  n_sectors: number;
  top_sectors: string[];
  peak_rate: number;
  entities?: string;
}

export interface ShockSummaryYear {
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

export interface CrosswalkSummary {
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

export interface CrosswalkMappedRow {
  icio_sector: string;
  mapped_value_weight: number;
  affected_value_weight: number;
  tariff_contribution: number;
  avg_tariff: number;
  top_hs_chapters: string;
}

export interface CrosswalkRow {
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

export interface IndicatorFieldMeta {
  label: string;
  format: "amount" | "pct" | "number";
}

export interface IndicatorGroup {
  key: string;
  label: string;
  fields: string[];
}

export interface IndicatorSchema {
  groups: IndicatorGroup[];
  fields: Record<string, IndicatorFieldMeta>;
}

export interface SectorPage {
  total: number;
  page: number;
  page_size: number;
  rows: Record<string, string | number | null>[];
}

export interface CoefStat {
  name: string;
  coef: number;
  se: number;
  t: number;
  p: number;
  stars: string;
}

export interface RegressionOptions {
  granularities: string[];
  shock_types: string[];
  methods: string[];
  control_modes: string[];
  price_modes: string[];
  scenarios: string[];
  scenario_labels: Record<string, string>;
  steps: Record<string, string>; // 步骤号 → 被解释变量中文名
}

export interface RegressionDesignInfo {
  step: number;
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
  controls: string[];
  control_labels: Record<string, string>;
  equation: string;
  panel_file: string;
  entity: string;
  cluster: string;
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
}

export interface ReportResponse {
  path: string;
  markdown: string;
}
