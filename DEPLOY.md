# 远程部署

当前试用服务器：`root@101.201.151.30`，访问端口 `6363`。

- 应用目录：`/opt/gvcsim/current`
- 持久数据：`/opt/gvcsim/shared/data`、`/opt/gvcsim/shared/reports`
- 数据库备份：`/opt/gvcsim/shared/backups`（私有目录，不随代码发布覆盖）
- 环境配置：`/etc/gvcsim.env`（部署时不要覆盖）
- 服务：`gvcsim-api`、`gvcsim-backup.timer`、`nginx`

## 首次安装备份定时器

在代码和 `/etc/gvcsim.env` 已就绪后，以 root 执行：

```bash
install -d -o gvcsim -g gvcsim -m 0700 /opt/gvcsim/shared/backups
install -m 0644 /opt/gvcsim/current/deploy/gvcsim-backup.service /etc/systemd/system/
install -m 0644 /opt/gvcsim/current/deploy/gvcsim-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gvcsim-backup.timer
systemctl list-timers gvcsim-backup.timer
```

定时器每天按服务器本地时间 02:30 触发，最多随机延迟 15 分钟，并通过 `Persistent=true` 补跑关机期间错过的任务。服务以 `gvcsim` 用户运行，只能写入私有备份目录；`backup_classroom.sh` 会先验证 custom archive 可读，再以 SHA-256 sidecar 作为完成标记。

## 更新流程

1. 确认本地改动已提交并推送，然后把当前提交导出到远端 staging 目录。

   ```bash
   SHA=$(git rev-parse --short HEAD)
   ssh root@101.201.151.30 "mkdir /opt/gvcsim/staging-$SHA"
   git archive HEAD | ssh root@101.201.151.30 "tar -xf - -C /opt/gvcsim/staging-$SHA"
   ```

2. 构建预填演示口令的前端。

   ```bash
   ssh root@101.201.151.30 "cd /opt/gvcsim/staging-$SHA/frontend && \
     bun install --frozen-lockfile && \
     VITE_DEMO_MODE=1 VITE_DEMO_PASSWORD=gvclab2026 bun run build"
   ```

3. 在服务器上备份旧版本、切换代码并重启。

   ```bash
   ssh root@101.201.151.30
   set -euo pipefail
   SHA=<上一步的提交号>
   REBUILD_DATASET=0  # 课程发布或固定指标有变化时改为 1
   test -n "$SHA"

   # 先停止课堂写入，再制作一致且覆盖停服前全部提交的数据库备份。
   systemctl stop gvcsim-api
   systemctl reset-failed gvcsim-backup.service || true
   systemctl start gvcsim-backup.service
   latest_sidecar=$(find /opt/gvcsim/shared/backups -maxdepth 1 -type f \
     -name 'classroom-*.dump.sha256' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
   test -n "$latest_sidecar"
   (cd /opt/gvcsim/shared/backups && sha256sum -c "$(basename "$latest_sidecar")")

   mkdir -p /opt/gvcsim/backups
   cp -al /opt/gvcsim/current /opt/gvcsim/backups/current-before-$SHA
   rsync -a --delete \
     --exclude=/OECD_ICIO --exclude=/data --exclude=/reports --exclude=/.venv \
     --exclude=/frontend/node_modules \
     /opt/gvcsim/staging-$SHA/ /opt/gvcsim/current/
   cd /opt/gvcsim/current
   install -m 0644 deploy/gvcsim-api.service /etc/systemd/system/
   install -m 0644 deploy/gvcsim-backup.service /etc/systemd/system/
   install -m 0644 deploy/gvcsim-backup.timer /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable gvcsim-backup.timer
   /root/.local/bin/uv sync \
     --python /opt/gvcsim/python/cpython-3.13-linux-x86_64-gnu/bin/python3.13 \
     --frozen
   set -a; . /etc/gvcsim.env; set +a
   if [[ "$REBUILD_DATASET" == "1" ]]; then
     runuser -u gvcsim --preserve-environment -- .venv/bin/gvcsim compute
   fi
   runuser -u gvcsim --preserve-environment -- .venv/bin/gvcsim preflight
   systemctl start gvcsim-api
   rm -rf "/opt/gvcsim/staging-$SHA"
   ```

   `uv sync` 必须在正式目录执行，否则 editable 安装可能继续引用 staging 路径。发布前备份步骤不得跳过；必须先停止 API 写入，再完成备份并校验最新 SHA-256 sidecar，之后才允许切换代码、运行 `compute` 或执行 schema 破坏性操作。课程发布版本或固定指标产物变化时必须把 `REBUILD_DATASET` 设为 `1`；`compute` 必须在 preflight 和启动服务之前完成。计算会先完整构建并校验不可变发布，再原子切换 `data/processed`，最后清空学生进度、会话、报告和提交；上一份发布保留用于失败回滚。数据发布变化后，旧登录令牌会失效，仍打开的旧页面不能把清空前的进度重新写回。

   如果 compute 报告学习记录清理失败，或 preflight 提示存在未完成发布，不要手工删除 `data/.processed-publication.json`。修复 PostgreSQL 后保持 API 停止并执行：

   ```bash
   .venv/bin/gvcsim compute --recover-pending
   .venv/bin/gvcsim preflight
   ```

