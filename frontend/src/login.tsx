/**
 * 登录页:接真实后端(POST /api/auth/login,服务端加密校验 + 签名令牌)。
 *
 * 凭证只在**显式的演示构建**(VITE_DEMO_MODE=1)里预填:课堂演示要能一键进出,
 * 而生产构建绝不能内嵌课堂口令。开关取自 import.meta.env,构建期即为字面量,
 * 未开启时下面这段快捷账号 UI 与口令常量会被一起摇掉,不进产物。
 */
import { useEffect, useRef, useState } from "react";
import { api, isApiErrorStatus } from "./api";
import { LogoMark } from "./brand";
import type { LoginResponse } from "./types";
import { userFacingRequestError } from "./user-facing-error";

export const LOGIN_FLOW = ["数据接入", "指标计算", "图表比较", "关税回归", "实验报告"];
export const LOGIN_DATA_LABEL = "数据来源与范围以登录后的课程数据说明为准";

export const DEMO_STUDENT_COUNT = 50;
const SEEN_DEMO_STUDENTS_KEY = "gvcsim_seen_demo_students";
// The account the server last suggested to this tab: a reload asks for it back instead of holding another.
const DEMO_SUGGESTION_KEY = "gvcsim_demo_suggestion";

export interface DemoStudentCredential {
  username: string;
  password: string;
}

export function demoStudentCredentials(basePassword: string): DemoStudentCredential[] {
  return Array.from({ length: DEMO_STUDENT_COUNT }, (_, offset) => {
    const index = offset + 1;
    return {
      username: index === 1 ? "student" : `student${String(index).padStart(2, "0")}`,
      password: index === 1 ? basePassword : `${basePassword}-${String(index).padStart(2, "0")}`,
    };
  });
}

export function isDemoStudentUsername(username: string): boolean {
  if (username === "student") return true;
  const match = /^student(\d{2})$/.exec(username);
  if (!match) return false;
  const index = Number(match[1]);
  return index >= 2 && index <= DEMO_STUDENT_COUNT;
}

export function chooseDemoStudent(
  students: readonly DemoStudentCredential[],
  seenUsernames: readonly string[],
  randomValue = Math.random(),
): { student: DemoStudentCredential; nextSeen: string[] } {
  const validUsernames = new Set(students.map((student) => student.username));
  const seen = [...new Set(seenUsernames.filter((username) => validUsernames.has(username)))];
  const lastUsername = seen.at(-1) ?? null;
  const startingNewCycle = seen.length >= students.length;
  const cycleSeen = startingNewCycle ? [] : seen;
  const unseen = students.filter((student) => !cycleSeen.includes(student.username));
  const candidates = startingNewCycle
    ? unseen.filter((student) => student.username !== lastUsername)
    : unseen;
  const normalized = Number.isFinite(randomValue) ? Math.min(Math.max(randomValue, 0), 0.999999999) : 0;
  const student = candidates[Math.floor(normalized * candidates.length)]!;
  return { student, nextSeen: [...cycleSeen, student.username] };
}

