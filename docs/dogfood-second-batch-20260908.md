# 深度 Dogfood：第二批执行记录

日期：2026-09-08。代码基线仍为 `3bad3e7c682fc8f49109b93f07f710777544fd88`。

**当批状态：完成基础 36 格回归矩阵、两轮报告快照与本人改密恢复，并执行多轮三标签/换号测试；不是全量验收或修复结论。**

后续定位更新：DF-DEV-01 空白页已定位为浏览器所在机器 `/tmp` 容量压力引发 Chromium 资源加载失败。独立磁盘 `TMPDIR` 对照六轮完整流程通过，业务代码未改；旧 CDP 超时未逐项证明同因。见 [定位报告](dogfood-dev-blank-root-cause-20260908.md)。以下保留当批证据与当时判断。

计划：[dogfood-plan-20260908.md](dogfood-plan-20260908.md)。第一批：[dogfood-progress-20260908.md](dogfood-progress-20260908.md)。本批证据：`dogfood-output/deep-3bad3e7-20260908/second/`。

## 1. 已完成的结果

| 检查 | 实际结果 | 限制 |
| --- | --- | --- |
| B05 基础矩阵 | 4 类指标 × 3 方法 × 3 冲击，36 个最终响应均 HTTP 200、设计绑定正确 | 真实 API；不是 36 条浏览器完整旅程 |
| 推断状态 | 4 `ok`、16 `invalid_design`、16 `insufficient` | 状态不等于因果识别；停止推断不是请求失败 |
| 数值审核/门禁 | 4 个 `ok` 均通过返回的 PanelOLS 库对照；32 个停止推断结果 p/CI/星号均抑制 | 并非另行独立重算所有协方差 |
| 本人改密恢复 | 两个新普通账号，各成功提示并恢复改密前未保存草稿，DB 核对一致 | 使用浏览器定向 abort 制造保存失败；不是主旅程 |
| 报告快照 | 两个新辅助账号，两轮均通过 | 前置材料由 API helper 预置，明确不计为从零 UI 主旅程 |
| 三标签版本冲突 | 多次通过：旧标签保持本地稿、显式加载服务端版本，再正确保存 | 不代表换号后的完整后半段每次都通过 |
| 撤销旧请求/换号/恢复 | Vite dev 有一组两轮完整通过；生产前端 preview 另有两轮完整通过 | dev 还有失败记录，不能合并写成全部通过 |
| 构建 | `bun run build` 通过 | 仅生成本仓库 dist；未部署到 `/opt/gvcsim` |

## 2. 回归矩阵口径与门禁

从开发 API `/api/regression/options` 读取真实支持范围，使用同一开发学生 `student02` **串行**请求：

- outcomes：trade / production / length / network。
- methods：did / event_study / twfe_intensity。
- shocks：tariff / sanctions / export_control。
- 固定国家行业粒度、无控制、无交互、clean 场景、排除 ROW、名义口径、首次处理前固定权重。

没有修改或绕过每分钟限额。收到 429 后按 Retry-After 等待 **49、1、50 秒**并重试；这是协议退避，不是用 sleep 修正数值或竞态断言。

四个 `ok` 均为关税连续强度 TWFE。API 每份设计中的 outcome/method/shock/granularity 均与该请求一致。矩阵及完整响应保留在 `matrix/`，后续门禁核查在 `matrix/gates-verified.json`。

额外复核最初误以为所有停止推断结果都应删除 SE/t，且第一次读取 benchmark 字段的层级错误；核对当前实现和 JSON 后纠正了检查脚本，**未修改应用或已有测试**。现有 TWFE 支持不足契约明确保留诊断性 SE/t、抑制 p/CI/星号；本矩阵有 8 个此类响应。不能将 ER03 零 jackknife 方差下的 SE 空值规则推广到所有 TWFE 诊断。

仍未覆盖 country 粒度、当期权重、交互、其他场景及所有前端选做分支；这些不包含在“36 格完成”里。

## 3. 报告快照与本人改密

### 报告快照两轮

执行 `scripts/dogfood_report_snapshots.py`，仅用新创建的 `report-snapshot-*` 账号。该脚本通过 `seed_full_journey` 准备报告前置数据，不冒充第一批真实 UI 旅程。

逐轮核对：

1. 已评分旧报告形成固定快照。
2. 在浏览器只把关税设置切成出口管制，旧 run、旧 report 不变。
3. 实际运行新设置，保存最新不可推断诊断，旧 report 仍不变。
4. 修改原创研究问题，只有 session 更新，旧 report 仍不变。
5. 点击重新生成并提交后，报告更新为 pending、旧评分清空，新结果与 provenance 一致。

本次关税基准本来就是诊断结果，没有 qualified_run。因此只覆盖“诊断基准 → 新诊断”的分支；**未验证已有合格估计仍作为对照、另保留探索结果的分支**。

