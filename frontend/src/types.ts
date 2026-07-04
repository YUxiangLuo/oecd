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
  imposer: string;
  targets: string;
  exempt: string;
  announced: string;
  effective: string;
  n_sectors: number;
  top_sectors: string[];
  peak_rate: number;
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
  steps: Record<string, string>; // 步骤号 → 被解释变量中文名
}

export interface RegressionDesignInfo {
  step: number;
  depvar: string;
  depvar_label: string;
  granularity: string;
  shock_type: string;
  method: string;
  control_mode: string;
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
    passed: boolean;
    notes: string[];
  };
  disclaimer: string;
}
