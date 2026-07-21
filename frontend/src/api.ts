import type { Enrollment, ExperimentSession, GeneratedReport, ProgressResponse, ReportGate, SessionResponse } from "./types";

export const AUTH_TOKEN_KEY = "gvcsim_token";

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
  if (!shouldExpireAuth(requestToken, localStorage.getItem(AUTH_TOKEN_KEY))) return;
  localStorage.removeItem(AUTH_TOKEN_KEY);
  window.dispatchEvent(new Event("gvcsim-auth-expired"));
}

function authHeaders(token: string | null, extra?: HeadersInit): HeadersInit {
  return token ? { ...extra, Authorization: `Bearer ${token}` } : (extra ?? {});
}

async function get<T>(url: string): Promise<T> {
  const requestToken = localStorage.getItem(AUTH_TOKEN_KEY);
  const resp = await fetch(url, { headers: authHeaders(requestToken) });
  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    if (resp.status === 401) notifyAuthExpired(requestToken);
    throw new ApiError(resp.status, body?.detail, `${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

async function post<T>(url: string, body?: unknown, method = "POST"): Promise<T> {
  const requestToken = localStorage.getItem(AUTH_TOKEN_KEY);
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
  me: async (token: string) => {
    const resp = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new ApiError(resp.status, null, "令牌无效或已过期");
    return resp.json() as Promise<import("./types").AuthUser>;
  },
  logout: async (token: string) => {
    const resp = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new ApiError(resp.status, (await resp.json().catch(() => null))?.detail, resp.statusText);
    return resp.json() as Promise<{ ok: boolean }>;
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
    issueEvidence: (body: {
      step: number;
      kind: "slice" | "qc_resolution" | "indicator" | "visualization" | "shock";
      payload: Record<string, unknown>;
    }) => post<{ evidence_id: string; evidence?: Record<string, unknown> }>("/api/classroom/evidence/issue", body),
    submitQuiz: (body: { step: number; version: string; answers: Record<string, string> }) =>
      post<{
        passed: boolean;
        version: string;
        results: { question_id: string; correct: boolean; explanation: string }[];
        quiz_id?: string;
        quiz?: { version: string; answers: Record<string, string> };
      }>("/api/classroom/quiz/submit", body),
    announcements: () =>
      get<{ announcements: import("./types").Announcement[] }>("/api/classroom/announcements"),
    progress: () => get<ProgressResponse>("/api/classroom/progress"),
    reportProgress: (step: number) => post<{ ok: boolean }>("/api/classroom/progress", { step }),
    session: () => get<SessionResponse>("/api/classroom/session"),
    saveSession: (body: { base_revision: number; session: ExperimentSession }) =>
      post<SessionResponse>("/api/classroom/session", body, "PUT"),
    clearSession: () => post<{ ok: boolean; attempt_id?: number }>("/api/classroom/session", undefined, "DELETE"),
    // 只交报告指纹;服务端从它自己生成的报告里取正文,接口不接受 Markdown。
    submitReport: (body: { title: string; report_key: string }) =>
      post<{ id: number; state: string; submitted_at: string }>("/api/classroom/report/submit", body),
    generateReport: () => post<GeneratedReport>("/api/classroom/report/generate"),
    generatedReport: () => get<Partial<GeneratedReport>>("/api/classroom/report/generated"),
    reportGate: () => get<ReportGate>("/api/classroom/report/gate"),
    myReport: () => get<import("./types").MySubmission>("/api/classroom/report/mine"),
    overview: (classId?: number | null) =>
      get<import("./types").ClassOverview>(
        withQuery("/api/classroom/overview", { class_id: classId }),
      ),
    classes: () => get<{ classes: import("./types").ClassInfo[] }>("/api/classroom/classes"),
    courseRuns: () => get<{ course_runs: import("./types").CourseRun[] }>("/api/classroom/course-runs"),
    createCourseRun: (body: { name: string; code: string; term?: string; release_tag?: string }) =>
      post<import("./types").CourseRun>("/api/classroom/course-runs", body),
    archiveCourseRun: (id: number, archived: boolean) =>
      post<import("./types").CourseRun>(`/api/classroom/course-runs/${id}/archive`, { archived }),
    assignments: (courseRunId?: number | null) =>
      get<{ assignments: import("./types").Assignment[] }>(
        withQuery("/api/classroom/assignments", { course_run_id: courseRunId }),
      ),
    createAssignment: (body: {
      course_run_id: number;
      slug: string;
      title: string;
      manifest_id: string;
      release_tag?: string;
      opens_at?: string | null;
      due_at?: string | null;
    }) => post<import("./types").Assignment>("/api/classroom/assignments", body),
    setAssignmentState: (id: number, active: boolean) =>
      post<import("./types").Assignment>(`/api/classroom/assignments/${id}/state`, { active }),
    enrollStudent: (body: { course_run_id: number; account_id: number; class_id?: number | null }) =>
      post<Enrollment>("/api/classroom/enrollments", body),
    enrollments: (courseRunId: number) =>
      get<{ enrollments: import("./types").EnrollmentRow[] }>(
        withQuery("/api/classroom/enrollments", { course_run_id: courseRunId }),
      ),
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
      body: { display_name?: string; student_no?: string; class_id?: number; active?: boolean; password?: string },
    ) => post<import("./types").StudentRow>(`/api/classroom/students/${id}`, body),
    submissions: () =>
      get<{ submissions: import("./types").SubmissionRow[] }>("/api/classroom/submissions"),
    submissionDetail: (id: number) =>
      get<import("./types").SubmissionDetail>(`/api/classroom/submissions/${id}`),
    submissionHistory: (id: number) =>
      get<import("./types").SubmissionHistory>(`/api/classroom/submissions/${id}/history`),
    grade: (id: number, score: number, feedback: string) =>
      post<import("./types").SubmissionDetail>(`/api/classroom/submissions/${id}/grade`, { score, feedback }),
    createAnnouncement: (body: { title: string; body: string; class_id?: number | null }) =>
      post<import("./types").Announcement>("/api/classroom/announcements", body),
    deleteAnnouncement: (id: number) =>
      post<{ ok: boolean }>(`/api/classroom/announcements/${id}`, undefined, "DELETE"),
  },
};