## 验证

```bash
curl -fsS http://127.0.0.1:18000/health
systemctl is-active gvcsim-api nginx
systemctl status gvcsim-backup.timer gvcsim-backup.service
systemctl list-timers gvcsim-backup.timer
journalctl -u gvcsim-backup.service --since '7 days ago'
```

浏览器访问 <http://101.201.151.30:6363/>，确认已预填 `student / gvclab2026`，并测试学生、教师身份登录。

新发布的 `dataset.json` 使用产物契约 v2。`preflight` 会重新流式校验全部产物的 SHA-256、大小与 CSV/JSON 结构，不能用 `/health` 代替发布验收；`/health` 只在同一发布的全部顶层文件状态未变化时复用深度校验，指针切换或文件变化会自动重新校验。systemd 同时把 `.processed-releases` 暴露给 API 为只读。升级期间旧的无版本元数据仍按存在性契约读取，任何带清单但缺版本或 v2 清单不完整的发布都会 fail closed。

## 备份保留与恢复演练

仓库不自动删除备份。运维策略建议至少保留最近 30 份每日完整备份，并把加密副本同步到异机或对象存储；在确认异地副本完整、恢复演练通过且满足课程数据保留政策后，再由运维人员显式清理旧文件。不要只保留同一台服务器上的副本。

每月至少执行一次隔离恢复演练。先创建名称以 `_restore_drill` 结尾的全新空数据库，再通过环境变量提供目标 DSN 和精确确认值；不要把含密码的 DSN 放进命令参数：

```bash
latest_dump=$(find /opt/gvcsim/shared/backups -maxdepth 1 -type f \
  -name 'classroom-*.dump' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
test -n "$latest_dump"
export GVCSIM_RESTORE_DSN='postgresql://.../gvcsim_monthly_restore_drill'
export GVCSIM_RESTORE_DRILL_CONFIRM='gvcsim_monthly_restore_drill'
cd /opt/gvcsim/current
runuser -u gvcsim --preserve-environment -- .venv/bin/python \
  scripts/restore_classroom_drill.py "$latest_dump" \
  --receipt /opt/gvcsim/shared/backups/restore-drill-$(date -u +%Y%m%dT%H%M%SZ).json
```

核对回执中的 schema 版本、各表行数、preflight 和 SHA-256 后，由运维人员显式删除演练数据库。恢复脚本不会自动删除目标库。

## 回滚

```bash
set -euo pipefail
systemctl stop gvcsim-api
rsync -a --delete /opt/gvcsim/backups/current-before-<SHA>/ /opt/gvcsim/current/
cd /opt/gvcsim/current
set -a; . /etc/gvcsim.env; set +a
runuser -u gvcsim --preserve-environment -- .venv/bin/gvcsim preflight
systemctl start gvcsim-api
```

如果回滚后的 preflight 报告课程发布与 `dataset.json` 不兼容，保持 API 停止；确认正在运行回滚代码后执行 `.venv/bin/gvcsim compute` 重建与该代码匹配的数据，再重新运行 preflight。不要在 preflight 失败时直接启动，也不要只回滚代码而忽略共享 `data/processed` 指针的兼容性。

当前入口是明文 HTTP，且演示密码公开，只用于试用环境，不应录入真实数据。
