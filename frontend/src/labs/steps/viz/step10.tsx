/**
 * 步骤 9 · 生产长度可视化 —— 故事:「生产链有多长,你在上游还是下游?」
 *
 * 长度专属镜头:
 *   上下游定位  前向 GVC 段长 × 后向 GVC 段长,象限区分上游 / 下游 / 长链 / 短链
 *   链长对比    前向 PLv 与后向 PLy 双条 + GVCPs 位置指数
 *   GVCPs 排名  位置指数 = 前向 / 后向 GVC 长度之比,>1 更靠上游
 */
import { api } from "../../../api";
import { EvidencePanel, VerifiedActionBox } from "../../../step-evidence";
import type { Meta, Step, StepEvidenceApi } from "../../../types";
import { LengthViz, QuadrantScatter, RankBarChart } from "../../../viz";
import { useAsync } from "../../shared";
import { ChartStory, LensNav, StepIntro, VizWorkbench, finiteBy, num, useCountryObservations, useVizLab, type Row, type VizEvidence } from "./scaffold";

type Lens = "position" | "bars" | "rank";

const POS_LABELS: [string, string, string, string] = [
  "长链 · 两端都深", "偏上游 · 前向长", "短链 · 靠近两端", "偏下游 · 后向长",
];

export function Step10Length({ meta, step, evidence }: { meta: Meta; step: Step; evidence: StepEvidenceApi<VizEvidence> }) {
  const { year, setYear, lens, pickLens, picked, pickCountries } = useVizLab(
    meta, step, evidence, "position", ["position", "bars", "rank"],
  );
  const { data } = useAsync<Row[]>(() => api.countryIndicators(year), [year]);
  const rows = data ?? [];
  useCountryObservations(rows, picked, year, "GVCPs", evidence);
  const highlight = new Set(picked);

  const posRows = finiteBy(rows, "PLv_GVC", "PLy_GVC");
  const rankRows = [...finiteBy(rows, "GVCPs")].sort((a, b) => num(b.GVCPs) - num(a.GVCPs)).slice(0, 20);

  return (
    <div>
      <EvidencePanel evidence={evidence} title="本步要留下的证据:选一个镜头,并在「选国家」里挑至少两个经济体对比" />
      <StepIntro
        kicker={`步骤 ${step.n} · 生产长度可视化`}
        lead="生产链有多长,你在上游还是下游?"
        concept={step.concept}
        todo={[
          "在「选国家」里挑至少两个经济体对比",
          "在上下游定位图里找它们靠上游还是下游",
          "用 GVCPs 排名看谁最靠近原材料端",
        ]}
      />

      <LensNav<Lens>
        active={lens as Lens}
        onPick={pickLens}
        lenses={[
          { key: "position", label: "上下游定位", hint: "前向 × 后向 GVC 段长" },
          { key: "bars", label: "链长对比", hint: "前向 PLv vs 后向 PLy" },
          { key: "rank", label: "GVCPs 排名", hint: "位置指数,>1 更上游" },
        ]}
      />

      <VizWorkbench
        years={meta.years} year={year} onYearChange={setYear}
        countries={meta.countries} picked={picked} onPick={pickCountries}
      >
      {!rows.length ? (
        <p className="muted">加载 {year} 年国家指标中…</p>
      ) : lens === "position" ? (
        <ChartStory
          eyebrow="价值链位置"
          title="上下游定位:前向 GVC 段长 × 后向 GVC 段长"
          what={<>横轴 <b>后向 GVC 段长 PLy_GVC</b>(最终品回溯到初始投入的跨境环节),纵轴 <b>前向 GVC 段长 PLv_GVC</b>(增加值到最终吸收的跨境环节)。虚线是全样本中位数。</>}
          read={<>越靠<b>左上</b>(前向长、后向短)= 越<b>上游</b>(靠近原材料 / 初始投入);越靠<b>右下</b> = 越<b>下游</b>(靠近最终消费)。两者都长 = 长链枢纽。</>}
          find={<>资源、原材料供应型经济体(如沙特、澳大利亚、俄罗斯)偏上游;组装、消费型经济体偏下游。看你选的国家落在哪。</>}
          note={`参考线基于全部有效样本 n=${posRows.length};段长 = 增加值被计为总产出的平均次数(WWYZ 2017b)。`}
        >
          <QuadrantScatter
            rows={posRows} referenceRows={posRows}
            xKey="PLy_GVC" yKey="PLv_GVC"
            xLabel="后向 GVC 段长(→下游)" yLabel="前向 GVC 段长(→上游)"
            xFormat="number" yFormat="number"
            highlight={highlight} quadrantLabels={POS_LABELS}
            equalityLine
          />
        </ChartStory>
      ) : lens === "bars" ? (
        <ChartStory
          eyebrow="前向 vs 后向"
          title="生产链长度对比(按前向总长度前 15)"
          what={<>每个国家两条:上条 <b>前向总长度 PLv</b>(增加值 → 最终吸收),下条 <b>后向总长度 PLy</b>(最终品 → 初始投入);右侧是 <b>GVCPs</b> 位置指数。</>}
          read={<>两条都长 = 生产环节多、辗转深。GVCPs = 前向 / 后向 GVC 段之比,&gt;1 表示更靠上游。</>}
          find={<>对比不同类型经济体的链长;总长度通常在 2–4 之间,增加值平均被计为产出 2–4 次。</>}
          note="固定展示前向总长度前 15 的经济体(此镜头为总览,不随选国家变化)。"
        >
          <LengthViz rows={rows} />
        </ChartStory>
      ) : (
        <ChartStory
          eyebrow="上游度"
          title="GVC 位置指数 GVCPs 排名(前 20)"
          what={<>横条 = <b>GVCPs = 前向 GVC 段长 / 后向 GVC 段长</b>。&gt;1 = 前向更长 = 更靠<b>上游</b>(离最终需求远)。</>}
          read={<>越长 = 越靠近价值链的原材料 / 初始投入端。这类经济体的角色是"供给上游中间品",而非组装成品。</>}
          find={<>榜首多为资源与原材料供应方;把你选的国家和它们对比,判断它在链条中的角色。</>}
          note="仅展示前 20;GVCPs 为无量纲比值。"
        >
          <RankBarChart rows={rankRows} metricKey="GVCPs" label="GVC 位置指数" format="number" highlight={highlight} />
        </ChartStory>
      )}
      </VizWorkbench>
      <VerifiedActionBox
        step={step.n}
        kind="visualization"
        evidence={evidence}
        ready={Boolean(evidence.data?.chart && (evidence.data?.compared?.length ?? 0) >= 2 && (evidence.data?.observations?.length ?? 0) >= 2)}
        context={{ topic: step.topic, year, chart: lens, compared: picked, metric: evidence.data?.metric, observations: evidence.data?.observations }}
      />
    </div>
  );
}
