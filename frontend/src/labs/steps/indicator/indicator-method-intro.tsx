/**
 * 步骤 2–4 的“01 / 计算方法”：用几步文字说明指标如何从 ICIO 表算出，每一步链接到
 * 课程校订版说明或原始论文；文档库直接嵌在本区块，不再放在页面底部。
 * 代表指标公式与下方“动手拆解”的公式一致。
 */
import { INDICATOR_READINGS, IndicatorReadingLibrary, readingAssetUrl } from "./indicator-reading-library";

export type MethodTopic = "trade" | "production" | "length";

interface MethodStep {
  title: string;
  body: string;
  /** Reading id in INDICATOR_READINGS[topic] that documents this step. */
  source: string;
  sourceLabel: string;
}

interface MethodContent {
  label: string;
  question: string;
  lead: string;
  steps: MethodStep[];
  formula: string;
  caveat: string;
}

const METHOD: Record<MethodTopic, MethodContent> = {
  trade: {
    label: "总贸易流分解（WWZ）",
    question: "出口额怎样拆成国内价值、外国价值与重复计算？",
    lead: "出口额不全是本国创造的价值。WWZ 方法沿 ICIO 的投入产出链，追踪每一元出口的价值来源和最终吸收地。",
    steps: [
      {
        title: "从 ICIO 表取账户",
        body: "中间投入 Z、最终需求 Y、增加值 VA 与总产出 x；算出投入系数 A = Z / x 和增加值系数 v = VA / x。",
        source: "trade-guide",
        sourceLabel: "课程校订版说明",
      },
      {
        title: "累计全部生产环节",
        body: "里昂惕夫逆矩阵 B = (I − A)⁻¹ 把直接和间接投入累计起来，可以追溯出口中每一元价值来自哪个国家–行业。",
        source: "trade-paper-cn",
        sourceLabel: "王直等（2015）",
      },
      {
        title: "按来源和吸收地归类",
        body: "WWZ 把双边总出口分解为 16 项，按“国内或国外价值 × 在哪里被最终吸收 × 是否重复计算”归并为 DVAex、DVArt、DDC、FVA、FDC 五类；本系统另加 taxsub（产品税减补贴，来自 TLS 账户）。",
        source: "trade-paper-en",
        sourceLabel: "Wang, Wei & Zhu（2018）",
      },
    ],
    formula: "总出口 = DVAex + DVArt + DDC + FVA + FDC + taxsub；外国增加值项占比 = FVA ÷ 总出口",
    caveat: "FVA 不含外国重复计算 FDC；分母是六项加总的总出口，不是 OECD 官方 EXGR_FVASH 口径。",
  },
  production: {
    label: "生产活动分解（WWYZ）",
    question: "本国创造的增加值，最终通过什么路径被使用？",
    lead: "上一步问出口价值从哪里来，这一步从增加值的创造端出发，看它沿哪条生产路径被最终使用。",
    steps: [
      {
        title: "求出增加值的完整去向",
        body: "同样由 ICIO 求出 v 和 B；增加值 v̂·B·Y 给出每个国家–行业创造的增加值最终被哪里的最终需求吸收。",
        source: "production-guide",
        sourceLabel: "课程校订版说明",
      },
      {
        title: "区分国内与跨境环节",
        body: "把投入系数拆成国内块与跨境块，用国内逆矩阵区分增加值是否离开本国、以中间品还是最终品形式跨境。",
        source: "source-production-note",
        sourceLabel: "原始方法说明",
      },
      {
        title: "归入四类生产活动",
        body: "纯国内（1_VA_D，不跨境）、传统贸易（2_VA_RT，随最终品出口）、简单 GVC（3a，随中间品跨境一次后被吸收）、复杂 GVC（3b，至少两次跨境）。四类加总等于总增加值 SVA。",
        source: "production-paper",
        sourceLabel: "Wang 等（2017a）",
      },
    ],
    formula: "SVA = 1_VA_D + 2_VA_RT + 3a + 3b；复杂 GVC 生产份额 = 3b_VA_GVC_C ÷ SVA",
    caveat: "后向 FGY 系列按最终产品完成地对称分解；复杂 GVC 份额描述活动构成，不直接代表技术水平或收益。",
  },
  length: {
    label: "生产长度与位置（WWYZ）",
    question: "一笔增加值在被最终使用前，平均经过几道生产环节？",
    lead: "生产长度是增加值在生产中被计入总产出的平均次数。它衡量生产环节的多少，不是跨境次数。",
    steps: [
      {
        title: "前向与后向两个方向",
        body: "前向 PLv = (Bx)ᵢ / xᵢ，从价值来源出发追踪到最终产品；后向 PLy = (v′BB)ⱼ / (v′B)ⱼ，从最终产品回溯到初始投入。",
        source: "length-guide",
        sourceLabel: "课程校订版说明",
      },
      {
        title: "按生产活动加权",
        body: "总长度是各段长度的增加值加权平均：PLv = 纯国内、传统贸易、GVC 三段各自的“增加值份额 × 段长度”之和。最长的一段不一定贡献最大。",
        source: "length-paper",
        sourceLabel: "Wang 等（2017b）",
      },
      {
        title: "比较前后向得到位置",
        body: "GVC 位置指数 GVCPs = PLv_GVC ÷ PLy_GVC，大于 1 表示在该口径下相对上游；国家级先加总分子分母，不能简单平均行业比值。",
        source: "source-length-note",
        sourceLabel: "原始方法说明",
      },
    ],
    formula: "PLv = Σ（增加值份额 × 段长度）；GVCPs = PLv_GVC ÷ PLy_GVC",
    caveat: "长度不是跨境次数：增加国内加工也能拉长生产链。存在负增加值时是有符号加权。",
  },
};

export function IndicatorMethodIntro({ topic }: { topic: MethodTopic }) {
  const content = METHOD[topic];
  const readings = INDICATOR_READINGS[topic];
  return (
    <section className="method-intro" aria-label="指标计算方法">
      <span className="icio-kicker">01 / 计算方法 · {content.label}</span>
      <h2>{content.question}</h2>
      <p className="method-lead">{content.lead}</p>
      <ol className="method-steps">
        {content.steps.map((step) => {
          const reading = readings.find((item) => item.id === step.source);
          return (
            <li key={step.title}>
              <b>{step.title}</b>
              <span>{step.body}</span>
              {reading && (
                <a href={readingAssetUrl(reading.file)} target="_blank" rel="noopener noreferrer" title={reading.title}>
                  依据：{step.sourceLabel} ↗
                </a>
              )}
            </li>
          );
        })}
      </ol>
      <div className="method-formula" role="note">
        <span>本步代表指标</span>
        <b>{content.formula}</b>
        <small>{content.caveat}</small>
      </div>
      <IndicatorReadingLibrary topic={topic} />
    </section>
  );
}
