/**
 * 步骤8-11 富可视化 + 事件研究系数图。
 *
 * 设计遵循 dataviz 方法:类别色按固定槽位分配(已跑 validate_palette.js,
 * 白底最差相邻 CVD ΔE 24.2 通过;aqua/yellow 对比度不足按救济规则以
 * 可见标签 + 表格视图补偿);细标记、段间 2px 留白、悬停 tooltip 不设门槛
 * (所有数值同时可在表格视图读取);文本一律用文字色,不穿系列色。
 */
import { useRef } from "react";

// 固定顺序的类别槽位(经校验的默认调色板,前 6 位)
export const CAT = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948"];
// 顺序色(蓝,浅→深),用于热力表
export const SEQ = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];

export const REGIONS = ["东亚", "东南亚·南亚", "欧洲", "美洲", "中东·非洲", "大洋洲·其他"] as const;
export const REGION_OF: Record<string, number> = {};
(
  [
    ["CHN JPN KOR TWN HKG", 0],
    ["VNM THA MYS IDN PHL SGP KHM LAO MMR BRN IND BGD PAK", 1],
    ["AUT BEL BGR BLR CHE CYP CZE DEU DNK ESP EST FIN FRA GBR GRC HRV HUN IRL ISL ITA LTU LUX LVA MLT NLD NOR POL PRT ROU RUS SVK SVN SWE TUR UKR", 2],
    ["USA CAN MEX ARG BRA CHL COL CRI PER", 3],
    ["SAU ISR JOR EGY MAR TUN NGA ZAF CIV CMR SEN", 4],
    ["AUS NZL KAZ ROW", 5],
  ] as const
).forEach(([codes, r]) => codes.split(" ").forEach((c) => (REGION_OF[c] = r)));

/* ---------------------------------- 共用 ---------------------------------- */

export type Row = Record<string, string | number | null>;
export const num = (v: string | number | null | undefined) => (typeof v === "number" ? v : 0);

/** OECD ICIO 45 行业代码 → 中文名(学生看不懂 C26/H50 这类裸代码,统一映射) */
export const SECTOR_NAMES: Record<string, string> = {
  A01_02: "农林牧业", A03: "渔业", B05_06: "能源矿产开采", B07_08: "金属矿开采", B09: "采矿支持服务",
  C10T12: "食品饮料烟草", C13T15: "纺织服装皮革", C16: "木材制品", C17_18: "造纸印刷", C19: "焦炭与精炼油",
  C20: "化学品", C21: "医药", C22: "橡胶塑料", C23: "非金属矿物制品", C24: "基本金属", C25: "金属制品",
  C26: "计算机电子光学", C27: "电气设备", C28: "机械设备", C29: "汽车及零部件", C30: "其他运输设备",
  C31T33: "家具及其他制造", D: "电力燃气", E: "供水与废弃物", F: "建筑", G: "批发零售",
  H49: "陆路运输", H50: "水路运输", H51: "航空运输", H52: "仓储与运输辅助", H53: "邮政快递",
  I: "住宿餐饮", J58T60: "出版影视广播", J61: "电信", J62_63: "IT与信息服务", K: "金融保险",
  L: "房地产", M: "专业科技服务", N: "行政与支持服务", O: "公共管理与国防", P: "教育",
  Q: "卫生与社会工作", R: "文体娱乐", S: "其他服务", T: "家庭自用生产",
};
/** 行业代码显示名:有映射则 "代码 中文名",否则原样返回;国家代码原样返回 */
export const sectorLabel = (code: string) => (SECTOR_NAMES[code] ? `${code} ${SECTOR_NAMES[code]}` : code);
/** 图元实体名:行业行显示中文名,国家行显示代码 */
export const rowName = (r: Row) => (r.sector != null ? sectorLabel(String(r.sector)) : String(r.country));

/** 暗色悬浮 tooltip(增强通道;全部数值同时可在表格视图获得) */
export function useTip() {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const show = (e: React.MouseEvent, lines: [string, string][]) => {
    const box = boxRef.current, wrap = wrapRef.current;
    if (!box || !wrap) return;
    box.replaceChildren(
      ...lines.map(([label, value], i) => {
        const div = document.createElement("div");
        if (i === 0) { div.style.cssText = "font-weight:700;font-size:12.5px;margin-bottom:3px"; div.textContent = value; }
        else {
          const b = document.createElement("b");
          b.style.cssText = "color:#fff;font-weight:600";
          b.textContent = value;
          const span = document.createElement("span");
          span.style.color = "#c8ccd6";
          span.textContent = `${label} · `;
          div.append(span, b);
        }
        return div;
      }),
    );
    const r = wrap.getBoundingClientRect();
    let x = e.clientX - r.left + 14, y = e.clientY - r.top + 12;
    if (x > r.width - 190) x = e.clientX - r.left - 195;
    box.style.left = `${x}px`; box.style.top = `${y}px`; box.style.opacity = "1";
  };
  const hide = () => { if (boxRef.current) boxRef.current.style.opacity = "0"; };
  const Tip = (
    <div ref={boxRef} style={{
      position: "absolute", pointerEvents: "none", opacity: 0, transition: "opacity .12s",
      background: "#1b1f2b", color: "#fff", padding: "9px 12px", borderRadius: 10,
      fontSize: 11.5, lineHeight: 1.75, boxShadow: "0 8px 24px rgba(0,0,0,.22)", zIndex: 6, minWidth: 150,
    }} />
  );
  return { wrapRef, Tip, show, hide };
}

export function Legend({ items }: { items: { name: string; color: string; line?: boolean }[] }) {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
      {items.map((it) => (
        <div key={it.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={it.line
            ? { width: 14, height: 2, borderRadius: 2, background: it.color }
            : { width: 11, height: 11, borderRadius: 3, background: it.color }} />
          <span style={{ fontSize: 11.5, color: "#5a6070" }}>{it.name}</span>
        </div>
      ))}
    </div>
  );
}

export const cardStyle: React.CSSProperties = {
  position: "relative", background: "#fff", border: "1px solid #e7e9f0",
  borderRadius: 16, padding: "20px 22px",
};

