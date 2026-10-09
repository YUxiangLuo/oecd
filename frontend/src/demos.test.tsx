import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "./api";
import { buildDecompositionModel, type DecompositionModel, type DecompositionSpec } from "./decomposition-model";
import {
  ClosenessPathTable,
  DecompositionDemo,
  DecompositionDetailTable,
  DecompositionRequestMessage,
  IndicatorCalculationDisclosure,
  PANEL_ROUNDING_NOTE,
  amountAt,
  NetworkCentralityDemo,
  betweennessExamplePair,
  betweennessExampleSentence,
  decompositionModelReason,
  displayedRowsAddUp, displayedSumNote,
  fmt,
  formulaAmount,
  networkDemoKeyTransition,
  networkDemoNodeAccessibleName,
  nextNetworkDemoNode,
  panelAmountDecimals,
  ratioOperands,
  sumText,
  teachingBetweennessPairs,
  teachingNetworkCentralitySnapshot,
  teachingNetworkEdgesForNode,
  unavailableDashNote,
  unavailableTotalNote,
  zeroTotalDecompositionHint,
} from "./demos";
import type { Meta } from "./types";

const meta: Meta = {
  years: [2019, 2020],
  countries: ["CHN", "USA"],
  sectors: ["T"],
  dataset: null,
};
const directAmount: DecompositionSpec = {
  total: "total",
  parts: [{ key: "a" }, { key: "b" }],
};

afterEach(cleanup);

describe("zero-total decomposition copy", () => {
  test("reserves structural or inactive context for a complete all-zero row", () => {
    const model = buildDecompositionModel({ total: 0, a: 0, b: 0 }, directAmount);
    const allZero = decompositionModelReason(model);
    const hint = zeroTotalDecompositionHint(model, "总出口");
    expect(allZero).toContain("所有分项都是 0");
    expect(allZero).toContain("可能没有相关活动");
    expect(hint).toContain("所有分项都是 0");
    expect(hint).toContain("请换一个行业");
  });

  test("describes signed offsets without a false all-zero, structural, or inactive claim", () => {
    const model = buildDecompositionModel({ total: 0, a: 2, b: -2 }, directAmount);
    const copy = [
      decompositionModelReason(model),
      zeroTotalDecompositionHint(model, "总出口"),
    ].join(" ");
    expect(copy).toContain("正负分项相互抵消");
    expect(copy).toContain("无法算比重");
    expect(copy).not.toContain("所有分项都是 0");
    expect(copy).not.toContain("没有相关活动");
    expect(copy).not.toContain("换一个行业");
  });
});

describe("indicator calculation disclosure", () => {
  test("shows the Step 2 FVA share formula with independently substituted values", () => {
    const html = renderToStaticMarkup(
      <IndicatorCalculationDisclosure step={4} row={{ FVA: 20, gross_exports: 80 }} />,
    );
    expect(html).toContain("外国增加值项占比 = FVA / 总出口");
    expect(html).toContain("= 20.00 / 80.00 = <b>25.000%</b>");
    expect(html).toContain("FVA 不包括外国重复计算 FDC");
  });

  test("keeps every integer digit of large operands so they match the displayed total", () => {
    const html = renderToStaticMarkup(
      <IndicatorCalculationDisclosure step={4} row={{ FVA: 88206.5, gross_exports: 1067093.2 }} />,
    );
    expect(html).toContain("= 88,207 / 1,067,093 = <b>8.266%</b>");
  });

  test("shows the Step 3 complex-GVC share rather than the total GVC share", () => {
    const html = renderToStaticMarkup(
      <IndicatorCalculationDisclosure step={5} row={{ "3b_VA_GVC_C": 15, "3_VA_GVC": 40, SVA: 60 }} />,
    );
    expect(html).toContain("复杂 GVC 生产份额 = 3b_VA_GVC_C / 总增加值 SVA");
    expect(html).toContain("= 15.00 / 60.00 = <b>25.000%</b>");
    expect(html).not.toContain("40 / 60");
  });

  test("preserves small real-data operands instead of displaying a false zero calculation", () => {
    const step2 = renderToStaticMarkup(
      <IndicatorCalculationDisclosure
        step={4}
        row={{ FVA: 1.180410305310168e-5, gross_exports: 9.999997853224356e-5 }}
      />,
    );
    // Three significant digits (0.0000118) would give 11.8%; the operand takes the digits the percentage needs.
    expect(step2).toContain("= 0.000011804 / 0.0001 = <b>11.804%</b>");
    expect(step2).not.toContain("= 0 / 0");

    const step3 = renderToStaticMarkup(
      <IndicatorCalculationDisclosure
        step={5}
        row={{ "3b_VA_GVC_C": 0.0002487161528365, SVA: 0.0117999999999999 }}
      />,
    );
    expect(step3).toContain("= 0.0002487 / 0.0118 = <b>2.108%</b>");
    expect(step3).not.toContain("= 0 / 0.01");
  });

  test("shows the Step 4 position formula and does not substitute total lengths", () => {
    const html = renderToStaticMarkup(
      <IndicatorCalculationDisclosure step={6} row={{ PLv_GVC: 2.4, PLy_GVC: 1.6, PLv: 9, PLy: 3 }} />,
    );
    expect(html).toContain("GVCPs = PLv_GVC / PLy_GVC");
    expect(html).toContain("= 2.400 / 1.600 = <b>1.500</b>");
    expect(html).not.toContain("= 9 / 3");
  });

  test("keeps a defined signed Step 4 position ratio when the backward length is negative", () => {
    const html = renderToStaticMarkup(
      <IndicatorCalculationDisclosure step={6} row={{ PLv_GVC: 2.4, PLy_GVC: -1.6 }} />,
    );
    expect(html).toContain("= 2.400 / -1.600 = <b>-1.500</b>");
  });

  test("does not display a rounded negative zero for a tiny signed position ratio", () => {
    const html = renderToStaticMarkup(
      <IndicatorCalculationDisclosure step={6} row={{ PLv_GVC: -0.0001, PLy_GVC: 1 }} />,
    );
    expect(html).toContain("= -0.0001 / 1.000 = <b>0.000</b>");
    expect(html).not.toContain("<b>-0.000</b>");
  });

  test("does not manufacture a ratio for a zero denominator", () => {
    const html = renderToStaticMarkup(
      <IndicatorCalculationDisclosure step={4} row={{ FVA: 2, gross_exports: 0 }} />,
    );
    expect(html).toContain("—（总量为 0，无法计算比重）");
    expect(html).not.toContain("Infinity");
  });

  test("names a negative total and missing data as such (MLT H51 has SVA -1.268)", () => {
    const negative = renderToStaticMarkup(
      <IndicatorCalculationDisclosure step={5} row={{ "3b_VA_GVC_C": -0.197, SVA: -1.268 }} />,
    );
    expect(negative).toContain("= -0.197 / -1.268 = <b>—（总量为负，无法计算比重）</b>");
    const missing = renderToStaticMarkup(
      <IndicatorCalculationDisclosure step={5} row={{ "3b_VA_GVC_C": null, SVA: 4 }} />,
    );
    expect(missing).toContain("—（缺数据，无法计算）");
  });

  test("a GVC position with no GVC activity says so instead of missing data (BRN T)", () => {
    const inactive = renderToStaticMarkup(
      <IndicatorCalculationDisclosure step={6} row={{ PLv_GVC: null, PLy_GVC: null, "3_VA_GVC": 0, "3_FGY_GVC": 0 }} />,
    );
    expect(inactive).toContain("—（无此类活动，无法计算）");
    expect(inactive).not.toContain("缺数据");
    const missing = renderToStaticMarkup(
      <IndicatorCalculationDisclosure step={6} row={{ PLv_GVC: null, PLy_GVC: 2 }} />,
    );
    expect(missing).toContain("—（缺数据，无法计算）");
  });

  test("keeps a valid Step 4 position calculation visible when negative SVA blocks only the PLv decomposition", async () => {
    const row = {
      country: "CYP", industry: "H51", year: 2016,
      SVA: -3.7579, PLv: 1.6426754975,
      "1_VA_D": -1.7848700902, "2_VA_RT": -1.0071156465, "3_VA_GVC": -0.9659142633,
      PLv_D: 1.0608326699, PLv_RT: 1.0614992997,
      PLv_GVC: 3.3238034859, PLy_GVC: 3.5453989331, GVCPs: 0.9374977396,
    };
    const countryRequest = spyOn(api, "countryIndicatorsForCountry").mockResolvedValue([row]);
    const industryRequest = spyOn(api, "industryIndicatorsAll").mockResolvedValue({
      total: 1, page: 1, page_size: 200, rows: [row],
    });
    try {
      const view = render(
        <DecompositionDemo
          step={6}
          meta={{ years: [2016], countries: ["CYP"], sectors: ["H51"], dataset: null }}
          primaryYear={2016}
          primaryCountry="CYP"
        />,
      );
      await waitFor(() => expect(view.getByText("当前分解不可用")).toBeTruthy());
      const disclosure = view.getByLabelText("GVC 位置指数计算公式");
      expect(disclosure.textContent).toContain("3.324 / 3.545 = 0.937");
      // Round 12: the headline length is defined, only its share-weighted split is not; "—" is not missing data.
      const box = view.getByText("当前分解不可用").parentElement!.textContent ?? "";
      expect(box).toContain("SVA 小于 0，无法按份额加权平均。");
      expect(box).toContain("前向总生产长度 PLv = 1.643 仍有定义");
      expect(box).toContain("“—”表示这一项无法计算（不是缺少数据）");
      expect(box).not.toContain("表示没有数据");
    } finally {
      countryRequest.mockRestore();
      industryRequest.mockRestore();
    }
  });
});

