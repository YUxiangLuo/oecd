import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SyncProblemBanner } from "./sync-problem";

const base = { error: "保存失败：教学服务暂时不可用，请稍后重试。", conflict: false, syncing: false, act: () => {} };

test("a failed save says whether it will be sent again on its own", () => {
  for (const compact of [false, true]) {
    const markup = renderToStaticMarkup(<SyncProblemBanner problem={base} compact={compact} />);
    expect(markup).toContain("尚未确认保存成功");
    expect(markup).not.toContain("尚未保存到服务器");
  }
  expect(renderToStaticMarkup(<SyncProblemBanner problem={{ ...base, autoRetry: true }} />)).toContain("本页内容还在，系统会自动重试，也可以现在重试");
  expect(renderToStaticMarkup(<SyncProblemBanner problem={base} />)).toContain("本页内容还在，可以直接重试");
});

test("a conflict warns that reloading discards unsaved edits, including in fullscreen", () => {
  for (const compact of [false, true]) {
    const markup = renderToStaticMarkup(<SyncProblemBanner problem={{ ...base, conflict: true }} compact={compact} />);
    // A restored draft without its old merge base can also block unrelated edits.
    expect(markup).toContain("服务器版本已变化");
    expect(markup).not.toContain("同一份材料");
    expect(markup).toContain("复制");
    expect(markup).toContain("丢弃本页修改并载入服务器版本");
    expect(markup).not.toContain("合并保留");
  }
});
