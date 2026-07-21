/**
 * 步骤 7–10 可视化的**共享底座**(仅底层,不是页面级组件)。
 *
 * 四个可视化页此前共用同一个 VizLab、只换默认指标,导致高度雷同、教学稀薄、
 * 图表用途不明。改造后每步是独立的展示组件(step8/9/10/11.tsx),各自决定布局、
 * 主图与讲解;这里只沉淀真正该复用的三样东西:
 *   1) ChartStory —— 每张图自带「看什么 / 怎么读 / 该发现」读图脚手架;
 *   2) StepIntro / LensNav —— 常驻教学引导与「本步专属」的视角切换(非通用 7 标签);
 *   3) useVizLab —— 年份 / 选国家 / 数据拉取 + 学习证据({chart, compared})。
 * 证据语义与旧实现一致(gvcsim/evidence.py::_check_viz:chart 非空 + compared≥2),
 * 只在真实交互后写入,页面默认视图不计入。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../../api";
import type { IndicatorSchema, Meta, QuizStepEvidence, Step, StepEvidenceApi } from "../../../types";
import { useAsync } from "../../shared";
import { CountryPicker } from "../../country-picker";
import { CAT, cardStyle } from "../../../viz/shared";

export type Row = Record<string, string | number | null>;
export const num = (v: string | number | null | undefined): number => (typeof v === "number" ? v : 0);
export const isFin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** 占比/长度等对“实际不出口的行业”为 null 的指标:排序/散点前先剔除,避免幽灵点。 */
export const finiteBy = (rows: Row[], ...keys: string[]) => rows.filter((r) => keys.every((k) => isFin(r[k])));

/** 讲解性正文的最大阅读行宽(px):容器与图表/表格仍全宽,只有正文不跟着拉长,保证可读。 */
export const PROSE_MAX = 820;

export interface VizEvidence extends QuizStepEvidence, Record<string, unknown> {
  chart?: string;
  compared?: string[];
  year?: number;
  drill?: string;
  metric?: string;
  observations?: { entity: string; country: string; industry?: string; year: number; value: number }[];
}

export interface RestoredVizState {
  year: number;
  lens: string;
  picked: string[];
}

/** Pure restoration policy, shared by initial render, async hydration and tests. */
export function restoreVizState(
  meta: Pick<Meta, "years" | "countries">,
  saved: VizEvidence | undefined,
  defaultLens: string,
  validLenses: readonly string[],
): RestoredVizState {
  return {
    year: saved?.year != null && meta.years.includes(saved.year) ? saved.year : meta.years.at(-1)!,
    lens: saved?.chart && validLenses.includes(saved.chart) ? saved.chart : defaultLens,
    picked: Array.isArray(saved?.compared)
      ? saved.compared.filter((code) => meta.countries.includes(code))
      : [],
  };
}

