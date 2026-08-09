/**
 * 步骤 10 · 网络可视化 —— 故事:「谁是全球生产的枢纽?」
 *
 * 网络专属镜头(与前三步完全不同的图元):
 *   贸易网络图  国家间双边贸易流的有向网络,悬停看某国的伙伴与区域集群
 *   枢纽热力表  选一国,看它各行业节点在**完整全球国家×行业图**上的中心性(热力)
 *
 * 口径:国家级贸易图是完全图 → 无权中心性(度 / 介数 …)恒为常数、无区分度,
 * 因此枢纽识别只在国家–行业级做(见 country_degenerate 处理与回归 network 粒度)。
 * 对比对象 = 学生下钻看过的国家(≥2)。
 */
import { useEffect, useRef, useState } from "react";
import { LabeledControl } from "../../../a11y";
import { api } from "../../../api";
import type { IndustryPage, Meta, NetworkData, Step, StepStateApi } from "../../../types";
import { HeatTableViz, NetworkViz, countryLabel } from "../../../viz";
import { AsyncStateMessage, useAsync } from "../../shared";
import { ChartStory, LensNav, StepIntro, YearSelect, useVizLab, type Row, type VizStepState } from "./scaffold";

type Lens = "heat" | "network";

export const STEP10_DEFAULT_LENS: Lens = "network";
export const STEP10_LENSES: { key: Lens; label: string; hint: string }[] = [
  { key: "network", label: "贸易网络图", hint: "经济体间双边流向" },
  { key: "heat", label: "枢纽热力表", hint: "一个经济体内各行业的中心性" },
];
const STEP10_LENS_KEYS = STEP10_LENSES.map(({ key }) => key);

