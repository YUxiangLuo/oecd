/**
 * 品牌标识:价值链节点沿虚线"经纬环"逐级攀升,寓意增加值的跨境流动。
 * 顶栏 / 登录页 / 系统介绍共用,尺寸由 size 控制。
 */
import { useId } from "react";

export function LogoMark({ size = 32 }: { size?: number }) {
  const gid = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="供应链仿真系统">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#34309f" />
          <stop offset="100%" stopColor="#12102f" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill={`url(#${gid})`} />
      <circle
        cx="24" cy="25" r="15" fill="none"
        stroke="rgba(255,255,255,0.28)" strokeWidth="1.2" strokeDasharray="2.5 4"
      />
      <path
        d="M13 31 L24 17 L35 27" fill="none"
        stroke="rgba(255,255,255,0.92)" strokeWidth="2.4"
        strokeLinecap="round" strokeLinejoin="round"
      />
      <circle cx="13" cy="31" r="3.4" fill="#8fd3b6" />
      <circle cx="24" cy="17" r="4" fill="#ffffff" />
      <circle cx="35" cy="27" r="3.4" fill="#ffb454" />
    </svg>
  );
}