/** Capture the exact country-level values behind the current comparison. */
export function useCountryObservations(
  rows: Row[],
  picked: string[],
  year: number,
  metric: string,
  evidence: StepEvidenceApi<VizEvidence>,
) {
  useEffect(() => {
    if (picked.length < 1 || rows.length < 1) return;
    const observations = picked.map((country) => {
      const row = rows.find((item) => String(item.country) === country);
      const value = row?.[metric];
      return typeof value === "number" && Number.isFinite(value)
        ? { entity: country, country, year, value }
        : null;
    }).filter((item): item is { entity: string; country: string; year: number; value: number } => item != null);
    if (JSON.stringify(observations) === JSON.stringify(evidence.data?.observations)
      && evidence.data?.metric === metric) return;
    evidence.save({ metric, observations, evidence_id: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, picked, year, metric]);
}

/* --------------------------- 常驻教学引导(不折叠) --------------------------- */

/** 每步顶部的教学卡:一句主旨 + concept 段落 + “这一步你要做的事”。
 *  取代旧设计里默认折叠、首屏看不到的「讲解」卡。 */
export function StepIntro({ kicker, lead, concept, todo }: {
  kicker: string;
  lead: string;
  concept: string;
  todo: ReactNode[];
}) {
  return (
    <section style={{ ...cardStyle, borderLeft: `4px solid ${CAT[0]}`, marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".08em", color: CAT[0], textTransform: "uppercase" }}>
        {kicker}
      </div>
      <div style={{ fontSize: 15.5, fontWeight: 700, color: "#1b1f2b", margin: "5px 0 8px", maxWidth: PROSE_MAX }}>{lead}</div>
      <p style={{ fontSize: 12.8, lineHeight: 1.85, color: "#4a5061", margin: 0, maxWidth: PROSE_MAX }}>{concept}</p>
      <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
        {todo.map((item, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "baseline", gap: 6, fontSize: 12, color: "#3a4050",
            background: "#f5f7fc", borderRadius: 8, padding: "6px 11px",
          }}>
            <span style={{ fontWeight: 700, color: CAT[0] }}>{i + 1}</span>
            <span>{item}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ----------------------- 读图脚手架:每张图都自带讲解 ----------------------- */

/** 图卡:标题 + 「看什么 / 怎么读 / 该发现」三句引导 + 图本体。
 *  这是解决“图表多但不知道在干什么”的核心——引导先行,再看图。 */
export function ChartStory({ eyebrow, title, what, read, find, note, children }: {
  eyebrow?: string;
  title: string;
  what: ReactNode;   // 这张图在展示什么(轴 / 颜色 / 分段的含义)
  read: ReactNode;   // 怎么读(位置 / 方向代表什么)
  find?: ReactNode;  // 该发现什么(真实数据里的看点)
  note?: ReactNode;  // 口径 / 提醒(小字)
  children: ReactNode;
}) {
  const guide: [string, ReactNode, string][] = [
    ["看什么", what, CAT[0]],
    ["怎么读", read, CAT[1]],
    ...(find ? ([["该发现", find, CAT[2]]] as [string, ReactNode, string][]) : []),
  ];
  return (
    <section style={{ marginBottom: 18 }}>
      <div style={{ marginBottom: 9 }}>
        {eyebrow && <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".06em", color: "#9aa0ae", textTransform: "uppercase" }}>{eyebrow}</div>}
        <h3 style={{ fontSize: 15, fontWeight: 700, color: "#1b1f2b", margin: "2px 0 0" }}>{title}</h3>
      </div>
      <div style={{ display: "grid", gap: 6, marginBottom: 11, maxWidth: PROSE_MAX }}>
        {guide.map(([label, body, color]) => (
          <div key={label} style={{ display: "flex", gap: 9, fontSize: 12.3, lineHeight: 1.65 }}>
            <span style={{
              flexShrink: 0, alignSelf: "flex-start", fontSize: 10.5, fontWeight: 700, color: "#fff",
              background: color, borderRadius: 5, padding: "2px 7px",
            }}>{label}</span>
            <span style={{ color: "#4a5061" }}>{body}</span>
          </div>
        ))}
      </div>
      {children}
      {note && <p style={{ fontSize: 11, color: "#a2a8b6", margin: "9px 2px 0", lineHeight: 1.6, maxWidth: PROSE_MAX }}>{note}</p>}
    </section>
  );
}

/* --------------------- 本步专属的视角切换(非通用 7 标签) --------------------- */

/** 每步只保留讲得清本步故事的少数镜头;选中即记为 chart 证据。 */
export function LensNav<K extends string>({ lenses, active, onPick }: {
  lenses: { key: K; label: string; hint?: string }[];
  active: K;
  onPick: (key: K) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
      {lenses.map((l) => {
        const on = l.key === active;
        return (
          <button key={l.key} onClick={() => onPick(l.key)} title={l.hint}
            style={{
              border: on ? `1.5px solid ${CAT[0]}` : "1.5px solid #e2e5ee", background: on ? "#eef4fe" : "#fff",
              color: on ? CAT[0] : "#5a6070", borderRadius: 9, padding: "7px 14px", cursor: "pointer",
              fontSize: 12.5, fontWeight: on ? 700 : 500, transition: "all .12s",
            }}>
            {l.label}
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------- 数据 + 学习证据 ----------------------------- */

/** 四步共用的数据/证据底座:年份、选国家、schema,以及 {chart, compared} 证据写入。
 *  compared = 学生**主动选出**的对比对象(Top-N 自动选出的不算学生的比较决定)。 */
export function useVizLab(
  meta: Meta,
  _step: Step,
  evidence: StepEvidenceApi<VizEvidence>,
  defaultLens: string,
  validLenses: readonly string[],
) {
  const restored = restoreVizState(meta, evidence.data, defaultLens, validLenses);
  const [year, setYearState] = useState(restored.year);
  const [lens, setLens] = useState(restored.lens);
  const [picked, setPicked] = useState<string[]>(restored.picked);
  const [interacted, setInteracted] = useState(false);
  const hydrated = useRef(Boolean(evidence.data));
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);

  // Session data arrives asynchronously after the page mounts. Hydrate once,
  // unless the student already interacted while it was loading.
  useEffect(() => {
    if (hydrated.current || interacted || !evidence.data) return;
    const next = restoreVizState(meta, evidence.data, defaultLens, validLenses);
    setYearState(next.year);
    setLens(next.lens);
    setPicked(next.picked);
    hydrated.current = true;
  }, [evidence.data, interacted, meta.countries, meta.years, validLenses]);

  // 只有学生真正动过(切镜头 / 选国家)才写证据;页面默认视图不计入(与旧实现一致)。
  useEffect(() => {
    if (!interacted) return;
    evidence.save({ chart: lens, compared: picked, year, evidence_id: "" });
    // evidence 每次渲染都是新对象,不入依赖(与旧 VizLab 相同做法)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interacted, lens, picked, year]);

  const pickLens = (l: string) => { setLens(l); setInteracted(true); };
  const pickCountries = (c: string[]) => { setPicked(c); setInteracted(true); };
  const setYear = (next: number) => { setYearState(next); setInteracted(true); };
  return { year, setYear, lens, pickLens, picked, pickCountries, schema, markInteracted: () => setInteracted(true) };
}

/** 年份下拉(四步共用的唯一通用控件)。 */
/**
 * 可视化工作台:左边「年份 + 选国家」,右边图表,两栏等高并排。
 *
 * 原先年份/选国家整宽铺在最上方,中间还隔着镜头切换,学生要在页面上下来回滚动才能
 * 把"选了谁"和"图上是谁"对上。这里把二者并到同一行:选择器列表 flex:1 内部滚动,
 * 高度由右侧图表决定,所以永远与图表齐平;选完即可在旁边直接看到结果。
 */
export function VizWorkbench({ years, year, onYearChange, countries, picked, onPick, minPicks = 2, children }: {
  years: number[];
  year: number;
  onYearChange: (y: number) => void;
  countries: string[];
  picked: string[];
  onPick: (picked: string[]) => void;
  minPicks?: number;
  children: React.ReactNode;
}) {
  const enough = picked.length >= minPicks;
  return (
    <div className="viz-split">
      <aside className="viz-split-side" aria-label="年份与经济体选择">
        <div className="viz-side-head">
          <YearSelect years={years} year={year} onChange={onYearChange} />
          <span className="viz-side-count">
            已选 <b className={enough ? "ok" : "todo"}>{picked.length}</b> 国{enough ? "" : `(需 ≥${minPicks})`}
          </span>
        </div>
        <CountryPicker countries={countries} picked={picked} onChange={onPick} />
      </aside>
      <div className="viz-split-main">{children}</div>
    </div>
  );
}

export function YearSelect({ years, year, onChange }: { years: number[]; year: number; onChange: (y: number) => void }) {
  return (
    <span className="field">
      <label>年份</label>
      <select value={year} onChange={(e) => onChange(Number(e.target.value))}>
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
    </span>
  );
}