describe("step 4: the sum line says ≈ when the shown lengths do not add up to the shown sum", () => {
  const renderLengths = async (row: Record<string, number | string>) => {
    const countryRequest = spyOn(api, "countryIndicatorsForCountry").mockResolvedValue([{ ...row, industry: null }]);
    const industryRequest = spyOn(api, "industryIndicatorsAll").mockResolvedValue({ total: 1, page: 1, page_size: 200, rows: [row] });
    try {
      const view = render(
        <DecompositionDemo step={6} meta={{ years: [2017], countries: [String(row.country)], sectors: ["A"], dataset: null }}
          primaryYear={2017} primaryCountry={String(row.country)} />,
      );
      await waitFor(() => expect(view.container.querySelector(".decomp-identity")).toBeTruthy());
      return {
        rows: [...view.container.querySelectorAll(".decomp-table tbody tr .dt-val")].map((cell) => cell.textContent),
        line: view.container.querySelector(".decomp-identity")!.textContent!,
      };
    } finally {
      countryRequest.mockRestore();
      industryRequest.mockRestore();
    }
  };

  test("KOR 2017 (国家整体): 1.222 + 0.205 + 0.782 = 2.209, so the line reads ≈ 2.210", async () => {
    // Weighted contributions 1.2222 + 0.2054 + 0.7821 = 2.2097: each row rounds down, the sum rounds up.
    const { rows, line } = await renderLengths({
      country: "KOR", year: 2017, SVA: 1, PLv: 2.2097,
      "1_VA_D": 0.6, "2_VA_RT": 0.1, "3_VA_GVC": 0.3,
      PLv_D: 1.2222 / 0.6, PLv_RT: 2.054, PLv_GVC: 0.7821 / 0.3,
    });
    expect(rows).toEqual(["1.222", "0.205", "0.782"]);
    // "≈" and "等于" never share a line.
    expect(line).toContain("✓ 3 项相加 ≈ 2.210，与前向总生产长度 PLv 一致（差别来自四舍五入）");
    expect(line).not.toContain("等于");
    cleanup();
    // Rows that add up as shown keep "=".
    const exact = await renderLengths({
      country: "KOR", year: 2017, SVA: 1, PLv: 2,
      "1_VA_D": 0.6, "2_VA_RT": 0.1, "3_VA_GVC": 0.3,
      PLv_D: 2, PLv_RT: 2, PLv_GVC: 2,
    });
    expect(exact.line).toContain("✓ 3 项相加 = 2.000，等于前向总生产长度 PLv");
  });
});

describe("the unavailable step 4 split names undefined parts as such (round 12)", () => {
  const cfg = { totalLabel: "前向总生产长度 PLv", unit: "number" as const, weightTotal: "SVA" };
  const model = (reason: DecompositionModel["reason"], total: number | null) => ({ reason, total }) as DecompositionModel;

  test("LUX B09: SVA is 0, so the dash means 无法计算 and no total is claimed", () => {
    expect(unavailableDashNote(model("zero-weight-denominator", null))).toBe("“—”表示这一项无法计算（不是缺少数据），不按 0 计算。");
    expect(unavailableTotalNote(model("zero-weight-denominator", null), cfg)).toBeNull();
    expect(decompositionModelReason(model("zero-weight-denominator", null), "SVA")).toBe("SVA 为 0（没有这类活动），无法计算加权长度。");
  });

  test("missing fields still read as missing data", () => {
    expect(unavailableDashNote(model("missing-fields", 2))).toBe("“—”表示没有数据，不按 0 计算。");
    expect(unavailableTotalNote(model("missing-fields", 2), cfg)).toBeNull();
  });

  test("LUX B09 2020: FGY = 0 is structural, so the PLy heading reads 无法拆分, not 暂时无法拆分 (round 13)", async () => {
    const row = {
      country: "LUX", industry: "B09", year: 2020,
      SVA: 0, FGY: 0, PLv: null, PLy: null, "1_VA_D": 0, "2_VA_RT": 0, "3_VA_GVC": 0,
      "1_FGY_D": 0, "2_FGY_RT": 0, "3_FGY_GVC": 0, PLv_D: null, PLv_RT: null, PLv_GVC: null,
      PLy_D: null, PLy_RT: null, PLy_GVC: null, GVCPs: null,
    };
    const countryRequest = spyOn(api, "countryIndicatorsForCountry").mockResolvedValue([{ ...row, industry: null }]);
    const industryRequest = spyOn(api, "industryIndicatorsAll").mockResolvedValue({ total: 1, page: 1, page_size: 200, rows: [row] });
    try {
      const view = render(
        <DecompositionDemo step={6} meta={{ years: [2020], countries: ["LUX"], sectors: ["B09"], dataset: null }}
          primaryYear={2020} primaryCountry="LUX" />,
      );
      await waitFor(() => expect(view.container.textContent).toContain("后向 PLy · 无法拆分"));
      expect(view.container.textContent).not.toContain("暂时无法拆分");
      expect(view.container.textContent).toContain("FGY 为 0（没有这类活动）");
    } finally {
      countryRequest.mockRestore();
      industryRequest.mockRestore();
    }
  });

  test("MLT H51: a negative SVA leaves PLv defined and says so", () => {
    expect(unavailableTotalNote(model("negative-weight-denominator", 2.1310588), cfg)).toBe(
      "前向总生产长度 PLv = 2.131 仍有定义：总长度由投入产出关系直接算出，不需要份额；无法计算的只是按 SVA 份额加权的各段贡献，因此只是无法按段分解。",
    );
  });
});

