# 远程部署

示例代码目录为 `/opt/gvcsim/current`，共享状态根目录为 `/opt/gvcsim/shared`，环境配置为 `/etc/gvcsim.env`。正式账号只能通过 HTTPS 登录。`<课程域名>`、`<数据库主机>` 等占位符按实际环境替换，实际值只写入 `/etc/gvcsim.env` 或当次环境变量；健康检查统一用 `GVCSIM_BASE_URL` 指定站点地址。

部署分为三个互不绑定的生命周期：

1. **代码部署**：更新 Python/前端代码，不计算数据、不清空教学库。
2. **数据发布**：执行 `compute` 并原子切换 release，不清空教学库；会话和报告按 `release_id` 自动隔离。
3. **新学期重置**：仅在明确清场时执行 `classroom-init --reset`，会删除全部账号、会话、报告和评分。

## 一次性主机 bootstrap

先由系统管理员安装 Python 3.13、uv、Bun、PostgreSQL、Nginx、OpenSSL 和所用 ACME/TLS 客户端。Ubuntu 24.04 的 apt 仓库只有 Python 3.12，可用 uv 安装受管解释器并放在代码目录之外，例如 `UV_PYTHON_INSTALL_DIR=/opt/uv-python uv python install 3.13`，再把 `uv python find 3.13` 给出的路径链接为 `/usr/local/bin/python3.13`；后文所有 `uv sync` 命令沿用同一个 `UV_PYTHON_INSTALL_DIR`。确认以下命令都可用：

```bash
python3.13 --version
uv --version
bun --version
psql --version
nginx -v
openssl version
```

创建不可登录的服务账号和持久目录：

```bash
useradd --system --home-dir /opt/gvcsim --create-home --shell /usr/sbin/nologin gvcsim
# Ubuntu 21.04+ 的 useradd 把家目录建成 0750；Nginx 的 www-data 必须能穿过它读取
# /opt/gvcsim/current/frontend/dist，否则首页返回 500（stat() Permission denied）。
chmod 0751 /opt/gvcsim
install -d -o gvcsim -g gvcsim -m 0750 /opt/gvcsim/shared/data
install -d -o gvcsim -g gvcsim -m 0750 /opt/gvcsim/shared/OECD_ICIO
install -d -o gvcsim -g gvcsim -m 0700 /opt/gvcsim/shared/backups
```

创建独立 PostgreSQL 角色与数据库；按提示生成并妥善保存数据库口令。PostgreSQL 与 API 可以不同机，但以下本地 socket 命令必须登录到**实际数据库主机**执行，不能在另一台 API 主机上照抄；若由远程管理终端建库，应显式指定数据库主机并使用对应的管理员认证。应用最终只通过环境文件中的连接串定位数据库：

```bash
sudo -u postgres createuser --pwprompt gvcsim
sudo -u postgres createdb --owner=gvcsim gvclab
```

将代码检出到 `/opt/gvcsim/current`，然后安装锁定依赖并构建前端：

```bash
cd /opt/gvcsim/current
uv sync --frozen
cd frontend && bun install --frozen-lockfile && bun run build && cd ..
```

准备生产环境文件：

```bash
install -o root -g gvcsim -m 0640 deploy/gvcsim.env.example /etc/gvcsim.env
openssl rand -hex 32   # 把输出写入 GVCSIM_AUTH_SECRET，不要提交到仓库
editor /etc/gvcsim.env
```

必须替换 `GVCSIM_PG_DSN`、`GVCSIM_AUTH_SECRET`、域名和允许来源；`GVCSIM_DATA_DIR` 与 `GVCSIM_RAW_DATA_DIR` 必须指向上述代码目录外的持久位置。`GVCSIM_PG_DSN` 中的数据库主机按实际位置填写，不默认任何固定地址。把课程使用的唯一一份 `ICIO2023_<year>.csv` 放入 `/opt/gvcsim/shared/OECD_ICIO/`，并执行：

```bash
chown -R gvcsim:gvcsim /opt/gvcsim/shared/data /opt/gvcsim/shared/OECD_ICIO
chmod 0640 /opt/gvcsim/shared/OECD_ICIO/ICIO*.csv
```

先完成域名 DNS 与 TLS 证书签发，再替换 `deploy/nginx-gvcsim.conf` 中的域名和证书路径。Nginx 与 API 不在同机、或 API 使用非默认端口时，同时把配置中的 upstream 地址改为 API 进程的实际位置。安装并检查 Nginx 配置：

