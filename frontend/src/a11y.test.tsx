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
    const dom = document.createElement("div");
    dom.innerHTML = html;
    const group = dom.querySelector(".labeled-control");
    expect(group?.querySelector("label")).toBeTruthy();
    expect(group?.querySelector("select")).toBeTruthy();
  });

  test("renders a named, keyboard-focusable scroll region by default", () => {
    const html = renderToStaticMarkup(
      <ScrollableRegion label="数据表，可横向滚动">
        <table><tbody><tr><td>值</td></tr></tbody></table>
      </ScrollableRegion>,
    );

    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="数据表，可横向滚动"');
  });

  test("allows a composite child to own the only sequential Tab stop", () => {
    const html = renderToStaticMarkup(
      <ScrollableRegion label="复合数据表" focusable={false}>
        <button tabIndex={0}>活动单元格</button>
      </ScrollableRegion>,
    );

    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="复合数据表"');
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain('tabindex="-1"');
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
