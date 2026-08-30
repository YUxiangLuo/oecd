import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StudentWorkspaceSkipLink,
  focusStepMainContent,
  stepMainContentId,
} from "./student-workspace";

describe("student workspace skip link", () => {
  test("is the first native Tab stop and has one unique current-main target", () => {
    const targetId = stepMainContentId(13);
    const html = renderToStaticMarkup(
      <div>
        <StudentWorkspaceSkipLink targetId={targetId} targetRef={{ current: null }} />
        <button type="button">顶部导航</button>
        <main id={targetId} tabIndex={-1}>本步内容</main>
      </div>,
    );
    expect(html.indexOf("跳到本步内容")).toBeLessThan(html.indexOf("顶部导航"));
    expect(html).toContain(`href="#${targetId}"`);
    expect(html.match(new RegExp(`id="${targetId}"`, "g"))).toHaveLength(1);
    expect(html).toContain('tabindex="-1"');
  });

  test("click or keyboard activation lands focus on the current main reliably", () => {
    let prevented = 0;
    let focused = 0;
    let scrolled = 0;
    focusStepMainContent(
      { preventDefault: () => { prevented += 1; } },
      {
        focus: (options) => {
          focused += 1;
          expect(options).toEqual({ preventScroll: true });
        },
        scrollTo: (options) => {
          scrolled += 1;
          expect(options).toEqual({ top: 0, left: 0, behavior: "auto" });
        },
      },
    );
    expect({ prevented, focused, scrolled }).toEqual({ prevented: 1, focused: 1, scrolled: 1 });
    expect(stepMainContentId(12)).not.toBe(stepMainContentId(13));
  });
});
