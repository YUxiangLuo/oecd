/**
 * 步骤 6 · 贸易流可视化 —— 故事:「一国的出口,价值从哪来?」
 *
 * 三个贸易专属镜头(非通用图表标签),各自带读图脚手架:
 *   出口拆解 先看选中国家的完整出口构成
 *   定位图   外国增加值项占比 × 跨境生产占比，只比较相对高低
 *   占比排名 比较外国增加值项占比（字段仍为 FVA_share）
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
  "两项占比均较高", "外国增加值项较低 · 跨境生产较高", "两项占比均较低", "外国增加值项较高 · 跨境生产较低",
];
export const TRADE_DEFAULT_LENS = "decompose";
export const TRADE_LENSES = ["decompose", "quadrant", "rank"] as const;

export function eligibleExportCompositionRows(rows: Row[]): Row[] {
  return finiteBy(rows, "gross_exports", ...WWZ_SEGMENTS.map((segment) => segment.key));
}

export function TradeVizStep({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<VizStepState> }) {
  const { year, setYear, lens, pickLens, picked, pickCountries } = useVizLab(
    meta, step, state, TRADE_DEFAULT_LENS, TRADE_LENSES,
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
              { key: "decompose", label: "出口拆解", hint: "先比较出口各分项的构成" },
              { key: "quadrant", label: "定位图", hint: "比较外国增加值项占比与跨境生产占比" },
              { key: "rank", label: "占比排名", hint: "比较外国增加值项占比" },
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
          eyebrow="两种构成一起看"
          title="出口构成与跨境生产占比"
          what={<>横轴是出口分解中<b>外国增加值这一项的占比</b>；纵轴是本国增加值中经中间品贸易进入跨境生产的占比。两条虚线分别是当前样本的中位数。</>}
          read={<>越靠右，外国增加值项占比越高；越靠上，跨境生产占比越高。象限只表示相对高低，不代表经济体的嵌入深度或政策敏感程度。</>}
          find={<>你选的两个经济体在哪个方向差别更大？切回出口拆解，看看还有哪些分项不同。</>}
          note={`参考线基于全部有效样本 n=${quadRows.length};份额 = 占毛出口 / 总增加值的比例。`}
        >
          <QuadrantScatter
            rows={quadRows} referenceRows={quadRows}
            xKey="FVA_share" yKey="3_VA_GVC_share"
            xLabel="外国增加值项占比" yLabel="跨境生产占比"
            xFormat="pct" yFormat="pct"
            highlight={highlight} quadrantLabels={QUAD_LABELS}
          />
        </ChartStory>
      ) : lens === "decompose" ? (
        <ChartStory
          eyebrow="先看完整构成"
          title="拆开一国的出口：各项价值从哪里来？"
          what={<>每条代表一个国家的出口，各分项按毛出口换算成比例。先区分<b>国内来源、外国来源和税收减补贴</b>，再比较相同分项的宽度；金额与详细定义可查看图例和数据表。</>}
          read={<>{WWZ_READING_GUIDE}各段越宽，表示对应分项占 VA+TLS 账户闭合毛出口的份额越高；右侧数字是该国毛出口(百万美元)。</>}
          find={<>两国最大的分项分别是什么？除了外国增加值这一项，国内来源和重复计算部分的占比还有哪些差别？</>}
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
          eyebrow="选一项比较"
          title="外国增加值项占比排名"
          what={<>横条表示出口分解中<b>外国增加值这一项的占比</b>，从高到低取前 20；你选中的国家高亮为红色。</>}
          read={<>条越长，这一项在出口中占的比例越高。占比高不代表出口总额大，也不能直接说明对政策更敏感。</>}
          find={<>你选的国家在排名中处于什么位置？回到出口拆解，对照其他分项一起解释。</>}
          note="展示前 20，并追加你主动选择但未进入前 20 的国家。"
        >
          <RankBarChart rows={rankRows} metricKey="FVA_share" label="外国增加值项占比" format="pct" highlight={highlight} />
        </ChartStory>
      )}
      </VizWorkbench>
      <p className="muted">报告保留所选比较对象，并在数值可用时记录外国增加值项占比作为代表指标；不保存图表全部分项。完整指标定义见第 2 步数据表的列说明。</p>
    </div>
  );
}
