# 远程部署

示例目录为 `/opt/gvcsim/current`，共享数据根目录为 `/opt/gvcsim/shared`，环境配置为 `/etc/gvcsim.env`。

## 准备

环境文件必须允许服务账号读取，数据目录必须由该账号持有：

```bash
chown root:gvcsim /etc/gvcsim.env
chmod 0640 /etc/gvcsim.env
install -d -o gvcsim -g gvcsim -m 0750 /opt/gvcsim/shared/data
install -d -o gvcsim -g gvcsim -m 0750 /opt/gvcsim/shared/OECD_ICIO
chown -R gvcsim:gvcsim /opt/gvcsim/shared/data /opt/gvcsim/shared/OECD_ICIO
```

把课程使用的 `ICIO2023_<year>.csv` 放入 `/opt/gvcsim/shared/OECD_ICIO/`。`/etc/gvcsim.env` 必须按 `deploy/gvcsim.env.example` 设置 `GVCSIM_DATA_DIR=/opt/gvcsim/shared/data` 和 `GVCSIM_RAW_DATA_DIR=/opt/gvcsim/shared/OECD_ICIO`；应用不从代码目录保存或读取生产数据。

安装服务文件：

```bash
install -m 0644 deploy/gvcsim-api.service /etc/systemd/system/
install -d -o gvcsim -g gvcsim -m 0700 /opt/gvcsim/shared/backups
install -m 0644 deploy/gvcsim-backup.service deploy/gvcsim-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable gvcsim-api
systemctl enable --now gvcsim-backup.timer
```

## 每次部署

每次部署都进入维护窗口并清空教学数据库。以下命令以 root 执行；任一步失败都会停止，API 保持关闭。首次部署还没有可备份的数据库时，省略备份服务那一行。

```bash
set -euo pipefail
read -rsp '首位教师初始口令（至少 12 位）: ' GVCSIM_INITIAL_TEACHER_PASSWORD
echo
test "${#GVCSIM_INITIAL_TEACHER_PASSWORD}" -ge 12
export GVCSIM_INITIAL_TEACHER_PASSWORD
trap 'unset GVCSIM_INITIAL_TEACHER_PASSWORD' EXIT
systemctl stop gvcsim-api
systemctl start gvcsim-backup.service

cd /opt/gvcsim/current
uv sync --frozen
cd frontend
bun install --frozen-lockfile
bun run build
cd ..

runuser -u gvcsim --preserve-environment -- /bin/sh -c '
  set -eu
  set -a; . /etc/gvcsim.env; set +a
  cd /opt/gvcsim/current
  .venv/bin/gvcsim compute
  .venv/bin/gvcsim classroom-init --reset --teacher-username teacher --teacher-name 老师
  .venv/bin/gvcsim preflight
'
systemctl start gvcsim-api
curl -fsS http://127.0.0.1:18000/health
unset GVCSIM_INITIAL_TEACHER_PASSWORD
trap - EXIT
```

`compute`、数据库重建和 `preflight` 必须以 `gvcsim` 服务账号运行；release 使用 `0700`，用 root 运行会产生服务不可读的目录。`compute` 只重建预计算数据，不修改 PostgreSQL；构建或 QC 失败时旧数据发布仍保留。`--allow-qc-override` 只保留给 ICIO/控制变量教学质检；冲击 schema、来源与语义 fatal 检查不可 override，发布 metadata 中的 shock override 必须为 false。切换前会校验完整 SHA-256/结构清单并同步落盘，成功后保留当前和上一发布。数据库重建会删除全部账号、会话、报告和评分，旧令牌随之失效。

数据库重建后必须创建首位教师，否则 `preflight` 和 `/health` 会拒绝放行。初始口令只通过当前部署进程传给初始化命令，不写入环境文件；服务启动后应立即登录并轮换。

## 备份与恢复演练

备份脚本内部使用 `pg_dump --format=custom`；恢复演练使用标准 `pg_restore`，并且不会覆盖已有归档。

```bash
set -a; . /etc/gvcsim.env; set +a
GVCSIM_BACKUP_DIR=/opt/gvcsim/shared/backups scripts/backup_classroom.sh
cd /opt/gvcsim/shared/backups
sha256sum -c classroom-YYYYmmddTHHMMSSZ.dump.sha256
pg_restore --list classroom-YYYYmmddTHHMMSSZ.dump >/dev/null
# 以下是 libpq 命令实际读取的连接变量；按 GVCSIM_PG_DSN 填写主机、端口和用户。
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gvcsim
read -rsp 'PostgreSQL 口令: ' PGPASSWORD
echo
export PGPASSWORD
createdb --maintenance-db=postgres gvcsim_restore_drill
pg_restore --single-transaction --no-owner --no-acl --dbname=gvcsim_restore_drill classroom-YYYYmmddTHHMMSSZ.dump
psql --dbname=gvcsim_restore_drill -Atc "select version from schema_meta where singleton"
unset PGPASSWORD
```

演练结果必须为 `gvcsim-teaching-db-v10`。恢复生产库前应停止 API、保留故障库，并先在隔离空库完成上述摘要、目录和 schema 验证；仓库不自动执行生产恢复或删除备份。
