# 全局经济学审查：二次确认与修复（2026-09-08）

基线：`07c3597`。本次修复 ER01–ER04，不回滚既有并发/文件缓存修复，不修改课堂数据库 schema、事务、API 字段或发布契约版本。此前的经济学修复参见 [economics-fixes-20260908.md](economics-fixes-20260908.md)；本次不是重复报告那些历史问题。

## 1. 二次确认

修复前重新运行原审查的四个独立反例：**4 失败**。修复后同一文件、同一断言：**4 通过**。

```bash
PYTHONPATH=.:/tmp OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 \
  uv run pytest /tmp/test_oecd_deep_economics_findings.py -q --tb=short
```

| 编号 | 确认的错误 | 修复结果 |
| --- | --- | --- |
| ER01 / P2 | 不连通 TWFE 面板统一按 `E+T−1` 计算固定效应秩，自写实现与 PanelOLS 共享错误假设 | 按最终估计样本的实体—年份二部图计算 `E+T−C`；同步修复自由度预检和库对照 |
| ER02 / P2 | 步骤 4 长度演示顶部将段长度直接相加，漏写 VA 权重 | 实际公式逐项显示 `VA 分项 / SVA × 段长度`，表格改称“加权贡献” |
| ER03 / P3 | 将所有 `invalid_design` 解释为政策路径不相容；对照不足也归咎于处理聚类不足 | 使用后端具体原因；无原因时明确说未提供，不推测失败机制；保留推断抑制 |
| ER04 / P3 | 相隔两年的名义累计增长被当成同比 | 缺少上一日历年时返回 NaN；发布 QC 明确拒绝不连续年度控制变量，不放宽首年空值契约 |

四项反例已扩展为仓库内回归测试：新增后端 **15** 项、前端 **11** 项。没有放宽原数值对照精度、恢复被抑制的推断，或用等待时间规避问题。

## 2. ER01：实际固定效应秩与独立 CR1 对照

文件：`gvcsim/regression/panel.py`、`tests/test_disconnected_twfe.py`。

- 用稀疏图连通分量计算固定效应秩，不构造 `观测数 × 实体数` 的稠密虚拟变量矩阵。
- 在 outcome/control 完整案例筛选之后计算连通结构。既有控制变量自由度预检仍保持保守性。
- CR1 保持 `G/(G−1) × (n−1)/(n−k−rank(FE))`；p 值和区间仍按 `t(G−1)`。
- 连通样本继续由 PanelOLS 吸收实体和时间效应。不连通样本改用实体吸收，加上**每个连通分量各省略一个基期**的时间虚拟变量，使其参数计数正确；显式关闭自动自由度选择并计入实体效应，避免实体嵌套于聚类时又漏计秩。
- 对照仍由 PanelOLS 自行估计系数、残差和协方差，不把自写标准误复制给它，也不关闭 SE 门禁。额外时间虚拟变量不进入对外系数集合。
- 保留库对照原有的 entity-within R² 口径，防止显式时间虚拟变量改变附带统计量的含义。主结果的双向 within R² 不变。
- 不连通样本的 notes 披露连通分量、FE 秩、残差自由度及共同斜率口径。

原反例：6 国仅在 2016–2017 年有观察，另 6 国仅在 2018–2020 年有观察。共 30 行，FE 秩应为 15 而非 16。

| 统计量 | 修复前 | 修复后 / 独立参考 |
| --- | ---: | ---: |
| 政策系数 | 0.493399676755 | 0.493399676755 |
| CR1 标准误 | 0.204349422902 | 0.196916031112 |

测试的独立参考使用完整实体/年份虚拟变量 OLS、SVD 实际秩与 Moore–Penrose sandwich；**不复用**生产实现的连通分量、交替去均值或 PanelOLS。覆盖连通平衡/非平衡面板、交错日历、多分量、单例分量、跨分量国家聚类、附加控制、内部虚拟变量名称碰撞、缺失样本筛选、乱序、仅剩 1 个残差自由度，以及真正无剩余自由度时继续拒绝。

