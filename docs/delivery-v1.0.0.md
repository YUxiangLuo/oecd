# 交付说明 v1.0.0

| 项目 | 内容 |
| --- | --- |
| 交付版本 | Git 标签 `v1.0.0` |
| 交付日期 | 2026-10-06（评审周结束于交付日前） |
| 评审记录 | [docs/delivery-review-plan.md](delivery-review-plan.md)：七天计划、证据记录、问题清单 |
| 手册 | [技术手册 1.3](../技术手册.md)、[实验手册 2.3](../实验手册.pdf)、[DEPLOY.md](../DEPLOY.md)、[README.md](../README.md) |

本说明对应技术手册 16.2"建议交付材料"的六项，逐项说明交付包里有什么、怎样生成、以及明确不在本次验收范围内的事项。

## 1. 源代码与构建产物

- `gvcsim-v1.0.0-src.tar.gz`：`git archive v1.0.0`，含 `uv.lock`、`frontend/bun.lock`、`deploy/` 模板、全部测试与脚本。
- `gvcsim-v1.0.0-frontend-dist.tar.gz`：`bun run build` 的普通生产构建（不含演示构建的内置账号）。生产部署按 DEPLOY.md 在目标主机重新构建亦可，产物应一致。
- 校验：`SHA256SUMS` 覆盖包内全部文件。

## 2. 文档与配置项

- 技术手册 1.3（架构、算法、契约、接口、数据库、运行保护、测试、运维），实验手册 2.3（学生操作，28 页，19 张按交付界面重拍的截图），DEPLOY.md（主机命令，本周在干净 Ubuntu 24.04 上逐块演练并修正），README.md。
- 环境配置项以 `deploy/gvcsim.env.example` 为准；必须替换 `GVCSIM_PG_DSN`、`GVCSIM_AUTH_SECRET`、`GVCSIM_ALLOWED_ORIGINS`、数据目录。启动／停止：`systemctl start|stop gvcsim-api`，健康检查 `GET /health`。

## 3. 数据

- 正式指标基于 OECD ICIO 2023 版 2016–2020 五个 `ICIO2023_<year>.csv`；原始文件 SHA-256 见包内 `data/raw-sha256sums.txt`。
- `data/release-01b87b87/` 为开发机上由同一原始文件计算、并通过全部发布门禁的 release 的 `manifest.json`、`dataset.json` 与 QC 文件，作为来源说明和对照样本。**目标主机必须自行运行 `gvcsim compute` 生成自己的 release**（release id 含发布时间，与此不同是正常的），并按 DEPLOY.md 在该主机运行性能验收脚本。
- 关税冲击、HS→ICIO 示例、宏观控制与 CI 合成表均为教学 mock，不是官方统计。

## 4. 教师初始化与账号交接

- 首位教师由 `gvcsim classroom-init --teacher-username ... --teacher-name ...` 创建，初始口令只通过当前进程环境传入，不写入任何文件；首次登录后应立即改密。
- 学生账号由教师在工作台单个或按名单批量创建；批量创建会生成含初始密码的清单，仅供教师下载后逐人发放。
- 口令、数据库连接串、认证密钥均不在交付包中，通过受限渠道交接。

## 5. 测试与验收证据

全部证据目录位于仓库忽略目录 `dogfood-output/`，交付包 `evidence/` 复制了其中的日志、JSON 结果和截图（不含任何数据库转储）。

