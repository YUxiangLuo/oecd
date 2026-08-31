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

export const LOGIN_FLOW = ["数据接入", "指标计算", "可视化", "教学实证", "实验报告"];
export const LOGIN_DATA_LABEL = "OECD ICIO 2023 版 · 数据期 2016–2020";

const DEMO_ACCOUNTS = [
  { username: "student", label: "学生身份", note: "完成 16 步实验" },
  { username: "teacher", label: "教师身份", note: "学生管理与报告评阅" },
];
/** 演示口令;可用 VITE_DEMO_PASSWORD 覆盖,与服务端 GVCSIM_BOOTSTRAP_PASSWORD 对应。 */
const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD || "gvclab2026";

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
  // 演示构建默认落在学生身份并预填口令,打开即可直接登录;非演示构建仍是空表单。
  const [username, setUsername] = useState(demoMode ? DEMO_ACCOUNTS[0].username : "");
  const [password, setPassword] = useState(demoMode ? DEMO_PASSWORD : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (error) submitRef.current?.focus();
  }, [error]);

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
            从真实指标出发,
            <br />
            亲手分析全球价值链变化。
          </h1>
          <p className="login-desc">
            基于 OECD 全球投入产出数据库的教学实验平台。
            从 76 个具名经济体 + ROW 剩余地区账户、45 个行业的真实贸易流出发，计算价值链指标，
            再用拟真政策冲击练习实证比较、识别假设与不确定性判断，最终生成实验报告。
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
          <p className="login-card-sub">使用教师分配的个人账号登录；角色与课程权限由服务器确认。</p>
          {notice && <div className="success-box login-notice" role="status">{notice}</div>}

          {demoMode && <div className="login-roles" role="group" aria-label="开发演示快捷账号">
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.username}
                type="button"
                className={`login-role${username === a.username ? " on" : ""}`}
                onClick={() => {
                  setUsername(a.username);
                  setPassword(DEMO_PASSWORD);
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
            {demoMode && <>课堂演示口令统一为 <b>{DEMO_PASSWORD}</b>;上方可一键切换学生 / 教师身份。<br /></>}
            会话有效期由服务器安全策略决定；登录后页面会显示本次会话的实际到期时间。
          </div>
        </form>
      </div>
    </main>
  );
}
