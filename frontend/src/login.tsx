/**
 * 登录页:接真实后端(POST /api/auth/login,PBKDF2 哈希 + HMAC 签名令牌)。
 * 演示定位:默认预填演示账号 student / gvclab2026,一键即可进入。
 */
import { useState } from "react";
import { api } from "./api";
import type { LoginResponse } from "./types";

const PIPELINE = ["数据", "指标", "回归", "报告"];

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
        <div>
          <div className="login-logo">仿</div>
          <h1>供应链仿真系统</h1>
          <div className="login-sub">GVC SIMULATION LAB</div>
          <p className="login-desc">
            基于 OECD 全球投入产出数据库的价值链教学实验平台:
            从真实数据出发,计算 GVC 指标、检验政策冲击的因果效应、自动生成实验报告。
          </p>
          <div className="login-pipeline">
            {PIPELINE.map((p, i) => (
              <span key={p} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="pipe-chip" style={{ animationDelay: `${i * 0.35}s` }}>{p}</span>
                {i < PIPELINE.length - 1 && <span className="pipe-arrow">→</span>}
              </span>
            ))}
          </div>
        </div>
        <div className="login-foot">国际经济学 · 全球价值链实验 · 77 经济体 × 45 行业 × 2016–2020</div>
      </div>

      <div className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <h2>登录实验平台</h2>
          <p className="muted" style={{ marginTop: 4, marginBottom: 22 }}>
            演示环境已预填账号,直接点击登录即可
          </p>
          <label className="login-label">用户名</label>
          <input className="login-input" value={username} autoComplete="username"
            onChange={(e) => setUsername(e.target.value)} />
          <label className="login-label">密码</label>
          <input className="login-input" type="password" value={password} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} />
          {error && <div className="error-box" style={{ marginTop: 12, padding: "10px 14px" }}>{error}</div>}
          <button className="run-btn login-btn" type="submit" disabled={busy}>
            {busy ? "登录中…" : "登 录"}
          </button>
          <div className="login-hint">
            演示账号:<code>student / gvclab2026</code>(学生)· <code>teacher / gvclab2026</code>(教师)
            <br />后端真实校验:PBKDF2 口令哈希 + HMAC 签名令牌(12 小时有效)
          </div>
        </form>
      </div>
    </div>
  );
}
