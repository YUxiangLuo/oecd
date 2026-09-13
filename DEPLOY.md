# 远程部署

示例代码目录为 `/opt/gvcsim/current`，共享状态根目录为 `/opt/gvcsim/shared`，环境配置为 `/etc/gvcsim.env`。正式账号只能通过 HTTPS 登录。

**地址约定**：本文档不绑定任何固定 IP 或主机名。凡涉及主机位置一律使用占位符——`<课程域名>` 表示站点对外域名，`<数据库主机>` 表示 PostgreSQL 地址，`<api主机>` 表示 API 进程地址；实际值只写入 `/etc/gvcsim.env` 或部署当次的环境变量。各节健康检查统一用 `GVCSIM_BASE_URL` 指定站点地址，脚本与文档任何位置都不写死 IP。

部署分为三个互不绑定的生命周期：

1. **代码部署**：更新 Python/前端代码，不计算数据、不清空教学库。
2. **数据发布**：执行 `compute` 并原子切换 release，不清空教学库；会话和报告按 `release_id` 自动隔离。
3. **新学期重置**：仅在明确清场时执行 `classroom-init --reset`，会删除全部账号、会话、报告和评分。

**v15 不是普通代码更新：** 新契约要求来源绑定的 `panel_teaching.csv`，并校验 `step10-tariff-teaching-v1`、seed `20260913`、生成参数和源文件哈希；seed 不能替代 release 来源绑定。v14 产物不满足该契约。先在独立 `GVCSIM_DATA_DIR` 用新代码完整重算并验收新的 release，再安排代码与数据协调切换；不得向旧 release 补文件或改版本号，也不得执行教学库重置。当前部署在新 release 验收前保持原样；本文不表示部署已经完成。旧代码与旧 release 成对保留供回滚，原会话／报告继续绑定原 release。参见 [README 的 v15 升级要求](README.md#数据发布)。

## 一次性主机 bootstrap

先由系统管理员安装 Python 3.13、uv、Bun、PostgreSQL、Nginx、OpenSSL 和所用 ACME/TLS 客户端。确认以下命令都可用：

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
useradd --system --home-dir /opt/gvcsim --create-home --shell /usr/bin/nologin gvcsim
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
  .venv/bin/gvcsim classroom-init --reset --teacher-username teacher --teacher-name 老师
  .venv/bin/gvcsim preflight
'
unset GVCSIM_INITIAL_TEACHER_PASSWORD
trap - EXIT
systemctl start gvcsim-api
GVCSIM_BASE_URL='https://<课程域名>'   # 替换为站点实际对外地址
curl -fsS "$GVCSIM_BASE_URL/health"
```

首次登录后立即轮换教师口令。

## 普通代码部署

普通代码部署不运行 `compute`，更不能运行 `classroom-init --reset`。新代码若要求更高的 artifact contract，应改走下一节的数据发布流程。

文件缓存修复不改变 artifact contract 或数据库 schema，无需重算数据或重建教学库。更新 API 代码并重启即可使用默认的 `GVCSIM_FILE_CACHE_MODE=hash`。只读本地课堂部署还应安装新版 `deploy/gvcsim-api.service` 并执行 `systemctl daemon-reload`：模板显式设置 `notify`，避免热请求反复扫描全部大表；仅支持 ext 系列、tmpfs、XFS、Btrfs 的普通文件写入／替换通知，其他文件系统及监听失败自动回退哈希。API 运行期间，外部维护程序也不得改写 active release 或原始输入；尤其不能依赖 inotify 发现 mmap／原始块设备写入。不满足不可变数据前提时，在 `/etc/gvcsim.env` 显式设置 `GVCSIM_FILE_CACHE_MODE=hash` 覆盖模板，接受额外的哈希 I/O 和解析快照内存开销。修改变量后需重启进程。完整边界与验证见[文件缓存修复](docs/file-cache-identity-fixes-20260908.md)。

更新课堂并发修复时，还需安装本仓库的新 systemd 与 Nginx 模板：Uvicorn 连接限制为 512，upstream 每个 Nginx worker 保留 8 个空闲连接、2 秒回收。保留实际域名、证书和 upstream 地址，执行 `nginx -t`、`systemctl daemon-reload` 并重载 Nginx；只更新代码不会改变已经安装的旧模板。单 API worker、16 个普通线程和 4 个计算名额保持配套使用，详见[运行容量](技术手册.md#112-运行容量)。

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

进入停机维护窗口并先备份数据库。`compute` 以 `gvcsim` 账号在暂存 release 中完成计算、诊断、manifest 和原始输入内容绑定，通过后才原子切换。只有完整性检查阻断发布；数值、经济含义与研究设计诊断持续披露。数据库不会被重置。

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

当前 `gvcsim-teaching-db-v11` 是 15 步课程的全新基线，不兼容 v10 会话与报告；从 v10 部署本版本时必须先备份，再按已批准的新课程清场执行上一节的显式重置。后续普通升级仍不得用重置代替迁移；版本不匹配必须让预检失败。

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
# 演练库所在主机按实际环境填写（可与生产库同机，也可以是隔离主机）
export PGHOST=<数据库主机> PGPORT=5432 PGUSER=gvcsim
read -rsp 'PostgreSQL 口令: ' PGPASSWORD
echo
export PGPASSWORD
createdb --maintenance-db=postgres gvcsim_restore_drill
pg_restore --single-transaction --no-owner --no-acl --dbname=gvcsim_restore_drill classroom-YYYYmmddTHHMMSSZ.dump
psql --dbname=gvcsim_restore_drill -Atc "select version from schema_meta where singleton"
unset PGPASSWORD
```

结果必须为 `gvcsim-teaching-db-v11`。恢复生产库前应停止 API、保留故障库，并先在隔离空库完成摘要、目录和 schema 验证。

本机保留不等于灾难备份。应只同步已同时存在 `.dump` 与 `.dump.sha256` 的完成文件对到异机或对象存储，并对异机副本定期执行同样的摘要与隔离恢复演练。
