import type { ExperimentSession, GeneratedReport, ProgressResponse, ReportGate, SessionResponse } from "./types";

export const AUTH_TOKEN_KEY = "gvcsim_token";

// localStorage 只负责跨刷新恢复认证。每个已挂载标签页必须继续使用自己校验过的
// token；否则另一个标签登录新账号后，旧页面会把自己的 React 状态写给新账号。
let activeAuthToken: string | null | undefined;

export function setActiveAuthToken(token: string | null): void {
  activeAuthToken = token;
}

export function getActiveAuthToken(): string | null {
  if (activeAuthToken === undefined) {
    activeAuthToken = globalThis.localStorage?.getItem(AUTH_TOKEN_KEY) ?? null;
  }
  return activeAuthToken;
}

class ApiError extends Error {
  status: number;
  /** 结构化 detail(如第 16 步门槛的 blocked 列表);普通字符串 detail 时为 undefined。 */
  blocked?: import("./types").ReportGateItem[];

  constructor(status: number, detail: unknown, fallback: string) {
    // FastAPI 的 detail 可以是字符串,也可以是对象(门槛就返回 {message, blocked})。
    // 直接把对象塞进 Error.message 会渲染成 "[object Object]",这里分开处理。
    const structured = typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : null;
    super(typeof detail === "string" ? detail : (structured?.message as string) ?? fallback);
    this.name = "ApiError";
    this.status = status;
    if (Array.isArray(structured?.blocked)) this.blocked = structured.blocked as import("./types").ReportGateItem[];
  }
}

type QueryValue = string | number | boolean | null | undefined;

/** 所有查询参数统一在这里编码，避免国家/行业代码中的 &、+ 等字符破坏 URL。 */
export function withQuery(path: string, params: Record<string, QueryValue>): string {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
  });
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

export function shouldExpireAuth(requestToken: string | null, currentToken: string | null): boolean {
  return requestToken !== null && requestToken === currentToken;
}

function notifyAuthExpired(requestToken: string | null) {
  if (!shouldExpireAuth(requestToken, getActiveAuthToken())) return;
  setActiveAuthToken(null);
  // 延迟返回的旧请求不能删除另一个标签刚写入的新 token。
  if (requestToken === localStorage.getItem(AUTH_TOKEN_KEY)) {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  }
  window.dispatchEvent(new Event("gvcsim-auth-expired"));
}

function authHeaders(token: string | null, extra?: HeadersInit): HeadersInit {
  return token ? { ...extra, Authorization: `Bearer ${token}` } : (extra ?? {});
}

const GET_TIMEOUT_MS = 10_000;
async function getWithToken<T>(url: string, requestToken: string | null, fallback?: string): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), GET_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: authHeaders(requestToken),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => null);
      if (resp.status === 401) notifyAuthExpired(requestToken);
      throw new ApiError(resp.status, body?.detail, fallback ?? `${resp.status} ${resp.statusText}`);
    }
    return await resp.json() as T;
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error(`请求超时（${GET_TIMEOUT_MS / 1000} 秒）：${url}`);
    }
    throw cause;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function get<T>(url: string): Promise<T> {
  return getWithToken<T>(url, getActiveAuthToken());
}

