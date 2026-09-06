第一批深度测试结果（2026-09-07，基于 49c7af1）

已完成计划指定的第一批七个案例：SYNC-01、SYNC-02、AUTH-02、REPORT-01、REPORT-02、FAIL-01、E2E-01。发现两项产品问题，分别经过两次独立账号/场景复现后修复；其余测试脚本中的滚动、控件名称、答案夹具和异步等待问题已修正，没有计入产品缺陷。

| 案例 | 测试方法 | 结果与证据 |
| --- | --- | --- |
| SYNC-01 | 真实浏览器编辑；代理确认上游已返回 200 后扣留、丢弃响应；期间继续编辑，再重试并显式载入服务器版本 | 两轮通过。数据库保留第一次已提交内容，未确认的新编辑留在页面，重试收到 409；只有显式选择服务器版本才替换页面。`dogfood-output/p0/sync-final.log` |
| SYNC-02 | 扣留旧保存响应，观察新编辑的实际防抖回调，再释放响应 | 两轮通过。旧响应不覆盖新编辑，队列保存最新内容，刷新后与 PostgreSQL 一致。`dogfood-output/p0/sync-final/` |
| AUTH-02 | 两个从未保存过会话的普通学生，在版本 A 暂存退出，停服切换 B 后重新登录 | 修复前两个账号均能把 A 的暂存写入 B；修复后两个账号均无恢复入口、无 B 会话写入。回到暂存所属版本后，两份内容仍能恢复。`auth-before.json`、`auth-fixed.json`、`auth-same-release.json` |
| REPORT-01 | HTTP 路由读取旧会话后阻塞报告构建；另一请求保存新会话；随后释放构建 | 无旧报告/已有旧报告两种情况通过：返回带 `session_changed` 的 409，原报告不变，新会话保留。`tests/test_p0_transactions.py` |
| REPORT-02 | 在真实 PostgreSQL 写入后、提交前持有行锁，并通过 `pg_stat_activity` 确认另一请求正在等待；分别强制评分优先、重生成优先、两个教师竞争评分 | 三种情况通过：新报告不搭配旧评分；陈旧评分被拒绝；同一版本仅一个教师成功评分。`transactions-locked.log` 与最终全量测试 |
| FAIL-01：事务中断 | 找到被本测试所持行锁阻塞的数据库连接，并仅终止该连接 | 两轮通过：API 返回 503，原会话与版本戳不变；连接恢复后可正常重试保存。`transaction-abort.log` |
| FAIL-01：进程终止 | 启动测试脚本自己拥有的 API 子进程，分别在事务提交前、数据库提交且响应未交付后 SIGKILL | 两轮、四种执行通过：提交前无半成品，提交后数据保留；重启后原令牌仍有效，陈旧写入被拒绝。`process-faults.log` |
| FAIL-01：数据库停启 | 独立 PostgreSQL 实例停止；验证 liveness/readiness，真实浏览器刷新；启动数据库并重试 | 修复前两次均误退出有效登录；修复后两次保留令牌，liveness=200、readiness=503；数据库恢复后直接重试回到原会话，已保存文字保留。`database-restart-confirm.log`、`database-restart-fixed.log` |
| E2E-01 | 教师在浏览器创建普通学生；从空会话逐步操作 1–15；实际点击全部 19 道理解题，包含一次错答重试；记录数据、比较、三类事件、四项回归、反思；生成提交，教师评分，学生刷新查分 | 全部 15 步通过，最终 93 分且三段反思在数据库报告中完整保留。没有 API 预填学习记录或直接写会话/报告表。`course-verified.log`、`course-verified/results.json` |

证据路径除另有说明，均相对于 `dogfood-output/p0/`。报告竞争测试的数据库和 HTTP 路由是真实的；REPORT-01 用受控构建替身固定时序，专门检查来源版本竞争，实际完整报告构建由 E2E-01 覆盖。

修复一：恢复记录缺少数据 release 绑定。

旧暂存只有用户名和基础版本戳。原会话尚未创建时，基础版本戳为 null；换版后的新会话也为空，因此旧内容可以通过正常的首次保存规则被写入新版本。现在会话读取接口返回认证所绑定的 release，暂存结构升为 version 2，写入与恢复均使用该 release。不同账号、不同 release、无法确认所属 release 的旧版暂存都不提供恢复。检查不匹配时不直接删除原暂存；本次测试验证了回到原版本可恢复。仍沿用单份暂存机制，不宣称支持多版本离线草稿库。

修复二：登录校验把临时故障当作过期。

API 层原本已经区分 503 与 401，但 App 启动逻辑对所有登录校验异常都执行退出。现在只有明确的 401 才按过期处理；临时依赖故障显示保留登录信息的重试页面，既不挂载未经校验的工作区，也不清除有效令牌。服务恢复后可重试连接。

最终回归：后端 562 项通过，覆盖率 89.60%；前端 362 项通过，TypeScript/Vite 构建通过。新增回归覆盖恢复 helper 与实际 useSession 的跨版本防护、旧暂存拒绝、503/500 启动行为、真实 401、服务端 release 返回，以及五项 PostgreSQL 报告竞争场景。Ruff、格式和 mypy 另有最终检查记录。

可复用测试入口：

| 文件 | 用途 |
| --- | --- |
| `scripts/dogfood_fault_proxy.py` | 仅回环监听的可控前置/后置响应屏障；不记录请求头或正文；不得作为演示部署服务启动 |
| `scripts/dogfood_sync.py` | 浏览器保存丢响应、在途编辑、数据库核对；同时提供统一 agent-browser 控制器 |
| `scripts/dogfood_transaction_abort.py` | 校验独立 PostgreSQL 数据目录后，只终止被本测试行锁阻塞的连接 |
| `scripts/dogfood_process_faults.py` | 启动并终止自身拥有的 API 子进程，验证提交前后持久性 |
| `scripts/agent_browser_course_journey.py` | 普通账号的纯浏览器完整课程；数据库只读核对；使用独立维护的答题选择，不导入服务端判题答案 |
| `tests/test_p0_transactions.py` | 可随 pytest 运行的确定性 PostgreSQL 报告竞争回归 |

上述脚本通过环境变量指定目标与测试账号：`GVCSIM_BASE_URL`、`GVCSIM_PG_DSN`、`GVCSIM_E2E_TEACHER_USERNAME`、`GVCSIM_E2E_TEACHER_PASSWORD`、`GVCSIM_E2E_PASSWORD`、`GVCSIM_E2E_ARTIFACT_DIR`。同步测试另外需要 `GVCSIM_FAULT_PROXY`；数据库/进程故障脚本需要 `GVCSIM_FAULT_PGDATA`，并核对连接实际指向该目录。Python 使用锁定的 uv 环境，前端使用 Bun；浏览器与截图均使用 agent-browser。

故障环境使用独立的 PostgreSQL 实例（本机 15432）和独立数据副本。A/B 是从上一轮真实五年产物复制、重新生成合法 metadata 的两个不同 release，用于验证身份和恢复隔离；没有把这一测试当成完整 compute 发布/回滚验收。原演示数据库所在的 5432 实例没有被停止。

剩余项目仍按 `deep-test-plan.md` 排队：更广的账号/响应交错、报告设置与快照语义、compute 发布中断/磁盘故障、独立数值核验、课堂容量分布及持续运行。本批没有运行过夜负载，没有模拟机器断电，也没有执行远程部署。
