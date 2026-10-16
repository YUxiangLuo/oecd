/**
 * 登录页:接真实后端(POST /api/auth/login,服务端加密校验 + 签名令牌)。
 *
 * 凭证只在**显式的演示构建**(VITE_DEMO_MODE=1)里预填:课堂演示要能一键进出,
 * 而生产构建绝不能内嵌课堂口令。开关取自 import.meta.env,构建期即为字面量,
 * 未开启时下面这段快捷账号 UI 与口令常量会被一起摇掉,不进产物。
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError, isApiErrorStatus } from "./api";
import { LogoMark } from "./brand";
import type { LoginResponse } from "./types";
import { userFacingRequestError } from "./user-facing-error";

export const LOGIN_FLOW = ["数据接入", "指标计算", "图表比较", "关税回归", "实验报告"];
export const LOGIN_DATA_LABEL = "登录后可查看数据来源与年份";
/** One product summary, shared by the login page and the intro. */
export const PRODUCT_SUMMARY = "用投入产出数据计算价值链指标、比较经济体，再用关税数据做回归，最后完成实验报告。";

export const DEMO_STUDENT_COUNT = 50;
const SEEN_DEMO_STUDENTS_KEY = "gvcsim_seen_demo_students";
// The account the server last suggested to this tab: a reload asks for it back instead of holding another.
const DEMO_SUGGESTION_KEY = "gvcsim_demo_suggestion";
// Demo builds: the demo student this browser last signed in as (never the teacher). A new tab, or a return from
// the teacher identity, offers it again, so the student's progress does not seem lost.
export const LAST_DEMO_STUDENT_KEY = "gvcsim_last_demo_student";

function readStorage(storage: () => Storage, key: string): string | null {
  try { return storage().getItem(key); } catch { return null; }
}

/** Remembers a demo student sign-in in this browser; other accounts (the teacher, real accounts) are not kept. */
export function rememberDemoStudent(username: string): void {
  if (!isDemoStudentUsername(username)) return;
  try { localStorage.setItem(LAST_DEMO_STUDENT_KEY, username); } catch { /* storage refused: a new tab gets a fresh suggestion */ }
}

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