首次运行误在模型设计仍生成、控件尚不可用时点击，工具称找不到“出口管制”。实际 snapshot 确认该按钮存在。辅助包装器只增加“真实按钮已启用”的条件等待和 snapshot；没有更改数字、预期状态或后端门禁，重跑两轮通过。

证据：`dogfood_report_snapshots/run.log`（原失败）、`dogfood_report_snapshots-retry1/results.json`、`settings-only-*.png`、`insufficient-followup-*.png`、`regenerated-*.png`。

### 本人改密两轮

执行 `scripts/dogfood_self_password_recovery.py`：浏览器只阻断本账号 session 保存请求 → 输入原创稿 → 看到重试提示 → 正常本人改密 → 解除路由阻断 → 新密码登录 → 接受恢复提示 → DB 核对稿件。

两个普通新账号均 `offered=true`、`recovered=true`。证据在 `password-recovery/`。不使用受保护的 demo 账号验证改密，不停用课堂账号。

## 4. 当批未关闭观察 DF-DEV-01：多标签换号后退出时的空白页/失响应

**分类：已重复观察到开发环境异常，根因未定。不能据此认定生产缺陷、数据丢失或越权，也不能将本场景标为全面通过。**

### 环境与步骤

独立 Vite dev `127.0.0.1:18762` → 本轮故障代理 `18761` → 开发 API `8001`。代理只在显式 gate 匹配时挂起 session PUT，默认放行；不接入 8000。

1. 新普通账号 A 登录，打开三个真实标签，逐个制造并恢复旧版本保存冲突。
2. 标签 1 的新稿 PUT 在发往 API 之前被 gate 挂起。
3. 教师重置 A 密码；标签 2 退出 A、登录另一新账号 B。
4. 放行旧 A 请求，确认没有写入 A；B 页面不显示 A 的恢复稿，保存 B 新稿并核对 DB。
5. 标签 2 再次退出 B，准备重新登录 A、恢复 A 的未保存稿。
6. 在步骤 5 附近部分运行无法出现登录页或无法完成输入。两份截图为空白页；一次 DOM 证据为 `readyState=complete`、`<div id="root"></div>`、页面 URL 仍为 `/?step=15`，未捕获 JS 错误为空。

### 运行记录（不选择性省略失败）

| 输出子目录 | 结果 |
| --- | --- |
| `dogfood_workspace_interleavings` | 三标签检查通过，随后登录密码输入 CDP `Input.insertText` 超时，失败截图采集也报错 |
| `...-retry1` | 三标签通过，后半段等待登录框超时；空白截图，body 文本为空 |
| `...-retry2` | 两轮完整通过：三标签、撤销旧请求、换号隔离、旧账号稿恢复 |
| `...-retry3` | 三标签通过，再次空白；保存 console、URL、空 root DOM 等诊断 |
| `...-dev-video` | 再次后半段失响应；诊断中的 Runtime.evaluate 也超时，未获得可靠完成的复现录像 |
| `...-prod2` | 当前代码生产构建 + Vite preview，无开发 HMR；同一脚本两轮完整通过 |

另有一次重启探测把无监听的 TIME_WAIT 端口判成占用，未进入用例；改正本地启动器的 SO_REUSEADDR 探测后再运行。`...-prod1` 误假设 API 自带静态根页面，实际 `/` 返回 404，属于环境搭建失败，不计为产品失败；生产对照随后使用真正的 Vite preview。

截图：`...-retry1/failure.png`、`...-retry3/failure.png`。详细诊断：`...-retry3/diagnostic-1788881199369834244.json`。录制尝试受 CDP 失响应影响，保留文件但**不算完整复现视频通过**。

目前不能确定 React、开发模块加载、Chromium/CDP 哪一层导致异常。生产 preview 两轮未复现只能缩小排查方向，不能证明已修复。下一步应采集导航/模块加载与浏览器主线程证据，保留生产/开发模式对照；不要先改认证逻辑或放宽等待时限。

## 5. 隔离与收尾

- 临时故障代理与 dev/preview 18761/18762 均由本地启动器持有进程对象，在 finally 中关闭；最终无监听。
- 浏览器均为本轮命名 session，脚本 finally 关闭；录制 ffmpeg 已退出。
- 仍使用独立开发库/数据副本。第一批 `student` 报告未用于这些修改；辅助账号及其证据保留在开发库。
- 开发 5173/8001 保持运行，原课堂 8000 未停止或改配置；没有停止共享 PostgreSQL。
- 没有执行发布切换、原始数据损坏、私有 PGDATA 停机测试或容量压测。
- 未改业务代码；本地启动/诊断辅助脚本仅位于 `/root/.local/share/gvcsim-dev/`。尚未提交或 push。

## 6. 后续仍待执行

DF-DEV-01 的归因优先；此外还有已有 qualified_run 的报告分支、同步 I/O 请求取消与响应丢失、其余回归设置、D 阶段发布/数据库隔离故障，以及 E 的完整桌面/键盘/性能矩阵。本批结果不填充这些未执行项。
