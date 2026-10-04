import { useState } from "react";
import "./indicator-reading-library.css";

export type IndicatorReadingTopic = "trade" | "production" | "length" | "network";

type IndicatorReading = {
  id: string;
  title: string;
  authors: string;
  year: number | null;
  publication: string;
  focus: string;
  file: string;
  sourceUrl?: string;
};

export const readingAssetUrl = (file: string) => `${import.meta.env.BASE_URL}readings/${file}`;
const citation = (reading: IndicatorReading) =>
  `${reading.authors} · ${reading.year ?? "年份未标注"} · ${reading.publication}`;

export const INDICATOR_READINGS: Record<IndicatorReadingTopic, IndicatorReading[]> = {
  trade: [
    {
      id: "trade-guide",
      title: "总贸易流分解指标说明（课程校订版）",
      authors: "课程项目组",
      year: 2026,
      publication: "课程指标说明",
      focus: "结合当前 OECD 2023 数据口径，逐项解释 DVAex、FVA、FDC、taxsub 和占比边界。",
      file: "trade-decomposition-guide.pdf",
    },
    {
      id: "source-trade-note",
      title: "双边总贸易流分解指标构建",
      authors: "原始资料",
      year: null,
      publication: "方法说明（历史资料）",
      focus: "原始指标表与简要定义；FVA 与 taxsub 的当前课程口径以校订版为准。",
      file: "source-trade-decomposition-note.pdf",
    },
    {
      id: "trade-paper-en",
      title: "Quantifying International Production Sharing at the Bilateral and Sector Levels",
      authors: "Zhi Wang、Shang-Jin Wei、Kunfu Zhu",
      year: 2018,
      publication: "NBER Working Paper 19677",
      focus: "总出口在双边和行业层面的增加值及重复计算分解方法。",
      file: "wang-wei-zhu-trade-decomposition.pdf",
      sourceUrl: "https://www.nber.org/papers/w19677",
    },
    {
      id: "trade-paper-cn",
      title: "总贸易核算法：官方贸易统计与全球价值链的度量",
      authors: "王直、魏尚进、祝坤福",
      year: 2015,
      publication: "中国社会科学",
      focus: "以中文讨论增加值出口、返回国内增加值、外国增加值和重复计算。",
      file: "wang-wei-zhu-total-trade-accounting-cn.pdf",
    },
  ],
  production: [
    {
      id: "production-guide",
      title: "GVC 生产分解指标说明（课程校订版）",
      authors: "课程项目组",
      year: 2026,
      publication: "课程指标说明",
      focus: "区分前向与后向账户，并纠正原始资料中重复的 3b_FGY_GVC_C 字段名。",
      file: "production-decomposition-guide.pdf",
    },
    {
      id: "source-production-note",
      title: "全球价值链生产分解指标构建",
      authors: "原始资料",
      year: null,
      publication: "方法说明（历史资料）",
      focus: "原始公式、ICIO 表结构和十二项生产分解指标说明；数据年份以当前课程为准。",
      file: "source-production-decomposition-note.pdf",
    },
    {
      id: "production-paper",
      title: "Measures of Participation in Global Value Chains and Global Business Cycles",
      authors: "Zhi Wang、Shang-Jin Wei、Xinding Yu、Kunfu Zhu",
      year: 2017,
      publication: "NBER Working Paper 23222",
      focus: "纯国内、传统贸易、简单 GVC 与复杂 GVC 生产活动的理论分解。",
      file: "wang-et-al-gvc-participation.pdf",
      sourceUrl: "https://www.nber.org/papers/w23222",
    },
  ],
  length: [
    {
      id: "length-guide",
      title: "生产长度与 GVC 位置指标说明（课程校订版）",
      authors: "课程项目组",
      year: 2026,
      publication: "课程指标说明",
      focus: "解释前向/后向生产长度、GVCPs，以及“长度不是跨境次数”的边界。",
      file: "production-length-guide.pdf",
    },
    {
      id: "source-length-note",
      title: "全球价值链长度分解指标构建",
      authors: "原始资料",
      year: null,
      publication: "方法说明（历史资料）",
      focus: "原始矩阵公式、生产长度分解框架和十项指标说明；数据年份以当前课程为准。",
      file: "source-production-length-note.pdf",
    },
    {
      id: "length-paper",
      title: "Characterizing Global Value Chains: Production Length and Upstreamness",
      authors: "Zhi Wang、Shang-Jin Wei、Xinding Yu、Kunfu Zhu",
      year: 2017,
      publication: "NBER Working Paper 23261",
      focus: "生产长度分段与相对上游位置指标的理论来源。",
      file: "wang-et-al-production-length.pdf",
      sourceUrl: "https://www.nber.org/papers/w23261",
    },
  ],
  network: [
    {
      id: "network-guide",
      title: "全球生产网络指标说明（课程校订版）",
      authors: "课程项目组",
      year: 2026,
      publication: "课程指标说明",
      focus: "明确全部正边、有向无权路径、自环双计、未归一化 Brandes 等当前口径。",
      file: "production-network-guide.pdf",
    },
    {
      id: "source-network-note",
      title: "全球生产网络指标构建",
      authors: "原始资料",
      year: null,
      publication: "方法说明（历史资料）",
      focus: "原始 Gephi 指标清单及中文定义；数据年份和精确算法口径以课程校订版为准。",
      file: "source-production-network-note.pdf",
    },
    {
      id: "brandes-paper",
      title: "A Faster Algorithm for Betweenness Centrality",
      authors: "Ulrik Brandes",
      year: 2001,
      publication: "Journal of Mathematical Sociology",
      focus: "课程所用精确介数算法的原始方法论文。",
      file: "brandes-betweenness-centrality.pdf",
      sourceUrl: "https://doi.org/10.1080/0022250X.2001.9990249",
    },
    {
      id: "tourism-network-example",
      title: "高铁沿线旅游流网络结构及其互动关系研究",
      authors: "李磊、陆林、孙小龙、虞虎",
      year: 2020,
      publication: "人文地理",
      focus: "Gephi 网络指标的中文应用示例；用于帮助理解，不作为生产网络算法口径来源。",
      file: "li-et-al-tourism-network-cn.pdf",
    },
  ],
};

