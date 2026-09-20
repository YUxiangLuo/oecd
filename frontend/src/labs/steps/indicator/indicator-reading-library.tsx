import { useState } from "react";
import "./indicator-reading-library.css";

export type IndicatorReadingTopic = "trade" | "production" | "length" | "network";

type IndicatorReading = {
  id: string;
  title: string;
  authors: string;
  year: number;
  publication: string;
  focus: string;
  file: string;
  sourceUrl?: string;
};

const pdfUrl = (file: string) => `${import.meta.env.BASE_URL}readings/${file}`;

export const INDICATOR_READINGS: Record<IndicatorReadingTopic, IndicatorReading[]> = {
  trade: [
    {
      id: "trade-decomposition",
      title: "总出口分解与外国增加值占比",
      authors: "课程项目组（示范）",
      year: 2026,
      publication: "界面占位材料",
      focus: "示范：从六项账户分解理解 FVA、FDC 与总出口口径。",
      file: "demo-trade-decomposition.pdf",
    },
    {
      id: "share-interpretation",
      title: "占比指标的国家比较与解释边界",
      authors: "课程项目组（示范）",
      year: 2026,
      publication: "界面占位材料",
      focus: "示范：如何报告百分点差异，同时避免把描述性比较写成因果结论。",
      file: "demo-share-interpretation.pdf",
    },
  ],
  production: [
    {
      id: "production-decomposition",
      title: "GVC 生产活动分解导读",
      authors: "课程项目组（示范）",
      year: 2026,
      publication: "界面占位材料",
      focus: "示范：区分纯国内、传统贸易、简单 GVC 与复杂 GVC 生产路径。",
      file: "demo-production-decomposition.pdf",
    },
  ],
  length: [
    {
      id: "length-position",
      title: "生产长度与 GVC 位置指数导读",
      authors: "课程项目组（示范）",
      year: 2026,
      publication: "界面占位材料",
      focus: "示范：理解增加值加权长度、前向/后向视角及 GVCPs。",
      file: "demo-length-position.pdf",
    },
  ],
  network: [
    {
      id: "network-centrality",
      title: "生产网络中心性指标导读",
      authors: "课程项目组（示范）",
      year: 2026,
      publication: "界面占位材料",
      focus: "示范：区分度、加权度、介数与接近中心性。",
      file: "demo-network-centrality.pdf",
    },
  ],
};

export function IndicatorReadingLibrary({ topic }: { topic: IndicatorReadingTopic }) {
  const readings = INDICATOR_READINGS[topic];
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState(readings[0].id);
  const selected = readings.find((reading) => reading.id === selectedId) ?? readings[0];
  const selectedUrl = pdfUrl(selected.file);

  return (
    <details
      className="indicator-reading-library"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span>
          <b>延伸阅读 · 指标相关文章</b>
          <small>{readings.length} 篇 PDF · 可选阅读，不影响本步完成</small>
        </span>
        <span className="indicator-reading-demo-badge">示范文档</span>
      </summary>
      <div className="indicator-reading-intro">
        当前文件仅用于演示文献组件和教学排版，不是正式学术论文。以后可直接替换 PDF 与文档信息。
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
              <small className="indicator-reading-citation">{reading.authors} · {reading.year} · {reading.publication}</small>
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
              <small className="indicator-reading-citation">{selected.authors} · {selected.year} · {selected.publication}</small>
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
