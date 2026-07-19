/**
 * 步骤 10 · 网络可视化 —— 故事:「谁是全球生产的枢纽?」
 *
 * 网络专属镜头(与前三步完全不同的图元):
 *   枢纽热力表  选一国,看它各行业节点在**完整全球国家×行业图**上的中心性(热力)
 *   贸易网络图  国家间双边贸易流的有向网络,悬停看某国的伙伴与区域集群
 *
 * 口径:国家级贸易图是完全图 → 无权中心性(度 / 介数 …)恒为常数、无区分度,
 * 因此枢纽识别只在国家–行业级做(见 country_degenerate 处理与回归 network 粒度)。
 * 对比对象 = 学生下钻看过的国家(≥2)。
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import { EvidencePanel, VerifiedCerBox } from "../../../step-evidence";
import type { IndustryPage, Meta, NetworkData, Step, StepEvidenceApi } from "../../../types";
import { HeatTableViz, NetworkViz, countryLabel } from "../../../viz";
import { useAsync } from "../../shared";
import { ChartStory, LensNav, StepIntro, YearSelect, useVizLab, type Row, type VizEvidence } from "./scaffold";

type Lens = "heat" | "network";

export function Step11Network({ meta, step, evidence }: { meta: Meta; step: Step; evidence: StepEvidenceApi<VizEvidence> }) {
  const { year, setYear, lens, pickLens, picked, pickCountries, schema } = useVizLab(
    meta, step, evidence, "heat", ["heat", "network"],
  );
  const fallbackDrill = meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "";
  const [drill, setDrill] = useState(evidence.data?.drill ?? evidence.data?.compared?.at(-1) ?? fallbackDrill);
  const drillTouched = useRef(Boolean(evidence.data));
  useEffect(() => {
    if (drillTouched.current || !evidence.data) return;
    const saved = evidence.data.drill ?? evidence.data.compared?.at(-1);
    if (saved && meta.countries.includes(saved)) setDrill(saved);
    drillTouched.current = true;
  }, [evidence.data, meta.countries]);
  const { data: page } = useAsync<IndustryPage | null>(
    () => (lens === "heat" && drill ? api.industryIndicatorsAll(year, drill) : Promise.resolve(null)),
    [lens, year, drill],
  );
  const { data: net } = useAsync<NetworkData | null>(
    () => (lens === "network" ? api.network(year) : Promise.resolve(null)),
    [lens, year],
  );

  // 对比对象 = 下钻看过的国家;换下钻国家即累加(累加而非覆盖,看过的不丢)。
  const changeDrill = (c: string) => {
    drillTouched.current = true;
    setDrill(c);
    pickCountries(picked.includes(c) ? picked : [...picked, c]);
    evidence.save({ drill: c, evidence_id: "" });
  };
  const heatRows = (page?.rows ?? []) as Row[];

  useEffect(() => {
    if (!page || !picked.includes(drill)) return;
    const metric = "betweenesscentrality";
    const row = heatRows.find((item) => typeof item[metric] === "number" && Number.isFinite(item[metric]));
    if (!row) return;
    const prior = evidence.data?.observations ?? [];
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
    if (JSON.stringify(observations) === JSON.stringify(prior) && evidence.data?.metric === metric) return;
    evidence.save({ metric, observations, evidence_id: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, drill, picked, year]);

  return (
    <div>
      <EvidencePanel evidence={evidence} title="本步要留下的证据:选一个镜头,并用「下钻国家」看过至少两个国家的行业枢纽" />
      <StepIntro
        kicker={`步骤 ${step.n} · 网络可视化`}
        lead="谁是全球生产的枢纽?"
        concept={step.concept}
        todo={[
          "用「下钻国家」看某国各行业的中心性热力",
          "至少换看两个国家,对比它们的枢纽行业",
          "再切「贸易网络图」看国家间的流向与集群",
        ]}
      />

      <div className="tipbox" style={{ marginBottom: 14 }}>
        国家级贸易图在全部正流量边下是<b>完全图</b>,度、介数、接近等无权中心性对所有国家恒为常数、没有区分度。
        因此枢纽识别在<b>国家–行业级</b>的完整全球图上做:每个数值都在包含全部国家×行业节点和所有正中间品流量边的有向图上计算,下钻只改变展示范围。
      </div>

      <div className="controls" style={{ marginBottom: 12 }}>
        <YearSelect years={meta.years} year={year} onChange={setYear} />
        <span className="muted" style={{ fontSize: 12 }}>
          已看过 <b style={{ color: picked.length >= 2 ? "#159a86" : "#e0982a" }}>{picked.length}</b> 国{picked.length < 2 ? "(需 ≥2)" : ""}
        </span>
      </div>

      <LensNav<Lens>
        active={lens as Lens}
        onPick={pickLens}
        lenses={[
          { key: "heat", label: "枢纽热力表", hint: "一国各行业的中心性" },
          { key: "network", label: "贸易网络图", hint: "国家间双边流向" },
        ]}
      />

      {lens === "heat" ? (
        <ChartStory
          eyebrow="国家×行业枢纽"
          title={`${countryLabel(drill)} 的行业节点中心性(全球图上计算,按介数前 15)`}
          what={<>选一个国家,每行 = 它的一个行业节点;各列是不同中心性(加权度 = 流量规模,介数 = 有向最短路经过次数 …)。颜色越深 = 该列内相对越大。</>}
          read={<>介数高 = 该行业节点是全球生产网络里的<b>中转枢纽</b>(很多最短供应路径经过它);加权度高 = 直接吞吐的中间品流量大。</>}
          find={<>换看两三个国家(下方下拉),对比它们的枢纽行业:制造业大国的电子 / 金属 / 化工节点通常介数更高。</>}
          note="中心性始终在完整全球国家×行业图上计算,下钻只筛选展示的行(见上方说明)。"
        >
          <div className="controls" style={{ marginBottom: 12 }}>
            <label>下钻国家</label>
            <select value={drill} onChange={(e) => changeDrill(e.target.value)}>
              {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
            </select>
          </div>
          {!page ? <p className="muted">加载 {countryLabel(drill)} 行业网络指标中…</p>
            : heatRows.length ? <HeatTableViz rows={heatRows} schema={schema} />
              : <p className="muted">该国无行业数据。</p>}
        </ChartStory>
      ) : (
        <ChartStory
          eyebrow="双边贸易网络"
          title="国家间生产贸易网络(有向,按流量)"
          what={<>节点 = 经济体,有向边 = 跨国中间品 + 最终品贸易流(不含国内边);点大小 / 边粗细反映流量规模。</>}
          read={<>悬停一个国家高亮它的贸易伙伴与所属区域集群;箭头方向是"卖给谁"。它用于观察国家间流向，与上方国家×行业中心性图属于不同粒度。</>}
          find={<>找出中国、美国、德国的区域集群;注意国家层几乎两两相连(接近完全图),这正是无权中心性在国家级退化的原因。</>}
          note="仅渲染流量最大的若干条边以保证可读;中心性计算用的是完整图,不受此展示阈值影响。"
        >
          {!net ? <p className="muted">加载 {year} 年贸易网络中…</p> : <NetworkViz data={net} />}
        </ChartStory>
      )}
      <VerifiedCerBox
        step={step.n}
        kind="visualization"
        evidence={evidence}
        ready={Boolean(evidence.data?.chart && (evidence.data?.compared?.length ?? 0) >= 2 && (evidence.data?.observations?.length ?? 0) >= 2)}
        context={{ topic: step.topic, year, chart: lens, compared: picked, drill, metric: evidence.data?.metric, observations: evidence.data?.observations }}
      />
    </div>
  );
}