describe("production-length formula", () => {
  test("renders every VA weight in the actual Step 4 formula, not an unweighted sum", () => {
    const html = renderToStaticMarkup(
      <DecompositionDemo step={6} meta={meta} primaryYear={2020} primaryCountry="CHN" />,
    );
    const formula = html.match(/<div class="decomp-formula">.*?<\/div>/)?.[0];
    expect(formula).toBeDefined();
    for (const term of ["纯国内份额 × 纯国内段长度", "传统贸易份额 × 传统贸易段长度", "GVC 份额 × GVC 段长度"]) {
      expect(formula).toContain(term);
    }
    const model = buildDecompositionModel(
      { PLv: 2.75, SVA: 100, "1_VA_D": 50, "2_VA_RT": 25, "3_VA_GVC": 25, PLv_D: 2, PLv_RT: 3, PLv_GVC: 4 },
      {
        total: "PLv", weightTotal: "SVA",
        parts: [
          { key: "PLv_D", weightKey: "1_VA_D" },
          { key: "PLv_RT", weightKey: "2_VA_RT" },
          { key: "PLv_GVC", weightKey: "3_VA_GVC" },
        ],
      },
    );
    expect(model.values).toEqual([1, 0.75, 1]);
    expect(model.sum).toBe(2.75);
  });

  test.each([4, 5])("keeps step=%s additive monetary decompositions unweighted", (step) => {
    const html = renderToStaticMarkup(
      <DecompositionDemo step={step} meta={meta} primaryYear={2020} primaryCountry="CHN" />,
    );
    const formula = html.match(/<div class="decomp-formula">.*?<\/div>/)?.[0];
    expect(formula).toBeDefined();
    expect(formula).not.toContain("/SVA");
    expect(formula).not.toContain("×");
  });
});

describe("semantic decomposition and path tables", () => {
  test("names decomposition details and exposes scoped columns and component row headers without changing signed/null copy", () => {
    const html = renderToStaticMarkup(
      <DecompositionDetailTable
        caption="实体 A：2020 年 CHN 中国 · 制造业 · 总出口分解明细"
        parts={[
          { key: "signed", label: "有符号分项", color: "#123456", desc: "负值说明" },
          { key: "missing", label: "缺失分项", color: "#654321", desc: "缺失说明" },
        ]}
        values={[-12, null]}
        shares={[-25, null]}
        unit="amount"
      />,
    );

    expect(html).toContain('<caption class="sr-only">实体 A：2020 年 CHN 中国 · 制造业 · 总出口分解明细</caption>');
    expect(html).toContain('<thead class="decomp-table-head">');
    expect(html.match(/scope="col"/g)).toHaveLength(4);
    expect(html.match(/scope="row"/g)).toHaveLength(2);
    expect(html).toContain("占总量比重");
    expect(html).toContain("负值表示抵减项");
    expect(html).toContain("-12");
    expect(html).toContain("-25.000%");
    expect(html).toContain('<td class="dt-val">—</td>');
    expect(html).toContain("—（无法计算）");
  });

  test("provides a native entity/decomposition caption for each decomposition teaching step", () => {
    for (const decomposition of ["总出口", "总增加值 SVA", "前向总生产长度 PLv"]) {
      const caption = `实体 B：2019 年 USA 美国 · 国家整体 · ${decomposition}分解明细`;
      const html = renderToStaticMarkup(
        <DecompositionDetailTable
          caption={caption}
          parts={[{ key: "part", label: "组成项", color: "#123456", desc: "组成说明" }]}
          values={[1]}
          shares={[100]}
          unit={decomposition === "总出口" || decomposition === "总增加值 SVA" ? "amount" : "number"}
        />,
      );
      expect(html).toContain(`<caption class="sr-only">${caption}</caption>`);
      expect(html.match(/scope="col"/g)).toHaveLength(4);
      expect(html.match(/scope="row"/g)).toHaveLength(1);
    }
  });

  test("names the closeness path and scopes destination columns and rows without changing path copy", () => {
    const html = renderToStaticMarkup(
      <ClosenessPathTable
        source="DEU"
        paths={[
          { target: "CHN", distance: 1, path: ["DEU", "CHN"] },
          { target: "USA", distance: Number.POSITIVE_INFINITY, path: [] },
        ]}
      />,
    );

    expect(html).toContain('<caption class="sr-only">从节点 DEU 出发的最短路径明细</caption>');
    expect(html).toContain("<thead>");
    expect(html.match(/scope="col"/g)).toHaveLength(3);
    expect(html.match(/scope="row"/g)).toHaveLength(2);
    expect(html).toContain("目标");
    expect(html).toContain("距离");
    expect(html).toContain("一条最短路径");
    expect(html).toContain("DEU → CHN");
    expect(html).toContain("不可达");
    expect(html).toContain("—");
  });
});

