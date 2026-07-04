async function get<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
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
  countryIndicators: (year: number) =>
    get<Record<string, string | number | null>[]>(`/api/indicators/country/${year}`),
  sectorIndicators: (year: number, country: string, page: number) =>
    get<import("./types").SectorPage>(
      `/api/indicators/sector/${year}?page=${page}${country ? `&country=${country}` : ""}`,
    ),
  network: (year: number) => get<import("./types").NetworkData>(`/api/viz/network/${year}`),
  shockEvents: () =>
    get<{ events: import("./types").ShockEvent[]; disclaimer: string }>("/api/shocks/events"),
  shockSummary: () => get<import("./types").ShockSummary>("/api/shocks/summary"),
  shockPanel: (year: number, country: string, sector: string, onlyHit: boolean, page: number) =>
    get<import("./types").SectorPage>(
      `/api/shocks/panel?year=${year}&only_hit=${onlyHit}&page=${page}` +
        (country ? `&country=${country}` : "") + (sector ? `&sector=${sector}` : ""),
    ),
  regressionOptions: () => get<import("./types").RegressionOptions>("/api/regression/options"),
  regressionDesign: (params: {
    step: number;
    granularity: string;
    shockType?: string;
    method: string;
    controlMode?: string;
  }) => {
    const qs = new URLSearchParams({
      step: String(params.step),
      granularity: params.granularity,
      method: params.method,
    });
    if (params.shockType) qs.set("shock_type", params.shockType);
    if (params.controlMode) qs.set("control_mode", params.controlMode);
    return get<import("./types").RegressionDesignInfo>(`/api/regression/design?${qs.toString()}`);
  },
  runRegression: async (step: number, granularity: string, method: string, controlMode: string) => {
    const resp = await fetch("/api/regression/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, granularity, method, control_mode: controlMode }),
    });
    if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText);
    return resp.json() as Promise<import("./types").RegressionResponse>;
  },
  report: (year: number) => get<{ path: string; markdown: string }>(`/api/report/${year}`),
};
