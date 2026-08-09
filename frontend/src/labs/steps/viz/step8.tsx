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
        lead="一个经济体的出口价值来自哪里？"
        concept={step.concept}
        todo={[
          "在“选经济体”中选择至少两个对象（如中国和越南）",
          "先看定位图它们各落哪个象限",
          "再切「出口拆解」比较六项构成",
        ]}
      />

      <LensNav<Lens>
        active={lens as Lens}
        onPick={pickLens}
        lenses={[
          { key: "quadrant", label: "定位图", hint: "后向参与 × 前向参与，四象限定位" },
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
        <p className="muted">该年份暂无经济体指标数据。</p>
      ) : lens === "quadrant" ? (
        <ChartStory
          eyebrow="经济体分型"
          title="出口价值定位图：后向参与 × 前向参与"
          what={<>横轴 <b>FVA 份额</b>表示出口中外国增加值所占比例，反映后向 GVC 参与；纵轴 <b>GVC 生产份额</b>表示本国增加值经中间品贸易进入全球生产的比例，反映前向参与。虚线是全样本中位数。</>}
          read={<>位置越靠右，出口中的外国增加值份额越高；位置越靠上，更多本国增加值进入跨境生产。四个象限对应两类参与度的不同组合。</>}
          find={<>找到所选经济体各自所在的象限，记录它们与两条中位线的相对位置；再用具体份额解释为什么分类不同。</>}
          note={`参考线基于全部 ${quadRows.length} 个有效样本；横纵轴分别使用各自定义下的份额。`}
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
          title="拆开一个经济体的出口：六项价值来源"
          what={<>每条表示一个经济体的毛出口，并将 WWZ 六项归一化到 100%：前三项（蓝色）是本国增加值及其重复计算，FVA 和 FDC（绿色、橙色）是外国来源，taxsub 是税收减补贴。</>}
          read={<>蓝色部分越宽，本国来源所占份额越高；绿色和橙色部分越宽，外国来源所占份额越高。右侧数字是毛出口金额，单位为百万美元。</>}
          find={<>选择两个经济体，比较本国来源与外国来源份额，并检查六项之和是否等于毛出口。</>}
          note={picked.length ? "当前显示你选中的经济体。" : "未选择时默认展示毛出口最大的 8 个经济体；可在上方选择其他对象。"}
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
          title="出口中的外国增加值份额（FVA 份额前 20）"
          what={<>横条表示各经济体的 <b>FVA 份额</b>，即外国增加值占毛出口的比例；按数值从高到低展示前 20，你选择的经济体以红色突出。</>}
          read={<>横条越长，后向 GVC 参与越强，出口中的外国增加值占比越高。这提示了潜在的进口投入暴露渠道，但不能直接推出其对政策冲击更敏感。</>}
          find={<>比较所选经济体与榜首对象的份额差距，并思考经济规模、产业结构和加工贸易可能怎样影响排序。</>}
          note="展示前 20，并追加你主动选择但未进入前 20 的经济体。"
        >
          <RankBarChart rows={rankRows} metricKey="FVA_share" label="FVA 份额" format="pct" highlight={highlight} />
        </ChartStory>
      )}
      </VizWorkbench>
    </div>
  );
}
