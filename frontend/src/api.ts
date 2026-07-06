export const AUTH_TOKEN_KEY = "gvcsim_token";

function notifyAuthExpired() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  window.dispatchEvent(new Event("gvcsim-auth-expired"));
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  return token ? { ...extra, Authorization: `Bearer ${token}` } : (extra ?? {});
}

async function get<T>(url: string): Promise<T> {
  const resp = await fetch(url, { headers: authHeaders() });
  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    if (resp.status === 401) notifyAuthExpired();
    throw new Error(body?.detail ?? `${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

export const api = {
  login: async (username: string, password: string) => {
    const resp = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText);
    return resp.json() as Promise<import("./types").LoginResponse>;
  },
  me: async (token: string) => {
    const resp = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error("令牌无效或已过期");
    return resp.json() as Promise<import("./types").AuthUser>;
  },
  steps: () => get<import("./types").StepsResponse>("/api/steps"),
  meta: () => get<import("./types").Meta>("/api/meta"),
  indicatorSchema: () => get<import("./types").IndicatorSchema>("/api/indicators/schema"),
  dbMeta: () => get<import("./types").DbMeta>("/api/db/meta"),
  dbSlice: (params: {
    year: number;
    table: import("./types").DbTableKind;
    rowCountry?: string;
    colCountry?: string;
    rowSector?: string;
    colSector?: string;
    page?: number;
    pageSize?: number;
  }) => {
    const qs = new URLSearchParams({
      year: String(params.year),
      table: params.table,
      page: String(params.page ?? 1),
      page_size: String(params.pageSize ?? 25),
    });
    if (params.rowCountry) qs.set("row_country", params.rowCountry);
    if (params.colCountry) qs.set("col_country", params.colCountry);
    if (params.rowSector) qs.set("row_sector", params.rowSector);
    if (params.colSector) qs.set("col_sector", params.colSector);
    return get<import("./types").DbSlice>(`/api/db/slice?${qs.toString()}`);
  },
  qc: (year: number) => get<import("./types").QcCheck[]>(`/api/qc/${year}`),
  qcShocks: () => get<import("./types").QcCheck[]>("/api/qc/shocks"),
  qcControls: () => get<import("./types").QcCheck[]>("/api/qc/controls"),
  countryIndicators: (year: number) =>
    get<Record<string, string | number | null>[]>(`/api/indicators/country/${year}`),
  sectorIndicators: (year: number, country: string, page: number) =>
    get<import("./types").SectorPage>(
      `/api/indicators/sector/${year}?page=${page}${country ? `&country=${country}` : ""}`,
    ),
  // 拉取一个国家全部行业的指标行(用于步骤4-6 的拆解演示,一次取回填充行业下拉)
  sectorIndicatorsAll: (year: number, country: string) =>
    get<import("./types").SectorPage>(
      `/api/indicators/sector/${year}?page=1&page_size=200${country ? `&country=${country}` : ""}`,
    ),
  network: (year: number) => get<import("./types").NetworkData>(`/api/viz/network/${year}`),
  shockEvents: () =>
    get<{ events: import("./types").ShockEvent[]; disclaimer: string }>("/api/shocks/events"),
  shockSummary: (shockType = "关税冲击") =>
    get<import("./types").ShockSummary>(
      `/api/shocks/summary?shock_type=${encodeURIComponent(shockType)}`,
    ),
  crosswalkDemo: (year = 2019) =>
    get<import("./types").CrosswalkPayload>(`/api/crosswalk/demo?year=${year}`),
  shockPanel: (year: number, shockType: string, country: string, sector: string, onlyHit: boolean, page: number) =>
    get<import("./types").SectorPage>(
      `/api/shocks/panel?year=${year}&shock_type=${encodeURIComponent(shockType)}&only_hit=${onlyHit}&page=${page}` +
        (country ? `&country=${country}` : "") + (sector ? `&sector=${sector}` : ""),
    ),
  regressionOptions: () => get<import("./types").RegressionOptions>("/api/regression/options"),
  regressionDesign: (params: {
    step: number;
    granularity: string;
    shockType?: string;
    method: string;
    controlMode?: string;
    interaction?: boolean;
    priceMode?: string;
    scenario?: string;
  }) => {
    const qs = new URLSearchParams({
      step: String(params.step),
      granularity: params.granularity,
      method: params.method,
    });
    if (params.shockType) qs.set("shock_type", params.shockType);
    if (params.controlMode) qs.set("control_mode", params.controlMode);
    if (params.interaction) qs.set("interaction", "true");
    if (params.priceMode) qs.set("price_mode", params.priceMode);
    if (params.scenario) qs.set("scenario", params.scenario);
    return get<import("./types").RegressionDesignInfo>(`/api/regression/design?${qs.toString()}`);
  },
  runRegression: async (
    step: number,
    granularity: string,
    shockType: string,
    method: string,
    controlMode: string,
    interaction: boolean,
    priceMode: string,
    scenario: string,
  ) => {
    const resp = await fetch("/api/regression/run", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        step,
        granularity,
        shock_type: shockType,
        method,
        control_mode: controlMode,
        interaction,
        price_mode: priceMode,
        scenario,
      }),
    });
    if (resp.status === 401) notifyAuthExpired();
    if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText);
    return resp.json() as Promise<import("./types").RegressionResponse>;
  },
  placeboRegression: async (
    step: number,
    granularity: string,
    shockType: string,
    method: string,
    controlMode: string,
    interaction: boolean,
    priceMode: string,
    scenario: string,
    nDraws = 40,
  ) => {
    const resp = await fetch("/api/regression/placebo", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        step,
        granularity,
        shock_type: shockType,
        method,
        control_mode: controlMode,
        interaction,
        price_mode: priceMode,
        scenario,
        n_draws: nDraws,
      }),
    });
    if (resp.status === 401) notifyAuthExpired();
    if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText);
    return resp.json() as Promise<import("./types").PlaceboResponse>;
  },
  report: async (params: import("./types").ReportRequest) => {
    const resp = await fetch("/api/report", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(params),
    });
    if (resp.status === 401) notifyAuthExpired();
    if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText);
    return resp.json() as Promise<import("./types").ReportResponse>;
  },
};
