import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDecompositionModel, type DecompositionSpec } from "./decomposition-model";
import {
  ClosenessPathTable,
  DecompositionDemo,
  DecompositionDetailTable,
  DecompositionRequestMessage,
  NetworkCentralityDemo,
  decompositionModelReason,
  networkDemoKeyTransition,
  networkDemoNodeAccessibleName,
  nextNetworkDemoNode,
  teachingNetworkCentralitySnapshot,
  teachingNetworkEdgesForNode,
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

describe("zero-total decomposition copy", () => {
  test("reserves structural or inactive context for a complete all-zero row", () => {
    const model = buildDecompositionModel({ total: 0, a: 0, b: 0 }, directAmount);
    const allZero = decompositionModelReason(model);
    const hint = zeroTotalDecompositionHint(model, "毛出口");
    expect(allZero).toContain("所有分项均为 0");
    expect(allZero).toContain("可能为结构零");
    expect(hint).toContain("所有分项均为 0");
    expect(hint).toContain("可能没有活动或为结构零");
  });

  test("describes signed offsets without a false all-zero, structural, or inactive claim", () => {
    const model = buildDecompositionModel({ total: 0, a: 2, b: -2 }, directAmount);
    const copy = [
      decompositionModelReason(model),
      zeroTotalDecompositionHint(model, "毛出口"),
    ].join(" ");
    expect(copy).toContain("正负有符号分项相互抵消");
    expect(copy).toContain("构成占比未定义");
    expect(copy).not.toContain("所有分项均为 0");
    expect(copy).not.toContain("结构零");
    expect(copy).not.toContain("没有活动");
    expect(copy).not.toContain("活跃行业");
  });
});

describe("production-length formula", () => {
  test("renders every VA weight in the actual Step 4 formula, not an unweighted sum", () => {
    const html = renderToStaticMarkup(
      <DecompositionDemo step={6} meta={meta} primaryYear={2020} primaryCountry="CHN" />,
    );
    const formula = html.match(/<div class="decomp-formula">.*?<\/div>/)?.[0];
    expect(formula).toBeDefined();
    for (const term of ["(1_VA_D/SVA) × PLv_D", "(2_VA_RT/SVA) × PLv_RT", "(3_VA_GVC/SVA) × PLv_GVC"]) {
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
        caption="实体 A：2020 年 CHN 中国 · 制造业 · 毛出口分解明细"
        parts={[
          { key: "signed", label: "有符号分项", color: "#123456", desc: "负值说明" },
          { key: "missing", label: "缺失分项", color: "#654321", desc: "缺失说明" },
        ]}
        values={[-12, null]}
        shares={[-25, null]}
        unit="amount"
      />,
    );

    expect(html).toContain('<caption class="sr-only">实体 A：2020 年 CHN 中国 · 制造业 · 毛出口分解明细</caption>');
    expect(html).toContain('<thead class="sr-only">');
    expect(html.match(/scope="col"/g)).toHaveLength(4);
    expect(html.match(/scope="row"/g)).toHaveLength(2);
    expect(html).toContain("有符号构成占比");
    expect(html).toContain("-12");
    expect(html).toContain("-25.0%");
    expect(html).toContain('<td class="dt-val">—</td>');
    expect(html).toContain("—（分母非正）");
  });

  test("provides a native entity/decomposition caption for each decomposition teaching step", () => {
    for (const decomposition of ["毛出口", "总增加值 SVA", "前向总生产长度 PLv"]) {
      const caption = `实体 B：2019 年 USA 美国 · 国家级 · ${decomposition}分解明细`;
      const html = renderToStaticMarkup(
        <DecompositionDetailTable
          caption={caption}
          parts={[{ key: "part", label: "组成项", color: "#123456", desc: "组成说明" }]}
          values={[1]}
          shares={[100]}
          unit={decomposition === "毛出口" || decomposition === "总增加值 SVA" ? "amount" : "number"}
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
    expect(html).toContain("德（DEU），度中心性 4，已选择");
    expect(html).toContain('aria-pressed="true" aria-label="显示度中心性"');
    expect(html).toContain('aria-pressed="false" aria-label="显示介数中心性"');
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
      .toBe("德（DEU），介数中心性 8.000，未选择");

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
    expect(html).toContain("实体 B的分解加载失败：网络连接中断，请检查连接后重试。");
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
    expect(loading).toContain("加载实体 A的分解数据中");
    expect(loading).toContain('role="status"');
    expect(empty).toContain("没有可用分解数据");
    expect(empty).toContain('role="status"');
    expect(empty).not.toContain("加载实体 A");
    expect(error).toContain("实体 A的分解加载失败：boom");
    expect(error).toContain("重试");
  });
});

describe("single-entity decomposition scope", () => {
  test("renders an immediate unavailable state for initial or restored global scope", () => {
    const html = renderToStaticMarkup(
      <DecompositionDemo step={4} meta={meta} primaryYear={2020} primaryCountry={null} />,
    );
    expect(html).toContain("数据表当前范围为“全部国家”");
    expect(html).toContain("不会沿用旧国家");
    expect(html).not.toContain("加载实体 A");
    expect(html).not.toContain("decomp-formula");
  });

  test("keeps an explicit valid country as the only active demo entity", () => {
    const html = renderToStaticMarkup(
      <DecompositionDemo step={4} meta={meta} primaryYear={2020} primaryCountry="CHN" />,
    );
    expect(html).not.toContain("数据表当前范围为“全部国家”");
    expect(html).toContain("加载实体 A");
    expect(html).toContain("decomp-formula");
  });
});
