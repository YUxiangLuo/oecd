/**
 * 步骤 6–9 可视化的**共享底座**(仅底层,不是页面级组件)。
 *
 * 四个可视化页此前共用同一个 VizLab、只换默认指标,导致高度雷同、教学稀薄、
 * 图表用途不明。改造后每个主题是独立的展示组件(trade/production/length/network),各自决定布局、
 * 主图与讲解;这里只沉淀真正该复用的三样东西:
 *   1) ChartStory —— 每张图自带「看什么 / 怎么读 / 该发现」读图脚手架;
 *   2) LensNav —— 「本步专属」的视角切换(非通用 7 标签);
 *   3) useVizLab —— 年份 / 选国家 / 数据拉取 + 自动实验快照({chart, compared})。
 * 只在真实交互后写入，页面默认视图不冒充学生探索。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LabeledControl, ScrollableRegion } from "../../../a11y";
import { api } from "../../../api";
import { FullscreenPanel } from "../../../fullscreen-panel";
import type { IndicatorSchema, Meta, QuizCompletionState, Step, StepStateApi } from "../../../types";
import { useAsync } from "../../shared";
import { CountryPicker } from "../../country-picker";
import type { IndicatorSelection } from "./indicator-model";

export type Row = Record<string, string | number | null>;
export const num = (v: string | number | null | undefined): number => (typeof v === "number" ? v : 0);
const isFin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** 占比/长度等对“实际不出口的行业”为 null 的指标:排序/散点前先剔除,避免幽灵点。 */
export const finiteBy = (rows: Row[], ...keys: string[]) => rows.filter((r) => keys.every((k) => isFin(r[k])));

/** 讲解性正文的最大阅读行宽(px):容器与图表/表格仍全宽,只有正文不跟着拉长,保证可读。 */
const PROSE_MAX = 820;

export type ObservationScope = "country" | "country-industry";

export interface VizObservation {
  entity: string;
  country: string;
  industry?: string;
  year: number;
  value: number;
  /** Indicator and request provenance for explicitly saved readings. */
  metric?: string;
  unit?: string;
  release?: string;
  scope?: ObservationScope;
  generation?: number;
  request_key?: string;
  source?: "explicit-network-trend" | "explicit-network-ranking" | "explicit-indicator-trend" | "explicit-indicator-comparison" | "explicit-indicator-composition";
}

export interface ObservationRequestIdentity {
  release: string;
  year: number;
  scope: ObservationScope;
  country?: string;
  generation: number;
  requestKey: string;
}

export interface BoundRows {
  identity: ObservationRequestIdentity;
  rows: Row[];
}

export interface VizStepState extends QuizCompletionState, Record<string, unknown> {
  indicator_selection?: IndicatorSelection;
  chart?: string;
  compared?: string[];
  year?: number;
  drill?: string;
  metric?: string;
  heat_sort?: string;
  heat_coverage?: string;
  observations?: VizObservation[];
  /** The student recorded this material explicitly after submitting the report (automatic saves clear it). */
  material_chosen?: boolean;
}

interface RestoredVizState {
  year: number;
  lens: string;
  picked: string[];
}

/** Never persist a year the current release does not contain (NaN / 0 / stale). */
export function persistableVizYear(years: readonly number[], year: number): number {
  return years.includes(year) ? year : years.at(-1)!;
}

export function addInspectedCountry(picked: string[], country: string, allowed: readonly string[]): string[] {
  if (!allowed.includes(country) || picked.includes(country)) return picked;
  return [...picked, country];
}

const RELEASE_ID = /^[0-9a-f]{32}$/;

export function currentReleaseId(meta: Pick<Meta, "dataset">): string | null {
  const release = meta.dataset?.release_id;
  return typeof release === "string" && RELEASE_ID.test(release) ? release : null;
}

export function observationRequestKey(
  meta: Pick<Meta, "dataset">,
  year: number,
  scope: ObservationScope,
  country?: string,
): string | null {
  const release = currentReleaseId(meta);
  if (!release) return null;
  return [release, String(year), scope, country ?? ""].join(":");
}

