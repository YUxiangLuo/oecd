/** Display-only course orientation. All teaching content is visible without opening controls. */
import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./a11y";
import { LogoMark } from "./brand";
import { icioDatasetName } from "./dataset-label";
import { PRODUCT_SUMMARY } from "./product-copy";
import type { AuthUser, Meta, StepsResponse } from "./types";
import "./intro.css";

const SCENE_NAMES = ["研究目标", "数据与指标", "关税暴露", "回归建模", "实验流程"];
const STAGE_OUTPUTS: Record<number, string> = {
  1: "识别中间投入、最终需求及跨国、跨行业投入产出关系。",
  2: "计算并解释贸易、生产、长度与网络指标。",
  3: "比较经济体与行业的指标差异，记录图表及观察范围。",
  4: "掌握关税暴露的构造方法，完成回归估计与模型比较。",
  5: "整理分析证据，说明研究结论与局限，提交实验报告。",
};
const DIMENSIONS = [
  ["贸易", "总出口价值分解", "将总出口分解为国内增加值、国外增加值与重复计算等组成部分。"],
  ["生产", "跨境生产分工", "区分国内生产、传统贸易以及简单和复杂全球价值链生产活动。"],
  ["长度", "生产长度与价值链位置", "比较前向、后向生产长度与全球价值链位置指数。"],
  ["网络", "生产网络结构", "刻画贸易伙伴、增加值联系与经济体的网络中心性。"],
];