describe("Step 5 teaching network accessibility", () => {
  test("keeps one roving node stop and exposes mode and selected-node semantics", () => {
    const html = renderToStaticMarkup(<NetworkCentralityDemo />);
    expect(html.match(/class="net-demo-node"/g)).toHaveLength(7);
    expect(html.match(/role="button" tabindex="0" aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/role="button" tabindex="-1" aria-pressed="false"/g)).toHaveLength(6);
    expect(html).toContain("德（DEU），度 4，已选择");
    expect(html).toContain('aria-pressed="true" aria-label="查看度的算法"');
    expect(html).toContain('aria-pressed="false" aria-label="查看介数的算法"');
    expect(html).toContain("选择节点后可查看它的指标值与相关边");
    expect(html).not.toMatch(/方向键|按 Tab|Enter|空格|点击/);
  });

  test("documents wrapping arrow navigation and Home/End bounds", () => {
    const nodes = ["USA", "MEX", "DEU"];
    expect(nextNetworkDemoNode(nodes, "USA", "ArrowLeft")).toBe("DEU");
    expect(nextNetworkDemoNode(nodes, "DEU", "ArrowRight")).toBe("USA");
    expect(nextNetworkDemoNode(nodes, "MEX", "ArrowUp")).toBe("USA");
    expect(nextNetworkDemoNode(nodes, "MEX", "ArrowDown")).toBe("DEU");
    expect(nextNetworkDemoNode(nodes, "MEX", "Home")).toBe("USA");
    expect(nextNetworkDemoNode(nodes, "MEX", "End")).toBe("DEU");
    expect(nextNetworkDemoNode(nodes, "MEX", "Enter")).toBeNull();
  });

  test("keeps roving focus separate from explicit selection", () => {
    const nodes = ["USA", "MEX", "DEU"];
    expect(networkDemoKeyTransition(nodes, { focused: "DEU", selected: "DEU" }, "ArrowRight"))
      .toEqual({ focused: "USA", selected: "DEU" });
    expect(networkDemoKeyTransition(nodes, { focused: "USA", selected: "DEU" }, "Home"))
      .toEqual({ focused: "USA", selected: "DEU" });
    expect(networkDemoKeyTransition(nodes, { focused: "USA", selected: "DEU" }, "Enter"))
      .toEqual({ focused: "USA", selected: "USA" });
    expect(networkDemoKeyTransition(nodes, { focused: "MEX", selected: "DEU" }, " "))
      .toEqual({ focused: "MEX", selected: "MEX" });
  });

  test("provides complete incoming/outgoing edge text without changing algorithms", () => {
    expect(teachingNetworkEdgesForNode("DEU")).toEqual([
      { direction: "入边", neighbor: "USA", from: "USA", to: "DEU", weight: 1 },
      { direction: "入边", neighbor: "MEX", from: "MEX", to: "DEU", weight: 1 },
      { direction: "出边", neighbor: "CHN", from: "DEU", to: "CHN", weight: 1 },
      { direction: "出边", neighbor: "JPN", from: "DEU", to: "JPN", weight: 1 },
    ]);
    const metrics = teachingNetworkCentralitySnapshot();
    expect(metrics.degree).toEqual({ USA: 2, MEX: 2, DEU: 4, CHN: 2, JPN: 3, KOR: 3, VNM: 2 });
    expect(metrics.betweenness).toEqual({ USA: 0, MEX: 0, DEU: 8, CHN: 1.5, JPN: 4.5, KOR: 1, VNM: 0 });
    expect(metrics.closeness.DEU).toBeCloseTo(2 / 3);
    expect(networkDemoNodeAccessibleName({ id: "DEU", label: "德" }, "betweenness", 8, false))
      .toBe("德（DEU），介数 8，未选择");

    const html = renderToStaticMarkup(<NetworkCentralityDemo />);
    expect(html).toContain("节点 DEU 的全部直接入边与出边；演示网络每条边权重均为 1");
    for (const edge of ["USA → DEU", "MEX → DEU", "DEU → CHN", "DEU → JPN"]) {
      expect(html).toContain(edge);
    }
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('class="ndp-edges scrollable-region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="节点 DEU 的全部直接入边与出边，可横向滚动"');
  });
});

describe("Step 5 betweenness example (round 10)", () => {
  test("the per-pair contributions add up to each node's betweenness", () => {
    const { betweenness } = teachingNetworkCentralitySnapshot();
    for (const [node, value] of Object.entries(betweenness)) {
      const sum = teachingBetweennessPairs(node).reduce((total, pair) => total + pair.through / pair.total, 0);
      expect(sum).toBeCloseTo(value);
    }
  });

  test("JPN's example is a pair whose every shortest route passes JPN", () => {
    const pair = betweennessExamplePair(teachingBetweennessPairs("JPN"))!;
    expect(pair).toMatchObject({ source: "USA", target: "VNM", through: 1, total: 1 });
    expect(betweennessExampleSentence(pair, "JPN")).toBe("例如 USA → VNM 只有一条最短路线，它要经过 JPN（已高亮），这一对计 1。");
  });

  test("CHN lies on only one of two USA → KOR routes, and the example says so", () => {
    const pairs = teachingBetweennessPairs("CHN");
    expect(pairs.every((pair) => pair.through < pair.total)).toBe(true);
    const pair = betweennessExamplePair(pairs)!;
    expect(pair).toMatchObject({ source: "USA", target: "KOR", through: 1, total: 2 });
    const sentence = betweennessExampleSentence(pair, "CHN");
    expect(sentence).toBe("例如 USA → KOR 有 2 条最短路线，其中 1 条经过 CHN（已高亮），这一对计 1/2 = 0.5。");
    expect(sentence).not.toContain("要经过");
  });

  test("the demo shows the sum behind the value and the pair table", () => {
    const view = render(<NetworkCentralityDemo />);
    fireEvent.click(view.getByRole("button", { name: "查看介数的算法" }));
    fireEvent.click(view.getByRole("button", { name: /^中（CHN）/ }));
    const text = view.container.textContent ?? "";
    expect(text).toContain("= 0.5 + 0.5 + 0.5 = 1.5");
    expect(text).toContain("其中 1 条经过 CHN");
    expect(text).not.toContain("最短路线要经过 CHN");
    expect(view.getByRole("table", { name: "节点 CHN 的介数：每一对起点和终点计入的份额" })).toBeTruthy();
  });
});

describe("independent decomposition request states", () => {
  test("a side B failure cannot replace or hide valid side A content", () => {
    const html = renderToStaticMarkup(
      <div>
        <section aria-label="实体 A"><b>实体 A 有效分解</b><div>四项加总 = SVA</div></section>
        <section aria-label="实体 B">
          <DecompositionRequestMessage
            label="实体 B"
            status="error"
            error="Failed to fetch"
            empty={false}
            onRetry={() => {}}
          />
        </section>
      </div>,
    );
    expect(html).toContain("实体 A 有效分解");
    expect(html).toContain("四项加总 = SVA");
    expect(html).toContain("实体 B 的分解加载失败：网络连接中断，请检查连接后重试。");
    expect(html).toContain("重试");
    expect(html).toContain('role="alert"');
  });

  test("distinguishes loading, valid empty and error copy", () => {
    const loading = renderToStaticMarkup(
      <DecompositionRequestMessage label="实体 A" status="loading" error={null} empty={false} onRetry={() => {}} />,
    );
    const empty = renderToStaticMarkup(
      <DecompositionRequestMessage label="实体 A" status="success" error={null} empty onRetry={() => {}} />,
    );
    const error = renderToStaticMarkup(
      <DecompositionRequestMessage label="实体 A" status="error" error="boom" empty={false} onRetry={() => {}} />,
    );
    expect(loading).toContain("正在加载实体 A 的分解数据");
    expect(loading).toContain('role="status"');
    expect(empty).toContain("没有可用的分解数据");
    expect(empty).toContain('role="status"');
    expect(empty).not.toContain("加载实体 A");
    expect(error).toContain("实体 A 的分解加载失败：boom");
    expect(error).toContain("重试");
  });
});

