# 远程部署

示例代码目录为 `/opt/gvcsim/current`，共享状态根目录为 `/opt/gvcsim/shared`，环境配置为 `/etc/gvcsim.env`。正式账号只能通过 HTTPS 登录。

部署分为三个互不绑定的生命周期：

1. **代码部署**：更新 Python/前端代码，不计算数据、不清空教学库。
2. **数据发布**：执行 `compute` 并原子切换 release，不清空教学库；会话和报告按 `release_id` 自动隔离。
3. **新学期重置**：仅在明确清场时执行 `classroom-init --reset`，会删除全部账号、会话、报告和评分。

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

创建独立 PostgreSQL 角色与数据库；按提示生成并妥善保存数据库口令：

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

必须替换 `GVCSIM_PG_DSN`、`GVCSIM_AUTH_SECRET`、域名和允许来源；`GVCSIM_DATA_DIR` 与 `GVCSIM_RAW_DATA_DIR` 必须指向上述代码目录外的持久位置。把课程使用的唯一一份 `ICIO2023_<year>.csv` 放入 `/opt/gvcsim/shared/OECD_ICIO/`，并执行：

```bash
chown -R gvcsim:gvcsim /opt/gvcsim/shared/data /opt/gvcsim/shared/OECD_ICIO
chmod 0640 /opt/gvcsim/shared/OECD_ICIO/ICIO*.csv
```

先完成域名 DNS 与 TLS 证书签发，再替换 `deploy/nginx-gvcsim.conf` 中的域名和证书路径。安装并检查 Nginx 配置：

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
curl -fsS https://gvcsim.example.edu/health
```

首次登录后立即轮换教师口令。

## 普通代码部署

普通代码部署不运行 `compute`，更不能运行 `classroom-init --reset`。新代码若要求更高的 artifact contract，应改走下一节的数据发布流程。

```bash
set -euo pipefail
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
curl -fsS https://gvcsim.example.edu/health
```

## 数据发布或 artifact contract 升级

进入停机维护窗口并先备份数据库。`compute` 以 `gvcsim` 账号在暂存 release 中完成计算、QC、manifest 和原始输入内容绑定，通过后才原子切换。数据库不会被重置。

准备一个可登录的普通学生账号供性能验收，并通过安全交互方式设置 benchmark 口令：

```bash
set -euo pipefail
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
curl -fsS https://gvcsim.example.edu/health
```

性能验收包含单请求冷启动、8 请求并发冷启动、warm sequential 和 8-concurrent；任一预算失败都会非零退出并阻止放行，此时 API 保持停止并按下文回滚到上一 release。

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

## 数据 release 回滚

发布前记录 `readlink /opt/gvcsim/shared/data/processed`。回滚时必须同时使用兼容该 artifact contract 的代码版本，并先验证目标 release；不要删除故障 release：

```bash
set -euo pipefail
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
curl -fsS https://gvcsim.example.edu/health
```

## 备份与恢复演练

备份脚本使用 `pg_dump --format=custom`，恢复演练不会覆盖已有归档：

```bash
set -a; . /etc/gvcsim.env; set +a
GVCSIM_BACKUP_DIR=/opt/gvcsim/shared/backups scripts/backup_classroom.sh
cd /opt/gvcsim/shared/backups
sha256sum -c classroom-YYYYmmddTHHMMSSZ.dump.sha256
pg_restore --list classroom-YYYYmmddTHHMMSSZ.dump >/dev/null
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gvcsim
read -rsp 'PostgreSQL 口令: ' PGPASSWORD
echo
export PGPASSWORD
createdb --maintenance-db=postgres gvcsim_restore_drill
pg_restore --single-transaction --no-owner --no-acl --dbname=gvcsim_restore_drill classroom-YYYYmmddTHHMMSSZ.dump
psql --dbname=gvcsim_restore_drill -Atc "select version from schema_meta where singleton"
unset PGPASSWORD
```

结果必须为 `gvcsim-teaching-db-v10`。恢复生产库前应停止 API、保留故障库，并先在隔离空库完成摘要、目录和 schema 验证。
