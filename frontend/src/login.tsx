/**
 * 登录页:接真实后端(POST /api/auth/login,服务端加密校验 + 签名令牌)。
 *
 * 凭证只在**显式的演示构建**(VITE_DEMO_MODE=1)里预填:课堂演示要能一键进出,
 * 而生产构建绝不能内嵌课堂口令。开关取自 import.meta.env,构建期即为字面量,
 * 未开启时下面这段快捷账号 UI 与口令常量会被一起摇掉,不进产物。
 */
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { LogoMark } from "./brand";
import type { LoginResponse } from "./types";
import { userFacingRequestError } from "./user-facing-error";

export const LOGIN_FLOW = ["数据接入", "指标计算", "图表比较", "模拟回归", "实验报告"];
export const LOGIN_DATA_LABEL = "数据来源与范围以登录后的课程数据说明为准";

export const DEMO_STUDENT_COUNT = 50;
const SEEN_DEMO_STUDENTS_KEY = "gvcsim_seen_demo_students";

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

export function LoginPage({ notice, onLogin }: { notice?: string | null; onLogin: (r: LoginResponse) => void }) {
  const demoMode = import.meta.env.VITE_DEMO_MODE === "1";
  // 放在组件的编译期 demo 分支内：Bun 单测可按渲染切换环境，Vite production
  // 又能连同基础口令和整组凭证一起消除。
  const demoPassword = demoMode ? import.meta.env.VITE_DEMO_PASSWORD || "gvclab2026" : "";
  const demoStudents = demoMode ? demoStudentCredentials(demoPassword) : [];
  const [initialDemoSelection] = useState(() => {
    if (!demoMode) return null;
    let seen: string[] = [];
    try {
      const stored = JSON.parse(sessionStorage.getItem(SEEN_DEMO_STUDENTS_KEY) ?? "[]");
      if (Array.isArray(stored)) seen = stored.filter((value): value is string => typeof value === "string");
    } catch {
      // Restricted or malformed storage still gets a usable random credential; rotation history is unavailable.
    }
    return chooseDemoStudent(demoStudents, seen);
  });
  const initialDemoStudent = initialDemoSelection?.student ?? null;
  // 演示构建从 50 组学生凭证中选一组;非演示构建仍是空表单。
  const [username, setUsername] = useState(initialDemoStudent?.username ?? "");
  const [password, setPassword] = useState(initialDemoStudent?.password ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (error) submitRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (!demoMode || !initialDemoSelection) return;
    try {
      sessionStorage.setItem(SEEN_DEMO_STUDENTS_KEY, JSON.stringify(initialDemoSelection.nextSeen));
    } catch {
      // Login remains usable when storage is unavailable.
    }
  }, [demoMode, initialDemoSelection]);

  const demoAccounts = initialDemoStudent ? [
    {
      ...initialDemoStudent,
      label: "学生身份",
      note: `${DEMO_STUDENT_COUNT} 个种子学生 · 刷新无重复轮换`,
    },
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
      onLogin(await api.login(username, password));
    } catch (err) {
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
            使用跨国投入产出表，计算价值链指标、比较经济体，再用教学模拟练习回归分析，判断结果及其不确定性，最后完成实验报告。
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
          {notice && <div className="success-box login-notice" role="status">{notice}</div>}

          {demoMode && <div className="login-roles" role="group" aria-label="开发演示快捷账号">
            {demoAccounts.map((a) => (
              <button
                key={a.username}
                type="button"
                className={`login-role${username === a.username ? " on" : ""}`}
                onClick={() => {
                  setUsername(a.username);
                  setPassword(a.password);
                }}
              >
                <span className="login-role-label">{a.label}</span>
                <span className="login-role-note">{a.note}</span>
              </button>
            ))}
          </div>}

          <label className="login-label" htmlFor="login-user">用户名</label>
          <input
            id="login-user" className="login-input" value={username} autoComplete="username" required
            onChange={(e) => setUsername(e.target.value)}
          />
          <label className="login-label" htmlFor="login-pass">密码</label>
          <input
            id="login-pass" className="login-input" type="password" value={password} required
            autoComplete="current-password" onChange={(e) => setPassword(e.target.value)}
          />
          {error && <div className="error-box" role="alert" style={{ marginTop: 14, padding: "10px 14px" }}>{error}</div>}
          <button ref={submitRef} className="login-btn" type="submit" disabled={busy}>
            {busy ? "正在登录…" : "登录"}
          </button>
          <div className="login-hint">
            {demoMode && <>当前预填的是 {DEMO_STUDENT_COUNT} 个种子学生中的一组；同一标签页刷新会无重复轮换账号和口令，轮完后再开启下一轮。上方可一键切换学生 / 教师身份。<br /></>}
            登录用于区分每位同学的实验记录。刷新可继续实验；退出只影响当前标签页。
          </div>
        </form>
      </div>
    </main>
  );
}
