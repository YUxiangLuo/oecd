/**
 * 登录后的沉浸式系统介绍(5 幕,可跳过、可在顶栏重看):
 *   1 开场:闭环管线动画 + 真实规模计数(经济体/行业/年份)
 *   2 数据底座:两张可翻开的数据卡(ICIO 结构 / 拟真政策冲击事件)
 *   3 十五步旅程：五阶段可点击展开（内容来自 /api/steps 真实元数据）
 *   4 动手示意:关税滑块驱动的供应链示意动画(明确标注非真实估计)
 *   5 就绪:以当前登录身份进入实验
 * 统计与文案全部取自后端真实接口;仅动手预演为教学示意。
 */
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./a11y";
import { api } from "./api";
import { LogoMark } from "./brand";
import { oecdIcioEdition } from "./dataset-label";
import type { AuthUser, Meta, ShockEvent, StepsResponse } from "./types";

const N_SCENES = 5;

/** 数据卡左上角的小图标(内联 SVG,替代 emoji) */
function CardIcon({ kind }: { kind: "icio" | "shock" }) {
  return (
    <span className="intro-card-icon" aria-hidden>
      {kind === "icio" ? (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7">
          <circle cx="12" cy="12" r="9" />
          <ellipse cx="12" cy="12" rx="4.2" ry="9" />
          <path d="M3.6 9h16.8M3.6 15h16.8" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
          <path d="M13.2 2.5 5 13.4h5.1L9.6 21.5l8.4-11.3h-5.3l0.5-7.7z" />
        </svg>
      )}
    </span>
  );
}

function NavIcon({ kind }: { kind: "prev" | "next" | "start" | "skip" }) {
  if (kind === "skip") {
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    );
  }
  if (kind === "start") {
    return (
      <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor">
        <path d="M8 5.4v13.2c0 .7.8 1.1 1.4.7l9.4-6.6c.5-.4.5-1.1 0-1.5L9.4 4.7C8.8 4.3 8 4.7 8 5.4z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      {kind === "prev" ? <path d="M15 18l-6-6 6-6" /> : <path d="M9 6l6 6-6 6" />}
    </svg>
  );
}

