/**
 * 登录后的沉浸式系统介绍(5 幕,可跳过、可在顶栏重看):
 *   1 开场:闭环管线动画 + 真实规模计数(经济体/行业/年份)
 *   2 数据底座：两张可独立展开的数据卡（真实数据 / 教学设定）
 *   3 十五步旅程：五阶段可点击展开（内容来自 /api/steps 真实元数据）
 *   4 证据预演：两国五年趋势 → 模拟 X/Y → 四项结果
 *   5 就绪:说明当前身份与完成规则，关闭介绍后返回实验台
 * 覆盖范围与目录来自课程元数据；趋势图仅为界面示意，不生成估计数值。
 */
import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./a11y";
import { LogoMark } from "./brand";
import { icioDatasetName } from "./dataset-label";
import type { AuthUser, Meta, StepsResponse } from "./types";

const SCENE_NAMES = ["认识实验", "数据与设定", "实验路线", "分析示例", "完成规则"];
const N_SCENES = SCENE_NAMES.length;
const STAGE_OUTPUTS: Record<number, string> = {
  1: "认识投入产出表，读懂一格数据的含义。",
  2: "了解指标怎样由投入产出表算出，并拆解两国读数。",
  3: "看指标的历年变化和在全部经济体中的位置，再与对比国家比较，形成图表证据。",
  4: "认识模拟关税暴露 X，用全部样本对四个模拟 Y 运行回归。",
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const [scene, setScene] = useState(0);
  const [openCards, setOpenCards] = useState({ icio: false, shock: false });
  const [stage, setStage] = useState(1);
  useDialogFocus({
    containerRef: dialogRef,
    initialFocusRef: skipRef,
    returnFocusRef,
    onClose: () => onDone(),
  });

  useLayoutEffect(() => {
    // A scene can remove the focused next button. Announce the new heading
    // through focus without turning the whole dialog into a live region.
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
  const datasetName = icioDatasetName(meta);

  const stages = useMemo(() => {
    return Object.entries(stepsData.stages).map(([n, name]) => ({
      n: Number(n), name, steps: stepsData.steps.filter((s) => s.stage === Number(n)),
    }));
  }, [stepsData]);
  const selectedStage = stages.find((s) => s.n === stage) ?? stages[0];
  const previewYears = years.length >= 5 ? years.slice(0, 5).map(String) : ["第1年", "第2年", "第3年", "第4年", "第5年"];

  const roleName = user.role === "teacher" ? "教师" : "学生";

  const scenes = [
    /* ---- 1 开场 ---- */
    <div key={0} className="intro-scene">
      <div className="intro-logo"><LogoMark size={76} /></div>
      <h1 className="intro-title">供应链仿真系统</h1>
      <div className="intro-kicker">GVC SIMULATION LAB</div>
      <p className="intro-lede">
        从全球生产联系，理解价值链变化。利用投入产出数据计算指标，看它们的五年变化和全球位置，再用教学模拟练习读取回归，完成有依据的实验报告。
      </p>
      <p className="intro-boundary">{datasetName} · 教学情景 · 不作真实政策效果预测</p>
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

    /* ---- 2 数据来源 ---- */
    <div key={1} className="intro-scene">
      <div className="intro-scene-kicker">数据来源</div>
      <h2 className="intro-h2">数据来源与教学设定</h2>
      <p className="intro-lede">真实投入产出表用于讲解指标概念；回归练习中的关税 X 与结果 Y 均为教学模拟。</p>
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
              <span className="intro-card-title">{datasetName}</span>
              <span className="intro-card-sub">数据结构与覆盖范围</span>
            </span>
            <span className="intro-card-toggle" aria-hidden>{openCards.icio ? "−" : "+"}</span>
          </span>
          </button>
          <ul className="intro-card-facts">
            <li>描述经济体与行业间的供货联系。</li>
            <li>据此计算出口构成、生产分工、链条长度与网络位置。</li>
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
            aria-expanded={openCards.shock}
            aria-controls={shockPanelId}
            onClick={() => setOpenCards((cards) => ({ ...cards, shock: !cards.shock }))}
          >
          <span className="intro-card-head">
            <CardIcon kind="shock" />
            <span>
              <span className="intro-card-title">教学模拟关税</span>
              <span className="intro-card-sub">课程生成的模拟数据</span>
            </span>
            <span className="intro-card-toggle" aria-hidden>{openCards.shock ? "−" : "+"}</span>
          </span>
          </button>
          <ul className="intro-card-facts">
            <li>关税路径与暴露值全部由课程生成。</li>
            <li>X 由首年销往美国的出口份额和模拟税率算出。</li>
            <li>Y 也是模拟结果，仅用于练习读回归。</li>
          </ul>
          {openCards.shock && (
            <div className="intro-card-body" id={shockPanelId}>
              <p>前两年税率为 0，受影响国家后三年为 10%，其余国家为 0。暴露强度等于首年销往美国的出口份额乘以模拟税率。</p>
              <p><b>注意：</b>这里没有真实事件、现实税率或现实政策效果。模拟 Y 参考首年真实指标的排序生成，但不保留真实指标值。</p>
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
      {selectedStage && STAGE_OUTPUTS[selectedStage.n] && <p className="intro-stage-output"><b>本阶段任务：</b>{STAGE_OUTPUTS[selectedStage.n]}</p>}
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

    /* ---- 4 分析示例 ---- */
    <div key={3} className="intro-scene">
      <div className="intro-scene-kicker">分析示例</div>
      <h2 className="intro-h2">先看加税前后的差距，再用回归量化</h2>
      <p className="intro-lede">选一个例子跟着走：两个国家和一个行业（默认是加拿大与墨西哥的汽车行业）。正式回归使用完整国家×行业面板，不限于所选两国；结果会换算回你的例子。</p>
      <div className="intro-preview-selection" role="group" aria-label="分析对象示意">
        <span><small>国家 A</small>由你选择</span>
        <span><small>国家 B</small>由你选择</span>
        <span><small>行业</small>由你选择</span>
      </div>
      <div className="intro-evidence-preview">
        <div className="intro-trend-card">
          <div className="intro-preview-heading"><b>01 · 你的例子：X 只在加税后出现</b><span><i className="country-a" />国家 A（模拟加税） <i className="country-b" />国家 B（未加税）</span></div>
          <svg viewBox="0 0 520 180" role="img" aria-label="国家 A 与国家 B 的五年模拟关税暴露 X 趋势界面示意，线条不代表真实数值">
            <path className="grid" d="M42 30H500M42 75H500M42 120H500" />
            <path className="country-a" d="M50 120L160 120L270 40L380 40L490 40" />
            <path className="country-b" d="M50 120L160 120L270 120L380 120L490 120" />
            <text x="42" y="18">X 示意强弱</text>
            <text x="28" y="124">0</text>
            {[50, 160, 270, 380, 490].map((x, index) => (
              <g key={x}>
                <circle className="country-a" cx={x} cy={[120, 120, 40, 40, 40][index]} r="4" />
                <circle className="country-b" cx={x} cy={120} r="4" />
                <text x={x} y="158" textAnchor="middle">{previewYears[index]}</text>
              </g>
            ))}
          </svg>
        </div>
        <div className="intro-xy-card">
          <b>02 · 用回归把差距量化</b>
          <div className="intro-xy-item"><strong>X</strong><span><b>模拟关税暴露</b><small>解释变量：用于比较的变量</small></span></div>
          <div className="intro-xy-link" aria-hidden>↓ X 每增加 1 个百分点，Y 平均变化多少？</div>
          <div className="intro-xy-item"><strong>Y</strong><span><b>模拟指标结果</b><small>结果变量：要观察的变量</small></span></div>
        </div>
      </div>
      <div className="intro-four-results" role="group" aria-label="四项结果都要汇总">
        <b>03 · 四步各估一项，报告中汇总</b>
        <span>出口构成</span><span>复杂生产</span><span>链条长度</span><span>网络位置</span>
      </div>
      <p className="intro-note intro-preview-note">图示：国家 A 被模拟加税，前两年 X 为零、之后为正；国家 B 未加税，X 始终为零。线条不是实际读数。X 与 Y 均为教学模拟；关系不显著或无法推断也要如实报告，不能解释为真实政策效果。</p>
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
        当前身份：<b>{roleName}</b>。按实验台中的任务提示操作并回答理解题，报告材料由系统自动记录，最后由你完成原创分析。
      </p>
      {/* 进入前讲清完成规则，避免把浏览位置误认为学习进度。 */}
      <div className="intro-ready-rules">
        <div><b>理解进度</b><p>答对本步理解题后，步骤显示“✓”。浏览过步骤，不等于已经完成。</p></div>
        <div><b>报告材料</b><p>第 1–10 步打开页面即自动记录；第 11–14 步点“运行回归”后自动保存；第 15 步写三段分析。每步顶部显示材料是否齐全（同步成功后更新）。</p></div>
        <div><b>报告提交</b><p>生成草稿不等于提交。复核后提交给老师，确认“等待教师评阅”；完成进度不能代替提交状态。</p></div>
      </div>
      <div className="intro-cta-row">
        <button type="button" className="intro-cta" onClick={() => onDone()}>开始实验</button>
      </div>
      <p className="intro-note">进入实验台不会改变当前实验步骤，可随时从顶栏重新查看介绍。</p>
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
      </div>
    </div>,
    document.body,
  );
}