| 证据 | 内容 | 结果 |
| --- | --- | --- |
| `evidence/local-ci/` | `scripts/local_ci.sh` 最终一轮：Gephi 基准、静态检查、808 后端测试（覆盖率 ≥85%）、478 前端测试、学生 15 步 smoke（含 WCAG A/AA）、完整提交评阅流程（含 PDF 七列）、纯界面 15 步课程、教师 smoke | 全部通过 |
| `evidence/statistics-review/` | 四项 TWFE 与 linearmodels PanelOLS 对照、覆盖率实验 | 系数差 ≤1.8e-12；覆盖率 0.9395 |
| `evidence/day3-recovery/` | 令牌过期、本人改密、三标签页交错的真实浏览器恢复脚本 | 通过 |
| `evidence/day4-capacity/` | 冲击面板基准、HTTP 边界探测、50 学生并发、冷启动计时 | 全部在预算内 |
| `evidence/day6-*` | 数据换版往返、发布中断 11 阶段 | 通过 |
| `evidence/rehearsal/` | 干净主机部署演练记录：首次发布日志、备份校验、隔离恢复、重置 | 通过（见下方已知问题中修正的文档缺陷） |
| `docs/student-manual/screenshots.json` | 19 张截图的代码基线、数据 release、SHA-256 | 与 PDF 一致 |

手工验收：学生端 15 步、教师端学期／班级／学生／批量建号／评阅／冲突／评分清除均在本地课堂逐项走过，见评审记录第 3、4 天。

## 6. 备份、恢复与回滚

- 每日备份由 `gvcsim-backup.timer` 执行，产物为 `pg_dump` 自定义格式 + SHA-256；本周在干净主机上验证了备份、校验、目录读取和隔离库恢复（schema `gvcsim-teaching-db-v12`）。交付包 `evidence/rehearsal/` 含校验文件与演练日志，不含转储本身。
- release 回滚按 DEPLOY.md"数据 release 回滚"执行，本周已演练；上一兼容版本即 `v1.0.0` 之前的最近提交，回滚代码时须同时使用兼容该 artifact contract（v15）的 release。

## 7. 已知问题（随包交付，不阻断验收）

| 编号 | 级别 | 说明 | 处理 |
| --- | --- | --- | --- |
| D-002 | P2 | 前端单测一条 React `act()` 警告，不影响通过 | 交付后处理 |
| D-011 | P3 | 三处代码整洁问题（共享文案常量用字符串替换改写、登录提示按文案判断样式、同一表达式重复计算） | 交付后处理 |
| D-013 | P2 | API 只信任 `127.0.0.1` 的转发头；Nginx 与 API 分机部署时全班被当作一个登录来源，默认每分钟 120 次 | 同机部署无影响；分机部署按 DEPLOY.md 调高 `GVCSIM_LOGIN_SOURCE_ATTEMPTS_PER_MINUTE` |
| D-014 | P2 | 文件身份 `hash` 模式下原始切片每次 420 ms；`notify` 模式 13 ms，但只在本地 ext4／XFS／Btrfs 生效 | 交付主机核对数据目录在本地文件系统并保留 `GVCSIM_FILE_CACHE_MODE=notify` |
| D-018 | P3 | 服务启动时 matplotlib 缓存目录告警；运维命令块保留 root 的 HOME 时 libpq 证书路径告警 | 交付后处理，不影响功能 |
| — | 观察 | 单元在首个 release 之前随主机启动会连续 5 次 preflight 失败并进入 start-limit，首次发布后如 `systemctl start` 被拒需先 `systemctl reset-failed gvcsim-api` | 已写入评审记录 |

## 8. 未验收项（需在交付环境完成）

- 目标主机上的 `gvcsim compute`、`scripts/benchmark_shock_panel_v9.py` 性能验收与 50 人并发（本周数据来自 12 核开发机与 WSL）。
- 真实域名、ACME/TLS 证书、异机备份目的地与备份保留策略。
- 浏览器矩阵：Chrome 之外的 Edge、Firefox 登录、步骤 2–5 指标说明 PDF 内嵌显示、步骤 15 导出 PDF 的目视分页、90%/110% 缩放。本周自动化验收与手工走查均基于 Chromium 内核。
- 一位真实学生从零走完 15 步的课堂时长。
- 移动端、多实例、灾备 SLA、真实政策因果结论，按技术手册 16.3 不在范围内。