describe("single-entity decomposition scope", () => {
  test("renders an immediate unavailable state for initial or restored global scope", () => {
    const html = renderToStaticMarkup(
      <DecompositionDemo step={4} meta={meta} primaryYear={2020} primaryCountry={null} />,
    );
    expect(html).toContain("还没有选择具体国家");
    // The unavailable state carries its own country selector (there is no other one on the page).
    expect(html).toContain("选择国家");
    expect(html).toContain("<option value=\"\" disabled=\"\" selected=\"\">请选择</option>");
    expect(html).not.toContain("加载实体 A");
    expect(html).not.toContain("decomp-formula");
  });

  test("keeps an explicit valid country as the only active demo entity", () => {
    const html = renderToStaticMarkup(
      <DecompositionDemo step={4} meta={meta} primaryYear={2020} primaryCountry="CHN" />,
    );
    expect(html).not.toContain("还没有选择具体国家");
    expect(html).toContain("正在加载所选国家的分解数据");
    expect(html).toContain("decomp-formula");
  });
});

describe("one country only", () => {
  test("decomposes the selected country, with 国家整体／单个行业 and no second country or side-by-side option", async () => {
    const row = (country: string, industry = "") => ({ country, industry, year: 2020, SVA: 10, "1_VA_D": 4, "2_VA_RT": 2, "3_VA_GVC": 4, "3a_VA_GVC_S": 1, "3b_VA_GVC_C": 3 });
    const countryRequest = spyOn(api, "countryIndicatorsForCountry").mockImplementation(async (_year, country) => [row(country)]);
    const industryRequest = spyOn(api, "industryIndicatorsAll").mockImplementation(async (_year, country) => ({
      total: 2, page: 1, page_size: 200, rows: [row(country as string, "C26"), row(country as string, "C29")],
    }));
    const changes: Array<[number, string]> = [];
    try {
      const view = render(
        <DecompositionDemo step={5} meta={{ years: [2020], countries: ["CHN", "USA"], sectors: ["C26", "C29"], dataset: null }}
          primaryYear={2020} primaryCountry="CHN" onPrimaryChange={(year, country) => changes.push([year, country])} />,
      );
      await waitFor(() => expect(view.getAllByRole("table")).toHaveLength(1));
      expect(view.queryByText(/并排比较/)).toBeNull();
      expect(view.queryByRole("checkbox")).toBeNull();
      expect(view.getAllByLabelText("国家")).toHaveLength(1);
      expect(view.container.textContent).not.toMatch(/左栏|右栏|对比国家/);
      // Every country is offered; the choice goes to the page, which records it as the report material.
      const countrySelect = view.getByLabelText("国家") as HTMLSelectElement;
      expect([...countrySelect.querySelectorAll("option")].map((option) => option.getAttribute("value"))).toEqual(["CHN", "USA"]);
      fireEvent.change(countrySelect, { target: { value: "USA" } });
      expect(changes).toEqual([[2020, "USA"]]);

      fireEvent.click(view.getByRole("button", { name: "单个行业" }));
      await waitFor(() => expect(view.getAllByLabelText("行业")).toHaveLength(1));
      const sector = view.getByLabelText("行业") as HTMLSelectElement;
      expect(sector.value).toBe("C26");
      fireEvent.change(sector, { target: { value: "C29" } });
      expect((view.getByLabelText("行业") as HTMLSelectElement).value).toBe("C29");
      expect(view.getAllByRole("table")).toHaveLength(1);
      expect(industryRequest.mock.calls.every(([, country]) => country === "CHN")).toBe(true);
    } finally {
      cleanup();
      countryRequest.mockRestore();
      industryRequest.mockRestore();
    }
  });
});

describe("steps 2–4 decomposition demo: all-zero rows and the remembered level", () => {
  const tradeRow = (country: string, industry: string, scale: number) => ({
    country, industry, year: 2020, gross_exports: 12 * scale, DVAex: 5 * scale, DVArt: 1 * scale, DDC: 1 * scale, FVA: 3 * scale, FDC: 1 * scale, taxsub: 1 * scale,
  });
  const mockRows = (rows: ReturnType<typeof tradeRow>[]) => [
    spyOn(api, "countryIndicatorsForCountry").mockResolvedValue([tradeRow("CHN", "", 1)]),
    spyOn(api, "industryIndicatorsAll").mockResolvedValue({ total: rows.length, page: 1, page_size: 200, rows }),
  ];

  test("step 2: an industry with every part 0 shows no empty grey bar", async () => {
    const mocks = mockRows([tradeRow("CHN", "B05", 0)]);
    try {
      const view = render(
        <DecompositionDemo step={4} meta={{ years: [2020], countries: ["CHN"], sectors: ["B05"], dataset: null }}
          primaryYear={2020} primaryCountry="CHN" initialView={{ level: "sector", industry: "B05" }} />,
      );
      await waitFor(() => expect(view.container.textContent).toContain("所有分项都是 0"));
      expect(view.container.querySelector(".decomp-bar")).toBeNull();
    } finally {
      cleanup();
      mocks.forEach((mock) => mock.mockRestore());
    }
  });

  test("单个行业 and the chosen industry are saved and reopen where the student left them", async () => {
    const mocks = mockRows([tradeRow("CHN", "C26", 1), tradeRow("CHN", "C29", 2)]);
    const meta = { years: [2020], countries: ["CHN"], sectors: ["C26", "C29"], dataset: null };
    const views: unknown[] = [];
    try {
      const view = render(<DecompositionDemo step={4} meta={meta} primaryYear={2020} primaryCountry="CHN" onViewChange={(saved) => views.push(saved)} />);
      await waitFor(() => expect(view.container.querySelector(".decomp-bar")).toBeTruthy());
      fireEvent.click(view.getByRole("button", { name: "单个行业" }));
      await waitFor(() => expect(view.getAllByLabelText("行业")).toHaveLength(1));
      fireEvent.change(view.getByLabelText("行业"), { target: { value: "C29" } });
      expect(views).toEqual([{ level: "sector", industry: "C26" }, { level: "sector", industry: "C29" }]);
      cleanup();
      // Coming back: the saved view may arrive after the first render.
      const back = render(<DecompositionDemo step={4} meta={meta} primaryYear={2020} primaryCountry="CHN" />);
      back.rerender(<DecompositionDemo step={4} meta={meta} primaryYear={2020} primaryCountry="CHN" initialView={{ level: "sector", industry: "C29" }} />);
      await waitFor(() => expect((back.getByLabelText("行业") as HTMLSelectElement).value).toBe("C29"));
      expect(back.getByRole("button", { name: "单个行业" }).getAttribute("aria-pressed")).toBe("true");
    } finally {
      cleanup();
      mocks.forEach((mock) => mock.mockRestore());
    }
  });
});

test("the negative-part note only appears beside shares it explains, in the step's own words", () => {
  const parts = [
    { key: "a", label: "纯国内", color: "#123456", desc: "" },
    { key: "b", label: "传统贸易", color: "#654321", desc: "" },
  ];
  const withoutShares = renderToStaticMarkup(
    <DecompositionDetailTable caption="MLT · H51" parts={parts} values={[-0.04, -0.634]} shares={null} unit="amount" />,
  );
  expect(withoutShares).not.toContain("decomp-table-note");
  const ownWords = renderToStaticMarkup(
    <DecompositionDetailTable caption="X" parts={parts} values={[5, -1]} shares={[125, -25]} unit="amount"
      negativeNote="负值表示这部分增加值为负（例如行业亏损），所以其他分项的比重之和可能超过 100%。" />,
  );
  expect(ownWords).toContain("负值表示这部分增加值为负");
  expect(ownWords).not.toContain("净补贴");
});

