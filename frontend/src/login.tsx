/**
 * 登录页:接真实后端(POST /api/auth/login,服务端加密校验 + 签名令牌)。
 * 演示定位:默认预填学生账号,右侧可一键切换学生/教师身份。
 */
import { useState } from "react";
import { api } from "./api";
import { LogoMark } from "./brand";
import type { LoginResponse } from "./types";

const FLOW = ["数据接入", "指标计算", "因果回归", "实验报告"];

const ACCOUNTS = [
  { username: "student", label: "学生身份", note: "完成 17 步实验" },
  { username: "teacher", label: "教师身份", note: "班级管理与报告评阅" },
];

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

export function LoginPage({ onLogin }: { onLogin: (r: LoginResponse) => void }) {
  const [username, setUsername] = useState("student");
  const [password, setPassword] = useState("gvclab2026");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.login(username, password));
    } catch (err) {
      setError(String((err as Error).message));
      setBusy(false);
    }
  };

  return (
    <div className="login-layout">
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
            用真实数据,
            <br />
            亲手检验全球价值链的因果。
          </h1>
          <p className="login-desc">
            基于 OECD 全球投入产出数据库的教学实验平台。
            从 77 个经济体、45 个行业的真实贸易流出发,
            计算价值链指标、检验政策冲击的因果效应,最终生成你自己的实验报告。
          </p>
          <div className="login-flow">
            {FLOW.map((p, i) => (
              <span key={p} className="login-flow-item" style={{ animationDelay: `${0.15 + i * 0.18}s` }}>
                <span className="login-flow-num">{String(i + 1).padStart(2, "0")}</span>
                {p}
              </span>
            ))}
          </div>
        </div>

        <div className="login-foot">国际经济学 · 全球价值链实验课程 · OECD ICIO 2016–2020</div>
      </div>

      <div className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <h2>进入实验平台</h2>
          <p className="login-card-sub">选择身份后点击登录,凭证已为你填好。</p>

          <div className="login-roles">
            {ACCOUNTS.map((a) => (
              <button
                key={a.username}
                type="button"
                className={`login-role${username === a.username ? " on" : ""}`}
                onClick={() => {
                  setUsername(a.username);
                  setPassword("gvclab2026");
                }}
              >
                <span className="login-role-label">{a.label}</span>
                <span className="login-role-note">{a.note}</span>
              </button>
            ))}
          </div>

          <label className="login-label" htmlFor="login-user">用户名</label>
          <input
            id="login-user" className="login-input" value={username} autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
          />
          <label className="login-label" htmlFor="login-pass">密码</label>
          <input
            id="login-pass" className="login-input" type="password" value={password}
            autoComplete="current-password" onChange={(e) => setPassword(e.target.value)}
          />
          {error && <div className="error-box" style={{ marginTop: 14, padding: "10px 14px" }}>{error}</div>}
          <button className="login-btn" type="submit" disabled={busy}>
            {busy ? "正在登录…" : "登录"}
          </button>
          <div className="login-hint">
            课堂演示口令统一为 <code>gvclab2026</code>;登录状态保留 12 小时,口令在服务端加密校验。
          </div>
        </form>
      </div>
    </div>
  );
}
