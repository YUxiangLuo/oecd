# 普通 I/O 取消边界：二次确认与修复（2026-09-08）

基线为 `99f3e47`。这是[课堂并发修复](classroom-concurrency-fixes-20260908.md)的补充，不改变数据库 schema、数据契约或数值算法；部署只需更新代码并重启 API，不需要重算数据或重置教学库。

## 二次确认

原生 `asyncio.Task.cancel()` 可以中断对 `anyio.to_thread.run_sync()` 的等待，提前释放普通线程令牌，但不会终止底层线程。原修复只在 CPU／原始表调度器内防止了这一点，仍遗漏：

- 主回归、置换检验在进入 CPU 调度前的面板读取。
- 报告的会话读取、落库和学习状态整理。
- 报告 HTTP 入口对整个生成流程监听断连，因此落库时也会取消等待。

真实线程配合阻塞 I/O 替身再次复现：普通线程上限设为 1，连续启动并取消 5 次后仍有 5 个工作在运行，但 `borrowed_tokens` 和调度器跟踪数量均为 0。回归使用 `max_inflight=1` 也不能防止这一情况，因为取消时共享任务键已移除。

先新增 6 项针对既有入口的回归用例，修复前全部失败：主回归／置换读表各一项、报告三个同步阶段各一项，以及落库断连一项。失败分别为令牌提前归零和落库等待返回 499。

## 修复

- 新增 `concurrency.run_sync()`，统一跟踪上述普通同步工作，仍共享原有的 16 个普通线程；额外最多接纳 64 项（含运行中），满额返回带 `Retry-After` 的 503。
- 等待者使用 `asyncio.shield()`；离开时取消工作自己的 AnyIO cancel scope，而不是原生取消工作 task。排队中的调用退出线程队列，已经分配给线程的调用由 AnyIO 的线程屏蔽机制保护，直到真正结束才释放线程令牌和准入名额。无需依赖线程函数刚开始时才设置的标志，因此不会遗漏分配线程到进入函数之间的竞争窗口。
- 取消的回归读取不会继续启动后续估计。仍有其他等待者的共享读取继续执行。
- 报告拆为准备和持久化两个阶段，仅准备阶段监听 HTTP 断连。进入持久化后仍按原来的会话版本检查和事务规则完成处理；响应丢失不代表事务回滚。普通 I/O 不套用 CPU 的 90 秒计算期限。
- 停机收尾同时等待这些同步工作，再由既有 lifespan 关闭数据库池；已无人等待的异常也会被观察，不产生未取回 task 异常。

## 验证入口与范围

[`tests/test_io_cancellation.py`](../tests/test_io_cancellation.py) 包含 15 项用例，覆盖上述入口、排队取消、超量准入、分配线程到函数入口之间的取消、共享读取、迟到异常、恢复重试、数据库池关闭顺序，以及真实 PostgreSQL 行锁期间断连后事务仍完成。

运行含数据库的测试前必须把 `GVCSIM_PG_DSN` 指向新建的隔离测试库；`teaching_db` 夹具会删除目标库的 `public` schema，严禁使用现有课堂库。无数据库的取消边界可单独运行：

```bash
uv run pytest tests/test_io_cancellation.py -q -k 'not real_row_lock'
```

线程竞争测试使用事件和容量状态控制时序；短超时只用于验证受阻事务／停机仍未结束，不作为性能指标。本次不将替身数据和 CI 合成 release 的测试结果当作真实 OECD 数据、Nginx 或 50 人网络压测。

## 验证结果

- 最终代码的针对性后端测试 **235 项通过**，包含全部 15 项新增用例；使用独立 PostgreSQL 测试库，测试后已删除。
- 不依赖数据库的 14 项取消边界用例连续执行 **10 轮全部通过**。
- 前端 **372 项通过**；TypeScript／生产构建、Ruff 格式与 lint、Mypy 通过。
- 另以临时 CI 合成 release 执行后端全套：**662 通过、1 跳过、3 失败**；该次收集后补充的两个竞争用例已纳入上述最终针对性验证。

后续已单独修复上述时间戳断言及真实缓存缺口，见[文件缓存身份修复](file-cache-identity-fixes-20260908.md)；以下保留本轮历史结果，不改记为通过。

全套失败均与既有文件时间戳假设有关：`test_csv_cache_refreshes_when_file_changes_without_size_or_mtime_change[False]`、`test_strict_raw_validator_invalidates_atomic_same_size_replacement_with_restored_mtime` 和 `test_raw_file_identity_uses_ctime_when_inode_size_and_mtime_are_unchanged`。快速改写后本机返回相同 `ctime_ns`；在未修改的 `99f3e47` 干净导出上三项同样可以复现（CSV 缓存用例为间歇失败）。本次未修改相关实现，也未放宽断言或把失败记为通过。root 环境验证时去掉 DAC 读取权限绕过能力，以正常检验不可读文件，而未修改仓库权限。
