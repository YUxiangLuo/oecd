/**
 * 讲解卡片体系(移植自 prototype 原型的 teaching blocks):
 * 概念卡 / 公式卡 / 陷阱卡 / 小结卡 / 自检卡 + 区块标题。
 * 内容是纯静态配置(见 regteach.ts),组件只负责渲染与自检展开交互。
 */
import { useState } from "react";

export type TeachBlock =
  | { kind: "concept"; kicker: string; title: string; paras: string[] }
  | { kind: "formula"; tex: string; terms: { sym: string; def: string }[]; note?: string }
  | { kind: "pitfall"; title?: string; items: string[] }
  | { kind: "takeaway"; items: string[] }
  | { kind: "selfcheck"; items: { q: string; a: string }[] };

/** 「📖 讲解」/「🧪 动手实验」这类分区标题(原型的 section header) */
export function SectionHead({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="section-head">
      <span className="section-head-icon">{icon}</span>
      <span>{label}</span>
      <div className="section-head-line" />
    </div>
  );
}

function ConceptCard({ b }: { b: Extract<TeachBlock, { kind: "concept" }> }) {
  return (
    <div className="teach-card teach-concept">
      <div className="teach-kicker">{b.kicker}</div>
      <h3>{b.title}</h3>
      {b.paras.map((p) => <p key={p.slice(0, 24)}>{p}</p>)}
    </div>
  );
}

function FormulaCard({ b }: { b: Extract<TeachBlock, { kind: "formula" }> }) {
  return (
    <div className="teach-card">
      <div className="teach-label">公式 / 定义</div>
      <div className="teach-formula">{b.tex}</div>
      <div className="teach-terms">
        {b.terms.map((t) => (
          <div key={t.sym} className="teach-term">
            <span className="teach-sym">{t.sym}</span>
            <span className="teach-def">{t.def}</span>
          </div>
        ))}
      </div>
      {b.note && <div className="teach-note">{b.note}</div>}
    </div>
  );
}

function PitfallCard({ b }: { b: Extract<TeachBlock, { kind: "pitfall" }> }) {
  return (
    <div className="teach-card teach-pitfall">
      <div className="teach-pitfall-title">⚠️ {b.title ?? "常见陷阱"}</div>
      {b.items.map((it) => (
        <div key={it.slice(0, 24)} className="teach-pitfall-item"><span>●</span>{it}</div>
      ))}
    </div>
  );
}

function TakeawayCard({ b }: { b: Extract<TeachBlock, { kind: "takeaway" }> }) {
  return (
    <div className="teach-card teach-takeaway">
      <div className="teach-takeaway-title">✅ 本步小结</div>
      {b.items.map((it) => (
        <div key={it.slice(0, 24)} className="teach-takeaway-item"><span>▪</span>{it}</div>
      ))}
    </div>
  );
}

function SelfCheckCard({ b }: { b: Extract<TeachBlock, { kind: "selfcheck" }> }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  return (
    <div className="teach-card">
      <div className="teach-label">🎯 自检 · 检验你的理解</div>
      {b.items.map((it, i) => (
        <div key={it.q} className="teach-check">
          <button className="teach-check-q" onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}>
            <span className="teach-check-icon">{open[i] ? "▾" : "▸"}</span>{it.q}
          </button>
          {open[i] && (
            <div className="teach-check-a"><b>答案 · </b>{it.a}</div>
          )}
        </div>
      ))}
    </div>
  );
}

export function TeachCards({ blocks }: { blocks: TeachBlock[] }) {
  return (
    <div className="teach-flow">
      {blocks.map((b, i) => {
        if (b.kind === "concept") return <ConceptCard key={i} b={b} />;
        if (b.kind === "formula") return <FormulaCard key={i} b={b} />;
        if (b.kind === "pitfall") return <PitfallCard key={i} b={b} />;
        if (b.kind === "takeaway") return <TakeawayCard key={i} b={b} />;
        return <SelfCheckCard key={i} b={b} />;
      })}
    </div>
  );
}
