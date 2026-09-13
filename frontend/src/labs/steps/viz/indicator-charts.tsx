import { countryLabel } from "../../../viz";
import { CAT } from "../../../viz/shared";
import { changeReading, finiteValue } from "./indicator-model";
import type { Row } from "./scaffold";

export const indicatorNumber = (value: number | null, unit: string) =>
  value === null
    ? "缺失"
    : `${(unit === "%" ? value * 100 : value).toLocaleString("zh-CN", { maximumFractionDigits: 3 })}${unit === "%" ? "%" : ""}`;

/** Include zero and negative values; both countries always share the same scale. */
export function IndicatorTrendChart({
  rows,
  countries,
  years,
  metric,
  label,
  unit,
}: {
  rows: Row[];
  countries: string[];
  years: number[];
  metric: string;
  label: string;
  unit: string;
}) {
  const series = countries.map((country) =>
    years.map((year) => {
      const value = rows.find(
        (row) => row.country === country && row.year === year,
      )?.[metric];
      return { year, value: finiteValue(value) ? value : null };
    }),
  );
  const values = series.flatMap((points) =>
    points.flatMap((point) => (point.value === null ? [] : [point.value])),
  );
  if (!values.length)
    return <p role="status">该指标没有有效读数，请更换国家、行业或年份。</p>;
  const lo = Math.min(0, ...values),
    hi = Math.max(
      0,
      ...values,
      metric === "GVCPs" || metric === "Pos_TPL" ? 1 : 0,
    );
  const extent = hi - lo || 1;
  const y = (value: number) => 250 - ((value - lo) / extent) * 210;
  const x = (year: number) =>
    110 + ((year - years[0]) / Math.max(1, years.at(-1)! - years[0])) * 620;
  const common = years.filter((_, i) =>
    series.every((points) => points[i].value !== null),
  );
  return (
    <section aria-label={`${label}趋势图`}>
      <h4>
        {label} · {unit}
      </h4>
      <svg
        viewBox="0 0 780 295"
        role="img"
        aria-label={`${label}历年变化；缺失不补零，详细读数见下方`}
        style={{ width: "100%", display: "block" }}
      >
        {[0, 1, 2, 3, 4].map((tick) => (
          <g key={tick}>
            <line
              x1={110}
              x2={730}
              y1={y(lo + (extent * tick) / 4)}
              y2={y(lo + (extent * tick) / 4)}
              stroke="#e2e5ee"
            />
            <text
              x={100}
              y={y(lo + (extent * tick) / 4) + 4}
              textAnchor="end"
              fontSize={12}
              fill="#596173"
            >
              {indicatorNumber(lo + (extent * tick) / 4, unit)}
            </text>
          </g>
        ))}
        {(metric === "GVCPs" || metric === "Pos_TPL") && (
          <g>
            <line
              x1={110}
              x2={730}
              y1={y(1)}
              y2={y(1)}
              stroke="#966500"
              strokeDasharray="6 4"
            />
            <text x={730} y={y(1) - 5} textAnchor="end" fontSize={11}>
              位置基准 = 1
            </text>
          </g>
        )}
        {years.map((year) => (
          <text
            key={year}
            x={x(year)}
            y={278}
            textAnchor="middle"
            fontSize={12}
          >
            {year}
          </text>
        ))}
        {series.map((points, index) => (
          <g key={countries[index]}>
            {points.map((point, i) =>
              point.value === null ? null : (
                <g key={point.year}>
                  {i > 0 && points[i - 1].value !== null && (
                    <line
                      data-series={countries[index]}
                      x1={x(points[i - 1].year)}
                      y1={y(points[i - 1].value!)}
                      x2={x(point.year)}
                      y2={y(point.value)}
                      stroke={CAT[index]}
                      strokeWidth={2.5}
                      strokeDasharray={index ? "7 4" : undefined}
                    />
                  )}
                  <circle
                    cx={x(point.year)}
                    cy={y(point.value)}
                    r={4}
                    fill={CAT[index]}
                  >
                    <title>{`${countryLabel(countries[index])} · ${point.year}：${indicatorNumber(point.value, unit)}`}</title>
                  </circle>
                </g>
              ),
            )}
          </g>
        ))}
      </svg>
      <p className="muted">
        {common.length >= 2
          ? `${common[0]}–${common.at(-1)}（共同有效起止年）：${countries.map((country, index) => `${countryLabel(country)} ${changeReading(series[index].find((p) => p.year === common[0])!.value!, series[index].find((p) => p.year === common.at(-1))!.value!, unit)}`).join("；")}`
          : "共同有效年份不足，暂不计算期间变化。"}
        {countries.length === 2 &&
          common.length > 0 &&
          `；${common.at(-1)} 年差距（A−B）：${changeReading(series[1].find((p) => p.year === common.at(-1))!.value!, series[0].find((p) => p.year === common.at(-1))!.value!, unit)}`}
      </p>
    </section>
  );
}

export function IndicatorPairBars({
  groups,
  countries,
  unit,
  onPick,
}: {
  groups: { key: string; label: string; values: (number | null)[] }[];
  countries: string[];
  unit: string;
  onPick?: (key: string) => void;
}) {
  const values = groups.flatMap((group) => group.values.filter(finiteValue));
  const lo = Math.min(0, ...values),
    hi = Math.max(0, ...values),
    extent = hi - lo || 1;
  const zero = (-lo / extent) * 100;
  return (
    <div aria-label="同刻度比较条形图" role="region">
      {groups.map((group) => (
        <div
          key={group.key}
          style={{ padding: "12px 0", borderBottom: "1px solid #e3e7ee" }}
        >
          {onPick ? (
            <button className="secondary" onClick={() => onPick(group.key)}>
              查看 {group.label} 的历年变化 →
            </button>
          ) : (
            <b>{group.label}</b>
          )}
          {group.values.map((value, i) => (
            <div
              key={countries[i]}
              style={{
                display: "grid",
                gridTemplateColumns: "50px minmax(80px, 1fr) 130px",
                gap: 10,
                alignItems: "center",
                paddingTop: 7,
              }}
            >
              <span>{countries[i]}</span>
              <div
                style={{
                  position: "relative",
                  height: 18,
                  background: "#f0f3f8",
                }}
                aria-hidden="true"
              >
                <span
                  style={{
                    position: "absolute",
                    left: `${zero}%`,
                    borderLeft: "1px solid #566173",
                    height: "100%",
                  }}
                />
                {value !== null && (
                  <span
                    style={{
                      position: "absolute",
                      left: `${((Math.min(0, value) - lo) / extent) * 100}%`,
                      width: `${(Math.abs(value) / extent) * 100}%`,
                      height: "100%",
                      background: CAT[i],
                      border: i ? "1px dashed #145840" : undefined,
                    }}
                  />
                )}
              </div>
              <span
                style={{
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {indicatorNumber(value, unit)}
              </span>
            </div>
          ))}
        </div>
      ))}
      <p className="muted">单位：{unit}；共同零轴，负值向左，缺失值不补零。</p>
    </div>
  );
}
