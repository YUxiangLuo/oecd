import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FullscreenPanel, lockFullscreenScroll } from "./fullscreen-panel";

function scrollTarget(overflow = "", overflowY = "") {
  return { style: { overflow, overflowY } };
}

describe("fullscreen scroll lock", () => {
  test("locks body and the course scroller, then restores their exact styles", () => {
    const body = scrollTarget("clip", "");
    const course = scrollTarget("", "scroll");

    const unlock = lockFullscreenScroll(body, course);
    expect(body.style.overflow).toBe("hidden");
    expect(course.style.overflowY).toBe("hidden");

    unlock();
    expect(body.style.overflow).toBe("clip");
    expect(course.style.overflowY).toBe("scroll");
  });

  test("still locks body when there is no course scroller", () => {
    const body = scrollTarget();
    const unlock = lockFullscreenScroll(body, null);

    expect(body.style.overflow).toBe("hidden");
    unlock();
    expect(body.style.overflow).toBe("");
  });
});

describe("FullscreenPanel inline state", () => {
  test("renders an explicit, contextual entry action", () => {
    const html = renderToStaticMarkup(
      <FullscreenPanel title="指标数据表" buttonLabel="全屏查看">
        <table><tbody><tr><td>42</td></tr></tbody></table>
      </FullscreenPanel>,
    );

    expect(html).toContain("fullscreen-panel-trigger");
    expect(html).toContain("aria-label=\"全屏查看：指标数据表\"");
    expect(html).toContain(">全屏查看</button>");
    expect(html).toContain("<td>42</td>");
  });

  test("keeps the same content wrapper but omits the entry action when disabled", () => {
    const html = renderToStaticMarkup(
      <FullscreenPanel title="账户项" enabled={false}>
        <div>窄表内容</div>
      </FullscreenPanel>,
    );

    expect(html).toContain("fullscreen-panel--workbench");
    expect(html).toContain("tabindex=\"-1\"");
    expect(html).toContain("窄表内容");
    expect(html).not.toContain("fullscreen-panel-trigger");
  });

  test("does not expand during initial render even when an auto signal is present", () => {
    const html = renderToStaticMarkup(
      <FullscreenPanel title="对比工作台" autoExpandSignal={3}>
        <div>已恢复的对比</div>
      </FullscreenPanel>,
    );

    expect(html).toContain("已恢复的对比");
    expect(html).not.toContain("fullscreen-panel--expanded");
    expect(html).not.toContain('role="dialog"');
  });
});
