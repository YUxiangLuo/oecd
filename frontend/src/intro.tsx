/** Display-only course orientation. All teaching content is visible without opening controls. */
import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./a11y";
import { LogoMark } from "./brand";
import { icioDatasetName } from "./dataset-label";
import { PRODUCT_SUMMARY } from "./product-copy";
import type { AuthUser, Meta, StepsResponse } from "./types";
import "./intro.css";

const SCENE_NAMES = ["认识实验", "数据与指标", "贸易政策情景", "分析方法", "实验流程与成果"];
const STAGE_OUTPUTS: Record<number, string> = {
  1: "读取中间投入、最终需求与账户数据。",
  2: "测算并解释四类全球价值链指标。",
  3: "比较国家、行业与年份差异，记录选定图表。",
  4: "完成默认模型估计，可进一步开展自主模型比较。",
  5: "汇总图表与模型结果，撰写分析并提交报告。",
};
const DIMENSIONS = [
  ["贸易", "出口的价值来源", "区分出口中的国内增加值、国外增加值及重复计算部分。"],
  ["生产", "跨境生产的分工方式", "区分国内生产、传统贸易，以及简单和复杂全球价值链生产活动。"],
  ["长度", "生产链条的长度与位置", "衡量生产过程的平均阶段数，比较前后向长度与价值链位置。"],
  ["网络", "经济体之间的生产联系", "识别主要贸易伙伴，比较经济体在生产网络中的位置。"],
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
      <div className="intro-cards">
        <article><span>研究对象</span><h3>跨国生产分工</h3><p>识别投入来源、产品去向与经济体之间的生产联系。</p></article>
        <article><span>分析内容</span><h3>结构差异与政策情景</h3><p>比较全球价值链指标，并在模拟贸易政策情景下开展分析。</p></article>
        <article><span>实验成果</span><h3>有证据支持的研究结论</h3><p>结合图表与模型结果，说明结论的依据、适用范围与研究局限。</p></article>
      </div>
      <div className="intro-coverage"><b>{datasetName}</b><span>{coverage}</span></div>
    </section>,
    <section key={1} className="intro-scene">
      <h2 id={titleId} className="intro-title">从投入产出联系到价值链指标</h2>
      <p className="intro-lede">一个行业的产出可以作为其他行业的投入，也可以用于消费、投资等最终用途。跨国投入产出表记录这些联系，为分析不同经济体与行业之间的生产分工提供依据。</p>
      <figure className="intro-production">
        <figcaption>投入产出联系示意 · 生产环节可分布于不同经济体</figcaption>
        <ol className="intro-flow">
          <li><h3>投入来源</h3><p>原材料、零部件与生产性服务</p></li>
          <li><h3>生产过程</h3><p>行业之间的加工与中间投入联系</p></li>
          <li><h3>最终使用</h3><p>居民消费、政府消费与投资等</p></li>
        </ol>
      </figure>
      <div className="intro-dimensions">{DIMENSIONS.map(([name, title, detail]) => <article key={name}><span>{name}</span><h3>{title}</h3><p>{detail}</p></article>)}</div>
      <div className="intro-dataset"><span className="intro-label">数据浏览与指标比较 · 步骤 1–9</span><h3>{datasetName}</h3><p>{coverage}</p></div>
    </section>,
    <section key={2} className="intro-scene">
      <h2 id={titleId} className="intro-title">贸易政策变化与价值链研究</h2>
      <p className="intro-lede">前述指标描述全球价值链的结构。进口关税是进口环节对商品征收的税收，其变化可能影响跨境采购与生产分工。实验进一步引入模拟加征关税的情景，考察贸易政策变化与这些指标的关系。</p>
      <div className="intro-scenario"><span className="intro-label">课程设定的政策情景</span><h3>美国对部分经济体加征进口关税</h3><p>各经济体与行业的对美出口占比不同，因此同一加征税率所涉及的贸易比重也不同。</p></div>
      <figure className="intro-policy-comparison">
        <figcaption>示意比较 · 两类出口行业面对相同的模拟加征税率</figcaption>
        <div className="intro-comparison">
          <article><span>对美出口占比较高</span><h3>涉及的出口比重较大</h3></article>
          <article><span>对美出口占比较低</span><h3>涉及的出口比重较小</h3></article>
        </div>
      </figure>
      <p className="intro-note">后续实验将对美出口占比与模拟加征税率结合，构造“关税暴露”指标，概括各经济体与行业面对该政策情景的程度。具体计算方法在步骤 10 中说明。</p>
      <p className="intro-data-note"><strong>教学模拟数据</strong>关税情景与回归使用的指标按课程设定生成；投入产出数据为贸易联系与指标量级提供参考。</p>
    </section>,
    <section key={3} className="intro-scene">
      <h2 id={titleId} className="intro-title">从图表比较到回归分析</h2>
      <p className="intro-lede">图表能够呈现指标的变化，但加税前后的差异还可能与汇率、经济规模等因素有关。回归分析在同时考虑多种因素的条件下，估计关税暴露与价值链指标之间的统计关联。</p>
      <ol className="intro-flow">
        <li><h3>图表观察</h3><p>比较不同经济体、行业与年份的指标走势，描述变化方向与幅度。</p></li>
        <li><h3>回归估计</h3><p>纳入汇率、经济规模和贸易开放度等因素，分析关税暴露与价值链指标的关系。</p></li>
        <li><h3>模型比较</h3><p>调整纳入的因素及其时间关系，考察结果对模型设定的敏感性。</p></li>
      </ol>
      <div className="intro-cards">
        <article><span>结果读数</span><h3>关联方向与变化幅度</h3><p>结合指标单位，解释模型估计的方向和量级。</p></article>
        <article><span>结果评估</span><h3>不确定性与样本范围</h3><p>关注估计区间与有效样本，避免仅凭单个数值作出判断。</p></article>
        <article><span>结论解释</span><h3>适用条件与研究局限</h3><p>说明结论依赖的数据与模型条件，并比较不同设定下的结果。</p></article>
      </div>
      <p className="intro-note">贸易、生产、长度与网络各设一个回归步骤。模型使用符合条件的完整国家 × 行业样本，所选案例用于辅助解释。教学模拟的估计结果不直接等同于现实关税政策的因果效应。</p>
    </section>,
    <section key={4} className="intro-scene">
      <h2 id={titleId} className="intro-title">实验流程与报告成果</h2>
      <p className="intro-lede">按照数据读取、指标测算、图表比较和模型分析的顺序完成实验。各阶段的记录汇集为实验报告，报告提交后由教师评阅。</p>
      {stages.length ? <ol className="intro-route">{stages.map(st => <li key={st.n}><h3>{st.name}</h3>{st.steps.length > 0 && <small>步骤 {st.steps[0].n}{st.steps.length > 1 ? `–${st.steps.at(-1)!.n}` : ""}</small>}<p>{STAGE_OUTPUTS[st.n]}</p></li>)}</ol> : <p role="status">当前课程暂无实验路线信息。</p>}
      <div className="intro-completion">
        <article><h3>理解与记录</h3><p>完成各步骤理解测验并达到通过要求。数据与指标步骤自动记录材料，图表比较步骤需记录选定图表。</p></article>
        <article><h3>分析与提交</h3><p>完成四项默认回归，撰写研究问题、结果解释、研究局限与后续方向。自主模型可选择记入报告。</p></article>
        <article><h3>评阅与留存</h3><p>教师评阅后可查看评分与评语，并导出 PDF 留存。草稿生成和 PDF 导出不替代正式提交。</p></article>
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
