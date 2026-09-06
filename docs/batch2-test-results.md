后续批次测试结果（2026-09-07，基于 d42706f）

上一批已提交为 `d42706f`。本批继续执行剩余 P0 组合场景，并完成 DATA-01 的首轮独立原始数据核验。下面只列实际执行范围；容量分布、过夜运行及其余数值独立基准仍未宣称完成。

本批确认并修复的问题：

| 问题 | 复现证据 | 修复 |
| --- | --- | --- |
| 旧发布目录无法列举时，可用的新发布被清理异常标记为失败 | 两次实际移除目录读权限，当前与上一发布的文件仍可按路径读取，但清理抛 PermissionError | 目录扫描失败返回清理警告；实际 compute 的清理失败场景两轮均成功保留新旧完整发布 |
| 点击载入服务器版本后继续输入，返回的快照覆盖新输入 | 两个普通学生、真实浏览器与延迟 GET 响应；新文字均被旧快照覆盖 | 记录载入开始时的本地快照，期间出现编辑则保留内容并要求重新明确载入；并阻止重复的并发载入 |
| 同大小且保留修改时间的文件变更被缓存掩盖 | 原地写入和原子替换各两次，完整校验拒绝而缓存校验接受 | metadata、CSV 与 release 校验缓存纳入设备、inode、大小、mtime、ctime |
| 健康检查已拒绝坏产物，数据 API 仍返回被篡改的内容 | 两个独立 API 子进程中，篡改国家标识后数据 API 为 200，health 为 503 | 签发令牌和校验有效令牌时检查当前产物树；同样场景复测 API/health 均为 503，坏数据不再返回 |
| 嵌套的 dataset.json 普通文件或同名符号链接绕过产物清单检查 | 两轮各添加未注册普通文件和符号链接，缓存/文件扫描未识别 | 只排除根目录 metadata 文件，嵌套同名文件仍参与清单及符号链接检查 |
| metadata 的非法 UTF-8/孤立代理字符未归类为产物故障 | 两类编码异常各重复触发两次，直接泄漏 UnicodeDecodeError/UnicodeEncodeError | 归为 ArtifactContractError；回归验证有效令牌及正常登录收到 503，而非误判过期或返回 500 |
| 学生自行改密时漏存未同步草稿 | 两个账号在会话保存断网时自行改密；重新登录均无恢复入口且数据库无草稿 | 改密成功退出前调用同账号、同 release 的草稿暂存；两轮浏览器复测恢复成功，并增加实际 App/改密弹窗集成回归 |

REPORT-03 测试起初误将 provenance 中“第一条步骤 11 结果”当作唯一结果。复核后确认产品按设计同时保留最新不足估计和原合格估计：前者标为“探索结果，未列入对照表”，后者用于对照表。已修正测试断言，未把这一行为计为产品缺陷。

| 测试组 | 实际覆盖 | 结果 |
| --- | --- | --- |
| SYNC-03 | 三个真实标签交错保存，陈旧写入拒绝，依次恢复后再编辑；另外两轮 GET 返回期间输入的保护 | 通过，未发生静默覆盖；新输入需要再次明确载入才能被替换 |
| AUTH-01 | 在途写入未到 API 时教师重置密码；其他标签切换账号；旧请求后到；再回原账号恢复；另两轮本人改密及两轮真实时钟到期 | 通过，旧请求不能写入新账号；不同账号不显示旧草稿；原账号重新认证后可恢复。自然到期使用测试子进程的 10 秒 TTL，普通演示服务的 TTL 未改变 |
| REPORT-03 | 修改设定不运行；运行支持度不足的出口管制；保留关税合格估计；修改反思；重新生成已评分报告 | 两轮通过。原报告在重生成前不变，重生成后新反思进入报告、旧评分清空，对照表仍引用原合格结果并披露不足估计 |
| REL-01 | 两套数值不同、完整验证的 CI 合成发布，停 API 后用实际发布函数 A→B→A，含会话、报告、评分、账号及旧令牌 | 两轮通过。账号 ID 不变，两份会话/报告分 release 保存，评分分别为 41/42；回 A 后 API 数值及会话/报告恢复原快照 |
| REL-02/03 | 写出部分产物、写 manifest、fsync、提升目录、链接切换前/后、清理前终止进程；清理目录不可读、暂存目录只读、两个 compute 竞争 | 每种两轮，共 20 次。切换前旧版本有效，切换后新版本完整，上一版本仍有效，锁可重新取得；并发失败后重新 compute 成功 |
| REL-03 磁盘满 | 32 MiB 独立 tmpfs，compute 到达写产物屏障后填至 ENOSPC，再继续执行 | 两轮通过：非零退出、旧发布有效、锁释放；测试卷已卸载，没有填满宿主磁盘 |
| REL-03 预热缓存 | 同大小/mtime 原地修改、inode 替换、嵌套未注册文件/符号链接、metadata 非法编码 | 修复前问题有重复记录；修复后相应拒绝路径和恢复路径通过 |
| DATA-01 | 独立使用标准库 csv/float/fsum 读取五份真实原始表，对照 Z/Y/账户项、负存货变化、负 TLS、分页顺序与切片合计 | 五年共 55 项通过；数值容差事前设为相对 1e-12、绝对 1e-8 |
| DATA-01 界面与报告 | 将 2020 年 CHN_A01_02→USA_A03 的零值通过真实浏览器记录，再生成报告并检查数据库和报告读法 | 通过。API、点击记录、SQL 会话与报告均保持零值和供给方向；不是把零当缺失。合计 DATA-01 56 项检查 |

