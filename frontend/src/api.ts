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

/** A failure the server did not explain: Chinese copy with the status code, never "404 Not Found". */
export function requestFailedMessage(status: number): string {
  return `请求失败（代码 ${status}），请刷新页面后重试；若持续出现，请联系老师或管理员。`;
}

const FIELD_NAMES: Record<string, string> = {
  username: "用户名", password: "密码", current_password: "当前密码", new_password: "新密码",
  name: "名称", display_name: "姓名", student_no: "学号", feedback: "评语", score: "分数",
};
const CJK = /[一-鿿]/;

/**
 * FastAPI's 422 detail is a list of field errors. Show the first one in Chinese: a Chinese message from a
 * validator as is, the common length errors spelled out, anything else as the generic sentence.
 */
export function validationErrorMessage(detail: unknown): string | null {
  if (!Array.isArray(detail) || detail.length === 0) return null;
  const first = detail[0] as { loc?: unknown; msg?: unknown; type?: unknown; ctx?: Record<string, unknown> };
  const message = typeof first?.msg === "string" ? first.msg.replace(/^Value error,\s*/, "").trim() : "";
  if (CJK.test(message)) return message;
  const key = Array.isArray(first?.loc) ? [...first.loc].reverse().find((part) => typeof part === "string" && part !== "body") : undefined;
  const field = typeof key === "string" ? FIELD_NAMES[key] : undefined;
  if (!field) return null;
  if (first.type === "string_too_short" && first.ctx?.min_length != null) {
    return Number(first.ctx.min_length) <= 1 ? `请填写${field}。` : `${field}至少 ${first.ctx.min_length} 个字符。`;
  }
  if (first.type === "string_too_long" && first.ctx?.max_length != null) return `${field}不能超过 ${first.ctx.max_length} 个字符。`;
  if (first.type === "missing") return `请填写${field}。`;
  return `${field}的格式不对，请检查后再试。`;
}

export class ApiError extends Error {
  status: number;
  /** 结构化 detail(如第 15 步门槛的 blocked 列表);普通字符串 detail 时为 undefined。 */
  blocked?: import("./types").ReportGateItem[];
  /** Seconds from a 429/503 Retry-After header, so a page can count down before offering a retry. */
  retryAfter?: number;

  constructor(status: number, detail: unknown, fallback: string, retryAfter?: number) {
    // FastAPI 的 detail 可以是字符串,也可以是对象(门槛就返回 {message, blocked})。
    // 直接把对象塞进 Error.message 会渲染成 "[object Object]",这里分开处理。
    const structured = typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : null;
    const defaultMessage = status >= 500
      ? "教学服务暂时不可用，请稍后重试；若持续失败，请联系老师或管理员。"
      : status === 422 ? validationErrorMessage(detail) ?? "提交内容不符合要求，请检查输入后重试。" : fallback;
    super(typeof detail === "string" ? detail : (structured?.message as string) ?? defaultMessage);
    this.name = "ApiError";
    this.status = status;
    if (Array.isArray(structured?.blocked)) this.blocked = structured.blocked as import("./types").ReportGateItem[];
    if (retryAfter != null && Number.isFinite(retryAfter) && retryAfter > 0) this.retryAfter = retryAfter;
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

/** Retry-After of a response, in seconds (absent or unparsable → undefined). */
function retryAfterSeconds(resp: Response): number | undefined {
  const value = Number(resp.headers.get("Retry-After"));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

// Above the server's 15 s compute queue (gvcsim/concurrency.py) plus a typical request, so a busy classroom
// waits for its answer instead of timing out while the server is still queueing it.
const GET_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 120_000;

/** A request that ran out of time: the server may still answer the same request later (a save is retried). */
export class RequestTimeoutError extends Error {
  name = "RequestTimeoutError";
}

async function withRequestTimeout<T>(
  _url: string,
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
    if (timedOut) throw new RequestTimeoutError(`服务器繁忙，请求超时（${timeoutMs / 1000} 秒），请稍后重试。`);
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
  const deadline = Date.now() + GET_TIMEOUT_MS;
  return withRequestTimeout(url, GET_TIMEOUT_MS, async (signal) => {
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) throw new Error("请求已取消");
      const resp = await fetch(url, { headers: authHeaders(requestToken), signal });
      if (resp.ok) return await resp.json() as T;
      const body = await resp.json().catch(() => null);
      const retryAfter = retryAfterSeconds(resp);
      const wait = Math.max(150 * 2 ** attempt + Math.random() * 100, (retryAfter ?? 0) * 1000);
      // Retry a busy server only when the wait still fits the request budget; otherwise report it now.
      if (attempt < 2 && [502, 503, 504].includes(resp.status) && Date.now() + wait < deadline - 1000) {
        await retryDelay(wait, signal);
        continue;
      }
      if (resp.status === 401) notifyAuthExpired(requestToken);
      throw new ApiError(resp.status, body?.detail, fallback ?? requestFailedMessage(resp.status), retryAfter);
    }
  }, callerSignal);
}

function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  return getWithToken<T>(url, getActiveAuthToken(), undefined, signal);
}

