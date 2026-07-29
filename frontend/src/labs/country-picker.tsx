/**
 * 选国家控件:可搜索的勾选列表 + 已选 chips。
 * 替代原生 <select multiple>(需要 Ctrl 多选、无搜索、只显示 ISO3 码,课堂可用性差)。
 *
 * 高度由外层容器决定:列表 flex:1 + 内部滚动,因此可以和右侧图表并排等高
 * (见 viz/scaffold 的 VizWorkbench)。国旗只是视觉锚点,搜索仍按代码/中文名匹配。
 */
import { useState } from "react";
import { COUNTRY_NAMES, countryFlag, countryLabel } from "../viz";

export function CountryPicker({ countries, picked, onChange }: {
  countries: string[];
  picked: string[];
  onChange: (picked: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = countries.filter((code) =>
    !q || code.toLowerCase().includes(q) || (COUNTRY_NAMES[code] ?? "").toLowerCase().includes(q),
  );
  const toggle = (code: string) =>
    onChange(picked.includes(code) ? picked.filter((c) => c !== code) : [...picked, code]);

  return (
    <div className="country-picker">
      <div className="country-picker-head">
        <input
          type="search"
          value={query}
          placeholder="搜索代码或中文名…"
          aria-label="搜索国家"
          onChange={(e) => setQuery(e.target.value)}
        />
        {picked.length > 0 && (
          <button type="button" className="country-picker-clear" onClick={() => onChange([])}>清空</button>
        )}
      </div>
      {picked.length > 0 && (
        <div className="country-picker-chips">
          {picked.map((code) => (
            <button type="button" key={code} className="country-chip" title="点击移除"
              onClick={() => toggle(code)}>
              <span className="country-flag" aria-hidden="true">{countryFlag(code)}</span>
              {countryLabel(code)} ×
            </button>
          ))}
        </div>
      )}
      <div className="country-picker-list" role="group" aria-label="国家选择列表">
        {shown.map((code) => (
          <label key={code} className={`country-picker-row${picked.includes(code) ? " on" : ""}`}>
            <input type="checkbox" checked={picked.includes(code)} onChange={() => toggle(code)} />
            <span className="country-flag" aria-hidden="true">{countryFlag(code)}</span>
            <b>{code}</b>
            <span className="country-picker-name">{COUNTRY_NAMES[code] ?? ""}</span>
          </label>
        ))}
        {shown.length === 0 && <div className="muted" style={{ padding: "6px 8px" }}>没有匹配「{query}」的经济体</div>}
      </div>
    </div>
  );
}
