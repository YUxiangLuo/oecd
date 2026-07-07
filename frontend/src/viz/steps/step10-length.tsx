import { CAT, Legend, type Row, cardStyle, num, useTip } from "../shared";

/* ---------------------------- 步骤10:长度分段条 ---------------------------- */

export function LengthViz({ rows }: { rows: Row[] }) {
  const { wrapRef, Tip, show, hide } = useTip();
  const top = [...rows].sort((a, b) => num(b.PLv) - num(a.PLv)).slice(0, 15);
  const maxLen = Math.max(...top.map((r) => num(r.PLv)), 1);
  const ticks = Array.from({ length: Math.floor(maxLen) + 1 }, (_, i) => i);
  const tipLines = (r: Row): [string, string][] => [
    ["", String(r.country)],
    ["PLv 前向总长度", num(r.PLv).toFixed(2)],
    ["PLv_D 前向国内段", num(r.PLv_D).toFixed(2)],
    ["PLv_RT 前向传统贸易段", num(r.PLv_RT).toFixed(2)],
    ["PLv_GVC 前向 GVC 长度", num(r.PLv_GVC).toFixed(2)],
    ["PLy 后向总长度", num(r.PLy).toFixed(2)],
    ["GVCPs", num(r.GVCPs).toFixed(2)],
  ];
  return (
    <div ref={wrapRef} style={cardStyle}>
      <div style={{ marginBottom: 16 }}>
        <Legend items={[
          { name: "国内生产段", color: CAT[0] },
          { name: "传统贸易段", color: CAT[1] },
          { name: "GVC 段", color: CAT[2] },
        ]} />
      </div>
      <div style={{ position: "relative" }}>
        <div style={{ position: "absolute", inset: 0, left: 56, right: 56, pointerEvents: "none" }}>
          {ticks.map((t) => (
            <div key={t} style={{
              position: "absolute", top: 0, bottom: 0, left: `${(t / maxLen) * 100}%`,
              borderLeft: "1px solid #f0f1f6",
            }} />
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 11, position: "relative" }}>
          {top.map((r) => (
            <div key={String(r.country)} style={{ display: "flex", alignItems: "center", gap: 12 }}
              onMouseEnter={(e) => show(e, tipLines(r))}
              onMouseMove={(e) => show(e, tipLines(r))} onMouseLeave={hide}>
              <div style={{ width: 44, fontSize: 12, fontWeight: 500, textAlign: "right" }}>{String(r.country)}</div>
              <div style={{ flex: 1, display: "flex", height: 16, gap: 2 }}>
                <div style={{ width: `${(num(r.PLv_D) / maxLen) * 100}%`, background: CAT[0] }} />
                <div style={{ width: `${(num(r.PLv_RT) / maxLen) * 100}%`, background: CAT[1] }} />
                <div style={{
                  width: `${(num(r.PLv_GVC) / maxLen) * 100}%`, background: CAT[2],
                  borderRadius: "0 4px 4px 0",
                }} />
              </div>
              <div style={{ width: 44, fontSize: 12.5, fontWeight: 600, color: "#3a4050", fontVariantNumeric: "tabular-nums" }}>
                {num(r.PLv).toFixed(2)}
              </div>
            </div>
          ))}
        </div>
        <div style={{ position: "relative", height: 18, marginTop: 6, marginLeft: 56, marginRight: 56 }}>
          {ticks.map((t) => (
            <span key={t} style={{
              position: "absolute", left: `${(t / maxLen) * 100}%`, transform: "translateX(-50%)",
              fontSize: 10.5, color: "#b0b5c2", fontVariantNumeric: "tabular-nums",
            }}>{t}</span>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 12, fontSize: 11, color: "#a2a8b6" }}>
        按 PLv 排序的 Top 15;条形总长 = 前向总生产长度
      </div>
      {Tip}
    </div>
  );
}