export function Step11Network({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<VizStepState> }) {
  const { year, setYear, lens, pickLens, picked, pickCountries, schema } = useVizLab(
    meta, step, state, STEP10_DEFAULT_LENS, STEP10_LENS_KEYS,
  );
  const fallbackDrill = meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "";
  const [drill, setDrill] = useState(state.data?.drill ?? state.data?.compared?.at(-1) ?? fallbackDrill);
  const drillTouched = useRef(Boolean(state.data));
  useEffect(() => {
    if (drillTouched.current || !state.data) return;
    const saved = state.data.drill ?? state.data.compared?.at(-1);
    if (saved && meta.countries.includes(saved)) setDrill(saved);
    drillTouched.current = true;
  }, [state.data, meta.countries]);
  const pageQuery = useAsync<IndustryPage>(
    () => api.industryIndicatorsAll(year, drill),
    [lens, year, drill],
    { enabled: lens === "heat" && Boolean(drill) },
  );
  const networkQuery = useAsync<NetworkData>(
    () => api.network(year),
    [lens, year],
    { enabled: lens === "network" },
  );
  const page = pageQuery.data;
  const net = networkQuery.data;

  // 对比对象 = 下钻看过的国家;换下钻国家即累加(累加而非覆盖,看过的不丢)。
  const changeDrill = (c: string) => {
    drillTouched.current = true;
    setDrill(c);
    pickCountries(picked.includes(c) ? picked : [...picked, c]);
    state.save({ drill: c });
  };
  const heatRows = (page?.rows ?? []) as Row[];

  useEffect(() => {
    if (!page || !picked.includes(drill)) return;
    const metric = "betweenesscentrality";
    const row = heatRows.find((item) => typeof item[metric] === "number" && Number.isFinite(item[metric]));
    if (!row) return;
    const prior = state.data?.observations ?? [];
    const observations = [
      ...prior.filter((item) => item.country !== drill),
      {
        entity: `${drill}·${String(row.industry ?? "")}`,
        country: drill,
        industry: String(row.industry ?? ""),
        year,
        value: row[metric] as number,
      },
    ].slice(-2);
    if (JSON.stringify(observations) === JSON.stringify(prior) && state.data?.metric === metric) return;
    state.save({ metric, observations });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, drill, picked, year]);

  return (
    <div>
      <StepIntro
        kicker={`步骤 ${step.n} · 网络可视化`}
        lead="哪些节点处于全球生产网络的枢纽位置？"
        concept={step.concept}
        todo={[
          "先看“贸易网络图”，观察经济体间的流向与区域集群",
          "点击任意经济体进入大图，查看主要贸易伙伴以及流入、流出",
          "再切换到“枢纽热力表”，对比至少两个经济体的枢纽行业",
        ]}
      />

      <div className="tipbox" style={{ marginBottom: 14 }}>
        经济体层贸易图在全部正流量边下是<b>完全图</b>，度、介数和接近中心性等无权指标对所有经济体都相同，无法区分枢纽。
        因此枢纽识别使用<b>经济体×行业</b>完整全球图：每个数值都基于全部经济体×行业节点和正的中间品流量边计算，下钻只改变展示范围。
      </div>

      <div className="controls" style={{ marginBottom: 12 }}>
        <YearSelect years={meta.years} year={year} onChange={setYear} />
        <span className="muted" style={{ fontSize: 12 }}>
          已查看 <b style={{ color: picked.length >= 2 ? "#159a86" : "#e0982a" }}>{picked.length}</b> 个经济体{picked.length < 2 ? "（需 ≥2）" : ""}
        </span>
      </div>

      <LensNav<Lens> active={lens as Lens} onPick={pickLens} lenses={STEP10_LENSES} />

      {lens === "heat" ? (
        <ChartStory
          eyebrow="经济体×行业枢纽"
          title={`${countryLabel(drill)} 的行业节点中心性（全球图计算，按介数前 15）`}
          what={<>选择一个经济体，每行表示其中一个行业节点；各列是不同中心性指标。加权度表示直接流量规模，介数表示有多少条有向最短路径经过该节点；颜色越深表示该列内数值相对越大。</>}
          read={<>介数较高表示该行业节点位于更多有向最短路径上；加权度较高表示直接流入和流出的中间品规模较大。两类数值不能互相替代。</>}
          find={<>切换两到三个经济体，检查电子、金属或化工行业的介数是否都较高，并引用具体数值说明结果。</>}
          note="中心性始终在完整全球经济体×行业图上计算；下钻只筛选展示的行。"
        >
          <div className="controls" style={{ marginBottom: 12 }}>
            <LabeledControl label="下钻经济体">
              {(id) => (
                <select id={id} value={drill} onChange={(e) => changeDrill(e.target.value)}>
                  {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
                </select>
              )}
            </LabeledControl>
          </div>
          {pageQuery.status === "loading" || pageQuery.status === "error" ? (
            <AsyncStateMessage
              status={pageQuery.status}
              error={pageQuery.error}
              loadingLabel={`加载 ${countryLabel(drill)} 行业网络指标中…`}
              onRetry={pageQuery.retry}
            />
          ) : heatRows.length ? <HeatTableViz rows={heatRows} schema={schema} />
            : <p className="muted">该国无行业数据。</p>}
        </ChartStory>
      ) : (
        <ChartStory
          eyebrow="双边贸易网络"
          title="经济体间生产贸易网络（有向，按流量）"
          what={<>节点表示经济体，有向边表示跨境中间品与最终品贸易流，不含本地交易；节点大小和边的粗细反映流量规模。</>}
          read={<>悬停经济体可临时高亮伙伴；点击后进入大图，并打开流入、流出伙伴表。箭头方向表示“卖给谁”。该图观察经济体间流向，与经济体×行业中心性图的粒度不同。</>}
          find={<>选择中国、美国或德国，比较它们的主要流入与流出伙伴；再观察经济体层几乎两两相连，理解无权中心性为什么失去区分度。</>}
          note="为保证可读性，界面只显示流量最大的若干条边；中心性使用完整图计算，不受展示阈值影响。"
        >
          {networkQuery.status === "loading" || networkQuery.status === "error" ? (
            <AsyncStateMessage
              status={networkQuery.status}
              error={networkQuery.error}
              loadingLabel={`加载 ${year} 年贸易网络中…`}
              onRetry={networkQuery.retry}
            />
          ) : net ? <NetworkViz data={net} /> : <p className="muted">该年份暂无网络数据。</p>}
        </ChartStory>
      )}
    </div>
  );
}
