/**
 * 步骤 6 · 贸易流可视化 —— 故事:「一国的出口,价值从哪来?」
 *
 * 三个贸易专属镜头(非通用图表标签),各自带读图脚手架:
 *   定位图   课程 FVA 份额× WWYZ GVC 生产份额,按样本中位数描述性分型
 *   出口拆解 选中国家的毛出口拆成五类 WWZ 聚合项与 TLS 扩展,直观看本国 / 外国来源占比
 *   FVA 排序 谁的出口最依赖外国增加值(后向 GVC 参与最深)
 */
import type { Meta, Step, StepStateApi } from "../../../types";
import { CompositionBar, QuadrantScatter, RankBarChart } from "../../../viz";
import { NEGATIVE_COMPOSITION_STYLE } from "../../../viz/explore/charts";
import { CAT } from "../../../viz/shared";
import { AsyncStateMessage } from "../../shared";
import { ChartStory, LensNav, VizWorkbench, finiteBy, num, useCountryIndicatorRows, useCountryObservations, useVizLab, type Row, type VizStepState } from "./scaffold";

type Lens = "quadrant" | "decompose" | "rank";

type ExportProvenance = "domestic" | "foreign" | "extension";

export const WWZ_SEGMENTS = [
  { key: "DVAex", name: "DVAex 国内增加值出口", provenance: "domestic", colorName: "蓝色", color: CAT[0] },
  { key: "DVArt", name: "DVArt 返回国内", provenance: "domestic", colorName: "绿色", color: CAT[1] },
  { key: "DDC", name: "DDC 国内重复计算", provenance: "domestic", colorName: "琥珀色", color: CAT[2] },
  { key: "FVA", name: "FVA 外国增加值", provenance: "foreign", colorName: "深绿色", color: CAT[3] },
  { key: "FDC", name: "FDC 外国重复计算", provenance: "foreign", colorName: "紫色", color: CAT[4] },
  { key: "taxsub", name: "taxsub 税收减补贴", provenance: "extension", colorName: "红色", color: CAT[5] },
] as const satisfies readonly {
  key: string;
  name: string;
  provenance: ExportProvenance;
  colorName: string;
  color: string;
}[];

function provenanceItems(provenance: ExportProvenance): string {
  return WWZ_SEGMENTS
    .filter((segment) => segment.provenance === provenance)
    .map((segment) => `${segment.colorName} ${segment.key}`)
    .join("、");
}

export const WWZ_READING_GUIDE = `正值时，${provenanceItems("domestic")} 属于国内增加值及其重复计算；`
  + `${provenanceItems("foreign")} 属于外国增加值及其重复计算；`
  + `${provenanceItems("extension")} 是 OECD TLS 账户扩展。`
  + `负分项统一以${NEGATIVE_COMPOSITION_STYLE.colorName}显示在零轴左侧；这里的${NEGATIVE_COMPOSITION_STYLE.colorName}表示负号，不改变其国内、外国或 TLS 扩展归类。`;
const QUAD_LABELS: [string, string, string, string] = [
  "双高 · 深度嵌入", "GVC 生产主导 · 前向型", "双低 · 参与较低", "进口依赖 · 后向型",
];

export function eligibleExportCompositionRows(rows: Row[]): Row[] {
  return finiteBy(rows, "gross_exports", ...WWZ_SEGMENTS.map((segment) => segment.key));
}

