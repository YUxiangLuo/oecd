import { CAT, Legend, type Row, cardStyle, countryLabel, num, useTip } from "../shared";

/* ------------------------ 步骤10:前向/后向生产长度对比 ------------------------ */

export function LengthViz({ rows }: { rows: Row[] }) {
  const { wrapRef, Tip, show, hide } = useTip();
  const top = [...rows].sort((a, b) => num(b.PLv) - num(a.PLv)).slice(0, 15);
  const maxLen = Math.max(...top.map((r) => Math.max(num(r.PLv), num(r.PLy))), 1);
  const ticks = Array.from({ length: Math.floor(maxLen) + 1 }, (_, i) => i);
  const tipLines = (r: Row): [string, string][] => [
    ["", countryLabel(String(r.country))],
    ["前向总长度 PLv", num(r.PLv).toFixed(2)],
    ["前向 GVC 段", num(r.PLv_GVC).toFixed(2)],
    ["后向总长度 PLy", num(r.PLy).toFixed(2)],
    ["后向 GVC 段", num(r.PLy_GVC).toFixed(2)],
    ["位置指数 GVCPs", num(r.GVCPs).toFixed(3)],
  ];
  return (
    <div ref={wrapRef} style={cardStyle}>
      <div style={{ marginBottom: 16 }}>
        <Legend items={[{ name: "前向长度 PLv(到最终吸收端)", color: CAT[0] }, { name: "后向长度 PLy(到初始投入端)", color: CAT[1] }]} />
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
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ width: `${(num(r.PLv) / maxLen) * 100}%`, height: 8, background: CAT[0], borderRadius: "0 4px 4px 0" }} />
                <div style={{ width: `${(num(r.PLy) / maxLen) * 100}%`, height: 8, background: CAT[1], borderRadius: "0 4px 4px 0" }} />
              </div>
              <div style={{ width: 78, fontSize: 12.5, fontWeight: 600, color: "#3a4050", fontVariantNumeric: "tabular-nums" }}
                title="GVC 位置指数 = PLv_GVC / PLy_GVC">
                GVCPs {num(r.GVCPs).toFixed(2)}
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
        按前向总生产长度 PLv 排序的 Top 15;GVCPs = 前向/后向 GVC 段长度之比,&gt;1 表示更靠上游(WWYZ 2017b)
      </div>
      {Tip}
    </div>
  );
}