/** 左侧背景:静态勾勒的贸易网络(手工布点,非装饰性随机) */
function NetBackdrop() {
  const nodes: [number, number, number][] = [
    [72, 96, 3], [178, 42, 2.4], [262, 132, 3.6], [372, 66, 2.6],
    [452, 168, 3], [548, 84, 2.4], [128, 226, 2.6], [318, 262, 3.2],
    [502, 288, 2.4], [212, 342, 2.8], [412, 376, 2.4], [88, 388, 2.2],
  ];
  const links = [
    [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [0, 6], [6, 2], [2, 7],
    [7, 4], [7, 9], [9, 11], [7, 10], [10, 8], [4, 8],
  ];
  return (
    <svg className="login-net" viewBox="0 0 620 440" preserveAspectRatio="xMidYMid slice" aria-hidden>
      {links.map(([a, b]) => (
        <line
          key={`${a}-${b}`}
          x1={nodes[a][0]} y1={nodes[a][1]} x2={nodes[b][0]} y2={nodes[b][1]}
          stroke="rgba(255,255,255,0.28)" strokeWidth="1"
        />
      ))}
      {nodes.map(([x, y, r], i) => (
        <circle key={i} cx={x} cy={y} r={r} fill="rgba(255,255,255,0.5)" />
      ))}
    </svg>
  );
}

export function LoginPage({ notice, username: returningUsername, onLogin }: {
  notice?: string | null;
  /** The account whose session just ended: prefilled instead of a demo credential, without a password. */
  username?: string | null;
  onLogin: (r: LoginResponse) => void;
}) {
  const demoMode = import.meta.env.VITE_DEMO_MODE === "1";
  // 放在组件的编译期 demo 分支内：Bun 单测可按渲染切换环境，Vite production
  // 又能连同基础口令和整组凭证一起消除。
  const demoPassword = demoMode ? import.meta.env.VITE_DEMO_PASSWORD || "gvclab2026" : "";
  const demoStudents = demoMode ? demoStudentCredentials(demoPassword) : [];
  // The demo student this tab used last: after 退出, the same person gets the same account back instead of
  // the next one in the rotation (which someone else may be using).
  const [previousDemoStudent] = useState(() => {
    if (!demoMode || returningUsername) return null;
    const previous = sessionStorage.getItem("gvcsim_signed_in_username");
    return demoStudents.find((student) => student.username === previous) ?? null;
  });
  const [initialDemoSelection] = useState(() => {
    if (!demoMode || returningUsername || previousDemoStudent) return null;
    let seen: string[] = [];
    try {
      const stored = JSON.parse(sessionStorage.getItem(SEEN_DEMO_STUDENTS_KEY) ?? "[]");
      if (Array.isArray(stored)) seen = stored.filter((value): value is string => typeof value === "string");
    } catch {
      // Restricted or malformed storage still gets a usable random credential; rotation history is unavailable.
    }
    return chooseDemoStudent(demoStudents, seen);
  });
  // 演示构建从 50 组学生凭证中选一组;非演示构建仍是空表单。
  const [demoStudent, setDemoStudent] = useState(previousDemoStudent ?? initialDemoSelection?.student ?? null);
  const [username, setUsername] = useState(returningUsername || demoStudent?.username || "");
  // After an expiry a demo account comes back with its (public, built-in) demo password, so a quick re-login
  // does not need it typed; real accounts never get a prefilled password.
  const returningDemoPassword = demoMode && returningUsername
    ? demoStudents.find((student) => student.username === returningUsername)?.password
      ?? (returningUsername === "teacher" ? demoPassword : "")
    : "";
  const [password, setPassword] = useState(returningDemoPassword || (demoStudent?.password ?? ""));
  const edited = useRef(false);
  // Every demo student is in use (the server had none idle): the form is not prefilled with someone's account.
  const [noIdleDemoStudent, setNoIdleDemoStudent] = useState(false);
  // Whether the prefilled student was confirmed idle by the server. Until then (or when the request fails) the
  // prefill is only a local random pick and must not be presented as idle.
  const [suggestion, setSuggestion] = useState<"pending" | "confirmed" | "failed">(
    demoMode && initialDemoSelection ? "pending" : "confirmed",
  );
  const [suggestionAttempt, setSuggestionAttempt] = useState(0);
  const userRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // A rate-limit message carries the wait time; typing must not hide it (a retry would only hit 429 again).
  const keepError = useRef(false);
  const clearError = () => { if (!keepError.current) setError(null); };
  const [busy, setBusy] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (error) submitRef.current?.focus();
  }, [error]);

  // "当前网络不可用" notices and network errors are stale once the connection is back.
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const back = () => {
      setOnline(true);
      setError((current) => (current && current.includes("网络连接中断") ? null : current));
    };
    const lost = () => setOnline(false);
    window.addEventListener("online", back);
    window.addEventListener("offline", lost);
    return () => {
      window.removeEventListener("online", back);
      window.removeEventListener("offline", lost);
    };
  }, []);
  const [noticeCleared, setNoticeCleared] = useState(false);
  useEffect(() => {
    if (online && notice?.includes("网络不可用") && navigator.onLine) setNoticeCleared(true);
  }, [online, notice]);
  const shownNotice = notice && !(noticeCleared && notice.includes("网络不可用"))
    ? notice
    : noticeCleared ? "网络已恢复，可以重新登录。" : null;

  // A random pick per tab collides across a classroom; the server knows which demo accounts are idle and
  // spreads simultaneous page loads. Its suggestion replaces the local pick unless the user already typed.
  useEffect(() => {
    if (!demoMode || !initialDemoSelection) return;
    let live = true;
    let keep: string | null = null;
    try { keep = sessionStorage.getItem(DEMO_SUGGESTION_KEY); } catch { /* no earlier suggestion to keep */ }
    setSuggestion("pending");
    api.demoStudent(keep).then(({ username: suggested }) => {
      if (!live) return;
      const student = demoStudents.find((item) => item.username === suggested) ?? null;
      setSuggestion("confirmed");
      try {
        if (student) sessionStorage.setItem(DEMO_SUGGESTION_KEY, student.username);
        else sessionStorage.removeItem(DEMO_SUGGESTION_KEY);
      } catch {
        // A reload then simply asks for a new suggestion.
      }
      if (edited.current) return;
      if (!student && suggested !== null) return;
      setDemoStudent(student);
      setNoIdleDemoStudent(!student);
      const local = initialDemoSelection.student;
      setUsername((current) => (current === local.username ? student?.username ?? "" : current));
      setPassword((current) => (current === local.password ? student?.password ?? "" : current));
      // Nothing left to sign in with: start at the user name.
      if (!student) window.requestAnimationFrame(() => userRef.current?.focus());
    }, () => { if (live) setSuggestion("failed"); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, initialDemoSelection, suggestionAttempt]);

  // A failed suggestion (offline, server busy) is asked again when the connection comes back.
  useEffect(() => {
    if (suggestion !== "failed") return;
    const retry = () => setSuggestionAttempt((value) => value + 1);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [suggestion]);

  useEffect(() => {
    if (!demoMode || !initialDemoSelection) return;
    try {
      sessionStorage.setItem(SEEN_DEMO_STUDENTS_KEY, JSON.stringify(initialDemoSelection.nextSeen));
    } catch {
      // Login remains usable when storage is unavailable.
    }
  }, [demoMode, initialDemoSelection]);

  // Signing in with the unconfirmed local pick could land on a classmate's account: wait for the server first.
  const awaitingSuggestion = suggestion === "pending" && !edited.current && demoStudent != null && username === demoStudent.username;

  const demoAccounts = demoStudent || noIdleDemoStudent ? [
    ...(demoStudent ? [{
      ...demoStudent,
      label: "学生身份",
      note: suggestion === "confirmed"
        ? `${DEMO_STUDENT_COUNT} 个种子学生 · 分配近 1 小时无人使用的账号`
        : suggestion === "pending" ? "正在分配空闲账号…" : "未能确认空闲账号，可能有同学在用",
    }] : []),
    {
      username: "teacher",
      password: demoPassword,
      label: "教师身份",
      note: "学生管理与报告评阅",
    },
  ] : [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      keepError.current = false;
      onLogin(await api.login(username, password));
    } catch (err) {
      keepError.current = isApiErrorStatus(err, 429);
      setError(userFacingRequestError(err, "登录失败"));
      setBusy(false);
    }
  };

  return (
    <main className="login-layout">
      <div className="login-brand">
        <NetBackdrop />
        <div className="login-brand-head">
          <LogoMark size={42} />
          <div>
            <div className="login-wordmark">供应链仿真系统</div>
            <div className="login-wordmark-en">GVC SIMULATION LAB</div>
          </div>
        </div>

        <div className="login-hero">
          <h1>
            从投入产出数据出发，
            <br />
            亲手分析全球价值链变化。
          </h1>
          <p className="login-desc">
            使用跨国投入产出表，计算价值链指标、比较经济体，再用关税数据练习回归分析，判断结果及其不确定性，最后完成实验报告。
          </p>
          <div className="login-flow">
            {LOGIN_FLOW.map((p, i) => (
              <span key={p} className="login-flow-item" style={{ animationDelay: `${0.15 + i * 0.18}s` }}>
                <span className="login-flow-num">{String(i + 1).padStart(2, "0")}</span>
                {p}
              </span>
            ))}
          </div>
        </div>

        <div className="login-foot">国际经济学 · 全球价值链实验课程 · {LOGIN_DATA_LABEL}</div>
      </div>

      <div className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <h2>进入实验平台</h2>
          <p className="login-card-sub">使用教师分配的个人账号登录。</p>
          {/* An expired session is a warning, not a success; a password change is confirmed in green. */}
          {shownNotice && <div className={`${shownNotice.includes("失效") || shownNotice.includes("网络不可用") ? "tipbox" : "success-box"} login-notice`} role="status">{shownNotice}</div>}

          {demoMode && demoAccounts.length > 0 && <div className="login-roles" role="group" aria-label="开发演示快捷账号">
            {demoAccounts.map((a) => (
              <button
                key={a.username}
                type="button"
                className={`login-role${username === a.username ? " on" : ""}`}
                aria-pressed={username === a.username}
                onClick={() => {
                  // A choice made here wins over a server suggestion that arrives later.
                  edited.current = true;
                  setUsername(a.username);
                  setPassword(a.password);
                  clearError();
                }}
              >
                <span className="login-role-label">{a.label}</span>
                <span className="login-role-note">{a.note}</span>
              </button>
            ))}
          </div>}

          <label className="login-label" htmlFor="login-user">用户名</label>
          <input
            ref={userRef}
            id="login-user" className="login-input" value={username} autoComplete="username" required
            // Start where typing is needed: the user name, or the password when the name is already filled in.
            autoFocus={!username}
            onChange={(e) => { edited.current = true; setUsername(e.target.value); clearError(); }}
          />
          <label className="login-label" htmlFor="login-pass">密码</label>
          <input
            id="login-pass" className="login-input" type="password" value={password} required
            autoFocus={Boolean(username) && !password}
            autoComplete="current-password" onChange={(e) => { edited.current = true; setPassword(e.target.value); clearError(); }}
          />
          {error && <div className="error-box" role="alert" style={{ marginTop: 14, padding: "10px 14px" }}>{error}</div>}
          {/* With both fields prefilled (demo accounts), start on the button: Enter signs in. */}
          <button ref={submitRef} className="login-btn" type="submit" disabled={busy || awaitingSuggestion} autoFocus={Boolean(username && password)}>
            {busy ? "正在登录…" : awaitingSuggestion ? "正在分配空闲账号…" : "登录"}
          </button>
          <div className="login-hint">
            {demoMode && !returningUsername && (noIdleDemoStudent
              ? <>{DEMO_STUDENT_COUNT} 个种子学生账号近 1 小时都有人在用，暂无空闲演示账号；请向老师索取账号，或稍后刷新页面。<br /></>
              : username === "teacher"
                ? <>当前预填的是教师演示账号，用于学生管理与报告评阅。上方可切换回学生身份。<br /></>
              : suggestion === "failed"
                ? <>暂时无法确认空闲账号（网络或服务繁忙）：当前预填的是随机挑选的种子学生账号，可能有同学正在使用；网络恢复后会自动重新分配，也可以向老师索取账号。<br /></>
                : suggestion === "pending"
                  ? <>正在为你分配一个近 1 小时无人使用的种子学生账号…<br /></>
                  : <>当前预填的是一个近 1 小时无人使用的种子学生账号；退出后本标签页回到原账号。上方可一键切换学生 / 教师身份。<br /></>)}
            登录用于区分每位同学的实验记录。刷新可继续实验；退出只影响当前标签页。
          </div>
        </form>
      </div>
    </main>
  );
}