async function post<T>(url: string, body?: unknown, method = "POST", callerSignal?: AbortSignal): Promise<T> {
  const requestToken = getActiveAuthToken();
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return withRequestTimeout(url, MUTATION_TIMEOUT_MS, async (signal) => {
    if (signal.aborted) throw new Error("请求已取消");
    const resp = await fetch(url, {
      method,
      headers: authHeaders(requestToken, { "Content-Type": "application/json" }),
      body: encoded,
      signal,
    });
    if (!resp.ok) {
      const payload = await resp.json().catch(() => null);
      if (resp.status === 401) notifyAuthExpired(requestToken);
      throw new ApiError(resp.status, payload?.detail, requestFailedMessage(resp.status), retryAfterSeconds(resp));
    }
    return await resp.json() as T;
  }, callerSignal);
}

// Data that does not change within a data release (indicator schema, teaching groups, the yearly trade
// network) is fetched once per tab instead of on every step mount. A failed request is not kept.
const releaseConstant = new Map<string, Promise<unknown>>();
function getOnce<T>(url: string): Promise<T> {
  const cached = releaseConstant.get(url);
  if (cached) return cached as Promise<T>;
  const request = get<T>(url);
  releaseConstant.set(url, request);
  request.catch(() => { if (releaseConstant.get(url) === request) releaseConstant.delete(url); });
  return request;
}
/** Tests and a release change start from an empty cache. */
export function clearReleaseConstantCache(): void {
  releaseConstant.clear();
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
        throw new ApiError(resp.status, payload?.detail, requestFailedMessage(resp.status), retryAfterSeconds(resp));
      }
      return await resp.json() as import("./types").LoginResponse;
    }),
  /** Demo builds: an idle demo student (null when all are in use); `keep` asks for this tab's earlier one back. */
  demoStudent: (keep?: string | null) => getWithToken<{ username: string | null }>(
    keep ? `/api/auth/demo-student?keep=${encodeURIComponent(keep)}` : "/api/auth/demo-student",
    null, "暂时无法分配演示账号"),
  me: (token: string) =>
    getWithToken<import("./types").AuthUser>("/api/auth/me", token, "登录已失效，请重新登录。"),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ ok: boolean; reauthenticate: boolean }>("/api/auth/password", {
      current_password: currentPassword,
      new_password: newPassword,
    }),
  steps: () => get<import("./types").StepsResponse>("/api/steps"),
  meta: () => get<import("./types").Meta>("/api/meta"),
  indicatorSchema: () => getOnce<import("./types").IndicatorSchema>("/api/indicators/schema"),
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
  /** One industry in every economy (steps 6–8 定位图 with an industry scope: the medians need all economies). */
  industryIndicatorsForIndustry: (year: number, industry: string) => {
    if (!industry) return Promise.reject(new Error("单行业指标请求必须指定行业"));
    return get<import("./types").IndustryPage>(
      withQuery(`/api/indicators/industry/${year}`, { page: 1, page_size: 200, industry }),
    );
  },
  /** Each industry's spread of a network metric across all economies (step 9 global reference). */
  industryDistribution: (metric: string, options: { years?: number[]; industry?: string; countries?: string[] } = {}) =>
    get<{ metric: string; rows: import("./types").IndustryDistributionRow[] }>(
      withQuery("/api/indicators/industry-distribution", {
        metric,
        years: options.years?.join(","),
        industry: options.industry,
        countries: options.countries?.join(","),
      }),
    ),
  network: (year: number) => getOnce<import("./types").NetworkData>(`/api/viz/network/${year}`),
  shockEvents: () =>
    get<{ events: import("./types").ShockEvent[]; disclaimer: string; source_disclosure: string }>("/api/shocks/events"),
  teachingPanel: (country: string, year: number, limit = 200) =>
    get<import("./types").TeachingPanelResponse>(
      withQuery("/api/regression/teaching-panel", { country, year, limit }),
    ),
  teachingGroups: () => getOnce<import("./types").TeachingGroupsResponse>("/api/regression/teaching-groups"),
  teachingCountries: () => getOnce<import("./types").TeachingCountriesResponse>("/api/regression/teaching-countries"),
  teachingOverview: () => getOnce<import("./types").TeachingOverviewResponse>("/api/regression/teaching-overview"),
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
  regressionDesign: (outcome: import("./types").RegressionOutcome, baseline?: string | null) => {
    return get<import("./types").RegressionDesignInfo>(withQuery("/api/regression/design", {
      outcome,
      ...(baseline ? { baseline } : {}),
    }));
  },
  runRegression: async (
    outcome: import("./types").RegressionOutcome,
    signal?: AbortSignal,
    baseline?: string | null,
    spec?: import("./types").ModelSpec | null,
  ) => {
    return post<import("./types").CurrentRegressionResponse>("/api/regression/run", {
      outcome,
      ...(baseline ? { baseline } : {}),
      ...(spec ? { spec } : {}),
    }, "POST", signal);
  },
  /** The workbench's choices; the same for every student and release, fetched once. */
  regressionOptions: () => getOnce<import("./types").WorkbenchOptions>("/api/regression/options"),
  classroom: {
    quizBank: () => get<import("./types").TeacherQuizBank>("/api/classroom/quizzes"),
    saveQuizStep: (step: number, body: { version: string; questions: import("./types").TeacherQuizQuestion[] }) =>
      post<import("./types").TeacherQuizBank>(`/api/classroom/quizzes/${step}`, body, "PUT"),
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
