export interface Step {
  n: number;
  stage: number;
  lab: "db" | "shock" | "qc" | "ind" | "viz" | "rgd" | "reg" | "rep";
  status: "done" | "demo" | "partial" | "planned";
  title: string;
  goal: string;
  concept: string;
  tip: string;
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

export interface RegressionResponse {
  design: { depvar: string; depvar_label: string; granularity: string; method: string; equation: string };
  result: {
    coefs: CoefStat[];
    n_obs: number;
    n_entities: number;
    n_times: number;
    n_clusters: number;
    r2_within: number;
    notes: string[];
  };
  disclaimer: string;
}
