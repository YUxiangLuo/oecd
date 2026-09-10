/**
 * 登录后的沉浸式系统介绍(5 幕,可跳过、可在顶栏重看):
 *   1 开场:闭环管线动画 + 真实规模计数(经济体/行业/年份)
 *   2 数据底座：两张可独立展开的数据卡（真实数据 / 教学设定）
 *   3 十五步旅程：五阶段可点击展开（内容来自 /api/steps 真实元数据）
 *   4 动手示意:关税滑块驱动的供应链示意动画(明确标注非真实估计)
 *   5 就绪:说明当前身份与完成规则，关闭介绍后返回实验台
 * 覆盖范围与目录来自课程元数据；机制图仅为教学示意，不生成估计数值。
 */
import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./a11y";
import { api } from "./api";
import { LogoMark } from "./brand";
import { oecdIcioEdition } from "./dataset-label";
import type { AuthUser, Meta, ShockEvent, StepsResponse } from "./types";

const SCENE_NAMES = ["认识实验", "数据与设定", "实验路线", "机制预演", "完成规则"];
const N_SCENES = SCENE_NAMES.length;
const STAGE_OUTPUTS: Record<number, string> = {
  1: "认识投入产出表，记录观察对象。",
  2: "计算并保存不同对象的价值链指标。",
  3: "比较差异，形成图表证据。",
  4: "核对冲击来源，保存估计或诊断结果。",
  5: "整合材料，完成原创分析与报告。",
};

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

