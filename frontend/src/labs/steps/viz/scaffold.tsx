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
import { CAT } from "../../../viz/shared";

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
  /** Additive provenance fields; legacy report readers still use the fields above. */
  metric?: string;
  release?: string;
  scope?: ObservationScope;
  generation?: number;
  request_key?: string;
  source?: "explicit-heat-row";
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
  chart?: string;
  compared?: string[];
  year?: number;
  drill?: string;
  metric?: string;
  heat_sort?: string;
  heat_coverage?: string;
  observations?: VizObservation[];
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

/** One request-bound country query shared by steps 7–9. */
export function useCountryIndicatorRows(meta: Meta, year: number) {
  const evidenceKey = observationRequestKey(meta, year, "country");
  const requestKey = evidenceKey ?? `missing-release:${year}:country`;
  const query = useAsync<Row[]>(() => api.countryIndicators(year), [year], { requestKey });
  const identity = observationRequestIdentity(meta, year, "country", query.generation);
  const response = query.data !== null && identity !== null
    ? { identity, rows: query.data } satisfies BoundRows
    : null;
  return { ...query, rows: query.data ?? [], identity, response };
}

export function countryObservationPatch(
  response: BoundRows | null,
  expected: ObservationRequestIdentity | null,
  picked: readonly string[],
  metric: string,
): Pick<VizStepState, "metric" | "observations"> {
  if (!response || !sameObservationIdentity(response.identity, expected) || picked.length < 1) {
    return { metric, observations: [] };
  }
  const observations = picked.map((country): VizObservation | null => {
    const row = response.rows.find((item) => String(item.country) === country);
    const value = row?.[metric];
    return typeof value === "number" && Number.isFinite(value)
      ? {
          entity: country,
          country,
          year: response.identity.year,
          value,
          metric,
          release: response.identity.release,
          scope: response.identity.scope,
          generation: response.identity.generation,
          request_key: response.identity.requestKey,
        }
      : null;
  }).filter((item): item is VizObservation => item !== null);
  return { metric, observations };
}

/** Capture values only from the response accepted for the current request identity. */
export function useCountryObservations(
  response: BoundRows | null,
  expected: ObservationRequestIdentity | null,
  picked: string[],
  metric: string,
  state: StepStateApi<VizStepState>,
) {
  useEffect(() => {
    const patch = countryObservationPatch(response, expected, picked, metric);
    if (JSON.stringify(patch.observations) === JSON.stringify(state.data?.observations)
      && state.data?.metric === metric) return;
    state.save(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response, expected, picked, metric]);
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
  note?: ReactNode;  // 口径 / 提醒(小字)
  children: ReactNode;
}) {
  const guide: [string, ReactNode, string][] = [
    ["看什么", what, CAT[0]],
    ["怎么读", read, CAT[1]],
    ...(find ? ([["试着观察", find, CAT[2]]] as [string, ReactNode, string][]) : []),
  ];
  return (
    <section style={{ marginBottom: 18 }}>
      <div style={{ marginBottom: 9 }}>
        {eyebrow && <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".06em", color: "#5f6677", textTransform: "uppercase" }}>{eyebrow}</div>}
        <h3 style={{ fontSize: 15, fontWeight: 700, color: "#1b1f2b", margin: "2px 0 0" }}>{title}</h3>
      </div>
      <div style={{ display: "grid", gap: 6, marginBottom: 11, maxWidth: PROSE_MAX }}>
        {guide.map(([label, body, color]) => (
          <div key={label} style={{ display: "flex", gap: 9, fontSize: 12.3, lineHeight: 1.65 }}>
            <span style={{
              flexShrink: 0, alignSelf: "flex-start", fontSize: 10.5, fontWeight: 700,
              color: color === CAT[0] ? "#fff" : "#1b1f2b",
              background: color, borderRadius: 5, padding: "2px 7px",
            }}>{label}</span>
            <span style={{ color: "#4a5061" }}>{body}</span>
          </div>
        ))}
      </div>
      {children}
      {note && <p style={{ fontSize: 11, color: "#5f6677", margin: "9px 2px 0", lineHeight: 1.6, maxWidth: PROSE_MAX }}>{note}</p>}
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
  return (
    <div
      role="group"
      aria-label="图表视角"
      style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}
    >
      {lenses.map((l) => {
        const on = l.key === active;
        return (
          <button
            key={l.key}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(l.key)}
            title={l.hint}
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
    if (next !== year) invalidateVizObservations(state);
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
