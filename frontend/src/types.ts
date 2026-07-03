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

export interface Meta {
  years: number[];
  countries: string[];
}

export interface QcCheck {
  name: string;
  kind: string;
  passed: boolean;
  detail: string;
  warnings: string[];
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
  design: { depvar: string; depvar_label: string; granularity: string; equation: string };
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