export function observationRequestIdentity(
  meta: Pick<Meta, "dataset">,
  year: number,
  scope: ObservationScope,
  generation: number,
  country?: string,
): ObservationRequestIdentity | null {
  const release = currentReleaseId(meta);
  const requestKey = observationRequestKey(meta, year, scope, country);
  return release && requestKey
    ? { release, year, scope, ...(country ? { country } : {}), generation, requestKey }
    : null;
}

export function sameObservationIdentity(
  first: ObservationRequestIdentity | null,
  second: ObservationRequestIdentity | null,
): boolean {
  return first !== null && second !== null
    && first.release === second.release
    && first.year === second.year
    && first.scope === second.scope
    && first.country === second.country
    && first.generation === second.generation
    && first.requestKey === second.requestKey;
}

/** Pure restoration policy, shared by initial render, async hydration and tests. */
export function restoreVizState(
  meta: Pick<Meta, "years" | "countries">,
  saved: VizStepState | undefined,
  defaultLens: string,
  validLenses: readonly string[],
): RestoredVizState {
  return {
    year: persistableVizYear(meta.years, typeof saved?.year === "number" ? saved.year : Number.NaN),
    lens: saved?.chart && validLenses.includes(saved.chart) ? saved.chart : defaultLens,
    picked: Array.isArray(saved?.compared)
      ? saved.compared.filter((code) => meta.countries.includes(code))
      : [],
  };
}

export function invalidateVizObservations(state: StepStateApi<VizStepState>) {
  state.save({ observations: [] });
}

function sameCountries(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((country, index) => country === second[index]);
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
  note?: ReactNode;  // 计算范围 / 提醒(小字)
  children: ReactNode;
}) {
  // Only "what" stays above the chart; how to read, what to try and the caveat fold into one disclosure.
  const guide: [string, ReactNode][] = [
    ["怎么读", read],
    ...(find ? ([["试着观察", find]] as [string, ReactNode][]) : []),
    ...(note ? ([["注意", note]] as [string, ReactNode][]) : []),
  ];
  return (
    <section style={{ marginBottom: 18 }}>
      <div style={{ marginBottom: 9 }}>
        {eyebrow && <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".06em", color: "#5f6677", textTransform: "uppercase" }}>{eyebrow}</div>}
        <h3 style={{ fontSize: 15, fontWeight: 700, color: "#1b1f2b", margin: "2px 0 0" }}>{title}</h3>
        <p style={{ fontSize: 12.3, lineHeight: 1.65, color: "#4a5061", margin: "4px 0 0", maxWidth: PROSE_MAX }}>{what}</p>
      </div>
      <details className="chart-story-guide" style={{ marginBottom: 11, maxWidth: PROSE_MAX }}>
        <summary>怎么读这张图</summary>
        <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
          {guide.map(([label, body]) => (
            <div key={label} style={{ display: "flex", gap: 9, fontSize: 12.3, lineHeight: 1.65 }}>
              <b style={{ flexShrink: 0, color: "#1b1f2b", fontSize: 11.5 }}>{label}</b>
              <span style={{ color: "#4a5061" }}>{body}</span>
            </div>
          ))}
        </div>
      </details>
      {children}
    </section>
  );
}

/* --------------------- 本步专属的视角切换(非通用 7 标签) --------------------- */