test("a merged two-part sum adds up as shown when a part is below 10, at the table's three decimals", () => {
  expect(sumText(0.817, 0.468)).toBe("0.817 + 0.468 = 1.285");
  expect(sumText(2.4771, 0.8669)).toBe("2.477 + 0.867 = 3.344");
  expect(sumText(0.00021, 0.00012)).toBe("0.00021 + 0.00012 = 0.00033");
  expect(sumText(0, 0.25)).toBe("0 + 0.250 = 0.250");
  expect(sumText(12_345.6, 0.4)).toBe("12,346 + 0.400 = 12,346");
  // Was "9": two parts read "5" and "3" in the table could not add up to it.
  expect(sumText(5.4, 3.3)).toBe("5.400 + 3.300 = 8.700");
  // Round 10: the EXDVA line mixed "0.9979" with the table's "0.998".
  expect(sumText(5298.2, 0.9979)).toBe("5,298.2 + 0.998 = 5,299.2");
  // Round 12: below 10,000 the parts are read with decimals, so they are written out too.
  expect(sumText(120.4, 30.25)).toBe("120.40 + 30.25 = 150.65");
  expect(sumText(120_000.4, 30_000.25)).toBe("150,001");
});

describe("small amounts read with the precision of the table rows (round 10)", () => {
  test("formula operands below 10 keep three decimals, tiny ones three significant digits", () => {
    expect(formulaAmount(1.3787)).toBe("1.379");
    expect(formulaAmount(0.56)).toBe("0.560");
    expect(formulaAmount(0.0603)).toBe("0.0603");
    expect(formulaAmount(0.06)).toBe("0.060");
    expect(formulaAmount(-1.2679)).toBe("-1.268");
    expect(formulaAmount(24.4)).toBe("24.40");
    expect(formulaAmount(6424.4)).toBe("6,424.4");
    expect(formulaAmount(16424.4)).toBe("16,424");
  });

  test("BRN C10T12: the FVA share formula substitutes the total the share was computed from", () => {
    const html = renderToStaticMarkup(
      <IndicatorCalculationDisclosure step={4} row={{ FVA: 0.5598, gross_exports: 1.3783 }} />,
    );
    // Round 12: "0.560 / 1.378" gives 40.639%, not the 40.615% shown; the operands take one more digit.
    expect(html).toContain("= 0.5598 / 1.3783 = <b>40.615%</b>");
    expect(html).not.toContain("/ 1 =");
  });

  test("MLT C16: the complex-GVC formula keeps the small total's decimals", () => {
    const html = renderToStaticMarkup(
      <IndicatorCalculationDisclosure step={5} row={{ "3b_VA_GVC_C": 0.166, SVA: 2.291 }} />,
    );
    expect(html).toContain("= 0.166 / 2.291 = <b>7.246%</b>");
  });

  test("table rows below 10 read three decimals, so a part never reads \"1\" beside \"0.563\"", () => {
    const html = renderToStaticMarkup(
      <DecompositionDetailTable
        caption="MLT · C16"
        parts={[
          { key: "a", label: "纯国内", color: "#123456", desc: "" },
          { key: "b", label: "传统贸易", color: "#654321", desc: "" },
          { key: "c", label: "大额", color: "#654321", desc: "" },
        ]}
        values={[1.274, 0.563, 1234.5]}
        shares={[55.61, 24.529, 1]}
        unit="amount"
      />,
    );
    expect(html).toContain('<td class="dt-val">1.274</td>');
    expect(html).toContain('<td class="dt-val">0.563</td>');
    expect(html).toContain('<td class="dt-val">1,234.5</td>');
  });

  test("a negative industry total is explained as negative, not as too small", async () => {
    // MLT H51 2020: value added −1.268 against a country total in the thousands.
    const row = (industry: string, scale: number) => ({
      country: "MLT", industry, year: 2020,
      SVA: -1.2681 * scale, "1_VA_D": -0.4 * scale, "2_VA_RT": -0.2739 * scale, "3_VA_GVC": -0.5942 * scale,
      "3a_VA_GVC_S": -0.3972 * scale, "3b_VA_GVC_C": -0.197 * scale,
    });
    const countryRequest = spyOn(api, "countryIndicatorsForCountry").mockResolvedValue([{ ...row("", -10_000), industry: null }]);
    const industryRequest = spyOn(api, "industryIndicatorsAll").mockResolvedValue({
      total: 2, page: 1, page_size: 200, rows: [row("H51", 1), row("C26", -10_000)],
    });
    try {
      const view = render(
        <DecompositionDemo step={5} meta={{ years: [2020], countries: ["MLT"], sectors: ["H51", "C26"], dataset: null }}
          primaryYear={2020} primaryCountry="MLT" />,
      );
      fireEvent.click(view.getByRole("button", { name: "单个行业" }));
      await waitFor(() => expect(view.container.textContent).toContain("总量为负，无法算比重"));
      expect(view.container.textContent).not.toContain("数值太小");
    } finally {
      countryRequest.mockRestore();
      industryRequest.mockRestore();
    }
  });

  test("a small total, its parts and the sum line agree in the rendered decomposition", async () => {
    const row = {
      country: "BRN", industry: "C10T12", year: 2020,
      gross_exports: 1.3783, DVAex: 0.7551, DVArt: 0.0002, DDC: 0.0001, FVA: 0.5598, FDC: 0.0601, taxsub: 0.003,
    };
    const countryRequest = spyOn(api, "countryIndicatorsForCountry").mockResolvedValue([{ ...row, industry: null }]);
    const industryRequest = spyOn(api, "industryIndicatorsAll").mockResolvedValue({
      total: 1, page: 1, page_size: 200, rows: [row],
    });
    try {
      const view = render(
        <DecompositionDemo step={4} meta={{ years: [2020], countries: ["BRN"], sectors: ["C10T12"], dataset: null }}
          primaryYear={2020} primaryCountry="BRN" />,
      );
      // Round 13: the panel reads one precision throughout (four decimals here, so every row's share checks by hand).
      await waitFor(() => expect(view.container.textContent).toContain("总出口 = 1.3783（"));
      const text = view.container.textContent ?? "";
      expect(text).toContain("6 项相加 = 1.3783，");
      expect(text).toContain("= 0.5598 / 1.3783 = 40.615%");
      expect(text).not.toContain("总出口 = 1（");
    } finally {
      countryRequest.mockRestore();
      industryRequest.mockRestore();
    }
  });
});

