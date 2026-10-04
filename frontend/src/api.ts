import type { ExperimentSession, ReportMutationResponse, SessionResponse, SessionSaveResponse } from "./types";

export const AUTH_TOKEN_KEY = "gvcsim_token";

// 登录只属于当前标签页；刷新保留，其他标签登录/退出不干扰本页。
// 挂载后仍固定请求身份，避免迟到请求跨账号读写。
let activeAuthToken: string | null | undefined;

export function setActiveAuthToken(token: string | null): void {
  activeAuthToken = token;
}

export function getActiveAuthToken(): string | null {
  if (activeAuthToken === undefined) {
    activeAuthToken = globalThis.sessionStorage?.getItem(AUTH_TOKEN_KEY) ?? null;
  }
  return activeAuthToken;
}

class ApiError extends Error {
  status: number;
  /** 结构化 detail(如第 15 步门槛的 blocked 列表);普通字符串 detail 时为 undefined。 */
  blocked?: import("./types").ReportGateItem[];

  constructor(status: number, detail: unknown, fallback: string) {
    // FastAPI 的 detail 可以是字符串,也可以是对象(门槛就返回 {message, blocked})。
    // 直接把对象塞进 Error.message 会渲染成 "[object Object]",这里分开处理。
    const structured = typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : null;
    const defaultMessage = status >= 500
      ? "服务暂时不可用，请稍后重试；若持续失败，请联系老师。"
      : status === 422 ? "提交内容不符合要求，请检查输入后重试。" : fallback;
    super(typeof detail === "string" ? detail : (structured?.message as string) ?? defaultMessage);
    this.name = "ApiError";
    this.status = status;
    if (Array.isArray(structured?.blocked)) this.blocked = structured.blocked as import("./types").ReportGateItem[];
  }
}

export function isApiErrorStatus(cause: unknown, status: number): boolean {
  return cause instanceof ApiError && cause.status === status;
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

function notifyAuthExpired(requestToken: string | null) {
  if (!requestToken || requestToken !== getActiveAuthToken()) return;
  setActiveAuthToken(null);
  if (requestToken === sessionStorage.getItem(AUTH_TOKEN_KEY)) {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
  }
  window.dispatchEvent(new Event("gvcsim-auth-expired"));
}

function authHeaders(token: string | null, extra?: HeadersInit): HeadersInit {
  return token ? { ...extra, Authorization: `Bearer ${token}` } : (extra ?? {});
}

const GET_TIMEOUT_MS = 10_000;
const MUTATION_TIMEOUT_MS = 120_000;

async function withRequestTimeout<T>(
  url: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("请求已取消")), { once: true });
  });
  const cancel = () => controller.abort();
  callerSignal?.addEventListener("abort", cancel, { once: true });
  if (callerSignal?.aborted) controller.abort();
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } catch (cause) {
    if (timedOut) throw new Error(`请求超时（${timeoutMs / 1000} 秒）：${url}`);
    throw cause;
  } finally {
    globalThis.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", cancel);
  }
}

async function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("请求已取消");
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      globalThis.clearTimeout(timer);
      reject(new Error("请求已取消"));
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

async function getWithToken<T>(url: string, requestToken: string | null, fallback?: string, callerSignal?: AbortSignal): Promise<T> {
  return withRequestTimeout(url, GET_TIMEOUT_MS, async (signal) => {
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) throw new Error("请求已取消");
      const resp = await fetch(url, { headers: authHeaders(requestToken), signal });
      if (resp.ok) return await resp.json() as T;
      const body = await resp.json().catch(() => null);
      if (attempt < 2 && [502, 503, 504].includes(resp.status)) {
        const retryAfter = Number(resp.headers.get("Retry-After"));
        const backoff = 150 * 2 ** attempt + Math.random() * 100;
        await retryDelay(Math.max(backoff, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0), signal);
        continue;
      }
      if (resp.status === 401) notifyAuthExpired(requestToken);
      throw new ApiError(resp.status, body?.detail, fallback ?? `${resp.status} ${resp.statusText}`);
    }
  }, callerSignal);
}