/** 每步只保留讲得清本步故事的少数镜头；选择会自动保存。 */
export function LensNav<K extends string>({ lenses, active, onPick }: {
  lenses: { key: K; label: string; hint?: string }[];
  active: K;
  onPick: (key: K) => void;
}) {
  // A segmented control (.lens-nav in workbench.css), the larger sibling of the mode switches under it.
  return (
    <div role="group" aria-label="图表视角" className="lens-nav">
      {lenses.map((l) => (
        <button key={l.key} type="button" aria-pressed={l.key === active} onClick={() => onPick(l.key)} title={l.hint}>
          {l.label}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------- 数据 + 实验快照 ----------------------------- */

/** 四步共用的数据底座：年份、选国家、schema，以及 {chart, compared} 快照写入。
 * compared 只记录学生主动选出的对象，Top-N 默认展示不算学生探索。 */
export function useVizLab(
  meta: Meta,
  _step: Step,
  state: StepStateApi<VizStepState>,
  defaultLens: string,
  validLenses: readonly string[],
) {
  const restored = restoreVizState(meta, state.data, defaultLens, validLenses);
  const [year, setYearState] = useState(restored.year);
  const [lens, setLens] = useState(restored.lens);
  const [picked, setPicked] = useState<string[]>(restored.picked);
  const [interacted, setInteracted] = useState(false);
  const hydrated = useRef(Boolean(state.data));
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);

  // Session data arrives asynchronously after the page mounts. Hydrate once,
  // unless the student already interacted while it was loading.
  useEffect(() => {
    if (hydrated.current || interacted || !state.data) return;
    const next = restoreVizState(meta, state.data, defaultLens, validLenses);
    setYearState(next.year);
    setLens(next.lens);
    setPicked(next.picked);
    hydrated.current = true;
  }, [state.data, interacted, meta.countries, meta.years, validLenses]);

  // 只有学生真正交互过（切镜头 / 选国家）才写入实验快照。
  useEffect(() => {
    if (!interacted) return;
    state.save({ chart: lens, compared: picked, year: persistableVizYear(meta.years, year) });
    // state 每次渲染都是新对象,不入依赖(与旧 VizLab 相同做法)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interacted, lens, picked, year]);

  const pickLens = (l: string) => { setLens(l); setInteracted(true); };
  const pickCountries = (c: string[]) => {
    if (!sameCountries(picked, c)) invalidateVizObservations(state);
    setPicked(c);
    setInteracted(true);
  };
  const setYear = (next: number) => {
    if (!meta.years.includes(next)) return;
    // Step 9's report material is an explicit snapshot, independent of browsing.
    if (next !== year && _step.n !== 9) invalidateVizObservations(state);
    setYearState(next);
    setInteracted(true);
  };
  return { year, setYear, lens, pickLens, picked, pickCountries, schema };
}

/** 年份下拉(四步共用的唯一通用控件)。 */
/**
 * 可视化工作台:左边「年份 + 选国家」,右边图表,两栏等高并排。
 *
 * 原先年份/选国家整宽铺在最上方,中间还隔着镜头切换,学生要在页面上下来回滚动才能
 * 把"选了谁"和"图上是谁"对上。这里把二者并到同一行:选择器列表 flex:1 内部滚动,
 * 高度由右侧图表决定,所以永远与图表齐平;选完即可在旁边直接看到结果。
 */
export function VizWorkbench({ title, toolbar, years, year, onYearChange, countries, picked, onPick, minPicks = 2, children }: {
  title: string;
  toolbar: ReactNode;
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
    <FullscreenPanel title={title} variant="workbench">
      {toolbar}
      <div className="viz-split">
        <aside className="viz-split-side" aria-label="年份与经济体选择">
          <div className="viz-side-head">
            <YearSelect years={years} year={year} onChange={onYearChange} />
            <span className="viz-side-count">
              已选 <b className={enough ? "ok" : "todo"}>{picked.length}</b> 国{enough ? "" : `（报告材料需 ≥${minPicks}）`}
            </span>
          </div>
          <CountryPicker countries={countries} picked={picked} onChange={onPick} />
        </aside>
        <ScrollableRegion className="viz-split-main" label="可视化图表与说明，可纵向滚动">
          {children}
        </ScrollableRegion>
      </div>
    </FullscreenPanel>
  );
}

export function YearSelect({ years, year, onChange }: { years: number[]; year: number; onChange: (y: number) => void }) {
  return (
    <span className="field">
      <LabeledControl label="年份">
        {(id) => (
          <select id={id} value={year} onChange={(e) => onChange(Number(e.target.value))}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        )}
      </LabeledControl>
    </span>
  );
}

/** Steps 6–9: one muted line under any chart that reads 2020; the report carries the full caveat. */
export const YEAR_2020_NOTE = "2020 年为现价且受疫情期外推影响，跨年比较请谨慎。";
export function Year2020Note() {
  return <p className="muted viz-year-note">{YEAR_2020_NOTE}</p>;
}