describe("steps 2–3: the shown numbers check by hand (round 12)", () => {
  /** Parse "1,234.5" back into the number it shows. */
  const shown = (text: string) => Number(text.replace(/,/g, ""));
  const checks = (numerator: number, denominator: number) => {
    const { numerator: n, denominator: d, percent } = ratioOperands(numerator, denominator);
    expect(`${((shown(n) / shown(d)) * 100).toFixed(3)}%`).toBe(percent);
    expect(percent).toBe(`${((numerator / denominator) * 100).toFixed(3)}%`);
    return `${n} / ${d} = ${percent}`;
  };

  test("amounts below 1,000 keep two decimals, below 10,000 one, so 15 / 100 no longer reads 15.415%", () => {
    expect(fmt(15.3999, "amount")).toBe("15.40");
    expect(fmt(99.906, "amount")).toBe("99.91");
    expect(fmt(379.2699, "amount")).toBe("379.27");
    expect(fmt(3829.7215, "amount")).toBe("3,829.7");
    expect(fmt(426596.9, "amount")).toBe("426,597");
  });

  test("real rows: the formula operands divide to the percentage shown", () => {
    // BRN B05_06 2020 (step 2): was "379 / 3,830 = 9.903%".
    expect(checks(379.26986681734746, 3829.7215)).toBe("379.27 / 3,829.7 = 9.903%");
    // LUX O 2020 (step 3): was "37 / 4,279 = 0.868%".
    expect(checks(37.1546, 4279.3718)).toMatch(/^37\.15\d* \/ 4,279\.\d+ = 0\.868%$/);
    // CAN 2016 (step 2): whole millions are not enough for three decimals of a percentage.
    expect(checks(82395.44226559399, 426596.90991223184)).toBe("82,395.4 / 426,596.9 = 19.315%");
    expect(checks(0.5598, 1.3783)).toBe("0.5598 / 1.3783 = 40.615%");
    // MLT H51 2016 (step 3): was "15 / 100 = 15.415%".
    expect(checks(15.353631712234272, 99.60180000000042)).toBe("15.354 / 99.602 = 15.415%");
  });

  test("MLT H51 2016: the four rows now add up to the shown total (they read 2.136 + 51 + 31 + 15 against 100)", () => {
    const values = [2.136177408891449, 50.97644689781885, 31.135543981055907, 15.353631712234272];
    expect(values.map((value) => fmt(value, "amount"))).toEqual(["2.136", "50.98", "31.14", "15.35"]);
    expect(fmt(values.reduce((a, b) => a + b, 0), "amount")).toBe("99.60");
    expect(displayedSumNote(values, values.reduce((a, b) => a + b, 0))).toBeNull();
  });

  test("the sum line says what the shown rows add to when rounding makes them differ", () => {
    // DEU 2016 (step 2): six rounded rows add to 1,260,796.6 against a total of 1,260,798.
    const values = [924670.2, 21896.4, 9744.6, 201727.4, 62187.4, 40572.4];
    const sum = values.reduce((a, b) => a + b, 0);
    expect(fmt(sum, "amount")).toBe("1,260,798");
    expect(displayedSumNote(values, sum)).toBe("（上表各项按显示值相加为 1,260,796.6，差别来自四舍五入）");
    // Rows at two decimals beside a total of the same size add up within its last digit: no note.
    expect(displayedSumNote([60.123, 15.3999, 23.247, 1.136], 99.9059)).toBeNull();
  });
});

describe("steps 2–3: every table row checks by hand, not only the formula (round 13)", () => {
  /** Render one country-level panel and read back the total, each row's amount and share, and the notes. */
  const renderPanel = async (step: 4 | 5, row: Record<string, number | string>) => {
    const countryRequest = spyOn(api, "countryIndicatorsForCountry").mockResolvedValue([{ ...row, industry: null }]);
    const industryRequest = spyOn(api, "industryIndicatorsAll").mockResolvedValue({ total: 1, page: 1, page_size: 200, rows: [row] });
    try {
      const view = render(
        <DecompositionDemo step={step} meta={{ years: [2020], countries: [String(row.country)], sectors: ["A"], dataset: null }}
          primaryYear={2020} primaryCountry={String(row.country)} />,
      );
      await waitFor(() => expect(view.container.querySelector(".decomp-table tbody td.dt-val")).toBeTruthy());
      const total = view.container.querySelector(".decomp-total-line b")!.textContent!;
      const cells = [...view.container.querySelectorAll(".decomp-table tbody tr")].map((tr) => ({
        amount: tr.querySelector(".dt-val")!.textContent!,
        share: tr.querySelector(".dt-share")!.textContent!,
      }));
      return { view, total, cells, text: view.container.textContent ?? "" };
    } finally {
      countryRequest.mockRestore();
      industryRequest.mockRestore();
    }
  };
  const shown = (text: string) => Number(text.replace(/,/g, ""));
  const byHand = (amount: string, total: string) => `${((shown(amount) / shown(total)) * 100).toFixed(3)}%`;

  test("BRN C10T12 2020 (step 2): rows, total, formula and the EXDVA line read one precision and check by hand", async () => {
    // Was "DVAex 0.755 54.795%" beside "0.5600 / 1.3788" (0.755 / 1.3788 = 54.758%), and "DVArt <0.001" beside
    // "EXDVA = 0.755 + 0.000151 = 0.756".
    const row = {
      country: "BRN", year: 2020,
      DVAex: 0.7554879510593011, DVArt: 0.00015061881428423774, DDC: 6.823455392098712e-05,
      FVA: 0.559987327375692, FDC: 0.05979233776682533, taxsub: 0.0032764752712730375,
    };
    const { total, cells, text } = await renderPanel(4, {
      ...row, gross_exports: row.DVAex + row.DVArt + row.DDC + row.FVA + row.FDC + row.taxsub,
    });
    expect(total).toBe("1.37876");
    expect(cells.map((cell) => `${cell.amount} ${cell.share}`)).toEqual([
      "0.75549 54.795%", "0.00015 0.011%", "0.00007 0.005%", "0.55999 40.615%", "0.05979 4.337%", "0.00328 0.238%",
    ]);
    for (const cell of cells) expect(byHand(cell.amount, total)).toBe(cell.share);
    expect(text).toContain("= 0.55999 / 1.37876 = 40.615%");
    expect(text).toContain("6 项相加 ≈ 1.37876，与总出口一致（差别来自四舍五入）");
    expect(text).toContain("EXDVA）= DVAex + DVArt = 0.75549 + 0.00015 = 0.75564。");
    expect(text).not.toContain("<0.001");
    expect(text).not.toContain("末位可能有出入");
  });

  test("MLT H51 2016 (step 3): 50.976 / 99.602 = 51.180%, as the table shows", async () => {
    const { total, cells, text } = await renderPanel(5, {
      country: "MLT", year: 2020, SVA: 99.60180000000042,
      "1_VA_D": 2.136177408891449, "2_VA_RT": 50.97644689781885, "3a_VA_GVC_S": 31.135543981055907, "3b_VA_GVC_C": 15.353631712234272,
    });
    expect(total).toBe("99.602");
    expect(cells.map((cell) => `${cell.amount} ${cell.share}`)).toEqual(["2.136 2.145%", "50.976 51.180%", "31.136 31.260%", "15.354 15.415%"]);
    for (const cell of cells) expect(byHand(cell.amount, total)).toBe(cell.share);
    expect(text).toContain("= 15.354 / 99.602 = 15.415%");
    // The GVC line keeps the table's digits; its shown parts add to 46.490, and it says so.
    expect(text).toContain("简单 GVC + 复杂 GVC = 31.136 + 15.354 ≈ 46.489");
  });

  test("a panel the digit cap cannot settle keeps its rows and says so under the table (ARG C26 2016)", async () => {
    const values = [120.72636476838437, 0.20395515237101824, 0.024104663925528947, 42.01000152258354, 5.738001185075063, 9.826121124970308];
    const sum = values.reduce((a, b) => a + b, 0);
    expect(panelAmountDecimals(values, sum)).toEqual({ decimals: 5, checks: false });
    const { text } = await renderPanel(4, {
      country: "ARG", year: 2020, gross_exports: sum,
      DVAex: values[0], DVArt: values[1], DDC: values[2], FVA: values[3], FDC: values[4], taxsub: values[5],
    });
    expect(text).toContain("总出口 = 178.52855（");
    expect(text).toContain(PANEL_ROUNDING_NOTE);
    expect(PANEL_ROUNDING_NOTE).toBe("百分比按未四舍五入的金额计算，按表中显示值手算，末位可能有出入。");
  });

  test("LUX T 2016 (step 3): a zero share reads 0.000% like the 100.000% beside it", async () => {
    const { cells, text } = await renderPanel(5, {
      country: "LUX", year: 2016, SVA: 150.45, "1_VA_D": 150.45, "2_VA_RT": 0, "3a_VA_GVC_S": 0, "3b_VA_GVC_C": 0,
    });
    expect(cells.map((cell) => cell.share)).toEqual(["100.000%", "0.000%", "0.000%", "0.000%"]);
    expect(text).toContain("= 0 / 150.45 = 0.000%");
    expect(text).not.toMatch(/= 0%|\b0%/);
  });
});

