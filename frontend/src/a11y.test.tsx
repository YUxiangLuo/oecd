import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LabeledControl, ScrollableRegion } from "./a11y";
import { CountryPicker } from "./labs/country-picker";

describe("shared accessibility primitives", () => {
  test("associates a visible label with its rendered control", () => {
    const html = renderToStaticMarkup(
      <LabeledControl label="学生">
        {(id) => <select id={id}><option>全部学生</option></select>}
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