/** A user name typed by hand is a choice, not a mistake: say which account it is and how to get the offered one. */
function ownAccountHint(username: string, offer: string): string {
  const name = username.trim();
  return name
    ? `你填写的是 ${name}；${offer}，点上方“学生身份”。`
    : `${offer}，点上方“学生身份”。`;
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
  // The demo student used last: in this tab, else in this browser (another tab, or before switching to the
  // teacher identity). The same person gets the same account back instead of the next one in the rotation.
  // It is their own account, so the server (which only suggests idle accounts) is not asked.
  const [previousDemoStudent, setPreviousDemoStudent] = useState(() => {
    if (!demoMode || returningUsername) return null;
    const inTab = readStorage(() => sessionStorage, "gvcsim_signed_in_username");
    const previous = isDemoStudentUsername(inTab ?? "") ? inTab : readStorage(() => localStorage, LAST_DEMO_STUDENT_KEY);
    return demoStudents.find((student) => student.username === previous) ?? null;
  });
  const pickDemoStudent = () => {
    let seen: string[] = [];
    try {
      const stored = JSON.parse(sessionStorage.getItem(SEEN_DEMO_STUDENTS_KEY) ?? "[]");
      if (Array.isArray(stored)) seen = stored.filter((value): value is string => typeof value === "string");
    } catch {
      // Restricted or malformed storage still gets a usable random credential; rotation history is unavailable.
    }
    return chooseDemoStudent(demoStudents, seen);
  };
  const [initialDemoSelection, setInitialDemoSelection] = useState(() =>
    !demoMode || returningUsername || previousDemoStudent ? null : pickDemoStudent());
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
  // The student the server confirmed idle; null before it answers (or outside the suggestion flow).
  const [confirmedStudent, setConfirmedStudent] = useState<string | null>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // A rate-limit message carries the wait time; typing must not hide it (a retry would only hit 429 again).
  const keepError = useRef(false);
  const clearError = () => { if (!keepError.current) setError(null); };
  const [busy, setBusy] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  // After a 429 with Retry-After: the time sign-in is accepted again, and the seconds left (shown on the button).
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [retryLeft, setRetryLeft] = useState(0);
  // Where focus goes after a failure: a wrong password is retyped, anything else is retried from the button.
  const [errorFocus, setErrorFocus] = useState<{ target: "password" | "submit" } | null>(null);

  useEffect(() => {
    if (!errorFocus) return;
    if (errorFocus.target === "password" && passwordRef.current) {
      passwordRef.current.focus();
      passwordRef.current.select();
    } else submitRef.current?.focus();
  }, [errorFocus]);

  useEffect(() => {
    if (retryAt == null) return;
    const tick = () => {
      const left = Math.ceil((retryAt - Date.now()) / 1000);
      if (left > 0) { setRetryLeft(left); return; }
      // The wait is over: the limit message no longer applies and the button signs in again.
      window.clearInterval(timer);
      setRetryAt(null);
      setRetryLeft(0);
      keepError.current = false;
      setError(null);
    };
    const timer = window.setInterval(tick, 250);
    tick();
    return () => window.clearInterval(timer);
  }, [retryAt]);
  const waiting = retryAt != null && retryLeft > 0;

  // "现在没有网络" notices and network errors are stale once the connection is back. Starts from the browser's own
  // state: a page shown offline (退出登录 without a network) must see the later "online" as a change.
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
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
    if (online && notice?.includes("没有网络") && navigator.onLine) setNoticeCleared(true);
  }, [online, notice]);
  const shownNotice = notice && !(noticeCleared && notice.includes("没有网络"))
    ? notice
    : noticeCleared
      ? notice?.includes("未保存的修改") ? "网络已恢复。重新登录后，未保存的修改会自动保存。" : "网络已恢复，可以重新登录。"
      : null;

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
      if (!student && suggested !== null) return;
      // The student chip always offers the confirmed account, even when the form already holds another choice.
      setDemoStudent(student);
      setConfirmedStudent(student?.username ?? null);
      setNoIdleDemoStudent(!student);
      if (edited.current) return;
      const local = initialDemoSelection.student;
      setUsername((current) => (current === local.username ? student?.username ?? "" : current));
      setPassword((current) => (current === local.password ? student?.password ?? "" : current));
      // Nothing left to sign in with: start at the user name; otherwise the now-enabled 登录 (Enter signs in).
      window.requestAnimationFrame(() => {
        if (!student) userRef.current?.focus();
        else if (document.activeElement == null || document.activeElement === document.body) submitRef.current?.focus();
      });
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

  // Someone else at this computer: forget the remembered account and ask the server for an idle one.
  const switchToIdleStudent = () => {
    // Forget both memories of the previous student: the browser's and this tab's, so a reload does not bring it back.
    try { localStorage.removeItem(LAST_DEMO_STUDENT_KEY); } catch { /* nothing remembered to forget */ }
    try { sessionStorage.removeItem("gvcsim_signed_in_username"); } catch { /* nothing remembered to forget */ }
    const selection = pickDemoStudent();
    edited.current = false;
    setPreviousDemoStudent(null);
    setConfirmedStudent(null);
    setDemoStudent(selection.student);
    setUsername(selection.student.username);
    setPassword(selection.student.password);
    setSuggestion("pending");
    setInitialDemoSelection(selection);
    clearError();
  };

  // Signing in with the unconfirmed local pick could land on a classmate's account: wait for the server first.
  const awaitingSuggestion = suggestion === "pending" && !edited.current && demoStudent != null && username === demoStudent.username;

  // Built only in the demo build, so the production bundle carries none of the demo labels.
  const demoAccounts = demoMode && (demoStudent || noIdleDemoStudent) ? [
    ...(demoStudent ? [{
      ...demoStudent,
      label: "学生身份",
      note: previousDemoStudent && demoStudent.username === previousDemoStudent.username
        ? "上次在这台电脑用的演示账号"
        : suggestion === "confirmed" && (confirmedStudent === null || demoStudent.username === confirmedStudent)
        ? "自动分配一个空闲的演示账号"
        : suggestion === "pending" ? "正在分配空闲账号…" : "账号可能有同学在用",
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
    // During the rate-limit wait the button is only marked unavailable (it keeps focus): a press does nothing.
    if (waiting) return;
    setBusy(true);
    setError(null);
    try {
      keepError.current = false;
      const response = await api.login(username, password);
      if (demoMode) rememberDemoStudent(response.user.username);
      onLogin(response);
    } catch (err) {
      const limited = isApiErrorStatus(err, 429);
      keepError.current = limited;
      setError(userFacingRequestError(err, "登录失败"));
      const wait = limited && err instanceof ApiError ? err.retryAfter : undefined;
      if (wait) {
        setRetryLeft(Math.ceil(wait));
        setRetryAt(Date.now() + wait * 1000);
      }
      setBusy(false);
      setErrorFocus({ target: isApiErrorStatus(err, 401) ? "password" : "submit" });
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
            {PRODUCT_SUMMARY}
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
          <h2>登录实验台</h2>
          <p className="login-card-sub">用老师发给你的账号登录。</p>
          {/* An expired session is a warning, not a success; a password change is confirmed in green. */}
          {shownNotice && <div className={`${shownNotice.includes("失效") || shownNotice.includes("没有网络") ? "tipbox" : "success-box"} login-notice`} role="status">{shownNotice}</div>}

          {demoMode && demoAccounts.length > 0 && <div className="login-roles" role="group" aria-label="演示账号快捷登录">
            {demoAccounts.map((a) => (
              <button
                key={a.username}
                type="button"
                className={`login-role${username === a.username ? " on" : ""}`}
                aria-pressed={username === a.username}
                onClick={() => {
                  // A different identity chosen here wins over a server suggestion that arrives later;
                  // re-clicking the identity already filled in changes nothing.
                  if (a.username !== username) edited.current = true;
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
            ref={passwordRef}
            id="login-pass" className="login-input" type="password" value={password} required
            autoFocus={Boolean(username) && !password}
            autoComplete="current-password" onChange={(e) => { edited.current = true; setPassword(e.target.value); clearError(); }}
          />
          {error && <div className="error-box" role="alert" style={{ marginTop: 14, padding: "10px 14px" }}>{error}</div>}
          {/* With both fields prefilled (demo accounts), start on the button: Enter signs in. */}
          <button
            ref={submitRef} className="login-btn" type="submit" disabled={busy || awaitingSuggestion}
            aria-disabled={waiting || undefined} autoFocus={Boolean(username && password)}
          >
            {busy ? "正在登录…" : awaitingSuggestion ? "正在分配空闲账号…" : waiting ? `${retryLeft} 秒后可再次登录` : "登录"}
          </button>
          <div className="login-hint">
            {demoMode && !returningUsername && (noIdleDemoStudent
              ? <>演示账号都在使用中。请稍后刷新页面，或向老师申请账号。<br /></>
              : username === "teacher"
                ? <>当前预填的是教师演示账号，用于学生管理与报告评阅。上方可切换回学生身份。<br /></>
              : previousDemoStudent && username === previousDemoStudent.username
                ? <>已为你预填上次在这台电脑用过的演示学生账号，之前的进度都在。在这台电脑的浏览器里再次登录，仍是这个账号。{" "}
                  <button type="button" className="login-hint-link" onClick={switchToIdleStudent}>不是你的？换一个空闲账号</button><br /></>
              : previousDemoStudent
                ? <>{ownAccountHint(username, "如需换回上次在这台电脑用的演示账号")}<br /></>
              : suggestion === "failed"
                ? <>暂时无法分配空闲账号，当前预填的账号可能有同学在用。请稍后刷新页面，或向老师申请账号。<br /></>
                : suggestion === "pending"
                  ? <>正在分配空闲的演示账号…<br /></>
                  : confirmedStudent !== null && username !== confirmedStudent
                    ? <>{ownAccountHint(username, "如需系统分配的空闲账号")}<br /></>
                    : <>已为你预填一个空闲的演示学生账号。用它登录后，在这台电脑的浏览器里再次登录仍是这个账号。<br /></>)}
            登录用于区分每位同学的实验记录。刷新页面不会丢失进度。
          </div>
        </form>
      </div>
    </main>
  );
}