```bash
install -m 0644 deploy/nginx-gvcsim.conf /etc/nginx/conf.d/gvcsim.conf
nginx -t
systemctl enable --now nginx
```

安装 systemd 服务与每日备份定时器：

```bash
install -m 0644 deploy/gvcsim-api.service /etc/systemd/system/
install -m 0644 deploy/gvcsim-backup.service deploy/gvcsim-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable gvcsim-api
systemctl enable --now gvcsim-backup.timer
```

首次建库必须显式初始化教师。初始口令只通过当前进程传入，不写环境文件：

```bash
read -rsp '首位教师初始口令（至少 12 位）: ' GVCSIM_INITIAL_TEACHER_PASSWORD
echo
test "${#GVCSIM_INITIAL_TEACHER_PASSWORD}" -ge 12
export GVCSIM_INITIAL_TEACHER_PASSWORD
trap 'unset GVCSIM_INITIAL_TEACHER_PASSWORD' EXIT
runuser -u gvcsim --preserve-environment -- /bin/sh -c '
  set -eu
  set -a; . /etc/gvcsim.env; set +a
  cd /opt/gvcsim/current
  .venv/bin/gvcsim compute
  .venv/bin/gvcsim classroom-init --teacher-username teacher --teacher-name 老师
  .venv/bin/gvcsim preflight
'
unset GVCSIM_INITIAL_TEACHER_PASSWORD
trap - EXIT
systemctl start gvcsim-api
GVCSIM_BASE_URL='https://<课程域名>'   # 替换为站点实际对外地址
curl -fsS "$GVCSIM_BASE_URL/health"
```

空库初始化不需要 `--reset`。首次登录后立即轮换教师口令：教师端顶部会提示仍在使用初始口令，点提示里的“立即修改密码”即可，改完后提示消失。

## 普通代码部署

普通代码部署不运行 `compute`，更不能运行 `classroom-init --reset`。新代码若要求更高的 artifact contract，应改走下一节的数据发布流程。

