import { countryLabel } from "../../../viz";
import { CAT } from "../../../viz/shared";
import { changeReading, finiteValue } from "./indicator-model";
import type { Row } from "./scaffold";

export const indicatorNumber = (value: number | null, unit: string) =>
  value === null
    ? "缺失"
    : `${(unit === "%" ? value * 100 : value).toLocaleString("zh-CN", { maximumFractionDigits: 3 })}${unit === "%" ? "%" : ""}`;

interface ComparisonReading {
  country: string;
  year: number;
  value: number | null;
}

export function ComparisonSummary({
  readings,
  countries,
  years,
  unit,
}: {
  readings: ComparisonReading[];
  countries: string[];
  years: number[];
  unit: string;
}) {
  if (countries.length !== 2) return null;
  const common = years.filter((year) =>
    countries.every((country) =>
      readings.some(
        (item) =>
          item.country === country && item.year === year && item.value !== null,
      ),
    ),
  );
  if (common.length < 2) {
    return <p className="muted">共同有效年份不足，暂不比较两国的期间变化。</p>;
  }
  const firstYear = common[0];
  const lastYear = common.at(-1)!;
  const value = (country: string, year: number) =>
    readings.find((item) => item.country === country && item.year === year)!
      .value!;
  const starts = countries.map((country) => value(country, firstYear));
  const ends = countries.map((country) => value(country, lastYear));
  const startGap = starts[0] - starts[1];
  const endGap = ends[0] - ends[1];
  const gapChange = Math.abs(endGap) - Math.abs(startGap);
  const gapMagnitude = unit === "%"
    ? `${(Math.abs(gapChange) * 100).toLocaleString("zh-CN", { maximumFractionDigits: 3 })} 个百分点`
    : indicatorNumber(Math.abs(gapChange), unit);
  const reversed = startGap !== 0 && endGap !== 0 && Math.sign(startGap) !== Math.sign(endGap);
  const gapStory = reversed
    ? "领先方反转"
    : Math.abs(gapChange) < 1e-12
      ? "差距基本不变"
      : gapChange > 0
        ? `差距扩大 ${gapMagnitude}`
        : `差距缩小 ${gapMagnitude}`;
  return (
    <div className="comparison-summary" aria-label="两国趋势结论">
      {countries.map((country, index) => (
        <div key={country}>
          <span>{countryLabel(country)} · {firstYear}→{lastYear}</span>
          <b>{changeReading(starts[index], ends[index], unit)}</b>
          <small>{indicatorNumber(starts[index], unit)} → {indicatorNumber(ends[index], unit)}</small>
        </div>
      ))}
      <div>
        <span>{lastYear} 年 A−B</span>
        <b>{changeReading(ends[1], ends[0], unit)}</b>
        <small>{countryLabel(countries[0])} 相对 {countryLabel(countries[1])}</small>
      </div>
      <div>
        <span>{firstYear}→{lastYear} 两国差距</span>
        <b>{gapStory}</b>
        <small>比较差距绝对值，不代表因果关系</small>
      </div>
    </div>
  );
}

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
  const readings = countries.flatMap((country, index) =>
    series[index].map((point) => ({ country, ...point })),
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
        {countries.map((country, index) => (
          <g key={`legend-${country}`} transform={`translate(${455 + index * 145} 16)`}>
            <line x1={0} x2={24} y1={0} y2={0} stroke={CAT[index]} strokeWidth={2.5} strokeDasharray={index ? "7 4" : undefined} />
            <circle cx={12} cy={0} r={4} fill={CAT[index]} />
            <text x={31} y={4} fontSize={12} fill="#374151">{countryLabel(country)}</text>
          </g>
        ))}
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
      <ComparisonSummary readings={readings} countries={countries} years={common} unit={unit} />
    </section>
  );
}