describe("steps 2–4 notes read plainly (round 17)", () => {
  test("step 4: the segment lengths are named forward and sit above the backward box", async () => {
    // MLT B09: forward lengths defined, no final goods (FGY = 0), so the backward side cannot be split.
    const row = {
      country: "MLT", industry: null, year: 2020,
      SVA: 1, PLv: 4.0, "1_VA_D": 0.5, "2_VA_RT": 0.2, "3_VA_GVC": 0.3, PLv_D: 3.263, PLv_RT: 3.525, PLv_GVC: 5.622,
      FGY: 0, PLy: null, "1_FGY_D": 0, "2_FGY_RT": 0, "3_FGY_GVC": 0, PLy_D: null, PLy_RT: null, PLy_GVC: null, GVCPs: null,
    };
    const countryRequest = spyOn(api, "countryIndicatorsForCountry").mockResolvedValue([row]);
    const industryRequest = spyOn(api, "industryIndicatorsAll").mockResolvedValue({ total: 1, page: 1, page_size: 200, rows: [{ ...row, industry: "B09" }] });
    try {
      const view = render(
        <DecompositionDemo step={6} meta={{ years: [2020], countries: ["MLT"], sectors: ["B09"], dataset: null }}
          primaryYear={2020} primaryCountry="MLT" />,
      );
      await waitFor(() => expect(view.container.textContent).toContain("前向各段长度：纯国内 3.263、传统贸易 3.525、GVC 5.622"));
      const text = view.container.textContent!;
      expect(text.indexOf("前向各段长度")).toBeLessThan(text.indexOf("后向 PLy"));
    } finally {
      countryRequest.mockRestore();
      industryRequest.mockRestore();
    }
  });

  test("a zero industry total is a plain notice, without an emoji", async () => {
    const zero = { country: "LUX", industry: "T", year: 2020, gross_exports: 0, DVAex: 0, DVArt: 0, DDC: 0, FVA: 0, FDC: 0, taxsub: 0 };
    const countryRequest = spyOn(api, "countryIndicatorsForCountry").mockResolvedValue([{ ...zero, industry: null, gross_exports: 100, DVAex: 100 }]);
    const industryRequest = spyOn(api, "industryIndicatorsAll").mockResolvedValue({ total: 1, page: 1, page_size: 200, rows: [zero] });
    try {
      const view = render(
        <DecompositionDemo step={4} meta={{ years: [2020], countries: ["LUX"], sectors: ["T"], dataset: null }}
          primaryYear={2020} primaryCountry="LUX" />,
      );
      fireEvent.click(await view.findByRole("button", { name: "单个行业" }));
      await waitFor(() => expect(view.container.querySelector(".decomp-hint")).not.toBeNull());
      const hint = view.container.querySelector(".decomp-hint")!;
      expect(hint.getAttribute("role")).toBe("note");
      expect(hint.className).toContain("decomp-identity neutral");
      expect(hint.textContent!.startsWith("ℹ LUX 卢森堡 · T")).toBe(true);
      expect(view.container.textContent).not.toContain("⚠");
    } finally {
      countryRequest.mockRestore();
      industryRequest.mockRestore();
    }
  });

  test("one panel precision: a whole-million total stays whole; a row below the last digit reads <unit", () => {
    // CAN-sized totals already check by hand at whole millions or one decimal.
    expect(panelAmountDecimals([300_000, 100_000, 26_596.9], 426_596.9)?.checks).toBe(true);
    expect(amountAt(0.000004, 5)).toBe("<0.00001");
    expect(amountAt(-0.000004, 5)).toBe(">-0.00001");
    expect(amountAt(0.4, 0)).toBe("<1");
    expect(amountAt(1_260_798.12, 1)).toBe("1,260,798.1");
    // Shares of a total of 0 or below are undefined: no panel precision, the rows keep their own reading.
    expect(panelAmountDecimals([1, -2], -1)).toBeNull();
  });

  test("a sum line at the panel's precision adds up as shown, or says what the shown parts add to", () => {
    expect(sumText(0.7554879510593011, 0.00015061881428423774, 5)).toBe("0.75549 + 0.00015 = 0.75564");
    expect(sumText(31.135543981055907, 15.353631712234272, 3)).toBe("31.136 + 15.354 ≈ 46.489");
    expect(sumText(2.5, 0.000004, 5)).toBe("2.50000 + <0.00001 = 2.50000（不到 0.00001 的一项按 0 相加）");
    expect(displayedSumNote([0.75549, 0.00015], 0.75564, 5)).toBeNull();
    // One last digit off ("46.490" vs "46.489"): no sentence, the sum line reads "≈" instead.
    expect(displayedSumNote([31.1355, 15.3536], 46.4891, 3)).toBeNull();
    expect(displayedRowsAddUp([31.1355, 15.3536], 46.4891, 3)).toBe(false);
    expect(displayedRowsAddUp([0.75549, 0.00015], 0.75564, 5)).toBe(true);
    expect(displayedSumNote([1.0004, 1.0004, 1.0004, 1.0004], 4.0016, 3)).toBe("（上表各项按显示值相加为 4.000，差别来自四舍五入）");
  });
});