export function IntroOverlay({ user, meta, onDone, returnFocusRef }: {
  user: AuthUser;
  meta: Meta | null;
  onDone: (gotoStep?: number) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const icioPanelId = useId();
  const shockPanelId = useId();
  const tariffSliderId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const [scene, setScene] = useState(0);
  const [stepsData, setStepsData] = useState<StepsResponse | null>(null);
  const [events, setEvents] = useState<ShockEvent[]>([]);
  const [openCard, setOpenCard] = useState<"icio" | "shock" | null>("icio");
  const [stage, setStage] = useState(1);
  const [tau, setTau] = useState(0);
  const [mechanism, setMechanism] = useState<"contract" | "reroute" | "offset" | null>(null);
  useDialogFocus({
    containerRef: dialogRef,
    initialFocusRef: skipRef,
    returnFocusRef,
    onClose: () => onDone(),
  });

  useEffect(() => {
    api.steps().then(setStepsData, () => {});
    api.shockEvents().then((r) => setEvents(r.events), () => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 表单控件（如关税滑块）需要原生方向键行为；全局翻页不劫持它们。
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (e.key === "ArrowRight") setScene((s) => Math.min(N_SCENES - 1, s + 1));
      if (e.key === "ArrowLeft") setScene((s) => Math.max(0, s - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const years = meta?.years ?? [];
  const yearSpan = years.length ? `${years[0]}–${years.at(-1)}` : "—";
  const nodes = (meta?.countries.length ?? 0) * (meta?.sectors.length ?? 0);
  const namedEconomies = meta?.countries.includes("ROW")
    ? meta.countries.length - 1
    : meta?.countries.length ?? 76;
  const regionCoverage = `${namedEconomies} 个具名经济体 + ROW 剩余地区账户`;
  const icioEdition = oecdIcioEdition(meta);

  const stages = useMemo(() => {
    if (!stepsData) return [];
    return Object.entries(stepsData.stages).map(([n, name]) => ({
      n: Number(n), name, steps: stepsData.steps.filter((s) => s.stage === Number(n)),
    }));
  }, [stepsData]);

  // This is a mechanism explorer, not a pre-baked causal answer. Students
  // predict first, then compare three plausible adjustment paths.
  const shrink = mechanism === "offset"
    ? Math.min(1.25, 1 + tau * 0.7)
    : mechanism === "reroute"
      ? Math.max(0.7, 1 - tau * 0.8)
      : Math.max(0.25, 1 - tau * 2.6);
  const demoShare = (mechanism === "offset"
    ? 12.0 * (1 + tau * 0.5)
    : mechanism === "reroute"
      ? 12.0 * Math.max(0.82, 1 - tau * 0.45)
      : 12.0 * Math.max(0.3, 1 - tau * 1.8)).toFixed(1);

  const roleName = user.role === "teacher" ? "教师" : "学生";

  const scenes = [
    /* ---- 1 开场 ---- */
    <div key={0} className="intro-scene">
      <div className="intro-logo"><LogoMark size={76} /></div>
      <h1 className="intro-title">供应链仿真系统</h1>
      <div className="intro-kicker">GVC SIMULATION LAB</div>
      <p className="intro-lede">
        把 <b>OECD ICIO 真实指标</b>变成<b>边界透明的方法演示链条</b> ——
        一条从数据接入到实验报告的完整闭环。
      </p>
      <div className="intro-pipeline">
        {/* 五阶段名称与 /api/steps、侧栏保持一致:学生接触到的旅程只有一套说法。 */}
        {["数据接入", "指标计算", "可视化分析", "回归设计与建模", "实验闭环"].map((p, i) => (
          <span key={p} style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span className="intro-chip" style={{ animationDelay: `${0.3 + i * 0.35}s` }}>
              <span className="intro-chip-num">{i + 1}</span>{p}
            </span>
            {i < 4 && <span className="intro-arrow" style={{ animationDelay: `${0.45 + i * 0.35}s` }}>→</span>}
          </span>
        ))}
      </div>
      <div className="intro-stats">
        {/* 课程范围是数据事实，必须从首帧就显示最终值。数字滚动会在截图或
            快速阅读时制造“58 / 34 / 12”一类并不存在的中间口径。 */}
        <div><div className="intro-stat-v">{namedEconomies} + ROW</div><div className="intro-stat-l">具名经济体 + 剩余账户</div></div>
        <div><div className="intro-stat-v">{meta?.sectors.length ?? 45}</div><div className="intro-stat-l">行业</div></div>
        <div><div className="intro-stat-v">{yearSpan}</div><div className="intro-stat-l">年份覆盖</div></div>
      </div>
    </div>,

    /* ---- 2 数据底座 ---- */
    <div key={1} className="intro-scene">
      <div className="intro-scene-kicker">数据底座</div>
      <h2 className="intro-h2">真实账本 × 拟真冲击</h2>
      <p className="intro-lede">价值链指标来自真实 ICIO,政策冲击是教学用拟真面板。点开卡片,看看两块底座分别装着什么；政策事件在第 10 步接入，并在第 11–14 步进入回归样本。</p>
      <div className="intro-cards">
        <div
          className={`intro-card${openCard === "icio" ? " open" : ""}`}
        >
          <button
            type="button"
            className="intro-card-toggle-button"
            aria-expanded={openCard === "icio"}
            aria-controls={icioPanelId}
            onClick={() => setOpenCard(openCard === "icio" ? null : "icio")}
          >
          <span className="intro-card-head">
            <CardIcon kind="icio" />
            <span>
              <span className="intro-card-title">OECD ICIO{icioEdition ? ` ${icioEdition} 版` : ""}投入产出表</span>
              <span className="intro-card-sub">谁向谁供货 —— 全球生产网络与增加值路径的账本</span>
            </span>
            <span className="intro-card-toggle">{openCard === "icio" ? "−" : "+"}</span>
          </span>
          </button>
          {openCard === "icio" && (
            <div className="intro-card-body" id={icioPanelId}>
              <div>{regionCoverage} × {meta?.sectors.length ?? 45} 行业节点，{yearSpan} 逐年</div>
              <div>中间品方阵约 {nodes.toLocaleString()} × {nodes.toLocaleString()}（国家×行业）</div>
              <div>原始宽表还含最终需求列与账户行，约 3,468 行 × 3,929 列</div>
              <div>结合 VA/TLS 账户、最终需求和里昂惕夫逆矩阵，追踪增加值、税收与网络位置</div>
            </div>
          )}
        </div>
        <div
          className={`intro-card${openCard === "shock" ? " open" : ""}`}
        >
          <button
            type="button"
            className="intro-card-toggle-button"
            aria-expanded={openCard === "shock"}
            aria-controls={shockPanelId}
            onClick={() => setOpenCard(openCard === "shock" ? null : "shock")}
          >
          <span className="intro-card-head">
            <CardIcon kind="shock" />
            <span>
              <span className="intro-card-title">贸易政策冲击面板</span>
              <span className="intro-card-sub">以 2017–2020 全球贸易摩擦为原型的课堂拟真事件库</span>
            </span>
            <span className="intro-card-toggle">{openCard === "shock" ? "−" : "+"}</span>
          </span>
          </button>
          {openCard === "shock" && (
            <div className="intro-card-body" id={shockPanelId}>
              {events.slice(0, 4).map((e) => (
                <div key={e.name}>{e.name}({e.effective} 生效)</div>
              ))}
              <div style={{ opacity: 0.7, marginTop: 8 }}>
                共 {events.length} 组事件，保留行业间差异和宣布/生效时间线；接入其他事件库时，必须满足同样的 country × industry × year 格式、行业映射和来源验证
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,

    /* ---- 3 十五步旅程 ---- */
    <div key={2} className="intro-scene">
      <div className="intro-scene-kicker">实验路线</div>
      <h2 className="intro-h2">五个阶段，十五步</h2>
      <p className="intro-lede">点击各阶段预览路线。建议按顺序完成；“自由浏览”只改变位置，答对本步选择题才会计入完成度。</p>
      <div className="intro-stage-tabs">
        {stages.map((st) => (
          <button
            key={st.n} className={`intro-stage-tab${stage === st.n ? " on" : ""}`}
            type="button"
            aria-pressed={stage === st.n}
            onClick={() => setStage(st.n)}
          >
            {st.n}. {st.name}
          </button>
        ))}
      </div>
      <div className="intro-steps">
        {(stages.find((s) => s.n === stage)?.steps ?? []).map((s) => (
          <div key={s.n} className="intro-step-row">
            <span className="intro-step-num">{String(s.n).padStart(2, "0")}</span>
            <span className="intro-step-title">{s.title}</span>
            <span className="intro-step-goal">{s.goal}</span>
            <button type="button" className="intro-step-start" aria-label={`自由浏览第 ${s.n} 步：${s.title}`} onClick={() => onDone(s.n)}>
              自由浏览此步
            </button>
          </div>
        ))}
      </div>
    </div>,

    /* ---- 4 动手示意 ---- */
    <div key={3} className="intro-scene">
      <div className="intro-scene-kicker">动手预演</div>
      <h2 className="intro-h2">政策冲击可能如何传导到价值链?</h2>
      <p className="intro-lede">先预测企业最可能怎样调整，再拖动滑块，看这条机制路径会怎样变化。真实方向必须由后续数据与识别设计回答。</p>
      <div className="intro-mechanisms" role="group" aria-label="先选择政策传导机制">
        <button type="button" aria-pressed={mechanism === "contract"} className={mechanism === "contract" ? "on" : ""} onClick={() => setMechanism("contract")}><b>跨境收缩</b><span>供应链缩短，复杂 GVC 下降</span></button>
        <button type="button" aria-pressed={mechanism === "reroute"} className={mechanism === "reroute" ? "on" : ""} onClick={() => setMechanism("reroute")}><b>贸易转移</b><span>改道第三国，原有链条部分保留</span></button>
        <button type="button" aria-pressed={mechanism === "offset"} className={mechanism === "offset" ? "on" : ""} onClick={() => setMechanism("offset")}><b>替代性扩张</b><span>新供应商接入，复杂度未必下降</span></button>
      </div>
      <svg viewBox="0 0 640 196" style={{ width: "min(720px, 94%)", margin: "10px auto 0" }}>
        {/* 跨境流:宽度随 τ 收缩 */}
        <path d="M118 95 C 200 40, 260 40, 312 88" fill="none" stroke="#7aa5e8"
          strokeWidth={10 * shrink} strokeLinecap="round" opacity={0.9} />
        <path d="M348 88 C 400 40, 460 40, 522 95" fill="none" stroke="#7aa5e8"
          strokeWidth={9 * shrink} strokeLinecap="round" opacity={0.9} />
        {/* 国内替代环:随 τ 变粗 */}
        <path d="M310 118 C 270 175, 370 175, 330 118" fill="none" stroke="#49c39b"
          strokeWidth={4 + tau * 26} strokeLinecap="round" opacity={0.9} />
        <text x={320} y={188} textAnchor="middle" fontSize={12.5} fill="#a8b6da">国内环节替代</text>
        {[["上游资源国", 90, "#eda100"], ["制造枢纽国", 320, "#3987e5"], ["最终消费国", 550, "#e34948"]].map(([label, x, col]) => (
          <g key={String(label)} transform={`translate(${x} 95)`}>
            <circle r={27} fill={String(col)} opacity={0.16} />
            <circle r={18} fill={String(col)} stroke="#101528" strokeWidth={3} />
            <text y={-34} textAnchor="middle" fontSize={14} fontWeight={600} fill="#eef1fb">{label}</text>
          </g>
        ))}
        <text x={215} y={34} textAnchor="middle" fontSize={12.5} fill="#a8b6da">中间品出口</text>
        <text x={435} y={34} textAnchor="middle" fontSize={12.5} fill="#a8b6da">最终品出口</text>
      </svg>
      <div className="intro-slider-row">
        <label className="intro-slider-label" htmlFor={tariffSliderId}>关税冲击 τ</label>
        <input
          id={tariffSliderId}
          type="range" min={0} max={25} value={tau * 100} disabled={!mechanism}
          onChange={(e) => setTau(Number(e.target.value) / 100)}
        />
        <span className="intro-tau">{(tau * 100).toFixed(0)}%</span>
        <span className="intro-slider-label" style={{ marginLeft: 20 }}>复杂 GVC 生产份额(示意)</span>
        <span className="intro-tau" style={{ color: tau > 0.02 ? "#ff9d9d" : "#eef1fb" }}>{demoShare}%</span>
      </div>
      {!mechanism && (
        <p className="intro-slider-hint">先在上方选择一种传导机制，滑块才会启用。</p>
      )}
      <p className="intro-note">
        本页只展示你选择的一种可能机制，不是估计结果，也不预告真实方向。后续回归会分别检验课程纯 VA 口径 FVA_share（非 OECD EXGR_FVASH）、
        复杂 GVC 生产份额、前向 GVC 生产长度(PLv_GVC)，并探索全正边二值网络介数；四项不能只挑显著结果。
      </p>
    </div>,

    /* ---- 5 就绪 ---- */
    <div key={4} className="intro-scene">
      <div className="intro-check" aria-hidden>
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 12.5 10 18 19.5 6.5" />
        </svg>
      </div>
      <h2 className="intro-h2">实验台已就绪</h2>
      <p className="intro-lede">
        你将以<b>{roleName}</b>身份进入。建议从阶段一开始,
        亲手走完五个阶段的完整闭环;
        每一步都配有方法说明、动手面板和小贴士。
      </p>
      {/* 进入前讲清完成规则，避免把浏览位置误认为学习进度。 */}
      <div className="intro-ready-rules">
        <b>侧栏会分别显示两种进度：</b>
        <span>步骤徽标“✓”= 本步理解题已答对；“材料已齐全”= 本步用于报告的材料已经保存。</span>
        <span>第 1 步记录单元格；第 2–5 步各用“记录当前国家到报告材料”按钮保存两个对象，第 6–9 步各完成指定的对比并保存；第 11–14 步各保存一次可报告估计；第 15 步完成三段原创分析。</span>
      </div>
      <div className="intro-cta-row">
        <button className="intro-cta" onClick={() => onDone(1)}>从第 1 步开始实验</button>
      </div>
    </div>,
  ];

  return createPortal(
    <div
      ref={dialogRef}
      className="intro-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <h2 id={titleId} className="sr-only">系统介绍</h2>
      <button ref={skipRef} className="intro-skip" aria-label="跳过介绍" title="跳过介绍" onClick={() => onDone()}>
        <NavIcon kind="skip" />
      </button>
      <div className="intro-scene-shell">
        <button
          className="intro-side-nav intro-side-nav-prev" aria-label="上一页" title="上一页" disabled={scene === 0}
          onClick={() => setScene(scene - 1)}
        >
          <NavIcon kind="prev" />
        </button>
        {scenes[scene]}
        {scene < N_SCENES - 1 ? (
          <button
            className="intro-side-nav intro-side-nav-next" aria-label="下一页" title="下一页"
            onClick={() => setScene(scene + 1)}
          >
            <NavIcon kind="next" />
          </button>
        ) : <span aria-hidden="true" />}
      </div>
      <div className="intro-nav">
        <div className="intro-dots">
          {Array.from({ length: N_SCENES }, (_, i) => (
            <button
              key={i} aria-label={`介绍页 ${i + 1}`}
              className={`intro-dot${i === scene ? " on" : ""}`} onClick={() => setScene(i)}
            />
          ))}
        </div>
      </div>
      <div className="intro-keyhint">← → 方向键翻页 · Esc 跳过</div>
    </div>,
    document.body,
  );
}
