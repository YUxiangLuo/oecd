/**
 * 步骤 2–5 的“01 / 计算方法”：用几步文字说明指标如何从 ICIO 表算出，每一步链接到
 * 课程校订版说明或原始论文；文档库直接嵌在本区块，不再放在页面底部。
 * 代表指标公式与下方“动手拆解”的公式一致。
 */
import type { ReactNode } from "react";
import { INDICATOR_READINGS, IndicatorReadingLibrary, readingAssetUrl } from "./indicator-reading-library";

export type MethodTopic = "trade" | "production" | "length" | "network";

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
    label: "总出口分解（WWZ 法）",
    question: "出口额怎样拆成国内增加值、外国增加值与重复计算？",
    lead: "出口额不全是本国创造的价值。WWZ 法（王直、魏尚进、祝坤福提出的总出口分解方法）沿 ICIO 的投入产出链，追踪每一元出口的价值从哪国来、最后在哪国被最终使用。",
    steps: [
      {
        title: "从 ICIO 表取账户",
        body: "中间投入 Z、最终需求 Y、增加值 VA 与总产出 x（即步骤 1 的 OUT）；投入系数 A = 每列的 Z ÷ 该列行业的总产出，增加值率 v = VA ÷ 总产出。",
        source: "trade-guide",
        sourceLabel: "课程说明",
      },
      {
        title: "累计全部生产环节",
        body: "里昂惕夫逆矩阵 B = (I − A)⁻¹（完全需求系数矩阵）把直接投入和各轮间接投入全部累加，可以追溯出口中每一元价值来自哪个国家×行业。",
        source: "trade-paper-cn",
        sourceLabel: "王直等（2015）",
      },
      {
        title: "按来源和使用地归类",
        body: "WWZ 把双边总出口分解为 16 项，按“国内还是外国增加值 × 在哪里被最终使用 × 是否重复计算”归并为五类：被国外最终使用的国内增加值（DVAex）、返回国内的增加值（DVArt）、国内重复计算（DDC）、外国增加值（FVA）、外国重复计算（FDC）；本系统另加产品税减补贴（taxsub，来自 TLS 账户）。",
        source: "trade-paper-en",
        sourceLabel: "Wang, Wei & Zhu（2018）",
      },
    ],
    formula: "总出口 = DVAex + DVArt + DDC + FVA + FDC + taxsub；外国增加值项占比 = FVA ÷ 总出口",
    caveat: "FVA 不包括外国重复计算 FDC。分母是六项相加得到的总出口，所以这个比例和 OECD TiVA 公布的“出口中外国增加值占比”不完全相同。",
  },
  production: {
    label: "生产活动分解（WWYZ 法）",
    question: "本国创造的增加值，最终通过什么路径被使用？",
    lead: "上一步问出口价值从哪里来，这一步从增加值的创造端出发，看它沿哪条生产路径被最终使用。WWYZ 法由王直、魏尚进、余心玎、祝坤福提出。",
    steps: [
      {
        title: "求出增加值的完整去向",
        body: "用上一步的 v 和 B，可以算出每个国家×行业创造的增加值最终被哪国的消费或投资所使用（公式 v̂BY，v̂ 是把 v 放在对角线上的矩阵）。",
        source: "production-guide",
        sourceLabel: "课程说明",
      },
      {
        title: "区分国内与跨境环节",
        body: "把投入分成“本国内部的投入”和“跨境投入”两部分分别计算，即可区分增加值是否跨境，以及随中间品还是随最终品跨境。",
        source: "source-production-note",
        sourceLabel: "原始方法说明",
      },
      {
        title: "归入四类生产活动",
        body: "纯国内（1_VA_D，不跨境）、传统贸易（2_VA_RT，随最终品出口）、简单 GVC（3a_VA_GVC_S，随中间品跨境一次后被最终使用）、复杂 GVC（3b_VA_GVC_C，至少两次跨境）。四类相加等于总增加值 SVA。",
        source: "production-paper",
        sourceLabel: "Wang 等（2017a）",
      },
    ],
    formula: "总增加值 SVA = 纯国内 + 传统贸易 + 简单 GVC + 复杂 GVC；复杂 GVC 生产份额 = 3b_VA_GVC_C ÷ SVA",
    caveat: "也可以反过来，从最终产品在哪国完成来拆分（后向分解，代码 FGY）：在步骤 7 的“四类生产活动”视角选“后向（按最终品）”，查看各类所占份额。复杂 GVC 生产份额描述活动构成，不直接代表技术水平或收益。",
  },
  length: {
    label: "生产长度与位置（WWYZ 法）",
    question: "一笔增加值在被最终使用前，平均经过几道生产环节？",
    lead: "生产长度是增加值在生产中被计入总产出的平均次数。它衡量生产环节的多少，不是跨境次数。",
    steps: [
      {
        title: "前向与后向两个方向",
        body: "前向：从增加值来源端向下游追踪；后向：从最终产品端向上游回溯。公式：前向 PLv = (Bx)ᵢ / xᵢ，后向 PLy = (v′BB)ⱼ / (v′B)ⱼ，其中 x 是总产出（步骤 1 的 OUT）。",
        source: "length-guide",
        sourceLabel: "课程说明",
      },
      {
        title: "按生产活动加权",
        body: "总长度是各段长度的增加值加权平均：PLv = 纯国内、传统贸易、GVC 三段各自的“增加值份额 × 段长度”之和。最长的一段不一定贡献最大。",
        source: "length-paper",
        sourceLabel: "Wang 等（2017b）",
      },
      {
        title: "比较前后向得到位置",
        body: "GVC 位置指数 GVCPs = PLv_GVC ÷ PLy_GVC，大于 1 表示相对更上游（更靠近原料、零部件这一端）；国家整体的数值先把分子、分母分别加总再相除，不是各行业比值的简单平均。",
        source: "source-length-note",
        sourceLabel: "原始方法说明",
      },
    ],
    formula: "PLv = Σ（增加值份额 × 段长度）；GVCPs = PLv_GVC ÷ PLy_GVC",
    caveat: "长度不是跨境次数：增加国内加工也能拉长生产链。少数行业增加值为负时，长度可能超出常规范围。",
  },
  network: {
    label: "全球生产网络（按 Gephi 网络软件的算法）",
    question: "把投入产出表看成网络，哪些国家×行业处在中心位置？",
    lead: "ICIO 记录了谁向谁提供中间投入，可以直接看成一张“谁向谁供货”的网络（有方向：从供给方指向使用方）。中心性从流量规模和路径位置两个角度描述节点。",
    steps: [
      {
        title: "把 ICIO 表变成有向网络",
        body: "节点是国家×行业；每一笔金额为正的中间品流量 Z 是一条从供给方指向使用方的边。国内联系和自环（行业卖给自己的部分，即 Z 表对角线上的单元格）都保留，在完整的全球网络上计算。",
        source: "network-guide",
        sourceLabel: "课程说明",
      },
      {
        title: "流量规模：加权总度",
        body: "加权总度（买入 + 卖出）= 加权入度 + 加权出度，即流入与流出的中间品金额之和；自环在买入和卖出各计一次。它衡量规模，不是去重后的贸易额。",
        source: "source-network-note",
        sourceLabel: "原始方法说明",
      },
      {
        title: "路径位置：介数",
        body: "介数（只看连接、不看金额）：将每条连接视为等长，统计其他节点之间的最短路线中经过该节点的条数（用 Brandes 算法精确计算）。",
        source: "brandes-paper",
        sourceLabel: "Brandes（2001）",
      },
    ],
    formula: "加权总度 = 加权入度 + 加权出度；介数 = Σ σₛₜ(v) ÷ σₛₜ（σₛₜ 是 s 到 t 的最短路线条数，σₛₜ(v) 是其中经过 v 的条数）",
    caveat: "介数把很小和很大的流量一视同仁，只能作参考；每两国之间都有贸易，所以国家层面的介数都是 0。中心性高不等于经济枢纽或瓶颈。",
  },
};

export function IndicatorMethodIntro({ topic, children }: { topic: MethodTopic; children?: ReactNode }) {
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
        <span>本步核心公式</span>
        <b>{content.formula}</b>
        <small>{content.caveat}</small>
      </div>
      {children}
      <IndicatorReadingLibrary topic={topic} />
    </section>
  );
}