`deploy/` 下的 systemd 或 Nginx 模板有变化时，只更新代码不会改变已安装的旧模板：保留实际域名、证书和 upstream 地址重新安装，执行 `nginx -t`、`systemctl daemon-reload` 并重载 Nginx。容量参数（单 API worker、16 个普通线程、4 个计算名额、512 个连接）须配套使用，见[运行容量](技术手册.md#112-运行容量)。

服务模板设置 `GVCSIM_FILE_CACHE_MODE=notify`，前提是 API 运行期间 active release 和原始输入不被改写（inotify 不覆盖 mmap／原始块设备写入；不支持的文件系统自动回退哈希）。不满足该前提时在 `/etc/gvcsim.env` 设为 `hash` 并重启。注意性能差异：`hash` 模式每次原始切片请求都重算原始 CSV 的 SHA-256，实测单次约 420 ms，50 名学生同时打开步骤 1 时排队超过 10 s；`notify` 模式单次约 13 ms。因此 `GVCSIM_DATA_DIR` 与 `GVCSIM_RAW_DATA_DIR` 必须放在本地 ext4／XFS／Btrfs 文件系统上，NFS、SMB、9p 等网络或虚拟文件系统会静默回退到 `hash`。部署后可用 `journalctl -u gvcsim-api` 与一次切片请求的耗时确认。

Nginx 与 API 分机部署时还要注意：API 只信任来自 `127.0.0.1` 的 `X-Forwarded-For`（uvicorn `forwarded_allow_ips`），分机时所有学生的来源 IP 都会被记成 Nginx 的地址，登录来源限流（默认每分钟 120 次）会把全班当作一个来源。同机部署无此问题；分机部署需相应调高 `GVCSIM_LOGIN_SOURCE_ATTEMPTS_PER_MINUTE`，或在 API 侧另行信任该代理地址。

```bash
set -euo pipefail
GVCSIM_BASE_URL='https://<课程域名>'   # 替换为站点实际对外地址
systemctl stop gvcsim-api
systemctl start gvcsim-backup.service
cd /opt/gvcsim/current
uv sync --frozen
cd frontend && bun install --frozen-lockfile && bun run build && cd ..
runuser -u gvcsim -- /bin/sh -c '
  set -eu; set -a; . /etc/gvcsim.env; set +a
  cd /opt/gvcsim/current
  .venv/bin/gvcsim preflight
'
systemctl start gvcsim-api
curl -fsS "$GVCSIM_BASE_URL/health"
```

## 数据发布或 artifact contract 升级

当前教学生成契约是 `step10-tariff-teaching-v13`。从 v12 或更早升级需要按本节重建完整 release，并重新构建前端；只更新代码、单个 CSV 或版本标签均不够。v13 改了课程生成变量的混杂强度与方向（GDP、开放度）、共同年份变化和七个 Y 的校准下限（见 `docs/regression-steps-11-14-optimization-final-2026-10-14.md`），发布质检仍逐行检查定义域与恒等式。API 启动拒绝旧教学契约，故应在维护窗口内协调代码与数据切换，不要将版本不匹配误诊为数据库故障。

切换使旧令牌失效，学生需要重新登录。会话、报告和评分按账号＋release 隔离：新 release 无历史记录时显示空记录，旧记录未删除；本标签页的旧 release 草稿不会套用到新 release。无需 `classroom-init --reset`，回滚需同时选择兼容的代码和数据。新手册 PDF 已更新，前端重建后才会包含新的带指纹资源。

进入停机维护窗口并先备份数据库。`compute` 以 `gvcsim` 账号在暂存 release 中完成计算、诊断、manifest 和原始输入内容绑定，通过后才原子切换。完整性、来源绑定与数学有效性检查失败均阻断发布，包括源账户误差超出容差、逆矩阵稳定性、计算恒等式或聚合一致性失败；容差内舍入、经济范围与研究设计诊断持续披露。数据库不会被重置。

准备一个可登录的普通学生账号供性能验收，并通过安全交互方式设置 benchmark 口令：

```bash
set -euo pipefail
GVCSIM_BASE_URL='https://<课程域名>'   # 替换为站点实际对外地址
systemctl stop gvcsim-api
systemctl start gvcsim-backup.service
cd /opt/gvcsim/current
uv sync --frozen
cd frontend && bun install --frozen-lockfile && bun run build && cd ..

read -rp '性能验收学生用户名: ' GVCSIM_BENCHMARK_USERNAME
read -rsp '性能验收学生口令: ' GVCSIM_BENCHMARK_PASSWORD
echo
export GVCSIM_BENCHMARK_USERNAME GVCSIM_BENCHMARK_PASSWORD
trap 'unset GVCSIM_BENCHMARK_USERNAME GVCSIM_BENCHMARK_PASSWORD' EXIT
runuser -u gvcsim --preserve-environment -- /bin/sh -c '
  set -eu; set -a; . /etc/gvcsim.env; set +a
  cd /opt/gvcsim/current
  .venv/bin/gvcsim compute
  .venv/bin/gvcsim preflight
  .venv/bin/python scripts/benchmark_shock_panel_v9.py
'
unset GVCSIM_BENCHMARK_USERNAME GVCSIM_BENCHMARK_PASSWORD
trap - EXIT
systemctl start gvcsim-api
curl -fsS "$GVCSIM_BASE_URL/health"
```

性能验收在进程内经正常登录中间件完成，包含单请求冷启动、8 请求并发冷启动、warm sequential 和 8-concurrent；任一预算失败都会非零退出并阻止放行，此时 API 保持停止并按下文回滚到上一 release。

### 工作台与报告 HTTP 验收（P3-19）

上述冲击面板基准不能代替工作台和报告验收。另在**隔离 staging/test** 上运行
`scripts/accept_workbench_reports.py`：使用独立数据库、独立 API 及测试账号，经真实 HTTP
（建议经过与生产相同的 Nginx）计算并保存完整步骤证据及每人 12 个真实附录模型快照。
它复用 `seed_full_journey.py`，不使用旧 R5 的占位快照，不建库、不 reset、不发布数据。
seed 通过学生 workspace 的公开 `quizzes` 核对步骤 1–14 的当前版本和题目均为内置默认，才使用默认答案；自定义、缺题或恢复默认后的新版本均明确拒绝。不需要教师口令，也不读取私有答案。请使用新建隔离库的默认题库，不为验收重置既有库。
必须由操作者显式指定 disposable/demo URL 和 2–20 个空白学生账号；绝不能指向生产或现有学生账号。
准备阶段发现任何账号已有步骤或报告会拒绝运行。失败后可能留下部分测试记录，重新测量应新建隔离库/账号，
不要为了重跑清空既有库。脚本不会替操作者证明目标是隔离环境。

先由管理员在新建的空测试库初始化 schema、用教师端创建 20 个测试学生，配置 API 使用该库和
只读的数据 release 副本。将凭据放在仓库外权限 0600 的 JSON 文件，形如
`[{"username":"<测试学生账号>","password":"<测试口令>"}, ...]`，不提交、不放入日志。

```bash
export GVCSIM_ACCEPT_ACCOUNTS="$(cat /secure/path/accept-accounts.json)"
TEST_URL='https://<隔离测试域名>'
PYTHONPATH=. .venv/bin/python scripts/accept_workbench_reports.py prepare \
  --disposable-demo-target "$TEST_URL" --max-seconds 120
# 仅重启上述隔离 API 的全部 worker，清空进程缓存；不重置数据库。
# 确认 release 未变、测试账号限流窗口已结束，且没有其他客户端提前暖缓存。
PYTHONPATH=. .venv/bin/python scripts/accept_workbench_reports.py run \
  --disposable-demo-target "$TEST_URL" --max-seconds 120
unset GVCSIM_ACCEPT_ACCOUNTS
```

`run` 首先并发生成冷报告，再并发生成暖报告，然后请求四步默认模型及自定义模型重复计算，
验证重复响应一致；非法模型要求 400，过期报告版本要求 409，并读回确认失败没有替换已保存报告。
输出仅含阶段、状态码和 p50/p95/max 秒数（不含凭据、姓名、会话或报告）。任一意外状态、
客户端错误、超出 `--max-seconds` 或数据校验失败均非零退出。120 秒只是可调整的验收预算，
不是生产 SLO；放行应保存机器规格、部署配置、并发人数、重启证据和本次输出，按课程需求收紧预算。
准备阶段的完整证据采集不是吞吐测量；报告冷启动必须由操作者重启保证，脚本不会远程重启服务。

当前默认模型独立常驻缓存（保留两个 release 身份），自定义模型为每进程 4096 条 LRU；
重启、release 更换及 LRU 淘汰后仍可能重算，不能承诺任意历史设定永久不计次。
页面、报告正文、总览与附录共享模型缓存、单飞及 CPU 名额；报告渲染另有有界准入，不再整份占用模型名额。
计算先保留限流名额、成功才提交；失败释放保留名额。报告仅对实际拥有的新计算计次，
成功保存并完成应答 bookkeeping 后提交，每份最多 20 次，暖命中不重复计次。

**计次可观测性限制**：公开 HTTP 不暴露限流事件/保留计数，因此本脚本不能把 400/409 后仍能请求
或数据库未改写当作“未扣次”的证明。隔离服务有计数探针时，应在失败前后核对已提交事件不变、
pending 回到零；503/排队、渲染、数据库失败及退款由聚焦自动测试另行覆盖，不在该脚本中破坏服务来制造。
已有 ASGI 20 人 × 12 合法附录模型冷/暖验证不等于真实 DB、代理与小主机容量验收。
生产课堂人数、混合工作台/自动保存/登录高峰、长期 RSS、多 worker、hash 模式与切换 release 的负载
仍需在对应部署上实测，不能沿用旧 R5 的每秒 5 次或约 40 人作为修复后的生产上限。

## 明确的新学期重置

这是独立且破坏性的操作，不得放入普通部署脚本：

```bash
set -euo pipefail
systemctl stop gvcsim-api
systemctl start gvcsim-backup.service
read -rsp '新学期首位教师口令（至少 12 位）: ' GVCSIM_INITIAL_TEACHER_PASSWORD
echo
test "${#GVCSIM_INITIAL_TEACHER_PASSWORD}" -ge 12
export GVCSIM_INITIAL_TEACHER_PASSWORD
trap 'unset GVCSIM_INITIAL_TEACHER_PASSWORD' EXIT
runuser -u gvcsim --preserve-environment -- /bin/sh -c '
  set -eu; set -a; . /etc/gvcsim.env; set +a
  cd /opt/gvcsim/current
  .venv/bin/gvcsim classroom-init --reset --teacher-username teacher --teacher-name 老师
  .venv/bin/gvcsim preflight
'
unset GVCSIM_INITIAL_TEACHER_PASSWORD
trap - EXIT
systemctl start gvcsim-api
```

## 教学数据库 schema 演进门槛

当前初始化版本为 `gvcsim-teaching-db-v15`（表结构同 v14；会话契约升为 `experiment-session-simple-v4`，步骤 11–14 只保存 `run` 和一个 `experiment`，旧记录在保存时被拒绝，因此要新建空库），保留学期/班级名称比较键及账号大小写一致的唯一约束，新增独立于 release 的系统统一 `quiz_config` 默认题库快照。
本轮按要求仅提供新库初始化，没有要求或实现历史兼容迁移；不要把不带 `--reset` 的
`classroom-init` 当作旧库升级器。既有数据库必须保留，schema 不匹配应预检失败，停止放行；
若要部署到旧库，需另行批准保留记录的迁移方案，不能用重置代替。隔离验收使用新建空库初始化 v15。教师改题无需重新发布数据；仅变更本步答案版本，不删除材料或已提交报告，未提交草稿需重新生成。

## 数据 release 回滚

发布前记录 `readlink /opt/gvcsim/shared/data/processed`。回滚时必须同时使用兼容该 artifact contract 的代码版本，并先验证目标 release；不要删除故障 release：

```bash
set -euo pipefail
GVCSIM_BASE_URL='https://<课程域名>'   # 替换为站点实际对外地址
systemctl stop gvcsim-api
set -a; . /etc/gvcsim.env; set +a
OLD_RELEASE_ID='<32位 release id>'
runuser -u gvcsim -- /opt/gvcsim/current/.venv/bin/python -c \
  "from pathlib import Path; from gvcsim.artifacts import validate_release; print(validate_release(Path('$GVCSIM_DATA_DIR/.processed-releases/$OLD_RELEASE_ID')))"
runuser -u gvcsim -- rm -f "$GVCSIM_DATA_DIR/processed.rollback"
runuser -u gvcsim -- ln -s ".processed-releases/$OLD_RELEASE_ID" "$GVCSIM_DATA_DIR/processed.rollback"
runuser -u gvcsim -- mv -Tf "$GVCSIM_DATA_DIR/processed.rollback" "$GVCSIM_DATA_DIR/processed"
runuser -u gvcsim -- /bin/sh -c '
  set -eu; set -a; . /etc/gvcsim.env; set +a
  cd /opt/gvcsim/current
  .venv/bin/gvcsim preflight
'
systemctl start gvcsim-api
curl -fsS "$GVCSIM_BASE_URL/health"
```

## 备份与恢复演练

备份脚本使用 `pg_dump --format=custom`，每日服务默认保留最新 90 组已完成的 dump + SHA-256 文件（可用 `GVCSIM_BACKUP_KEEP` 在 `1..10000` 内调整）。轮换先排除缺少 dump 或 checksum 的不完整归档，它们不占用保留名额；恢复演练不会覆盖已有归档。备份脚本从 `GVCSIM_PG_DSN` 读取数据库位置，文档与脚本均不预设数据库主机：

```bash
set -a; . /etc/gvcsim.env; set +a
GVCSIM_BACKUP_DIR=/opt/gvcsim/shared/backups scripts/backup_classroom.sh
cd /opt/gvcsim/shared/backups
sha256sum -c classroom-YYYYmmddTHHMMSSZ.dump.sha256
pg_restore --list classroom-YYYYmmddTHHMMSSZ.dump >/dev/null
# 演练库所在主机按实际环境填写（可与生产库同机，也可以是隔离主机）。
# 应用角色 gvcsim 没有 CREATEDB 权限，演练库须由数据库管理员在数据库主机上创建并指定属主：
sudo -u postgres createdb --owner=gvcsim gvcsim_restore_drill
export PGHOST=<数据库主机> PGPORT=5432 PGUSER=gvcsim
read -rsp 'PostgreSQL 口令: ' PGPASSWORD
echo
export PGPASSWORD
pg_restore --single-transaction --no-owner --no-acl --dbname=gvcsim_restore_drill classroom-YYYYmmddTHHMMSSZ.dump
psql --dbname=gvcsim_restore_drill -Atc "select version from schema_meta where singleton"
unset PGPASSWORD
```

当前版本的恢复结果必须为 `gvcsim-teaching-db-v15`（历史备份须配套历史代码验证，不会自动迁移）。恢复生产库前应停止 API、保留故障库，并先在隔离空库完成摘要、目录和 schema 验证。

本机保留不等于灾难备份。应只同步已同时存在 `.dump` 与 `.dump.sha256` 的完成文件对到异机或对象存储，并对异机副本定期执行同样的摘要与隔离恢复演练。
