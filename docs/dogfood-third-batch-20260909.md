# 深度 Dogfood：续测第三批

日期：2026-09-09；业务基线 `3bad3e7`。用户在前轮收尾后要求继续测试，已重新启动独立 8001/5173。课堂 8000 与共享 PostgreSQL 不变。本批不提交、不修业务代码。

## 1. 已有 qualified_run 的报告保留分支：两轮通过

使用两个新辅助账号，前置材料通过 seed helper 和公共 API 构造，**不是从零 UI 主旅程**。基准从 DID 改为实际运行的关税连续强度 TWFE；四项响应均先严格断言 `_result_is_qualified`，随后保存与真实设计一致的 settings。没有伪造结果、签名或推断状态。

UI 后续执行：切换出口管制但不运行、实际运行修改后的设定、修改反思、重新生成提交。

两轮均验证：

- 仅改设定不修改已有 run/qualified_run 或旧报告。
- 新的停止推断结果不会覆盖旧 qualified_run；旧报告在重生成前保持不变。
- 重生成后，新诊断与旧可推断结果的设计/结果均完整保留在报告来源记录中。
- 对照表采用最新完整诊断，不能用旧可推断结果替换或隐藏本次设计限制。
- 新反思进入报告，状态为 pending，旧 50 分清空。

证据：`dogfood-output/deep-3bad3e7-20260908/second/dogfood_report_snapshots-qualified-disk2/`，两条 `REPORT-03` 均通过，`kept_qualified_tariff_run=true`、`diagnostic_only_baseline=false`。

### 初次失败是旧测试口径，不是产品缺陷

`qualified-disk1` 在最后的表格断言失败：仓库旧脚本要求“关税旧结果进入对照表，出口管制为未列入表格的探索结果”。

复核依据：

- `frontend/src/regression.tsx` 明确显示：旧估计保留供核对，不能用它替换或隐藏本次设计限制。
- `tests/test_teaching_report.py::test_complete_stopped_diagnosis_satisfies_report_gate_without_hiding_it` 明确要求完整新诊断进入表格，即使旧 qualified_run 存在。
- `teaching_report._saved_runs()` / `_reported_by_step()` 的顺序与上述契约一致。

保留首次失败日志和截图；只在私有辅助脚本副本中校正了表格断言，并新增“两份来源记录均存在、最新诊断仍抑制推断”的检查。没有删掉 qualified_run 的身份一致性或旧报告不可变断言，也没有修改仓库业务代码。校正后换两个新账号，两轮全部通过。

## 2. 提交成功但响应丢失：两轮 API 集成检查通过

使用两个新辅助账号和拥有的回环故障代理 18763，代理仅指向独立 8001。故障点是**上游已经返回 200 后**暂停，再丢弃下游响应。

每轮实际顺序与断言：

1. 新账号初始 session 无持久化修订，提交一个辅助研究问题。
2. 代理停在 after，确认上游 HTTP 200。
3. 尚未释放响应时，直连后端 GET 已能读取提交的数据及新修订。
4. 释放并丢弃响应，原请求客户端得到 `RemoteDisconnected`。
5. 再次 GET，修订和 session 与丢响应前已经提交的状态完全一致。
6. 用旧 `base_updated_at=None` 重放，返回 409。
7. 使用重读后的修订继续修改，保存 200，GET 核对新文本成功。

证据：`third-20260909/response-loss/results.json`（相对上述证据根），两轮通过。代理在 finally 中正常退出，18763 已无监听。

这是 API 集成检查，不冒称 UI 自动重试或报告提交响应丢失已完成验证；更不把“客户端断开”写成数据库事务回滚。

## 3. 同步取消与报告契约：隔离单元子集通过

执行 `tests/test_io_cancellation.py`，明确排除需要 `teaching_db` 的真实行锁案例；同时运行上述完整诊断报告契约的两个参数案例。

结果：**16 passed, 1 deselected，4.57 秒**。其中 14 项为同步取消/准入/停机顺序等单元回归，2 项为报告契约。

使用单独的临时数据路径和拒绝连接实际数据库的测试 DSN，没有向测试进程提供开发或课堂 DSN，没有调用会删除 public schema 的 teaching_db fixture。

证据：`third-20260909/unit-cancellation-and-report.log`。这不是实际服务端进程取消/数据库锁的端到端故障测试；真实行锁测试仍待专属一次性库。

## 4. 状态与剩余范围

本批没有确认新的业务缺陷，新增发现是旧辅助测试的表格选择预期过时。此前最终报告是前轮停止时的快照，本篇补充其未测的 qualified_run 分支与部分响应丢失覆盖。

仍待执行：其余回归参数与 UI 快切归属、报告提交响应丢失/UI 恢复、真实服务取消/行锁、评分越界实际提交、私有 PGDATA 及发布副本故障、完整 1200/1440/1920 桌面/键盘/性能矩阵。

开发 8001/5173 本次恢复后保持运行。所有新浏览器操作沿用独立磁盘 TMPDIR；本批报告浏览器已关闭，临时代理已退出。开发数据及全部证据保留，未提交、推送或部署。

## 5. 后续授权修复：同步仓库辅助测试断言

用户明确要求修复后，已修改仓库 `scripts/dogfood_report_snapshots.py`：

- 两个分支均要求最新出口管制诊断进入对照表、保留停止推断说明。
- 旧 qualified_run 存在时仍核对其完整设计与结果，断言来源记录恰为两份；不存在时恰为一份。
- 新增最新诊断的设计一致性检查，保留旧报告不可变、反思更新、评分清空等原断言。
- 结果摘要记录基准方法与最新诊断进入表格，避免混淆测试覆盖。

私有运行器已改为直接执行修复后的仓库脚本，不再执行私有断言副本。真实 TWFE 基准的构造仍只作用于 seed helper，不改业务或伪造结果。

复跑结果：`qualified-repo-fix-disk1` 两轮通过（有 qualified_run，TWFE 基准）；`repo-fix-disk1` 两轮通过（无 qualified_run，DID 诊断基准）。共四轮通过，证据位于原 `second/dogfood_report_snapshots-<后缀>/` 目录。Ruff 与 `git diff --check` 通过。未改业务逻辑，未提交、推送。
