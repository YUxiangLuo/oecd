/**
 * 选国家控件:可搜索的勾选列表 + 已选 chips。
 * 替代原生 <select multiple>(需要 Ctrl 多选、无搜索、只显示 ISO3 码,课堂可用性差)。
 */
import { useState } from "react";
import { COUNTRY_NAMES, countryLabel } from "../viz";

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
              {countryLabel(code)} ×
            </button>
          ))}
        </div>
      )}
      <div className="country-picker-list" role="listbox" aria-multiselectable="true">
        {shown.map((code) => (
          <label key={code} className="country-picker-row">
            <input type="checkbox" checked={picked.includes(code)} onChange={() => toggle(code)} />
            <b>{code}</b>
            <span>{COUNTRY_NAMES[code] ?? ""}</span>
          </label>
        ))}
        {shown.length === 0 && <div className="muted" style={{ padding: "6px 8px" }}>没有匹配「{query}」的经济体</div>}
      </div>
    </div>
  );
}