async function post<T>(url: string, body?: unknown, method = "POST"): Promise<T> {
  const requestToken = getActiveAuthToken();
  const resp = await fetch(url, {
    method,
    headers: authHeaders(requestToken, { "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    const payload = await resp.json().catch(() => null);
    if (resp.status === 401) notifyAuthExpired(requestToken);
    throw new ApiError(resp.status, payload?.detail, `${resp.status} ${resp.statusText}`);
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
    if (!resp.ok) throw new ApiError(resp.status, (await resp.json()).detail, resp.statusText);
    return resp.json() as Promise<import("./types").LoginResponse>;
  },
  me: (token: string) =>
    getWithToken<import("./types").AuthUser>("/api/auth/me", token, "令牌无效或已过期"),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ ok: boolean; reauthenticate: boolean }>("/api/auth/password", {
      current_password: currentPassword,
      new_password: newPassword,
    }),
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
    return get<import("./types").DbSlice>(withQuery("/api/db/slice", {
      year: params.year,
      table: params.table,
      page: params.page ?? 1,
      page_size: params.pageSize ?? 25,
      row_country: params.rowCountry,
      col_country: params.colCountry,
      row_sector: params.rowSector,
      col_sector: params.colSector,
    }));
  },
  qc: (year: number) => get<import("./types").QcCheck[]>(`/api/qc/${year}`),
  qcShocks: () => get<import("./types").QcCheck[]>("/api/qc/shocks"),
  qcControls: () => get<import("./types").QcCheck[]>("/api/qc/controls"),
  countryIndicators: (year: number) =>
    get<Record<string, string | number | null>[]>(`/api/indicators/country/${year}`),
  industryIndicators: (year: number, country: string, page: number) =>
    get<import("./types").IndustryPage>(
      withQuery(`/api/indicators/industry/${year}`, { page, country }),
    ),
  // 拉取一个国家全部行业的指标行(用于步骤3-5 的拆解演示,一次取回填充行业下拉)
  industryIndicatorsAll: (year: number, country: string) =>
    get<import("./types").IndustryPage>(
      withQuery(`/api/indicators/industry/${year}`, { page: 1, page_size: 200, country }),
    ),
  network: (year: number) => get<import("./types").NetworkData>(`/api/viz/network/${year}`),
  shockEvents: () =>
    get<{ events: import("./types").ShockEvent[]; disclaimer: string }>("/api/shocks/events"),
  shockSummary: (shockType = "tariff") =>
    get<import("./types").ShockSummary>(
      withQuery("/api/shocks/summary", { shock_type: shockType }),
    ),
  crosswalkDemo: (year = 2019) =>
    get<import("./types").CrosswalkPayload>(withQuery("/api/crosswalk/demo", { year })),
  shockPanel: (year: number, shockType: string, country: string, sector: string, onlyHit: boolean, page: number) =>
    get<import("./types").PagedRows>(
      withQuery("/api/shocks/panel", {
        year, shock_type: shockType, only_hit: onlyHit, page, country, sector,
      }),
    ),
  regressionOptions: () => get<import("./types").RegressionOptions>("/api/regression/options"),
  regressionDesign: (params: {
    outcome: import("./types").RegressionOutcome;
    granularity: string;
    shockType?: string;
    method: string;
    controlMode?: string;
    interaction?: boolean;
    priceMode?: string;
    scenario?: string;
    weightMode?: string;
  }) => {
    return get<import("./types").RegressionDesignInfo>(withQuery("/api/regression/design", {
      outcome: params.outcome,
      granularity: params.granularity,
      method: params.method,
      shock_type: params.shockType,
      control_mode: params.controlMode,
      interaction: params.interaction || undefined,
      price_mode: params.priceMode,
      scenario: params.scenario,
      weight_mode: params.weightMode,
    }));
  },
  runRegression: async (
    outcome: import("./types").RegressionOutcome,
    granularity: string,
    shockType: string,
    method: string,
    controlMode: string,
    interaction: boolean,
    priceMode: string,
    scenario: string,
    weightMode: string,
  ) => {
    return post<import("./types").RegressionResponse>("/api/regression/run", {
        outcome,
        granularity,
        shock_type: shockType,
        method,
        control_mode: controlMode,
        interaction,
        price_mode: priceMode,
        scenario,
        weight_mode: weightMode,
    });
  },
  placeboRegression: async (
    outcome: import("./types").RegressionOutcome,
    granularity: string,
    shockType: string,
    method: string,
    controlMode: string,
    interaction: boolean,
    priceMode: string,
    scenario: string,
    weightMode: string,
    nDraws = 40,
  ) => {
    return post<import("./types").PlaceboResponse>("/api/regression/placebo", {
        outcome,
        granularity,
        shock_type: shockType,
        method,
        control_mode: controlMode,
        interaction,
        price_mode: priceMode,
        scenario,
        weight_mode: weightMode,
        n_draws: nDraws,
    });
  },
  classroom: {
    submitQuiz: (body: { step: number; version: string; answers: Record<string, string> }) =>
      post<{
        passed: boolean;
        version: string;
        results: { question_id: string; correct: boolean; explanation: string }[];
        quiz?: { version: string; answers: Record<string, string> };
      }>("/api/classroom/quiz/submit", body),
    announcements: () =>
      get<{ announcements: import("./types").Announcement[] }>("/api/classroom/announcements"),
    progress: () => get<ProgressResponse>("/api/classroom/progress"),
    reportProgress: (step: number) => post<{ ok: boolean }>("/api/classroom/progress", { step }),
    session: () => get<SessionResponse>("/api/classroom/session"),
    saveSession: (body: { session: ExperimentSession }) =>
      post<SessionResponse>("/api/classroom/session", body, "PUT"),
    resetWorkspace: (body: { confirmation: string }) =>
      post<{ ok: boolean }>("/api/classroom/workspace/reset", body),
    submitReport: (body: { title: string }) =>
      post<{
        id: number;
        state: "pending" | "graded";
        submitted_at: string;
      }>("/api/classroom/report/submit", body),
    generateReport: () => post<GeneratedReport>("/api/classroom/report/generate"),
    generatedReport: () => get<Partial<GeneratedReport>>("/api/classroom/report/generated"),
    reportGate: () => get<ReportGate>("/api/classroom/report/gate"),
    myReport: () => get<import("./types").MySubmission>("/api/classroom/report/mine"),
    overview: (classId?: number | null) =>
      get<import("./types").ClassOverview>(
        withQuery("/api/classroom/overview", { class_id: classId }),
      ),
    classes: () => get<{ classes: import("./types").ClassInfo[] }>("/api/classroom/classes"),
    createClass: (body: { name: string; code: string; semester?: string; note?: string }) =>
      post<import("./types").ClassInfo>("/api/classroom/classes", body),
    students: (classId?: number | null) =>
      get<{ students: import("./types").StudentRow[] }>(
        withQuery("/api/classroom/students", { class_id: classId }),
      ),
    createStudent: (body: {
      username: string;
      display_name: string;
      password: string;
      student_no?: string;
      class_id?: number | null;
    }) => post<import("./types").StudentRow>("/api/classroom/students", body),
    updateStudent: (
      id: number,
      body: { display_name?: string; student_no?: string; class_id?: number | null; password?: string },
    ) => post<import("./types").StudentRow>(`/api/classroom/students/${id}`, body),
    submissions: () =>
      get<{ submissions: import("./types").SubmissionRow[] }>("/api/classroom/submissions"),
    submissionDetail: (id: number) =>
      get<import("./types").SubmissionDetail>(`/api/classroom/submissions/${id}`),
    grade: (id: number, score: number, feedback: string) =>
      post<import("./types").SubmissionDetail>(`/api/classroom/submissions/${id}/grade`, { score, feedback }),
    createAnnouncement: (body: { title: string; body: string; class_id?: number | null }) =>
      post<import("./types").Announcement>("/api/classroom/announcements", body),
    deleteAnnouncement: (id: number) =>
      post<{ ok: boolean }>(`/api/classroom/announcements/${id}`, undefined, "DELETE"),
  },
};
