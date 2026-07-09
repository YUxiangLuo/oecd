import type { ClassOverview } from "../types";

/** 教师概览用的自足 SVG 小图表(纯 SVG,随容器缩放)。配色取全局 token。 */

const INDIGO = "#4b47e0";
const INDIGO_L = "#7a6bff";
const GREEN = "#12a150";
const AMBER = "#eda100";
const TRACK = "#eef0f5";

/** 评阅进度环图:已评阅 vs 待评阅(占已提交)。 */
export function GradingDonut({ submitted, graded }: { submitted: number; graded: number }) {
  const pending = Math.max(0, submitted - graded);
  const r = 54;
  const c = 2 * Math.PI * r;
  const gradedLen = submitted ? (graded / submitted) * c : 0;
  const pct = submitted ? Math.round((graded / submitted) * 100) : 0;
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 140 140" className="donut-svg" role="img" aria-label={`已评阅 ${graded} / 已提交 ${submitted}`}>
        <circle cx="70" cy="70" r={r} fill="none" stroke={TRACK} strokeWidth="16" />
        {submitted > 0 && (
          <circle
            cx="70"
            cy="70"
            r={r}
            fill="none"
            stroke={GREEN}
            strokeWidth="16"
            strokeLinecap="round"
            strokeDasharray={`${gradedLen} ${c - gradedLen}`}
            strokeDashoffset={c / 4}
            transform="rotate(-90 70 70)"
          />
        )}
        <text x="70" y="66" textAnchor="middle" className="donut-num">
          {pct}%
        </text>
        <text x="70" y="86" textAnchor="middle" className="donut-cap">
          已评阅
        </text>
      </svg>
      <div className="donut-legend">
        <span>
          <i style={{ background: GREEN }} />
          已评阅 {graded}
        </span>
        <span>
          <i style={{ background: AMBER }} />
          待评阅 {pending}
        </span>
      </div>
    </div>
  );
}

/** 近 14 天提交/评阅趋势:双序列折线 + 提交面积。 */
export function TrendChart({ data }: { data: ClassOverview["submission_trend"] }) {
  const W = 560;
  const H = 170;
  const pad = { l: 28, r: 12, t: 14, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = Math.max(1, ...data.flatMap((d) => [d.submitted, d.graded]));
  const x = (i: number) => pad.l + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const line = (key: "submitted" | "graded") =>
    data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(d[key]).toFixed(1)}`).join(" ");
  const area = `${line("submitted")} L ${x(data.length - 1).toFixed(1)} ${pad.t + ih} L ${x(0).toFixed(1)} ${pad.t + ih} Z`;
  const ticks = [0, max];
  return (
    <div className="chart-scroll">
      <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg" role="img" aria-label="近 14 天提交与评阅趋势">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={TRACK} />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" className="axis-lab">
              {t}
            </text>
          </g>
        ))}
        <path d={area} fill={INDIGO} opacity="0.1" />
        <path d={line("submitted")} fill="none" stroke={INDIGO} strokeWidth="2" />
        <path d={line("graded")} fill="none" stroke={GREEN} strokeWidth="2" strokeDasharray="4 3" />
        {data.map((d, i) =>
          i % 2 === 0 || i === data.length - 1 ? (
            <text key={d.date} x={x(i)} y={H - 6} textAnchor="middle" className="axis-lab">
              {d.date}
            </text>
          ) : null,
        )}
      </svg>
      <div className="chart-legend">
        <span>
          <i style={{ background: INDIGO }} />
          提交
        </span>
        <span>
          <i style={{ background: GREEN }} />
          评阅
        </span>
      </div>
    </div>
  );
}

/** 各步到达漏斗:17 步到达人数面积图。 */
export function StepFunnel({ steps, total }: { steps: ClassOverview["step_completion"]; total: number }) {
  const W = 560;
  const H = 150;
  const pad = { l: 24, r: 12, t: 12, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const denom = Math.max(1, total);
  const x = (i: number) => pad.l + (i / (steps.length - 1)) * iw;
  const y = (v: number) => pad.t + ih - (v / denom) * ih;
  const line = steps.map((s, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(s.reached).toFixed(1)}`).join(" ");
  const area = `${line} L ${x(steps.length - 1).toFixed(1)} ${pad.t + ih} L ${x(0).toFixed(1)} ${pad.t + ih} Z`;
  return (
    <div className="chart-scroll">
      <svg viewBox={`0 0 ${W} ${H}`} className="funnel-svg" role="img" aria-label="各步到达人数">
        <defs>
          <linearGradient id="funnelFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={INDIGO_L} stopOpacity="0.35" />
            <stop offset="100%" stopColor={INDIGO} stopOpacity="0.05" />
          </linearGradient>
        </defs>
        <line x1={pad.l} x2={W - pad.r} y1={y(denom)} y2={y(denom)} stroke={TRACK} strokeDasharray="3 3" />
        <text x={pad.l - 4} y={y(denom) + 3} textAnchor="end" className="axis-lab">
          {denom}
        </text>
        <path d={area} fill="url(#funnelFill)" />
        <path d={line} fill="none" stroke={INDIGO} strokeWidth="2" />
        {steps.map((s, i) => (
          <circle key={s.step} cx={x(i)} cy={y(s.reached)} r="2.4" fill={INDIGO} />
        ))}
        {steps.map((s, i) => (
          <text key={s.step} x={x(i)} y={H - 6} textAnchor="middle" className="axis-lab">
            {s.step}
          </text>
        ))}
      </svg>
    </div>
  );
}