export function LengthPositionTrajectory({
  rows,
  countries,
  years,
}: {
  rows: Row[];
  countries: string[];
  years: number[];
}) {
  const series = countries.map((country) =>
    years.flatMap((year, yearIndex) => {
      const row = rows.find(
        (item) => item.country === country && item.year === year,
      );
      return finiteValue(row?.PLy_GVC) && finiteValue(row?.PLv_GVC)
        ? [{ year, yearIndex, x: row.PLy_GVC, y: row.PLv_GVC }]
        : [];
    }),
  );
  const values = series.flatMap((points) =>
    points.flatMap((point) => [point.x, point.y]),
  );
  if (!values.length) return null;
  const rawLo = Math.min(0, ...values);
  const rawHi = Math.max(0, ...values);
  const padding = (rawHi - rawLo || 1) * 0.06;
  const lo = rawLo < 0 ? rawLo - padding : 0;
  const hi = rawHi + padding;
  const extent = hi - lo || 1;
  const scale = (value: number) => ((value - lo) / extent) * 540;
  const x = (value: number) => 120 + scale(value);
  const y = (value: number) => 590 - scale(value);
  return (
    <section aria-label="前后向生产长度位置轨迹">
      <h4>前向—后向位置轨迹 · 时间与国家对照</h4>
      <p className="muted">
        横轴是后向 GVC 段长度，纵轴是前向 GVC 段长度；箭头从较早年份指向较晚年份。等长线上方表示前向段相对更长。
      </p>
      <svg
        viewBox="0 0 720 650"
        role="img"
        aria-label={`前向与后向GVC段长度历年轨迹，${countries.map(countryLabel).join("与")}`}
        style={{ width: "100%", maxHeight: 520, display: "block" }}
      >
        <defs>
          {countries.map((country, index) => (
            <marker key={country} id={`length-arrow-${index}`} markerWidth="12" markerHeight="8" refX="11" refY="4" orient="auto" viewBox="0 0 12 8">
              <path d="M0,0 L8,4 L0,8 z" fill={CAT[index]} />
            </marker>
          ))}
        </defs>
        {series.map((points, index) => (
          <g key={`legend-${countries[index]}`} transform={`translate(125 ${18 + index * 24})`}>
            <line x1={0} x2={28} y1={0} y2={0} stroke={CAT[index]} strokeWidth={2.5} markerEnd={`url(#length-arrow-${index})`} />
            <text x={38} y={4} fontSize={12} fill="#374151">
              {countryLabel(countries[index])}{points.length ? ` · ${points[0].year}→${points.at(-1)!.year}` : ""}
            </text>
          </g>
        ))}
        <g transform="translate(430 18)">
          <circle cx={0} cy={0} r={5} fill="white" stroke="#596173" strokeWidth={2} />
          <text x={10} y={4} fontSize={11} fill="#596173">起点</text>
          <circle cx={58} cy={0} r={5} fill="#596173" />
          <text x={68} y={4} fontSize={11} fill="#596173">终点</text>
        </g>
        {[0, 1, 2, 3, 4].map((tick) => {
          const tickValue = lo + (extent * tick) / 4;
          return <g key={tick}>
            <line x1={120} x2={660} y1={y(tickValue)} y2={y(tickValue)} stroke="#e2e5ee" />
            <line x1={x(tickValue)} x2={x(tickValue)} y1={50} y2={590} stroke="#e2e5ee" />
            <text x={110} y={y(tickValue) + 4} textAnchor="end" fontSize={12}>{indicatorNumber(tickValue, "生产阶段")}</text>
            <text x={x(tickValue)} y={615} textAnchor="middle" fontSize={12}>{indicatorNumber(tickValue, "生产阶段")}</text>
          </g>;
        })}
        <line x1={x(lo)} y1={y(lo)} x2={x(hi)} y2={y(hi)} stroke="#8a6415" strokeDasharray="6 4" />
        <text x={650} y={y(hi) + 18} textAnchor="end" fontSize={11}>前向 = 后向</text>
        <text x={390} y={642} textAnchor="middle" fontSize={12}>后向 GVC 段长度</text>
        <text x={18} y={320} textAnchor="middle" fontSize={12} transform="rotate(-90 18 320)">前向 GVC 段长度</text>
        {series.map((points, countryIndex) => (
          <g key={countries[countryIndex]}>
            {points.map((point, index) => {
              const next = points[index + 1];
              const connectsToNext = next?.yearIndex === point.yearIndex + 1;
              const endpoint = index === 0 || index === points.length - 1;
              return <g key={point.year}>
                {connectsToNext && <line data-series={countries[countryIndex]} x1={x(point.x)} y1={y(point.y)} x2={x(next.x)} y2={y(next.y)} stroke={CAT[countryIndex]} strokeWidth={2.5} markerEnd={index === points.length - 2 ? `url(#length-arrow-${countryIndex})` : undefined} />}
                <circle
                  cx={x(point.x)}
                  cy={y(point.y)}
                  r={endpoint ? 5 : 3.5}
                  fill={index === 0 ? "white" : CAT[countryIndex]}
                  stroke={CAT[countryIndex]}
                  strokeWidth={index === 0 ? 2.5 : 1}
                >
                  <title>{`${countryLabel(countries[countryIndex])} · ${point.year}：后向 ${indicatorNumber(point.x, "生产阶段")}；前向 ${indicatorNumber(point.y, "生产阶段")}`}</title>
                </circle>
              </g>;
            })}
          </g>
        ))}
      </svg>
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