export function IndicatorReadingLibrary({ topic }: { topic: IndicatorReadingTopic }) {
  const readings = INDICATOR_READINGS[topic];
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState(readings[0].id);
  const selected = readings.find((reading) => reading.id === selectedId) ?? readings[0];
  const selectedUrl = readingAssetUrl(selected.file);

  return (
    <details
      className="indicator-reading-library"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span>
          <b>指标说明与相关文档</b>
          <small>{readings.length} 篇 PDF · 课程说明、原始方法资料与论文</small>
        </span>
        <span className="indicator-reading-badge">课程资料</span>
      </summary>
      <div className="indicator-reading-intro">
        本页汇总课程指标说明、原始方法说明与相关论文。课程说明已按当前 OECD ICIO 2023 edition（2016–2020）
        的计算口径校订；历史资料中的年份不代表本系统的数据范围。原始资料沿用原文件编号，与课程步骤编号不同，
        本页已按指标主题对应。建议先读课程校订版，再对照原始说明和方法论文。
      </div>
      <div className="indicator-reading-workspace">
        <div className="indicator-reading-list" aria-label="选择指标相关文章">
          {readings.map((reading, index) => (
            <button
              key={reading.id}
              type="button"
              id={`reading-tab-${topic}-${reading.id}`}
              aria-pressed={reading.id === selected.id}
              aria-controls={`reading-panel-${topic}`}
              onClick={() => setSelectedId(reading.id)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <b>{reading.title}</b>
              <small className="indicator-reading-citation">{citation(reading)}</small>
              <small>{reading.focus}</small>
            </button>
          ))}
        </div>
        <section
          className="indicator-reading-viewer"
          id={`reading-panel-${topic}`}
          aria-labelledby={`reading-tab-${topic}-${selected.id}`}
        >
          <div className="indicator-reading-viewer-head">
            <div className="indicator-reading-meta">
              <b>{selected.title}</b>
              <small className="indicator-reading-citation">{citation(selected)}</small>
              <small>{selected.focus}</small>
            </div>
            <div className="indicator-reading-links">
              {selected.sourceUrl && (
                <a href={selected.sourceUrl} target="_blank" rel="noopener noreferrer">
                  文献来源 <span aria-hidden="true">↗</span>
                </a>
              )}
              <a href={selectedUrl} target="_blank" rel="noopener noreferrer">
                新标签页打开 PDF <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
          {expanded && (
            <>
              <object
                key={selected.id}
                data={`${selectedUrl}#view=FitH`}
                type="application/pdf"
                aria-label={`${selected.title} PDF 预览`}
              >
                <div className="indicator-reading-pdf-fallback" role="status">
                  <b>当前浏览器无法内嵌显示这份 PDF。</b>
                  <a href={selectedUrl} target="_blank" rel="noopener noreferrer">请在新标签页中打开</a>
                </div>
              </object>
              <div className="indicator-reading-preview-help">
                如果预览空白或加载失败，请使用上方“新标签页打开 PDF”；仍无法打开时请联系教师检查文件。
              </div>
            </>
          )}
        </section>
      </div>
    </details>
  );
}