export function IntroOverlay({ user, meta, stepsData, onDone, returnFocusRef }: {
  user: AuthUser;
  meta: Meta | null;
  stepsData: StepsResponse;
  onDone: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const [scene, setScene] = useState(0);
  useDialogFocus({ containerRef: dialogRef, initialFocusRef: skipRef, returnFocusRef, onClose: () => onDone() });
  useLayoutEffect(() => {
    const heading = dialogRef.current?.querySelector<HTMLElement>(".intro-scene h1, .intro-scene h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      contentRef.current?.scrollTo({ top: 0 });
    }
  }, [scene]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!(e.target instanceof Element) || !dialogRef.current?.contains(e.target)) return;
      if (e.target.closest("button, input, textarea, select, a, [contenteditable]:not([contenteditable='false'])")) return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        setScene(s => Math.max(0, Math.min(SCENE_NAMES.length - 1, s + (e.key === "ArrowRight" ? 1 : -1))));
      }
    };
    const dialog = dialogRef.current;
    dialog?.addEventListener("keydown", onKey);
    return () => dialog?.removeEventListener("keydown", onKey);
  }, []);

  const years = meta?.years ?? [];
  const yearSpan = years.length ? (years.length === 1 ? String(years[0]) : `${years[0]}–${years.at(-1)}`) : "年份待确认";
  const hasRestOfWorld = meta?.countries.includes("ROW") ?? false;
  const coverage = meta ? `${meta.countries.length - Number(hasRestOfWorld)} 个经济体${hasRestOfWorld ? " + 世界其他地区" : ""} · ${meta.sectors.length} 个行业 · ${yearSpan}` : "课程数据范围暂不可用。";
  const datasetName = icioDatasetName(meta);
  const stages = useMemo(() => Object.entries(stepsData.stages).map(([n, name]) => ({
    n: Number(n), name, steps: stepsData.steps.filter(s => s.stage === Number(n)),
  })), [stepsData]);

  const scenes = [
    <section key={0} className="intro-scene">
      <p className="intro-eyebrow">全球价值链与贸易政策实验</p>
      <h1 id={titleId} className="intro-title">供应链仿真系统</h1>
      <p className="intro-lede">{PRODUCT_SUMMARY}</p>
      <div className="intro-questions">
        <article><span>研究对象</span><h3>跨国生产联系</h3><p>依据投入产出关系，识别出口增加值来源与跨境生产分工。</p></article>
        <article><span>指标比较</span><h3>全球价值链结构</h3><p>比较经济体与行业在贸易构成、生产分工、链条长度和网络位置上的差异。</p></article>
        <article><span>模型分析</span><h3>关税暴露与指标关联</h3><p>估计关税暴露与各类指标的条件关联，分析结果对模型设定的敏感性。</p></article>
      </div>
      <div className="intro-coverage"><b>{datasetName}</b><span>{coverage}</span></div>
    </section>,
    <section key={1} className="intro-scene">
      <h2 id={titleId} className="intro-title">投入产出数据与全球价值链指标</h2>
      <p className="intro-lede">跨国投入产出表记录各经济体、各行业之间的中间投入，以及产品和服务的最终使用。相关指标用于描述全球价值链的构成、分工方式与结构变化。</p>
      <div className="intro-dimensions">{DIMENSIONS.map(([name, title, detail]) => <article key={name}><span>{name}</span><h3>{title}</h3><p>{detail}</p></article>)}</div>
      <div className="intro-sources">
        <article><span className="intro-label">指标测算 · 步骤 1–9</span><h3>{datasetName}</h3><p>根据投入产出数据计算四类指标，比较经济体、行业与年份间的差异。</p><small>{coverage}</small></article>
        <article><span className="intro-label">计量分析 · 步骤 10–14</span><h3>教学模拟数据</h3><p>模拟税率路径与被解释变量 Y 按课程设定生成。投入产出数据用于构造对美出口权重并校准模拟量级；多数控制变量为模拟数据，具体来源见建模页面。</p><small>用于模型设定、估计比较与经济含义分析；估计结果不代表现实关税政策的因果效应。</small></article>
      </div>
    </section>,
    <section key={2} className="intro-scene">
      <p className="intro-eyebrow">示意算例</p><h2 id={titleId} className="intro-title">关税暴露指标的构造与时间结构</h2>
      <p className="intro-lede">关税暴露 X 由首年对美出口份额 w 与当年模拟税率 τ 的乘积构造，即 X = w × τ。税率相同时，初始出口份额差异形成不同的关税暴露水平。</p>
      <div className="intro-equation" aria-label="假设首年对美出口份额为百分之二十，模拟关税税率为百分之二十五，关税暴露为五个百分点">
        <div><strong>20<span>%</span></strong><span>首年对美出口份额 w</span></div><b aria-hidden="true">×</b>
        <div><strong>25<span>%</span></strong><span>模拟关税税率 τ</span></div><b aria-hidden="true">=</b>
        <div className="intro-equation-result"><strong>5<span> 个百分点</span></strong><span>关税暴露 X</span></div>
      </div>
      <div className="intro-timing">
        <div><h3>当期变量与滞后变量</h3><p>当期 X 表示本年度关税暴露，滞后一期 L1_X 表示上一年度关税暴露。示意算例假定加税前税率为 0，加税后维持不变。</p></div>
        <table><caption>示意暴露路径 · 单位：百分点</caption><thead><tr><th scope="col">时间</th><th scope="col">当期 X</th><th scope="col">滞后一期 L1_X</th></tr></thead><tbody><tr><th scope="row">加税前</th><td>0</td><td>0</td></tr><tr><th scope="row">加税当年</th><td>5</td><td>0</td></tr><tr><th scope="row">加税次年</th><td>5</td><td>5</td></tr></tbody></table>
      </div>
      <p className="intro-note">示意数值用于说明指标构造与滞后关系。国家与行业选择仅用于案例展示；回归样本为符合条件的完整国家 × 行业面板。案例结果由估计系数与对应暴露差异换算。</p>
    </section>,
    <section key={3} className="intro-scene">
      <h2 id={titleId} className="intro-title">回归模型设定与估计结果比较</h2>
      <p className="intro-lede">贸易、生产、长度与网络分别对应四个回归步骤。以默认模型为基准，通过调整被解释变量、控制变量、固定效应和滞后结构，考察估计结果的差异。</p>
      <div className="intro-model-parts">
        <article><span>被解释变量 Y</span><h3>指标选择与计量单位</h3><p>从当前维度的可用指标中选择 Y，并核对其计量单位。</p></article>
        <article><span>控制变量</span><h3>协变量选择</h3><p>选择控制变量及其当期或滞后形式。</p></article>
        <article><span>固定效应</span><h3>异质性与共同冲击</h3><p>设定经济体、行业、年份及其组合的固定效应。</p></article>
        <article><span>解释变量 X</span><h3>分布滞后结构</h3><p>选择当期、滞后一期或滞后二期暴露项及其组合。</p></article>
      </div>
      <div className="intro-sources">
        <article><span className="intro-label">默认模型</span><h3>双向固定效应基准模型</h3><p>纳入当期 X 与滞后一期 L1_X，控制汇率变动、GDP 对数和贸易开放度，并加入国家 × 行业固定效应与年份固定效应。</p></article>
        <article><span className="intro-label">结果解释</span><h3>点估计、区间估计与有效样本</h3><p>结合系数方向与量级、95% 置信区间和有效样本量解释结果。置信区间包含 0 或无法可靠推断的情形应一并报告。</p></article>
      </div>
      <p className="intro-note">四项默认模型结果自动纳入报告。自主模型须通过“记入报告”操作纳入，每个回归步骤限一项。模型比较需区分 Y 的计量单位、X 的时间跨度与有效样本。</p>
    </section>,
    <section key={4} className="intro-scene">
      <h2 id={titleId} className="intro-title">实验流程与报告要求</h2>
      <p className="intro-lede">实验依次完成数据读取、指标测算、图表比较与回归建模，并在报告中阐述研究问题、实验证据、研究局限与后续方向。</p>
      {stages.length ? <ol className="intro-route">{stages.map(st => <li key={st.n}><h3>{st.name}</h3>{st.steps.length > 0 && <small>步骤 {st.steps[0].n}{st.steps.length > 1 ? `–${st.steps.at(-1)!.n}` : ""}</small>}<p>{STAGE_OUTPUTS[st.n]}</p></li>)}</ol> : <p role="status">当前课程暂无实验路线信息。</p>}
      <div className="intro-completion">
        <article><h3>理解测验</h3><p>完成各步骤理解测验并达到通过要求。</p></article>
        <article><h3>实验材料</h3><p>步骤 1–5 与 10 自动记录材料；步骤 6–9 需记录图表；步骤 11–14 需完成默认模型估计。</p></article>
        <article><h3>分析与提交</h3><p>步骤 15 撰写三项分析并提交报告，由教师评阅。草稿生成和 PDF 导出不替代正式提交。</p></article>
      </div>
      <p className="intro-note">当前账号：{user.name || user.username}（{user.role === "teacher" ? "教师" : "学生"}）。关闭导览后返回当前实验步骤；可通过顶部“系统介绍”再次查看。</p>
    </section>,
  ];
  return createPortal(<div ref={dialogRef} className="intro-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <header className="intro-header"><div className="intro-brand"><LogoMark size={32} /><span>供应链仿真系统</span></div><span className="intro-header-label">实验导览</span><button ref={skipRef} type="button" className="intro-skip" aria-label="跳过介绍" onClick={() => onDone()}>跳过介绍 <span aria-hidden="true">×</span></button></header>
    <div ref={contentRef} className="intro-content">{scenes[scene]}</div>
    <footer className="intro-footer">
      <button type="button" className="intro-nav" disabled={scene === 0} onClick={() => setScene(s => s - 1)}>← 上一页</button>
      <div className="intro-progress"><span>介绍 {scene + 1} / {SCENE_NAMES.length} · {SCENE_NAMES[scene]}</span><div aria-hidden="true">{SCENE_NAMES.map((name, i) => <i key={name} className={i === scene ? "on" : ""} />)}</div></div>
      {scene === SCENE_NAMES.length - 1 ? <button type="button" className="intro-cta" onClick={() => onDone()}>进入实验 →</button> : <button type="button" className="intro-cta" onClick={() => setScene(s => s + 1)}>下一页 →</button>}
    </footer>
  </div>, document.body);
}
