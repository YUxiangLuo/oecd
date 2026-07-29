/**
 * 步骤 7 · 贸易流可视化 —— 故事:「一国的出口,价值从哪来?」
 *
 * 三个贸易专属镜头(非通用图表标签),各自带读图脚手架:
 *   定位图   FVA 份额(后向参与)× GVC 生产份额(前向参与),四象限给经济体分型
 *   出口拆解 选中国家的毛出口拆成 WWZ 六项,直观看本国 / 外国来源占比
 *   FVA 排序 谁的出口最依赖外国增加值(后向 GVC 参与最深)
 */
import { api } from "../../../api";
import type { Meta, Step, StepStateApi } from "../../../types";
import { CompositionBar, QuadrantScatter, RankBarChart } from "../../../viz";
import { AsyncStateMessage, useAsync } from "../../shared";
import { ChartStory, LensNav, StepIntro, VizWorkbench, finiteBy, num, useCountryObservations, useVizLab, type Row, type VizStepState } from "./scaffold";

type Lens = "quadrant" | "decompose" | "rank";

const WWZ_SEGMENTS = [
  { key: "DVAex", name: "DVAex 国内增加值出口" },
  { key: "DVArt", name: "DVArt 返回国内" },
  { key: "DDC", name: "DDC 国内重复计算" },
  { key: "FVA", name: "FVA 外国增加值" },
  { key: "FDC", name: "FDC 外国重复计算" },
  { key: "taxsub", name: "taxsub 税收减补贴" },
];
const QUAD_LABELS: [string, string, string, string] = [
  "双高 · 深度嵌入", "GVC 生产主导 · 前向型", "双低 · 相对自给", "进口依赖 · 后向型",
];

export function Step8Trade({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<VizStepState> }) {
  const { year, setYear, lens, pickLens, picked, pickCountries } = useVizLab(
    meta, step, state, "quadrant", ["quadrant", "decompose", "rank"],
  );
  const { data, error, status, retry } = useAsync<Row[]>(() => api.countryIndicators(year), [year]);
  const rows = data ?? [];
  useCountryObservations(rows, picked, year, "FVA_share", state);

  const highlight = new Set(picked);
  const quadRows = finiteBy(rows, "FVA_share", "3_VA_GVC_share");
  // 拆解镜头:优先看选中的国家;没选时用毛出口最大的 8 国垫场,保证有东西看。
  const decompRows = picked.length
    ? rows.filter((r) => picked.includes(String(r.country)))
    : [...rows].sort((a, b) => num(b.gross_exports) - num(a.gross_exports)).slice(0, 8);
  const ranked = [...finiteBy(rows, "FVA_share")].sort((a, b) => num(b.FVA_share) - num(a.FVA_share));
  const topRankRows = ranked.slice(0, 20);
  const rankRows = [...topRankRows, ...ranked.filter((row) => picked.includes(String(row.country)) && !topRankRows.includes(row))];

  return (
    <div>
      <StepIntro
        kicker={`步骤 ${step.n} · 贸易流可视化`}
        lead="一国的出口,价值从哪来?"
        concept={step.concept}
        todo={[
          "在「选国家」里挑至少两个经济体(如 中国 vs 越南)",
          "先看定位图它们各落哪个象限",
          "再切「出口拆解」比较六项构成",
        ]}
      />

      <LensNav<Lens>
        active={lens as Lens}
        onPick={pickLens}
        lenses={[
          { key: "quadrant", label: "定位图", hint: "后向 × 前向参与,四象限分型" },
          { key: "decompose", label: "出口拆解", hint: "毛出口 = WWZ 六项之和" },
          { key: "rank", label: "FVA 排序", hint: "谁最依赖外国增加值" },
        ]}
      />

      <VizWorkbench
        years={meta.years} year={year} onYearChange={setYear}
        countries={meta.countries} picked={picked} onPick={pickCountries}
      >
      {status === "loading" || status === "error" ? (
        <AsyncStateMessage
          status={status}
          error={error}
          loadingLabel={`加载 ${year} 年国家指标中…`}
          onRetry={retry}
        />
      ) : !rows.length ? (
        <p className="muted">该年份暂无国家指标数据。</p>
      ) : lens === "quadrant" ? (
        <ChartStory
          eyebrow="经济体分型"
          title="出口价值定位图:后向参与 × 前向参与"
          what={<>横轴 <b>FVA 份额</b> = 出口里用了多少<b>外国</b>增加值(后向 GVC 依赖);纵轴 <b>GVC 生产份额</b> = 本国增加值有多少经中间品贸易进入全球生产(前向参与)。虚线是全样本中位数。</>}
          read={<>越靠右,越依赖进口中间品做出口;越靠上,越多本国增加值卷入跨境生产。四个象限对应四种参与模式(见四角标签)。</>}
          find={<>找到你选的国家各落哪个象限:越南、卢森堡、斯洛伐克通常在右侧高 FVA 区(加工-再出口);美国、日本内需大,FVA 份额偏低。</>}
          note={`参考线基于全部有效样本 n=${quadRows.length};份额 = 占毛出口 / 总增加值的比例。`}
        >
          <QuadrantScatter
            rows={quadRows} referenceRows={quadRows}
            xKey="FVA_share" yKey="3_VA_GVC_share"
            xLabel="FVA 份额(后向参与)" yLabel="GVC 生产份额(前向参与)"
            xFormat="pct" yFormat="pct"
            highlight={highlight} quadrantLabels={QUAD_LABELS}
          />
        </ChartStory>
      ) : lens === "decompose" ? (
        <ChartStory
          eyebrow="WWZ 总贸易核算"
          title="拆开一国的出口:六项从哪来"
          what={<>每条 = 一个国家的毛出口,按 WWZ 六项归一化到 100%:前三项(蓝系)是<b>本国</b>增加值及其重复计算,FVA / FDC(绿 / 橙)是<b>外国</b>来源,taxsub 是税收。</>}
          read={<>蓝色段越宽,出口越"实"(本国增加值主导);绿 / 橙段越宽,越靠进口中间品。右侧数字是该国毛出口(百万美元)。</>}
          find={<>对比大型经济体(美国:DVAex 段主导)与小型开放经济体(越南、卢森堡:FVA 段很宽)。六项之和恒等于毛出口。</>}
          note={picked.length ? "当前显示你选中的国家。" : "未选国家时默认展示毛出口最大的 8 国;在上方「选国家」挑选可替换。"}
        >
          <CompositionBar
            rows={decompRows} segments={WWZ_SEGMENTS}
            sortKey="gross_exports" sortLabel="毛出口" sortFormat="amount"
            valueFormat="amount" highlight={highlight}
          />
        </ChartStory>
      ) : (
        <ChartStory
          eyebrow="后向 GVC 参与"
          title="谁的出口最依赖外国增加值(FVA 份额前 20)"
          what={<>横条 = 各国 <b>FVA 份额</b>(出口中外国增加值占比),从高到低取前 20;你选中的国家高亮为红色。</>}
          read={<>越长 = 后向 GVC 参与越深、越依赖全球供应链的进口投入。这类经济体对上游关税、断供最敏感。</>}
          find={<>榜首多是加工-再出口型小经济体;把中国、美国这类大国和它们对比,份额通常低不少。</>}
          note="展示前 20，并追加你主动选择但未进入前 20 的国家。"
        >
          <RankBarChart rows={rankRows} metricKey="FVA_share" label="FVA 份额" format="pct" highlight={highlight} />
        </ChartStory>
      )}
      </VizWorkbench>
    </div>
  );
}