两组固定效应冗余度的图论依据亦见 [reghdfe 的 Degrees-of-Freedom Adjustments / firstpair](https://scorreia.com/help/reghdfe.html)。数值一致只验证实现，**不验证共同斜率、平行趋势或因果识别假设**。

## 3. ER02、ER03：只改错误展示，不改正确算法或门禁

文件：`frontend/src/demos.tsx`、`frontend/src/regression-verdict.ts` 及对应测试；`gvcsim/teaching_report.py` 同步使用“样本支持度不足”摘要标签。

长度顶部等式为：

```text
PLv = (1_VA_D/SVA) × PLv_D
    + (2_VA_RT/SVA) × PLv_RT
    + (3_VA_GVC/SVA) × PLv_GVC
```

段长度 2、3、4，权重 0.5、0.25、0.25 时，贡献为 1、0.75、1，总长度 **2.75**，不是 9。前端模型和后端长度算法原本正确，未修改；直接金额分解仍使用普通加总。

结论卡合并、去重 `result.status_reasons` 与 `support.reasons`，保留旧响应仅在 support 提供原因时的解释。分别覆盖退化 jackknife 方差、PanelOLS 对照失败、实际政策撤销、配对对照不足和原因缺失。摘要标签不再把一般失败定性为政策路径不相容。

12 个处理国、12 个从未处理国、持续暴露且 ATT=0.05 的原反例，仍显示 **+5.00 个百分点**的描述性点估计；SE/p/CI 仍不可用，状态仍为 `invalid_design`。主解释现在准确显示缺少正的 delete-one jackknife 变异，不再声称发生政策路径错误。

## 4. ER04：缺年不算同比，发布契约不扩张

文件：`gvcsim/data/controls.py`、`gvcsim/data/quality.py`、`gvcsim/data/regression_quality.py`、`tests/test_controls.py`。

- `_growth` 显式接收年份，只保留相邻日历年比率；上一年为零或缺失仍保持缺失。
- 2016 年 100、2018 年 121、2019 年 133.1：2018 年增长未定义，2019 年为 10%。不返回 21%，也不自行年化为 10%。其他国家的连续观察不受影响。
- **NaN 是内部构造器的正确诊断，不代表支持发布缺年数据。** 当前产物仅允许各国首年增长率结构性空值。控制变量维度 QC 和回归输入 QC 同步检查年度连续性：即使人为把缺年增长补成有限数字也拒绝发布。这同时避免把按年度步进构造的 mock/平减序列误用于缺年输入。
- 保持 artifact v13 / regression-input QC v4 的字段、版本和首年空值规则；不新增允许缺年发布的契约。连续年度产物不因本次修改被要求升级版本。
- 另外对 8 组随机连续年度面板，与 `07c3597` 的构造器逐项精确比较：全部 18 列（含键和空值）完全一致。

已有发布文件、保存的回归快照及报告不会被代码修改自动重写。若另行确认历史辅助产物来自缺年输入，应补齐来源年份并重新生成、验证，不应仅改 metadata 或绕过 QC。公开主回归仍未开放这些名义控制量。

## 5. 验证结果与隔离边界

| 验证 | 结果 |
| --- | --- |
| 原四个 `/tmp` 审查反例 | 修复前 4 失败 → 修复后 4 通过 |
| 全量后端，默认 hash 模式 | **738 通过、1 跳过**；覆盖率 **90.60%** |
| 前端 `bun run test:unit` | **383 通过、0 失败**，55 文件、1779 个断言 |
| `bun run build` | TypeScript 检查和生产构建通过 |
| Ruff lint / 格式检查、Mypy、`git diff --check` | 通过 |
| agent-browser 本地组件检查 | 1200 / 1440 px；公式完整、允许换行、无横向溢出；加权贡献正确；国家/行业级切换正常 |

全量后端使用 `/tmp/oecd-economics-fixes-full-tests.sh`：

- 创建唯一临时 PostgreSQL 库和角色，并显式将 `GVCSIM_PG_DSN`、`GVCSIM_PG_DSN_TEST` 指向它；`teaching_db` 删除 public schema 的行为只发生在该临时库。
- 将 CI 生成器的原始数据、processed、marker 全部定向到 `/tmp`，构建 **15 国 × 24 行业 × 5 年**合成 release。
- 使用 `setpriv --bounding-set=-dac_override,-dac_read_search`，不改变仓库权限，让不可读文件测试按真实权限工作。
- 结束删除临时库、角色和合成数据；已核实无残留。

本地浏览器使用实际 `DecompositionDemo` 及生产 CSS，数据适配器为内存合成夹具；结论区域展示真实后端退化方差反例经 `buildRegressionVerdict` 生成的文字。通过 agent-browser 截图并检查 DOM 边界，未连接课堂 API。浏览器和临时 HTTP 服务已关闭。**这不是完整课堂端到端验收或线上验收。**

如实保留中间失败：新增增长率测试首轮因 pandas 整数列写入小数的夹具错误而失败，改正夹具 dtype 后在旧实现上稳定暴露 21% 错值；首轮带报告测试的无 release 运行有 5 个 `FileNotFoundError`，改用上述隔离合成 release 后全量通过。开发中增加了 R² 口径回归断言，捕获并修正了显式时间虚拟变量可能引入的附带统计量变化。

日志和临时证据：

- `/tmp/oecd-deep-economics-reconfirm.log`、`/tmp/oecd-deep-economics-findings-green.log`
- `/tmp/oecd-economics-fixes-backend-red.log`、`/tmp/oecd-economics-controls-red.log`
- `/tmp/oecd-economics-fixes-frontend-red.log`、`/tmp/oecd-economics-panelols-r2-guard.log`
- `/tmp/oecd-economics-fixes-backend-full.log`、`/tmp/oecd-economics-fixes-coverage.json`
- `/tmp/oecd-economics-fixes-frontend-full.log`、`/tmp/oecd-economics-fixes-build.log`
- `/tmp/oecd-economics-ui/length-1200.png`、`length-1440.png`、`layout-1200.json`、`layout-1440.json`

本次**未**重算真实 OECD 五年数据、修改真实课堂库、部署或进行容量压测。缺少真实原始数据/default release，不能据此判断正式完整面板是否触发 ER01，也不能把合成验证视为正式经济学结果验收。手册“份额系数乘 100”适用条件的补充建议不属于本次四项缺陷修复，未改写手册或其 PDF。
