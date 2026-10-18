# 部署

部署只支持当前代码、当前数据契约和全新教学库，不提供历史迁移、备份恢复或版本回滚。每次部署都在停止 API 后重建数据 release 和数据库；全部账号、题库修改、会话、报告及评分会清空，随后重新创建首位教师和学生账号。数据发布保留完整的暂存、校验和原子切换，成功后仅保留当前 release。

示例代码目录为 `/opt/gvcsim/current`，共享数据根目录为 `/opt/gvcsim/shared`，环境配置为 `/etc/gvcsim.env`。正式账号通过 HTTPS 登录。域名、证书、数据库地址和口令按实际环境填写，不提交仓库。

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
install -d -o gvcsim -g gvcsim -m 0750 /opt/gvcsim/shared
install -d -o gvcsim -g gvcsim -m 0750 /opt/gvcsim/shared/data
install -d -o gvcsim -g gvcsim -m 0750 /opt/gvcsim/shared/OECD_ICIO
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

安装 systemd 服务：

```bash
install -m 0644 deploy/gvcsim-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable gvcsim-api
```

## 首次及后续部署

先在开发环境运行 `bash scripts/local_ci.sh`。它使用独立数据库与合成数据验证，不操作课堂数据库。正式部署按以下顺序执行：

1. 停止 API，更新 `/opt/gvcsim/current` 中的代码及依赖。
2. 每次部署重新生成 `/etc/gvcsim.env` 的 `GVCSIM_AUTH_SECRET`（`openssl rand -hex 32`），使上一部署的令牌失效。其余配置保持实际环境值。
3. 重新构建前端和数据，运行发布验证。新的 release ID 同时隔离浏览器中上一部署的暂存内容。
4. 显式重建教学库，创建首位教师，预检通过后启动。

```bash
set -euo pipefail
systemctl stop gvcsim-api
cd /opt/gvcsim/current
uv sync --locked
cd frontend && bun install --frozen-lockfile && bun run build && cd ..
# 用新生成的随机值替换 GVCSIM_AUTH_SECRET，文件保持 root:gvcsim 0640。
editor /etc/gvcsim.env
read -rsp '首位教师初始口令（至少 12 位）: ' GVCSIM_INITIAL_TEACHER_PASSWORD
echo
export GVCSIM_INITIAL_TEACHER_PASSWORD
trap 'unset GVCSIM_INITIAL_TEACHER_PASSWORD' EXIT
runuser -u gvcsim --preserve-environment -- /bin/sh -c '
  set -eu
  set -a; . /etc/gvcsim.env; set +a
  cd /opt/gvcsim/current
  .venv/bin/gvcsim compute
  .venv/bin/gvcsim verify-release --out /opt/gvcsim/shared/release-verification.json
  .venv/bin/gvcsim verify-release --check /opt/gvcsim/shared/release-verification.json
  .venv/bin/gvcsim classroom-init --reset --teacher-username teacher --teacher-name 老师
  .venv/bin/gvcsim preflight
'
unset GVCSIM_INITIAL_TEACHER_PASSWORD
trap - EXIT
systemctl start gvcsim-api
GVCSIM_BASE_URL='https://<课程域名>'
curl -fsS "$GVCSIM_BASE_URL/health/live"
curl -fsS "$GVCSIM_BASE_URL/health"
```

`classroom-init --reset` 删除指定数据库的整个 `public` schema 后按当前版本创建。仅停止后的部署流程执行它；`serve`、`preflight` 和普通重启不会自动清库或迁移。首次使用空库也可以省略 `--reset`。教师首次登录后修改初始密码，再创建学生账号与班级。

`compute` 不连接数据库。在暂存目录中完成计算、QC、manifest 和来源绑定，通过后才原子切换入口；构建失败时入口仍指向原产物，服务保持停止，修复问题后重新部署。成功后清理旧 release，不提供恢复旧版本的流程。清理失败会打印警告，应检查目录权限和空间。

`verify-release` 将实际 release ID、dataset/panel 文件 SHA-256、运行时代码、构建入口与配置、锁文件、随站发布的静态资源及实验手册 PDF 指纹，以及安装的数值依赖版本写入验证记录，并复算各年份输出 QC、回归输入 QC 和 17 个 Y ×（默认模型 + 7 个预设）共 136 次标准库对照。`--check` 拒绝与上述输入不匹配的记录。它不代表完整模型网格、200 种子覆盖率、原始 IO 全量重算或生产容量验收；历史 benchmark 不能替代当次证据。

部署模板发生变化时，保留实际域名、证书、upstream 和服务用户配置重新安装，再执行 `nginx -t` 与 `systemctl daemon-reload`。`shared` 根目录必须允许服务账号写入验证记录，可执行 `install -d -o gvcsim -g gvcsim -m 0750 /opt/gvcsim/shared`。

服务模板采用单 API worker、16 个普通线程、4 个计算名额、512 个连接；容量边界见[技术手册](技术手册.md#112-运行容量)。`notify` 文件缓存要求 API 运行期间不改写数据，并使用支持 inotify 的本地文件系统；不满足时用 `hash`，延迟须重新实测。Nginx 与 API 分机时须同时调整受信代理和来源登录限流，避免全班被计为单个来源。

## 验收与故障处理

每次部署记录前端构建模式、验证 JSON、健康检查及实际浏览器验收。使用独立验收账号检查登录、保存、刷新恢复、报告生成/提交和教师评分；报告列表需验证分页及按需读取详情。

容量要求由目标机器单独验收。可先在相同配置的隔离环境设置 `GVCSIM_BENCHMARK_USERNAME`、`GVCSIM_BENCHMARK_PASSWORD`，运行 `uv run python scripts/benchmark_shock_panel_v9.py`；其 TestClient 结果仅表示进程内预算，不代表端到端网络时延。

任一门禁失败均保持 API 停止，查看日志、修复代码/数据/配置后重做部署。不将旧代码、旧数据库或旧数据作为回退目标。普通运行故障先检查 `journalctl -u gvcsim-api -n 100 --no-pager` 和 `/health`；普通重启不需要重建数据库。

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