export function IntroOverlay({ user, meta, stepsData, onDone, returnFocusRef }: {
  user: AuthUser;
  meta: Meta | null;
  stepsData: StepsResponse;
  onDone: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const icioPanelId = useId();
  const shockPanelId = useId();
  const tariffSliderId = useId();
  const mechanismHintId = useId();
  const flowArrowId = useId();
  const alternateArrowId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const eventCardRef = useRef<HTMLButtonElement>(null);
  const [scene, setScene] = useState(0);
  const [events, setEvents] = useState<ShockEvent[] | null>(null);
  const [eventsError, setEventsError] = useState(false);
  const [eventsAttempt, setEventsAttempt] = useState(0);
  const [openCards, setOpenCards] = useState({ icio: false, shock: false });
  const [eventsDisclosure, setEventsDisclosure] = useState("");
  const [stage, setStage] = useState(1);
  const [tau, setTau] = useState(0);
  const [mechanism, setMechanism] = useState<"contract" | "reroute" | "offset">("reroute");
  useDialogFocus({
    containerRef: dialogRef,
    initialFocusRef: skipRef,
    returnFocusRef,
    onClose: () => onDone(),
  });

  useEffect(() => {
    let active = true;
    setEvents(null);
    setEventsError(false);
    setEventsDisclosure("");
    api.shockEvents().then(
      (r) => { if (active) { setEvents(r.events); setEventsDisclosure(r.source_disclosure); } },
      () => { if (active) setEventsError(true); },
    );
    return () => { active = false; };
  }, [eventsAttempt]);

  useLayoutEffect(() => {
    // A scene can remove the focused next button. Announce the new heading
    // through focus, without making every slider change a live announcement.
    const container = dialogRef.current;
    const heading = container?.querySelector<HTMLElement>(".intro-scene h1, .intro-scene h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      container?.scrollTo({ top: 0 });
    }
  }, [scene]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!(target instanceof Element) || !dialogRef.current?.contains(target)) return;
      // Local controls retain their keyboard semantics, including nested SVGs.
      if (target.closest("button, input, textarea, select, summary, a, [contenteditable]:not([contenteditable='false']), [role='tab'], [role='radio']")) return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        setScene((s) => Math.max(0, Math.min(N_SCENES - 1, s + (e.key === "ArrowRight" ? 1 : -1))));
      }
    };
    const container = dialogRef.current;
    container?.addEventListener("keydown", onKey);
    return () => container?.removeEventListener("keydown", onKey);
  }, []);

  const years = meta?.years ?? [];
  const yearSpan = years.length ? `${years[0]}–${years.at(-1)}` : "—";
  const nodes = meta ? meta.countries.length * meta.sectors.length : null;
  const hasRestOfWorld = meta?.countries.includes("ROW") ?? false;
  const namedEconomies = meta ? meta.countries.length - Number(hasRestOfWorld) : null;
  const regionCoverage = meta
    ? `${namedEconomies} 个经济体${hasRestOfWorld ? " + ROW 世界其他地区账户" : ""}`
    : "覆盖范围暂不可用";
  const icioEdition = oecdIcioEdition(meta);

  const stages = useMemo(() => {
    return Object.entries(stepsData.stages).map(([n, name]) => ({
      n: Number(n), name, steps: stepsData.steps.filter((s) => s.stage === Number(n)),
    }));
  }, [stepsData]);
  const selectedStage = stages.find((s) => s.n === stage) ?? stages[0];

  // Animation widths illustrate a chosen assumption, not calibrated trade
  // volumes. Do not derive or display an invented GVC share from this diagram.
  const shrink = mechanism === "offset"
    ? Math.min(1.25, 1 + tau * 0.7)
    : mechanism === "reroute"
      ? Math.max(0.7, 1 - tau * 0.8)
      : Math.max(0.25, 1 - tau * 2.6);
  const mechanismFeedback = tau === 0
    ? "尚未加征关税：当前展示示意基线，尚未施加额外冲击。"
    : mechanism === "contract"
      ? "当前假设：原跨境路径减弱，国内替代增强。"
      : mechanism === "reroute"
        ? "当前假设：部分生产改经第三国，原供货路径部分保留。"
        : "当前假设：新增境外供应商与原供货路径并存，跨境活动可能扩张。";

  const roleName = user.role === "teacher" ? "教师" : "学生";

  const scenes = [
    /* ---- 1 开场 ---- */
    <div key={0} className="intro-scene">
      <div className="intro-logo"><LogoMark size={76} /></div>
      <h1 className="intro-title">供应链仿真系统</h1>
      <div className="intro-kicker">GVC SIMULATION LAB</div>
      <p className="intro-lede">
        从全球生产联系，理解价值链变化。基于 OECD ICIO 数据，计算和比较价值链指标，
        练习分析政策冲击，并完成有依据的实验报告。
      </p>
      <p className="intro-boundary">真实投入产出数据 · 教学情景 · 不作真实政策效果预测</p>
      <div className="intro-pipeline">
        {/* 五阶段名称与 /api/steps、侧栏保持一致:学生接触到的旅程只有一套说法。 */}
        {stages.map((st, i) => (
          <span key={st.n} style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span className="intro-chip" style={{ animationDelay: `${0.3 + i * 0.35}s` }}>
              <span className="intro-chip-num">{st.n}</span>{st.name}
            </span>
            {i < stages.length - 1 && <span className="intro-arrow" style={{ animationDelay: `${0.45 + i * 0.35}s` }}>→</span>}
          </span>
        ))}
      </div>
      <div className="intro-stats">
        {/* 课程范围是数据事实，必须从首帧就显示最终值。数字滚动会在截图或
            快速阅读时制造“58 / 34 / 12”一类并不存在的中间口径。 */}
        <div><div className="intro-stat-v">{namedEconomies ?? "—"}{hasRestOfWorld ? " + ROW" : ""}</div><div className="intro-stat-l">{hasRestOfWorld ? "经济体 + 世界其他地区账户" : "经济体"}</div></div>
        <div><div className="intro-stat-v">{meta?.sectors.length ?? "—"}</div><div className="intro-stat-l">行业</div></div>
        <div><div className="intro-stat-v">{yearSpan}</div><div className="intro-stat-l">当前课程数据范围</div></div>
      </div>
    </div>,

    /* ---- 2 数据底座 ---- */
    <div key={1} className="intro-scene">
      <div className="intro-scene-kicker">数据底座</div>
      <h2 className="intro-h2">真实数据与教学设定</h2>
      <p className="intro-lede">投入产出数据来自 OECD；指标按课程方法计算。政策事件有来源披露，但冲击参数与行业映射包含教学设定。</p>
      <div className="intro-cards">
        <div
          className={`intro-card${openCards.icio ? " open" : ""}`}
        >
          <button
            type="button"
            className="intro-card-toggle-button"
            aria-expanded={openCards.icio}
            aria-controls={icioPanelId}
            onClick={() => setOpenCards((cards) => ({ ...cards, icio: !cards.icio }))}
          >
          <span className="intro-card-head">
            <CardIcon kind="icio" />
            <span>
              <span className="intro-card-title">OECD ICIO{icioEdition ? ` ${icioEdition} 版` : ""}投入产出表</span>
              <span className="intro-card-sub">展开或收起数据结构说明</span>
            </span>
            <span className="intro-card-toggle" aria-hidden>{openCards.icio ? "−" : "+"}</span>
          </span>
          </button>
          <ul className="intro-card-facts">
            <li>来源：OECD ICIO 真实投入产出数据。</li>
            <li>描述经济体与行业间的供货联系。</li>
            <li>价值链指标按本课程口径计算，不等同于 OECD 官方已发布指标。</li>
          </ul>
          {openCards.icio && (
            <div className="intro-card-body" id={icioPanelId}>
              {meta && nodes !== null ? (
                <>
                  <div>{regionCoverage} × {meta.sectors.length} 行业节点，{yearSpan} 逐年</div>
                  <div>中间品方阵约 {nodes.toLocaleString()} × {nodes.toLocaleString()}（国家×行业）</div>
                </>
              ) : <p role="status">课程数据范围暂不可用。</p>}
              <div>原始宽表还包含最终需求列与增加值、税收等账户行。</div>
              <div>结合 VA/TLS 账户、最终需求和里昂惕夫逆矩阵，追踪增加值、税收与网络位置</div>
            </div>
          )}
        </div>
        <div
          className={`intro-card${openCards.shock ? " open" : ""}`}
        >
          <button
            type="button"
            className="intro-card-toggle-button"
            ref={eventCardRef}
            aria-expanded={openCards.shock}
            aria-controls={shockPanelId}
            onClick={() => setOpenCards((cards) => ({ ...cards, shock: !cards.shock }))}
          >
          <span className="intro-card-head">
            <CardIcon kind="shock" />
            <span>
              <span className="intro-card-title">贸易政策冲击面板</span>
              <span className="intro-card-sub">展开或收起事件目录与来源说明</span>
            </span>
            <span className="intro-card-toggle" aria-hidden>{openCards.shock ? "−" : "+"}</span>
          </span>
          </button>
          <ul className="intro-card-facts">
            <li>以贸易政策事件为背景，来源完整性需逐项核对。</li>
            <li>税率、覆盖范围与行业映射含教学设定。</li>
            <li>用于练习分析，不直接支持真实政策效果结论。</li>
          </ul>
          {openCards.shock && (
            <div className="intro-card-body" id={shockPanelId}>
              {eventsError ? (
                <div className="intro-load-state">
                  <p role="alert">事件信息暂时无法加载，请重试。未加载到数据不代表没有事件。</p>
                  <button type="button" className="intro-stage-tab" onClick={() => { eventCardRef.current?.focus(); setEventsAttempt((n) => n + 1); }}>重试加载事件</button>
                </div>
              ) : events === null ? (
                <p role="status">正在加载事件信息…</p>
              ) : events.length === 0 ? (
                <p role="status">当前事件目录为空。</p>
              ) : (
                <>
                  <div role="status">当前目录共 {events.length} 组事件。事件与日期的来源，不等于冲击参数已获官方核验。</div>
                  {eventsDisclosure && <p>{eventsDisclosure}</p>}
                  <details className="intro-details">
                    <summary>查看完整事件目录</summary>
                    {events.map((e) => (
                      <div key={e.name}>{e.name}（{e.effective} 生效）</div>
                    ))}
                  </details>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,

    /* ---- 3 十五步旅程 ---- */
    <div key={2} className="intro-scene">
      <div className="intro-scene-kicker">实验路线</div>
      <h2 className="intro-h2">{stages.length === 0 ? "实验路线" : stages.length === 5 && stepsData.steps.length === 15 ? "五个阶段，十五步" : `${stages.length} 个阶段，${stepsData.steps.length} 步`}</h2>
      <p className="intro-lede">选择阶段，了解要做的分析和留下的材料。这里仅作路线预览，不切换实验步骤。</p>
      {stages.length === 0 && <p role="status">当前课程暂无实验路线信息。</p>}
      <div className="intro-stage-tabs">
        {stages.map((st) => (
          <button
            key={st.n} className={`intro-stage-tab${selectedStage?.n === st.n ? " on" : ""}`}
            type="button"
            aria-pressed={selectedStage?.n === st.n}
            onClick={() => setStage(st.n)}
          >
            {st.n}. {st.name}
          </button>
        ))}
      </div>
      {selectedStage && STAGE_OUTPUTS[selectedStage.n] && <p className="intro-stage-output"><b>阶段产出：</b>{STAGE_OUTPUTS[selectedStage.n]}</p>}
      <div className="intro-steps">
        {(selectedStage?.steps ?? []).map((s) => (
          <div key={s.n} className="intro-step-row">
            <span className="intro-step-num">{String(s.n).padStart(2, "0")}</span>
            <span className="intro-step-title">{s.title}</span>
          </div>
        ))}
      </div>
      {selectedStage && selectedStage.steps.length > 0 && (
        <details key={selectedStage.n} className="intro-details intro-route-details">
          <summary>查看本阶段完整教学目标</summary>
          <ol>
            {selectedStage.steps.map((s) => (
              <li key={s.n}><b>{s.n}. {s.title}</b><p className="intro-step-goal">{s.goal}</p></li>
            ))}
          </ol>
        </details>
      )}
    </div>,

    /* ---- 4 动手示意 ---- */
    <div key={3} className="intro-scene">
      <div className="intro-scene-kicker">动手预演</div>
      <h2 className="intro-h2">同一种冲击，可能有不同调整路径</h2>
      <p className="intro-lede">假设原供货通道受到额外关税冲击。默认展示贸易转移；拖动滑块或切换机制，观察不同假设下的路径变化。</p>
      <div className="intro-mechanisms" role="group" aria-label="选择政策传导机制">
        <button type="button" aria-pressed={mechanism === "contract"} className={mechanism === "contract" ? "on" : ""} onClick={() => setMechanism("contract")}><b>跨境收缩</b><span>假设跨境路径减弱、国内替代增强</span></button>
        <button type="button" aria-pressed={mechanism === "reroute"} className={mechanism === "reroute" ? "on" : ""} onClick={() => setMechanism("reroute")}><b>贸易转移</b><span>改道第三国，原有链条部分保留</span></button>
        <button type="button" aria-pressed={mechanism === "offset"} className={mechanism === "offset" ? "on" : ""} onClick={() => setMechanism("offset")}><b>替代性扩张</b><span>假设新增境外供应商与原路径并存</span></button>
      </div>
      <svg viewBox="0 0 640 244" role="img"
        aria-label={mechanism === "contract" ? "跨境收缩示意：原跨境路径减弱，假设国内替代增强" : mechanism === "reroute" ? "贸易转移示意：部分生产经第三国制造枢纽到达最终消费国" : "替代性扩张示意：新增境外供应商接入跨境生产路径"}
        style={{ width: "min(720px, 94%)", margin: "10px auto 0" }}>
        <defs>
          <marker id={flowArrowId} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="16" markerHeight="16" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0 L10 5 L0 10 Z" fill="#7aa5e8" />
          </marker>
          <marker id={alternateArrowId} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="16" markerHeight="16" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0 L10 5 L0 10 Z" fill="#49c39b" />
          </marker>
        </defs>
        {/* 箭头表示供货方向，不是已经识别的政策因果效应。 */}
        <path data-flow="original" d="M118 95 C 190 40, 250 40, 292 88" fill="none" stroke="#7aa5e8"
          strokeWidth={10 * shrink} markerEnd={`url(#${flowArrowId})`} />
        <path data-flow="original" d="M348 88 C 400 40, 460 40, 522 95" fill="none" stroke="#7aa5e8"
          strokeWidth={9 * shrink} markerEnd={`url(#${flowArrowId})`} />
        {mechanism === "contract" ? (
          <g>
            <path data-flow="domestic" d="M310 122 C 262 183, 378 183, 330 122" fill="none" stroke="#49c39b"
              strokeWidth={4 + tau * 26} markerEnd={`url(#${alternateArrowId})`} />
            <text x={320} y={201} textAnchor="middle" fontSize={12.5} fill="#a8b6da">假设：国内替代增强</text>
          </g>
        ) : (
          <g>
            <path data-flow="alternate" d="M108 115 Q190 208 292 202" fill="none" stroke="#49c39b"
              strokeWidth={1 + tau * (mechanism === "reroute" ? 28 : 36)} strokeDasharray={tau === 0 ? "5 5" : undefined}
              markerEnd={`url(#${alternateArrowId})`} />
            <path data-flow="alternate" d="M348 202 Q450 208 532 115" fill="none" stroke="#49c39b"
              strokeWidth={1 + tau * (mechanism === "reroute" ? 28 : 36)} strokeDasharray={tau === 0 ? "5 5" : undefined}
              markerEnd={`url(#${alternateArrowId})`} />
            <circle cx={320} cy={202} r={26} fill="#49c39b" opacity={0.16} />
            <circle cx={320} cy={202} r={18} fill="#49c39b" stroke="#101528" strokeWidth={3} />
            <text x={320} y={238} textAnchor="middle" fontSize={13} fill="#eef1fb">{mechanism === "reroute" ? "第三国制造枢纽" : "新增境外供应商"}</text>
          </g>
        )}
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
        <label className="intro-slider-label" htmlFor={tariffSliderId}>假设加征税率</label>
        <input
          id={tariffSliderId}
          type="range" min={0} max={25} step={1} value={tau * 100}
          aria-valuetext={`假设加征税率 ${(tau * 100).toFixed(0)}%`}
          aria-describedby={mechanismHintId}
          onChange={(e) => setTau(Number(e.target.value) / 100)}
        />
        <span className="intro-tau">{(tau * 100).toFixed(0)}%</span>
      </div>
      <p className="intro-mechanism-feedback">{mechanismFeedback}</p>
      <p id={mechanismHintId} className="intro-slider-hint">箭头表示供货方向，虚线表示候选路径；线宽仅表示动画强弱，不代表可加总的贸易流量。本图不计算 GVC 份额，也不预测政策效果。</p>
      <p className="intro-note">这是机制示意，不是估计结果。真实分析需要比较多项指标，并如实报告不显著或无法推断的结果。</p>
      <details className="intro-details intro-method-details">
        <summary>查看指标口径与解释边界</summary>
        <p>后续回归分别检验课程 WWZ 口径（不含 FDC 与 TLS）的 FVA_share（非 OECD EXGR_FVASH）、复杂 GVC 生产份额、前向 GVC 生产长度（PLv_GVC），并探索全正边二值网络介数；四项不能只挑显著结果。</p>
      </details>
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
        当前身份：<b>{roleName}</b>。按实验台中的任务提示完成操作、记录材料并回答理解题，最后整合证据，形成原创分析。
      </p>
      {/* 进入前讲清完成规则，避免把浏览位置误认为学习进度。 */}
      <div className="intro-ready-rules">
        <div><b>理解进度</b><p>答对本步理解题后，步骤显示“✓”。浏览过步骤，不等于已经完成。</p></div>
        <div><b>报告材料</b><p>按页面提示记录分析结果；所需材料保存齐全后，显示“材料已齐全”。查看过结果，不等于已经保存报告材料。</p></div>
      </div>
      <div className="intro-cta-row">
        <button type="button" className="intro-cta" onClick={() => onDone()}>关闭介绍</button>
      </div>
      <p className="intro-note">关闭不会改变当前实验步骤，可随时从顶栏重新查看。</p>
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
      <div className="intro-footer">
        <div className="intro-page-label">介绍 {scene + 1} / {N_SCENES} · {SCENE_NAMES[scene]}</div>
        <div className="intro-nav" role="group" aria-label="选择介绍页面">
          <div className="intro-dots">
            {Array.from({ length: N_SCENES }, (_, i) => (
              <button
                key={i} aria-label={`介绍页 ${i + 1}`} title={SCENE_NAMES[i]}
                aria-current={i === scene ? "page" : undefined}
                className={`intro-dot${i === scene ? " on" : ""}`} onClick={() => setScene(i)}
              />
            ))}
          </div>
        </div>
        <div className="intro-keyhint">正文聚焦时 ← → 翻页 · Esc 关闭介绍</div>
      </div>
    </div>,
    document.body,
  );
}
