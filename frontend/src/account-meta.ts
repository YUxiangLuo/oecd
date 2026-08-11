import type { Meta } from "./types";

export const EMPTY_META: Meta = { years: [], countries: [], sectors: [] };

/**
 * 启动一次账号作用域内的 meta 请求，并返回清理函数。
 *
 * fetch 已经发出后未必能立即取消，但账号切换/退出时至少必须阻止旧 Promise
 * 再写入 React 状态；否则旧账号的数据版本会覆盖新账号上下文。
 */
export function beginAccountMetaLoad(
  load: () => Promise<Meta>,
  apply: (meta: Meta) => void,
): () => void {
  let active = true;
  load().then(
    (meta) => {
      if (active) apply(meta);
    },
    () => {
      if (active) apply(EMPTY_META);
    },
  );
  return () => {
    active = false;
  };
}
