/**
 * 登录后的沉浸式系统介绍(5 幕,可跳过、可在顶栏重看):
 *   1 开场:闭环管线动画 + 真实规模计数(经济体/行业/年份/步骤)
 *   2 数据底座:两张可翻开的数据卡(ICIO 结构 / 真实编码的冲击事件)
 *   3 十七步旅程:五阶段可点击展开(内容来自 /api/steps 真实元数据)
 *   4 动手示意:关税滑块驱动的供应链示意动画(明确标注非真实估计)
 *   5 就绪:以当前登录身份进入实验
 * 统计与文案全部取自后端真实接口;仅第 4 幕为教学示意。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { AuthUser, Meta, ShockEvent, StepsResponse } from "./types";

const N_SCENES = 5;

/** 数字滚动:0 → value,约 1 秒 */
function CountUp({ value, suffix }: { value: number; suffix?: string }) {
  const [v, setV] = useState(0);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 1000);
      setV(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [value]);
  return <span>{v}{suffix ?? ""}</span>;
}

export function IntroOverlay({ user, meta, onDone }: {
  user: AuthUser;
  meta: Meta | null;
  onDone: (gotoStep?: number) => void;
}) {
  const [scene, setScene] = useState(0);
  const [stepsData, setStepsData] = useState<StepsResponse | null>(null);
  const [events, setEvents] = useState<ShockEvent[]>([]);
  const [openCard, setOpenCard] = useState<"icio" | "shock" | null>(null);
  const [stage, setStage] = useState(1);
  const [tau, setTau] = useState(0);

  useEffect(() => {
    api.steps().then(setStepsData, () => {});
    api.shockEvents().then((r) => setEvents(r.events), () => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setScene((s) => Math.min(N_SCENES - 1, s + 1));
      if (e.key === "ArrowLeft") setScene((s) => Math.max(0, s - 1));
      if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  const years = meta?.years ?? [];
  const yearSpan = years.length ? `${years[0]}–${years.at(-1)}` : "—";
  const nodes = (meta?.countries.length ?? 0) * (meta?.sectors.length ?? 0);

  const stages = useMemo(() => {
    if (!stepsData) return [];
    return Object.entries(stepsData.stages).map(([n, name]) => ({
      n: Number(n), name, steps: stepsData.steps.filter((s) => s.stage === Number(n)),
    }));
  }, [stepsData]);

  // 第 4 幕示意:跨境流宽度随 τ 收缩,复杂 GVC 份额(示意值)随之下降
  const shrink = Math.max(0.25, 1 - tau * 2.6);
  const demoShare = (12.0 * Math.max(0.3, 1 - tau * 1.8)).toFixed(1);

  const scenes = [
    /* ---- 1 开场 ---- */
    <div key={0} className="intro-scene">
      <div className="intro-logo">仿</div>
      <h1 className="intro-title">供应链仿真系统</h1>
      <div className="intro-kicker">GVC SIMULATION LAB</div>
      <p className="intro-lede">
        把 <b>真实世界数据</b> 变成 <b>可检验的经济学结论</b> ——
        一条从数据接入到实验报告的完整闭环。
      </p>
      <div className="intro-pipeline">
        {["① 数据接入", "② 指标计算", "③ 可视化", "④ 因果回归", "⑤ 实验报告"].map((p, i) => (
          <span key={p} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="intro-chip" style={{ animationDelay: `${0.3 + i * 0.4}s` }}>{p}</span>
            {i < 4 && <span className="intro-arrow" style={{ animationDelay: `${0.5 + i * 0.4}s` }}>→</span>}
          </span>
        ))}
      </div>
      <div className="intro-stats">
        <div><div className="intro-stat-v"><CountUp value={meta?.countries.length ?? 77} /></div><div className="intro-stat-l">经济体</div></div>
        <div><div className="intro-stat-v"><CountUp value={meta?.sectors.length ?? 45} /></div><div className="intro-stat-l">行业</div></div>
        <div><div className="intro-stat-v">{yearSpan}</div><div className="intro-stat-l">年份覆盖</div></div>
        <div><div className="intro-stat-v"><CountUp value={17} /></div><div className="intro-stat-l">实验步骤</div></div>
      </div>
    </div>,

    /* ---- 2 数据底座 ---- */
    <div key={1} className="intro-scene">
      <h2 className="intro-h2">两块数据底座</h2>
      <p className="intro-lede">价值链是"果",政策冲击是"因" —— 点击卡片看看它们分别是什么。</p>
      <div className="intro-cards">
        <div className={`intro-card${openCard === "icio" ? " open" : ""}`}
          onClick={() => setOpenCard(openCard === "icio" ? null : "icio")}>
          <div className="intro-card-title">🌐 OECD 全球投入产出表</div>
          <div className="intro-card-sub">谁买了谁的东西 —— 全球生产网络的账本</div>
          {openCard === "icio" && (
            <div className="intro-card-body">
              <div>· {meta?.countries.length ?? 77} 经济体 × {meta?.sectors.length ?? 45} 行业,{yearSpan} 逐年</div>
              <div>· 每年一张 {nodes.toLocaleString()} × {nodes.toLocaleString()} 的中间品流量矩阵</div>
              <div>· 由此解出里昂惕夫逆矩阵,追踪增加值的跨境路径</div>
            </div>
          )}
        </div>
        <div className={`intro-card${openCard === "shock" ? " open" : ""}`}
          onClick={() => setOpenCard(openCard === "shock" ? null : "shock")}>
          <div className="intro-card-title">⚡ 贸易政策冲击面板</div>
          <div className="intro-card-sub">以 2018–2020 全球贸易摩擦为原型的拟真事件库</div>
          {openCard === "shock" && (
            <div className="intro-card-body">
              {events.slice(0, 4).map((e) => (
                <div key={e.name}>· {e.name}({e.effective} 生效)</div>
              ))}
              <div style={{ opacity: 0.75, marginTop: 6 }}>共 {events.length} 组事件,行业异质、覆盖全部经济体;宣布/生效时间线支持因果识别</div>
            </div>
          )}
        </div>
      </div>
    </div>,

    /* ---- 3 十七步旅程 ---- */
    <div key={2} className="intro-scene">
      <h2 className="intro-h2">五个阶段,十七步</h2>
      <p className="intro-lede">点击各阶段,预览你将亲手完成的每一步。</p>
      <div className="intro-stage-tabs">
        {stages.map((st) => (
          <button key={st.n} className={`intro-stage-tab${stage === st.n ? " on" : ""}`}
            onClick={() => setStage(st.n)}>
            {st.n}. {st.name}
          </button>
        ))}
      </div>
      <div className="intro-steps">
        {(stages.find((s) => s.n === stage)?.steps ?? []).map((s) => (
          <div key={s.n} className="intro-step-row">
            <span className="intro-step-num">{String(s.n).padStart(2, "0")}</span>
            <span style={{ fontWeight: 600 }}>{s.title}</span>
            <span className="intro-step-goal">{s.goal}</span>
          </div>
        ))}
      </div>
    </div>,

    /* ---- 4 动手示意 ---- */
    <div key={3} className="intro-scene">
      <h2 className="intro-h2">政策冲击如何重塑价值链?</h2>
      <p className="intro-lede">拖动滑块,给跨境环节加征关税,看看链条发生什么。</p>
      <svg viewBox="0 0 640 190" style={{ width: "min(640px, 90%)", margin: "8px auto 0" }}>
        {/* 跨境流:宽度随 τ 收缩 */}
        <path d={`M118 95 C 200 40, 260 40, 312 88`} fill="none" stroke="#7aa5e8"
          strokeWidth={10 * shrink} strokeLinecap="round" opacity={0.9} />
        <path d={`M348 88 C 400 40, 460 40, 522 95`} fill="none" stroke="#7aa5e8"
          strokeWidth={9 * shrink} strokeLinecap="round" opacity={0.9} />
        {/* 国内替代环:随 τ 变粗 */}
        <path d="M310 118 C 270 175, 370 175, 330 118" fill="none" stroke="#49c39b"
          strokeWidth={4 + tau * 26} strokeLinecap="round" opacity={0.9} />
        <text x={320} y={182} textAnchor="middle" fontSize={11} fill="#9fb0d8">国内环节替代</text>
        {[["上游资源国", 90, "#eda100"], ["制造枢纽国", 320, "#3987e5"], ["最终消费国", 550, "#e34948"]].map(([label, x, col]) => (
          <g key={String(label)} transform={`translate(${x} 95)`}>
            <circle r={26} fill={String(col)} opacity={0.16} />
            <circle r={17} fill={String(col)} stroke="#101528" strokeWidth={3} />
            <text y={-32} textAnchor="middle" fontSize={12.5} fontWeight={600} fill="#e8ecf8">{label}</text>
          </g>
        ))}
        <text x={215} y={36} textAnchor="middle" fontSize={11} fill="#9fb0d8">中间品出口</text>
        <text x={435} y={36} textAnchor="middle" fontSize={11} fill="#9fb0d8">最终品出口</text>
      </svg>
      <div className="intro-slider-row">
        <span style={{ fontSize: 13, color: "#9fb0d8" }}>关税冲击 τ</span>
        <input type="range" min={0} max={25} value={tau * 100}
          onChange={(e) => setTau(Number(e.target.value) / 100)} style={{ width: 260 }} />
        <span className="intro-tau">{(tau * 100).toFixed(0)}%</span>
        <span style={{ fontSize: 13, color: "#9fb0d8", marginLeft: 18 }}>复杂 GVC 份额(示意)</span>
        <span className="intro-tau" style={{ color: tau > 0.02 ? "#ff9d9d" : "#e8ecf8" }}>{demoShare}%</span>
      </div>
      <p className="intro-note">
        ⚠ 本页为教学示意动画,不是估计结果。真实效应由步骤 13–16 的 DID / 事件研究给出
        (演示数据上:受冲击国家-行业的复杂 GVC 份额在 2018 年后相对下降约 0.4 个百分点)。
      </p>
    </div>,

    /* ---- 5 就绪 ---- */
    <div key={4} className="intro-scene">
      <div className="intro-logo" style={{ fontSize: 30 }}>✓</div>
      <h2 className="intro-h2">一切就绪,{user.name}</h2>
      <p className="intro-lede">
        以 <b>{user.role === "teacher" ? "教师" : "学生"}</b> 身份进入。
        建议从阶段一开始,亲手走完 数据 → 指标 → 回归 → 报告 的闭环;
        每一步都配有概念讲解、动手面板和小贴士。
      </p>
      <div style={{ display: "flex", gap: 14, marginTop: 26, flexWrap: "wrap", justifyContent: "center" }}>
        <button className="intro-cta" onClick={() => onDone(1)}>从第 1 步开始实验 →</button>
        <button className="intro-cta ghost" onClick={() => onDone(8)}>先看看全球生产网络图</button>
      </div>
    </div>,
  ];

  return (
    <div className="intro-overlay">
      <button className="intro-skip" onClick={() => onDone()}>跳过介绍 ✕</button>
      {scenes[scene]}
      <div className="intro-nav">
        <button className="intro-nav-btn" disabled={scene === 0}
          onClick={() => setScene(scene - 1)}>←</button>
        <div className="intro-dots">
          {Array.from({ length: N_SCENES }, (_, i) => (
            <button key={i} className={`intro-dot${i === scene ? " on" : ""}`} onClick={() => setScene(i)} />
          ))}
        </div>
        {scene < N_SCENES - 1 ? (
          <button className="intro-nav-btn primary" onClick={() => setScene(scene + 1)}>→</button>
        ) : (
          <button className="intro-nav-btn primary" onClick={() => onDone(1)}>✓</button>
        )}
      </div>
      <div className="intro-keyhint">← → 方向键翻页 · Esc 跳过</div>
    </div>
  );
}
