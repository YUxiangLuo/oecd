import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { countryMarker } from "../viz";
import { CountryPicker } from "./country-picker";

describe("font-independent country markers", () => {
  test("uses stable ASCII markers instead of regional-indicator emoji", () => {
    expect(countryMarker("CHN")).toBe("CN");
    expect(countryMarker("USA")).toBe("US");
    expect(countryMarker("ROW")).toBe("ROW");
    expect(countryMarker("TWN")).toBe("TWN");

    const html = renderToStaticMarkup(
      <CountryPicker countries={["CHN", "TWN", "ROW"]} picked={["CHN", "TWN"]} onChange={() => {}} />,
    );
    expect(html).toContain('class="country-marker"');
    expect(html).toContain(">CN</span>");
    expect(html).toContain(">ROW</span>");
    // Both the selected chip and the selectable row use the neutral marker.
    expect(html.match(/>TWN<\/span>/g)).toHaveLength(2);
    expect(html).not.toContain(">TW</span>");
    expect(html).toContain("中国台湾");
    expect(html).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u);
  });
});
