import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { FullscreenPanel, FullscreenTriggerSlot, lockFullscreenScroll } from "./fullscreen-panel";
import { SyncProblemContext } from "./sync-problem";

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

describe("FullscreenPanel save problems", () => {
  afterEach(cleanup);

  test("an expanded panel repeats the unsaved-record warning the page banner can no longer show", () => {
    let retried = 0;
    const problem = { error: "网络连接中断", conflict: false, syncing: false, act: () => { retried += 1; } };
    render(
      <SyncProblemContext.Provider value={problem}>
        <FullscreenPanel title="中间投入 Z" buttonLabel="全屏查看"><p>表格</p></FullscreenPanel>
      </SyncProblemContext.Provider>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "全屏查看：中间投入 Z" }));
    const alert = screen.getByRole("dialog").querySelector("[role=alert]");
    expect(alert?.textContent).toContain("实验记录尚未保存到服务器");
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    expect(retried).toBe(1);
  });
});

describe("FullscreenPanel keyboard place", () => {
  afterEach(cleanup);

  test("opening from a cell keeps focus on it, and Escape returns to the cell the reader is on", async () => {
    const cells = <table><tbody><tr><td><button>格 A</button></td><td><button>格 B</button></td></tr></tbody></table>;
    const view = render(<FullscreenPanel title="中间投入 Z" autoExpandSignal={0}>{cells}</FullscreenPanel>);
    screen.getByRole("button", { name: "格 A" }).focus();
    view.rerender(<FullscreenPanel title="中间投入 Z" autoExpandSignal={1}>{cells}</FullscreenPanel>);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("格 A");
    screen.getByRole("button", { name: "格 B" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await Promise.resolve();
    expect(document.activeElement?.textContent).toBe("格 B");
  });

  test("Escape brings the control that keeps focus back into view (it may sit above the restored scroll)", async () => {
    const controls = <label>年份<select defaultValue="2020"><option>2020</option></select></label>;
    const view = render(<FullscreenPanel title="中间投入 Z" autoExpandSignal={0}>{controls}</FullscreenPanel>);
    view.rerender(<FullscreenPanel title="中间投入 Z" autoExpandSignal={1}>{controls}</FullscreenPanel>);
    const select = screen.getByRole("combobox");
    select.focus();
    const scrolled: unknown[] = [];
    select.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => { scrolled.push(options); };
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await Promise.resolve();
    expect(document.activeElement).toBe(select);
    expect(scrolled).toEqual([{ block: "nearest", inline: "nearest" }]);
  });

  test("a panel can place its entry button in its own control row, after the controls before it", () => {
    render(
      <FullscreenPanel title="中间投入 Z" buttonLabel="全屏查看" variant="table" triggerInContent>
        <div className="controls"><select aria-label="年份"><option>2020</option></select><FullscreenTriggerSlot /></div>
      </FullscreenPanel>,
    );
    const year = screen.getByRole("combobox", { name: "年份" });
    const trigger = screen.getByRole("button", { name: "全屏查看：中间投入 Z" });
    expect(trigger.closest(".controls")).toBe(year.closest(".controls"));
    expect(year.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(".fullscreen-panel-bar")).toBeNull();
    fireEvent.click(trigger);
    // Expanded, the slot is empty and the bar carries the exit button.
    expect(screen.queryByRole("button", { name: "全屏查看：中间投入 Z" })).toBeNull();
    expect(screen.getByRole("button", { name: "退出中间投入 Z全屏工作区" })).toBeTruthy();
  });
});
