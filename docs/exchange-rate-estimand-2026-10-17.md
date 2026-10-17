# 汇率的估计量：偏关联与总关联

日期：2026-10-17。范围：步骤 10–14 的默认模型、课程设定值、预设实验、结果卡、报告附录、题库与教师评分量规。数据 release 不变。

## 1. 问题

代码里的汇率（`teaching_exchange_rate_change`）由两部分组成：

```text
E = 噪声 + (−8) · 1[第一批被加税国家且 year ≥ 2018]
```

第一批国家 2018 年起加税，汇率也在同一年起额外贬值 8%；每个 Y 又按 `(−0.0095β)·E` 受汇率影响。也就是说：

```text
W（批次/加税时点）
├──→ X = w × τ ──────────────→ Y
└──→ E = 噪声 − 8·1[W=1,t≥2018] ─→ Y
```

`E` 和 `X` 都是 `W` 的下游。`E` 是**加税后同期变量（post-treatment）**，不是加税前就存在的混杂（confounder）。原口径却把 `E` 叫“混杂”，把去掉 `E` 叫“遗漏变量偏误”，并在同一段提醒“本身受关税影响的变量不应直接作为控制变量”，自相矛盾。

## 2. 估计量

- 默认模型：`Y ~ X + L1.X + 汇率 + GDP + 开放度 + FE`。X 的系数是**扣除汇率渠道后的偏关联**；课程设定值 β 对应这个模型。
- 去掉汇率：`Y ~ X + L1.X + GDP + 开放度 + FE`。X 的系数是**包含汇率渠道的总关联**；在 v13 数据上幅度约大 13%。
- 两者不是对错，是不同估计量。13% 不是“汇率效应”或“普适偏误”，而是第一批“高 X + 2018 年后 −8% 汇率”这一特定结构造成的差异。

GDP 对数和贸易开放度不同：它们从 2016 年起分化，是加税前趋势；漏掉它们，估计相对 β 有偏。汇率是加税后同期变化；漏掉它，估计换成总关联。

| 控制 | 时间 | 控制它 | 去掉它 |
| --- | --- | --- | --- |
| GDP 对数、贸易开放度 | 加税前趋势 | 减少遗漏预趋势的偏差 | 相对 β 有偏 |
| 汇率变动 | 加税后同期 | 偏关联（扣除汇率渠道） | 总关联（包含汇率渠道） |
| 人口增长率、FDI | 与加税无关 | 精度／负控制 | 几乎不变 |

## 3. 本次改动（方案 B）

不改数据、不改 β、不改 20,111 次估计与 200 种子基准的数值；只改估计量标签、页面/报告文案与设定值比较规则。

- `gvcsim/regression/spec.py`：`ControlInfo` 增加 `role`；汇率=`post_treatment`，GDP/开放度=`confounder`，人口/FDI=`negative_control`，ICIO 派生=`icio_control`；新增 `spec_omits_post_treatment`。
- `gvcsim/regression/workbench.py`：控制变量返回 `role`/`role_label` 与 `control_roles`；设定值说明区分“漏掉加税前趋势”与“去掉加税后同期”；`去掉汇率变动` 的问题改为“去掉汇率渠道后，合计是总关联还是偏关联？”；`去掉 GDP 对数` 改为与开放度比较。
- `gvcsim/report_workbench.py`：报告附录的设定值行改为“课程设定值（默认模型偏关联）”；不含汇率的列写“总关联；不与偏关联设定值比较”，不再打印偏差。
- `frontend/src/regression-workbench-table.ts`、`regression-step/result-text.ts`：结果卡与表格同规则；不含汇率的模型不比较设定值。
- `frontend/src/regression-workbench.tsx`：控制变量显示角色标签；自定义说明区分三类控制。
- `frontend/src/labs/steps/shock-lab.tsx`、`regression-step/family-bars.ts`：步骤 10 与“先看数据”的说明改为“加税前趋势 vs 加税后同期”；平行趋势只按加税前趋势表述。
- `gvcsim/quizzes.py`：步骤 11 题改为“控制汇率后估计的是偏关联还是总关联？”
- `frontend/src/teacher/reports.tsx`：评分量规要求区分两类控制。
- `README.md`、`技术手册.md`（新增 7.6）、`实验手册.md`（2.30）、`docs/regression-model-space-check-2026-10-14.md`：口径同步；数值不变。

## 4. 教学脚本

1. 步骤 10 先看加拿大（第一批）2018 年起汇率约 −8%，同时看 GDP 和开放度从 2016 年起就分化。
2. 步骤 11 读默认模型：X 的系数是“控制汇率后”的偏关联；课程设定值对应它。
3. 点“去掉汇率变动”：不是“修正一个错误”，而是换成包含汇率渠道的总关联；问“这两个数回答的是同一个问题吗？”
4. 点“去掉 GDP 对数”或“去掉贸易开放度”：这才是遗漏加税前趋势造成的偏离；与汇率实验对比。
5. 报告里写“默认模型估计偏关联；去掉汇率估计总关联；两者不是对错”，不要写“去掉汇率后关税作用更大”。

## 5. 备选方案

- **A. 把汇率改成真混杂**：把 −8% 贬值改成 2016 年起的预趋势，或由 2016 年顺差/汇率水平生成；重建 release，重跑模型空间与 200 种子。保留“遗漏变量偏误”的简单课，但所有数字、步骤 10 图和手册示例都要重做。
- **B. 保留 DGP，改口径（本次采用）**：不重建数据；把汇率叫处理后变量，区分偏关联/总关联；GDP 和开放度继续承担“遗漏变量偏误”的教学例子。
- **C. 默认模型去掉汇率**：默认估总关联；但课程设定值 β 是偏关联，设定值机制要整体重做，且总关联随批次异质，不推荐。

## 6. 验证

- `uv run ruff check .`、`uv run ruff format --check .`、`uv run mypy`。
- `cd frontend && bunx tsc --noEmit -p . && bun run test:unit`。
- 后端定向：`pytest tests/test_quizzes.py tests/test_workbench.py tests/test_teaching_report.py tests/test_teaching_regression.py tests/test_steps.py tests/test_route_adapters.py`（需要一次性测试库；`teaching_db` 会清空所连库的 `public` schema）。
- 手工：步骤 10 控制卡、步骤 11–14 预设/设定值行/结果卡、步骤 15 报告附录；确认不含汇率的列写“总关联；不与偏关联设定值比较”。

## 7. 后续

- 把 benchmark 绑定到当前 release（`release_id` + panel SHA-256），避免“当前 release”证据与提交物脱节。
- 在教师手册/生成规则说明里写明弱效应 Y 的噪声 draw 是课程挑选的零效应示例。
- 为 pytest 加测试库护栏，避免 `source .env.local && uv run pytest` 清空课堂库。
- 若未来把汇率改成预趋势（方案 A），删除本文件的“方案 B”段落并重新生成学生手册截图与 PDF。
