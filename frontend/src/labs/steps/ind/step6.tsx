/**
 * 步骤 5 · 指标计算(长度)—— 故事:「增加值走一趟生产,平均经过几道工序?」
 *
 * 计算阶段三段式:讲清 → 分解数据表 → 动手拆解(验证各段“VA份额×段长度”的贡献
 * 加权加总 = 总长度)。长度是加权口径,恒等式比 4/5 略微含蓄。
 */
import { api } from "../../../api";
import { DecompositionDemo } from "../../../demos";
import type { IndicatorSchema, Meta, Step, StepStateApi } from "../../../types";
import { useAsync } from "../../shared";
import { ChartStory, StepIntro } from "../viz/scaffold";
import { IndicatorTable, type IndicatorStepState, useIndicatorControls } from "./indicator-table";

export function Step6Length({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<IndicatorStepState> }) {
  const controls = useIndicatorControls(meta, state);
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);

  return (
    <div>
      <StepIntro
        kicker={`步骤 ${step.n} · 指标计算`}
        lead="增加值走完整条生产链，平均经过多少个生产环节？"
        concept={step.concept}
        todo={[
          "先看长度分解表：选择一个经济体，读取前向 PLv、后向 PLy 与位置指数 GVCPs",
          "再用「动手拆解」看各段按 VA 份额加权后精确加回总长度",
          "切换经济体进行对比；当前选择会自动保存到实验记录",
        ]}
      />

      <ChartStory
        eyebrow="计算结果 · 先出数字"
        title="生产长度分解表（由 ICIO 计算）"
        what={<>由步骤 1 的 <b>ICIO 表</b>计算生产长度：<b>前向长度（PLv）</b>从增加值来源看到最终吸收，<b>后向长度（PLy）</b>从最终产品回溯到初始投入，<b>GVC 位置指数（GVCPs）</b>比较前向与后向 GVC 长度。</>}
        read={<>PLv 和 PLy 表示增加值被计为总产出的平均次数；<b>GVCPs &gt; 1</b> 表示前向 GVC 长度相对更长，因此位置相对更靠上游。它不能单独识别具体产业角色。</>}
        find={<>切换经济体，比较 PLv、PLy 与 GVCPs 是否给出一致的链长和位置判断；再到下一节检查各段贡献能否加回总长度。</>}
      >
        <IndicatorTable
          meta={meta} groupKey="length" schema={schema} state={state}
          year={controls.year} country={controls.country} page={controls.page} interacted={controls.interacted}
          onYear={controls.setYear} onCountry={controls.setCountry} onPage={controls.setPage}
        />
      </ChartStory>

      <ChartStory
        eyebrow="验证与理解 · 选择一项拆开"
        title="动手拆解：各段加权后加回总长度"
        what={<>选择一个实体，把前向总长度 PLv 拆成纯国内、传统贸易和 GVC 三段；每段显示的是<b>“增加值份额 × 段长度”的贡献值</b>，不是段长度本身。</>}
        read={<>查看绿框中的恒等式：<b>各段贡献加总 = 总长度，误差 ≈ 0</b>。总长度是各段长度按增加值份额计算的<b>加权平均</b>（WWYZ 2017b），不是简单相加。</>}
        find={<>比较三段对总长度的贡献，再用 GVCPs = 前向 GVC 段 / 后向 GVC 段判断相对位置。</>}
      >
        <DecompositionDemo
          step={6}
          meta={meta}
          primaryYear={controls.year}
          primaryCountry={controls.country}
          onPrimaryChange={controls.setPrimary}
        />
      </ChartStory>
    </div>
  );
}
