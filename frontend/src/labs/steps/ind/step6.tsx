/**
 * 步骤 5 · 指标计算(长度)—— 故事:「增加值走一趟生产,平均经过几道工序?」
 *
 * 计算阶段三段式:讲清 → 分解数据表 → 动手拆解(验证各段“VA份额×段长度”的贡献
 * 加权加总 = 总长度)。长度是加权口径,恒等式比 4/5 略微含蓄。
 */
import { api } from "../../../api";
import { explicitDemoCountry } from "../../../decomposition-model";
import { DecompositionDemo } from "../../../demos";
import type { IndicatorSchema, Meta, Step, StepStateApi } from "../../../types";
import { useAsync } from "../../shared";
import { ChartStory, StepIntro } from "../viz/scaffold";
import { IndicatorTable, type IndicatorStepState, useIndicatorControls } from "./indicator-table";

function LengthPathGuide() {
  const nodes = ["原材料", "零部件", "整机", "最终消费"];
  return (
    <section className="length-path-guide" aria-labelledby="length-path-title">
      <div>
        <b id="length-path-title">先用同一条价值路径辨认方向</b>
        <span>这是方向示意；真实指标是许多路径按增加值份额加权后的平均值。</span>
      </div>
      <div className="length-path-nodes" aria-label="原材料到最终消费的价值路径">
        {nodes.map((node, index) => (
          <span key={node}>
            <b>{node}</b>
            {index < nodes.length - 1 && <i aria-hidden>→</i>}
          </span>
        ))}
      </div>
      <dl>
        <div><dt>前向 PLv →</dt><dd>站在增加值来源端，顺着生产链看到最终吸收。</dd></div>
        <div><dt>← 后向 PLy</dt><dd>站在最终产品端，逆着生产链回溯初始投入。</dd></div>
        <div><dt>位置 GVCPs</dt><dd>前向 GVC 段 ÷ 后向 GVC 段；大于 1 只表示该口径下相对更上游。</dd></div>
      </dl>
    </section>
  );
}

export function Step6Length({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<IndicatorStepState> }) {
  const controls = useIndicatorControls(meta, state);
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);

  return (
    <div>
      <StepIntro
        kicker={`步骤 ${step.n} · 指标计算`}
        lead="增加值走一趟生产,平均经过几道工序?"
        concept={step.concept}
        todo={[
          "先看长度分解表:选个国家,读前向 PLv、后向 PLy 与位置 GVCPs",
          "再用「动手拆解」看各段按 VA 份额加权后精确加回总长度",
          "切换国家进行对比；当前选择会自动保存到实验记录",
        ]}
      />

      <LengthPathGuide />

      <ChartStory
        eyebrow="计算结果 · 先出数字"
        title="生产长度分解表(从 ICIO 算出来的)"
        what={<>由步骤 1 的 <b>ICIO 表</b>算出的生产长度：<b>PLv</b> 顺着价值路径向前看，<b>PLy</b> 沿最终产品向后回溯，<b>GVCPs</b> 比较两者的 GVC 段。</>}
        read={<>PLv / PLy 表示增加值平均被计为总产出的次数；数值越大，核算到的生产环节越多。应在同一年、同一粒度内作相对比较。先看两段实际长度，再由 <b>GVCPs = PLv_GVC / PLy_GVC</b> 判断相对位置。</>}
        find={<>换个国家看数字怎么变。GVCPs 较高表示相对上游，但上游活动可来自原材料、关键中间品或生产性服务；下一节验证各段加权后加回总长度。</>}
      >
        <IndicatorTable
          meta={meta} groupKey="length" schema={schema} state={state}
          year={controls.year} country={controls.country} page={controls.page} interacted={controls.interacted}
          onYear={controls.setYear} onCountry={controls.setCountry} onPage={controls.setPage}
        />
      </ChartStory>

      <ChartStory
        eyebrow="验证 & 理解 · 挑一个拆开"
        title="动手拆解:各段加权后加回总长度"
        what={<>挑一个实体,把前向总长度 PLv 拆成三段(纯国内 / 传统 / GVC);每段显示的是<b>"VA 份额 × 段长度"的贡献值</b>,不是段长度本身。</>}
        read={<>盯住绿框:<b>各段贡献加总 = 总长度,误差 ≈ 0</b>——总长度是段长度按增加值份额的<b>加权平均</b>(WWYZ 2017b),不是简单相加。</>}
        find={<>注意 GVC 段通常最长(增加值多次被计为产出);GVCPs = 前向 GVC 段 / 后向 GVC 段。</>}
      >
        <DecompositionDemo
          step={6}
          meta={meta}
          primaryYear={controls.year}
          primaryCountry={explicitDemoCountry(meta.countries, controls.country)}
          onPrimaryChange={controls.setPrimary}
        />
      </ChartStory>
    </div>
  );
}