function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  return getWithToken<T>(url, getActiveAuthToken(), undefined, signal);
}

async function post<T>(url: string, body?: unknown, method = "POST", callerSignal?: AbortSignal): Promise<T> {
  const requestToken = getActiveAuthToken();
  return withRequestTimeout(url, MUTATION_TIMEOUT_MS, async (signal) => {
    if (signal.aborted) throw new Error("请求已取消");
    const resp = await fetch(url, {
      method,
      headers: authHeaders(requestToken, { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const payload = await resp.json().catch(() => null);
      if (resp.status === 401) notifyAuthExpired(requestToken);
      throw new ApiError(resp.status, payload?.detail, `${resp.status} ${resp.statusText}`);
    }
    return await resp.json() as T;
  }, callerSignal);
}

export const api = {
  login: (username: string, password: string) =>
    withRequestTimeout("/api/auth/login", GET_TIMEOUT_MS, async (signal) => {
      const resp = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        signal,
      });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => null);
        throw new ApiError(resp.status, payload?.detail, resp.statusText);
      }
      return await resp.json() as import("./types").LoginResponse;
    }),
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
  dbMeta: (signal?: AbortSignal) => get<import("./types").DbMeta>("/api/db/meta", signal),
  dbSlice: (params: {
    year: number;
    table: import("./types").DbTableKind;
    rowCountry?: string;
    colCountry?: string;
    rowSector?: string;
    colSector?: string;
    page?: number;
    pageSize?: number;
  }, signal?: AbortSignal) => {
    return get<import("./types").DbSlice>(withQuery("/api/db/slice", {
      year: params.year,
      table: params.table,
      page: params.page ?? 1,
      page_size: params.pageSize ?? 25,
      row_country: params.rowCountry,
      col_country: params.colCountry,
      row_sector: params.rowSector,
      col_sector: params.colSector,
    }), signal);
  },
  qc: (year: number) => get<import("./types").QcCheck[]>(`/api/qc/${year}`),
  qcShocks: () => get<import("./types").QcCheck[]>("/api/qc/shocks"),
  qcControls: () => get<import("./types").QcCheck[]>("/api/qc/controls"),
  countryIndicators: (year: number) =>
    get<Record<string, string | number | null>[]>(`/api/indicators/country/${year}`),
  countryIndicatorsForCountry: (year: number, country: string) => {
    if (!country) return Promise.reject(new Error("单实体指标请求必须指定国家"));
    return get<Record<string, string | number | null>[]>(
      withQuery(`/api/indicators/country/${year}`, { country }),
    );
  },
  industryIndicators: (year: number, country: string, page: number, pageSize?: number) =>
    get<import("./types").IndustryPage>(
      withQuery(`/api/indicators/industry/${year}`, { page, page_size: pageSize, country }),
    ),
  // 拉取一个国家全部行业的指标行(用于步骤2-4 的拆解演示,一次取回填充行业下拉)
  industryIndicatorsAll: (year: number, country: string) => {
    if (!country) return Promise.reject(new Error("单实体指标请求必须指定国家"));
    return get<import("./types").IndustryPage>(
      withQuery(`/api/indicators/industry/${year}`, { page: 1, page_size: 200, country }),
    );
  },
  network: (year: number) => get<import("./types").NetworkData>(`/api/viz/network/${year}`),
  shockEvents: () =>
    get<{ events: import("./types").ShockEvent[]; disclaimer: string; source_disclosure: string }>("/api/shocks/events"),
  teachingPanel: (country: string, year: number, limit = 200) =>
    get<import("./types").TeachingPanelResponse>(
      withQuery("/api/regression/teaching-panel", { country, year, limit }),
    ),
  teachingSeries: (countries: string[], industry: string) =>
    get<import("./types").TeachingPanelResponse>(
      withQuery("/api/regression/teaching-panel", {
        countries: countries.join(","), industry, limit: 200,
      }),
    ),
  shockSummary: (shockType = "tariff") =>
    get<import("./types").ShockSummary>(
      withQuery("/api/shocks/summary", { shock_type: shockType }),
    ),
  crosswalkDemo: (year = 2019) =>
    get<import("./types").CrosswalkPayload>(withQuery("/api/crosswalk/demo", { year })),
  shockPanel: (
    year: number,
    shockType: string,
    country: string,
    sector: string,
    filter: "treated" | "nonzero" | "all",
    sort: "intensity_desc" | "intensity_asc" | "country_asc" | "industry_asc",
    page: number,
  ) => get<import("./types").PagedRows>(
    withQuery("/api/shocks/panel", {
      year, shock_type: shockType, filter, sort, page, country, sector,
    }),
  ),
  regressionDesign: (outcome: import("./types").RegressionOutcome) => {
    return get<import("./types").RegressionDesignInfo>(withQuery("/api/regression/design", {
      outcome,
    }));
  },
  runRegression: async (
    outcome: import("./types").RegressionOutcome,
    signal?: AbortSignal,
  ) => {
    return post<import("./types").CurrentRegressionResponse>("/api/regression/run", {
      outcome,
    }, "POST", signal);
  },
  classroom: {
    submitQuiz: (body: { step: number; version: string; answers: Record<string, string> }) =>
      post<{
        passed: boolean;
        version: string;
        results: { question_id: string; correct: boolean; explanation: string }[];
        quiz?: { version: string; answers: Record<string, string> };
      }>("/api/classroom/quiz/submit", body),
    session: () => get<SessionResponse>("/api/classroom/session"),
    saveSession: (body: { session: ExperimentSession; base_updated_at: string | null }) =>
      post<SessionSaveResponse>("/api/classroom/session", body, "PUT"),
    submitReport: () => post<ReportMutationResponse>("/api/classroom/report/submit"),
    generateReport: (expectedReportUpdatedAt: string | null) =>
      post<ReportMutationResponse>("/api/classroom/report/generate", { expected_report_updated_at: expectedReportUpdatedAt }),
    semesters: () => get<{ semesters: import("./types").AcademicSemester[] }>("/api/classroom/semesters"),
    createSemester: (name: string) =>
      post<Omit<import("./types").AcademicSemester, "student_count" | "classes">>("/api/classroom/semesters", { name }),
    updateSemester: (id: number, body: { name?: string; is_active?: boolean }) =>
      post<Omit<import("./types").AcademicSemester, "student_count" | "classes">>(`/api/classroom/semesters/${id}`, body),
    createClass: (termId: number, name: string) =>
      post<Omit<import("./types").ClassGroup, "student_count">>("/api/classroom/classes", { term_id: termId, name }),
    updateClass: (id: number, body: { name?: string; is_active?: boolean }) =>
      post<Omit<import("./types").ClassGroup, "student_count">>(`/api/classroom/classes/${id}`, body),
    students: () => get<{ students: import("./types").StudentRow[] }>("/api/classroom/students"),
    createStudentBatch: (body: { class_id: number; students: { username: string; display_name: string; password: string }[]; preview: boolean }) =>
      post<{ existing: string[]; created: number }>("/api/classroom/students/batch", body),
    createStudent: (body: {
      username: string;
      display_name: string;
      password: string;
      student_no?: string;
      class_id?: number;
    }) => post<import("./types").StudentRow>("/api/classroom/students", body),
    updateStudent: (
      id: number,
      body: { display_name?: string; student_no?: string; password?: string },
    ) => post<import("./types").StudentRow>(`/api/classroom/students/${id}`, body),
    setEnrollment: (id: number, termId: number, classId: number | null) =>
      post<{ enrollments: import("./types").ClassEnrollment[] }>(
        `/api/classroom/students/${id}/enrollment`,
        { term_id: termId, class_id: classId },
      ),
    reports: () => get<{ reports: import("./types").TeacherReport[] }>("/api/classroom/reports"),
    reportDetail: (accountId: number) =>
      get<import("./types").TeacherReport>(`/api/classroom/reports/${accountId}`),
    grade: (accountId: number, score: number, feedback: string, expectedUpdatedAt: string) =>
      post<import("./types").TeacherReport>(`/api/classroom/reports/${accountId}/grade`, {
        score,
        feedback,
        expected_updated_at: expectedUpdatedAt,
      }),
  },
};