REL-01 的令牌语义另作明确记录：当前设计按 release_id 和账号认证版本绑定令牌，不包含发布次数。A 令牌在 B 被拒绝；回到 A 时，尚未过期且账号认证版本未变的 A 令牌可再次有效。这一行为被实际测到，没有把它误报为永久吊销；密码版本变化仍会撤销旧令牌。

发布故障使用真实 compute 流水线和实际 SIGKILL、权限、ENOSPC；为了能重复覆盖多个阶段，使用已标明 CI-only 的小型合成原始表，并未用它替代真实数据的数值验收。进程在检查点停止后再注入故障，不依赖随机 sleep。进程终止测试不等同于机器断电测试。

新增完整性校验后的冲击面板性能验收通过：单次冷索引约 392.64 ms，预热顺序请求 p95 约 36.82 ms，预热 8 并发 p95 约 352.69 ms；仍采用原有 500/1500 ms 门槛。这不是 PERF-01 所计划的 20 次独立冷启动分布，后者仍待执行。

最终回归为后端 576 passed，覆盖率 89.78%；前端 364 pass，TypeScript/Vite 构建通过；Ruff、格式、mypy 通过。没有数据库 schema 或 artifact contract 升级，正常部署只需更新代码与前端构建，不需要重置教学库或重算数据。

证据根目录：`dogfood-output/batch2/`。主要文件包括：

- `publication/results.json`、`diskfull/results.json`、`roundtrip/results.json`：发布中断、磁盘满、往返结果。
- `cache-before.log`、`cache-fixed.log`、`api-tamper-before.log`、`api-tamper-fixed.log`、`nested-metadata-before.log`、`encoding-before.log`：产物问题的修复前后证据及对应回归。
- `reload-edit-before.log`、`reload-edit-fixed.log`、`workspace/results.json`：恢复时序和多标签/身份交错。
- `snapshots-final/results.json`、`self-password-before/results.json`、`self-password-fixed/results.json`、`expiry/results.json`：报告、本人改密和到期恢复。
- `raw-oracle/results.json`、`raw-oracle/zero-cell.png`：独立原始数据及界面证据。
- `guard-benchmark.json`、`pytest-complete.log`、`frontend-all.log`、`build-all.log`：性能和全量回归。

新增可复用入口在 scripts/：`dogfood_publication_faults.py`、`dogfood_release_roundtrip.py`、`dogfood_workspace_interleavings.py`、`dogfood_report_snapshots.py`、`dogfood_self_password_recovery.py`、`dogfood_token_expiry.py`、`dogfood_raw_oracle.py`。账号口令从环境变量传入，浏览器全部使用 agent-browser。发布脚本只操作指定的新测试输出目录；临时 API/前端进程由脚本创建并回收；故障数据库仍是隔离实例。

下一批重点为 DATA-02/03/04 独立指标与回归基准、输入组合生成、课堂混合容量、过载恢复及 2 小时/过夜持续运行。当前原始数据核验仅覆盖已列样本；没有宣称逐格检查全部矩阵、完成所有组合或已通过远程部署。
