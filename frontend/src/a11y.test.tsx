import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LabeledControl, ScrollableRegion } from "./a11y";
import { CountryPicker } from "./labs/country-picker";
import { StepFunnel } from "./teacher/charts";

describe("shared accessibility primitives", () => {
  test("associates a visible label with its rendered control", () => {
    const html = renderToStaticMarkup(
      <LabeledControl label="班级">
        {(id) => <select id={id}><option>全部班级</option></select>}
      </LabeledControl>,
    );
    const controlId = html.match(/<label for="([^"]+)"/)?.[1];

    expect(controlId).toBeTruthy();
    expect(html).toContain(`<select id="${controlId}">`);
  });

  test("renders a named, keyboard-focusable scroll region", () => {
    const html = renderToStaticMarkup(
      <ScrollableRegion label="数据表，可横向滚动">
        <table><tbody><tr><td>值</td></tr></tbody></table>
      </ScrollableRegion>,
    );

    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="数据表，可横向滚动"');
  });

  test("uses checkbox-group semantics for the country picker", () => {
    const html = renderToStaticMarkup(
      <CountryPicker countries={["CHN", "USA"]} picked={["CHN"]} onChange={() => {}} />,
    );

    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="国家选择列表"');
    expect(html).not.toContain('role="listbox"');
  });
});

describe("teacher progress funnel semantics", () => {
  test("keeps interactive points inside a named group rather than an image", () => {
    const html = renderToStaticMarkup(
      <StepFunnel
        steps={[{ step: 1, reached: 3 }, { step: 2, reached: 2 }]}
        completions={[{ step: 1, completed: 2 }, { step: 2, completed: 1 }]}
        total={3}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain('class="funnel-svg" role="group"');
    expect(html).not.toContain('class="funnel-svg" role="img"');
    expect(html.match(/role="button"/g)?.length).toBe(4);
    expect(html).toContain("各步到达人数与服务端判定完成人数");
  });
});