export function TradeVizStep({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<VizStepState> }) {
  const { year, setYear, lens, pickLens, picked, pickCountries } = useVizLab(
    meta, step, state, "quadrant", ["quadrant", "decompose", "rank"],
  );
  const countryQuery = useCountryIndicatorRows(meta, year);
  const { rows, error, status, retry } = countryQuery;
  useCountryObservations(countryQuery.response, countryQuery.identity, picked, "FVA_share", state);

  const highlight = new Set(picked);
  const quadRows = finiteBy(rows, "FVA_share", "3_VA_GVC_share");
  const exportCompositionRows = eligibleExportCompositionRows(rows);
  // 拆解镜头:优先看选中的国家;没选时用毛出口最大的 8 国垫场,保证有东西看。
  const decompRows = picked.length
    ? exportCompositionRows.filter((r) => picked.includes(String(r.country)))
    : [...exportCompositionRows].sort((a, b) => num(b.gross_exports) - num(a.gross_exports)).slice(0, 8);
  const ranked = [...finiteBy(rows, "FVA_share")].sort((a, b) => num(b.FVA_share) - num(a.FVA_share));
  const topRankRows = ranked.slice(0, 20);
  const rankRows = [...topRankRows, ...ranked.filter((row) => picked.includes(String(row.country)) && !topRankRows.includes(row))];

  return (
    <div>
      <VizWorkbench
        title={`步骤 ${step.n} · GVC 贸易流指标可视化`}
        toolbar={(
          <LensNav<Lens>
            active={lens as Lens}
            onPick={pickLens}
            lenses={[
              { key: "quadrant", label: "定位图", hint: "后向依赖 × WWYZ 前向生产参与；样本中位数分型" },
              { key: "decompose", label: "出口拆解", hint: "毛出口 = 五类 WWZ 聚合项 + TLS 扩展" },
              { key: "rank", label: "FVA 排序", hint: "谁最依赖外国增加值" },
            ]}
          />
        )}
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
          title="出口价值定位图:后向依赖 × WWYZ 前向生产参与"
          what={<>横轴 <b>课程 FVA 份额</b> = 出口中由直接与间接外国上游创造的纯增加值构成（TLS 单列，非 OECD EXGR_FVASH）；纵轴 <b>GVC 生产份额</b> = 本国增加值有多少经中间品贸易进入全球生产。虚线是全样本中位数；四象限不是 OECD 官方分类，也不等同于 TiVA forward participation。</>}
          read={<>越靠右,越依赖进口中间品做出口;越靠上,越多本国增加值卷入跨境生产。四个象限对应四种参与模式(见四角标签)。</>}
          find={<>找到你选的国家各落哪个象限：越南、卢森堡、斯洛伐克通常在右侧较高课程 FVA 区；美国、日本内需大，该份额通常偏低。这里只描述构成，不直接判断政策暴露。</>}
          note={`参考线基于全部有效样本 n=${quadRows.length};份额 = 占毛出口 / 总增加值的比例。`}
        >
          <QuadrantScatter
            rows={quadRows} referenceRows={quadRows}
            xKey="FVA_share" yKey="3_VA_GVC_share"
            xLabel="课程 FVA 份额(非 OECD EXGR_FVASH)" yLabel="WWYZ GVC 生产份额(前向生产参与)"
            xFormat="pct" yFormat="pct"
            highlight={highlight} quadrantLabels={QUAD_LABELS}
          />
        </ChartStory>
      ) : lens === "decompose" ? (
        <ChartStory
          eyebrow="WWZ 聚合项 + OECD TLS 扩展"
          title="拆开一国的出口:五类增加值核算项与 TLS"
          what={<>每条 = 一个国家的 VA+TLS 账户闭合毛出口,归一化到 100%:DVAex / DVArt / DDC 是<b>本国</b>增加值及其重复计算,FVA / FDC 是<b>外国</b>来源；taxsub 是 OECD TLS 账户扩展,不是 WWZ 原文分类。</>}
          read={<>{WWZ_READING_GUIDE}各段越宽，表示对应分项占 VA+TLS 账户闭合毛出口的份额越高；右侧数字是该国毛出口(百万美元)。</>}
          find={<>对比大型经济体(美国:DVAex 段主导)与小型开放经济体(越南、卢森堡:FVA 段很宽)。五类 WWZ 聚合项加 TLS 扩展恒等于 VA+TLS 账户闭合毛出口；TLS 是产品税减补贴账户，不等于步骤 10 的额外关税。</>}
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
          title="课程 FVA 份额前 20（非 OECD EXGR_FVASH）"
          what={<>横条 = 各国课程纯 VA 口径的 <b>FVA 份额</b>，从高到低取前 20；你选中的国家高亮为红色。</>}
          read={<>条越长 = 直接与间接外国上游纯增加值构成越高。TLS 单列，因此不能拿这里的数值直接冒充 OECD 官方 EXGR_FVASH；是否更暴露或更敏感仍需回归证据。</>}
          find={<>榜首多是加工-再出口型小经济体;把中国、美国这类大国和它们对比,份额通常低不少。</>}
          note="展示前 20，并追加你主动选择但未进入前 20 的国家。"
        >
          <RankBarChart rows={rankRows} metricKey="FVA_share" label="课程 FVA 份额（非 EXGR_FVASH）" format="pct" highlight={highlight} />
        </ChartStory>
      )}
      </VizWorkbench>
    </div>
  );
}
