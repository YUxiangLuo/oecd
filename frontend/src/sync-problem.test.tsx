import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SyncProblemBanner } from "./sync-problem";

const base = { error: "保存失败：教学服务暂时不可用，请稍后重试。", conflict: false, syncing: false, act: () => {} };

test("a failed save says whether it will be sent again on its own", () => {
  expect(renderToStaticMarkup(<SyncProblemBanner problem={{ ...base, autoRetry: true }} />)).toContain("本页内容还在，系统会自动重试，也可以现在重试");
  expect(renderToStaticMarkup(<SyncProblemBanner problem={base} />)).toContain("本页内容还在，可以直接重试");
});
