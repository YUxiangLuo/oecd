# 远程部署

当前试用服务器：`root@101.201.151.30`，访问端口 `6363`。

- 应用目录：`/opt/gvcsim/current`
- 持久数据：`/opt/gvcsim/shared/data`、`/opt/gvcsim/shared/reports`
- 环境配置：`/etc/gvcsim.env`（部署时不要覆盖）
- 服务：`gvcsim-api`、`nginx`

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
   SHA=<上一步的提交号>
   test -n "$SHA"
   mkdir -p /opt/gvcsim/backups
   cp -al /opt/gvcsim/current /opt/gvcsim/backups/current-before-$SHA
   systemctl stop gvcsim-api
   rsync -a --delete \
     --exclude=/OECD_ICIO --exclude=/data --exclude=/reports --exclude=/.venv \
     --exclude=/frontend/node_modules \
     /opt/gvcsim/staging-$SHA/ /opt/gvcsim/current/
   cd /opt/gvcsim/current
   /root/.local/bin/uv sync \
     --python /opt/gvcsim/python/cpython-3.13-linux-x86_64-gnu/bin/python3.13 \
     --frozen
   set -a; . /etc/gvcsim.env; set +a
   runuser -u gvcsim --preserve-environment -- .venv/bin/gvcsim preflight
   systemctl start gvcsim-api
   rm -rf "/opt/gvcsim/staging-$SHA"
   ```

   `uv sync` 必须在正式目录执行，否则 editable 安装可能继续引用 staging 路径。
   只有课程发布版本或固定指标产物发生变化时才需在停服期间运行 `.venv/bin/gvcsim compute`；它会清空学生进度、会话、报告和提交。

## 验证

```bash
curl -fsS http://127.0.0.1:18000/health
systemctl is-active gvcsim-api nginx
```

浏览器访问 <http://101.201.151.30:6363/>，确认已预填 `student / gvclab2026`，并测试学生、教师身份登录。

## 回滚

```bash
systemctl stop gvcsim-api
rsync -a --delete /opt/gvcsim/backups/current-before-<SHA>/ /opt/gvcsim/current/
systemctl start gvcsim-api
```

当前入口是明文 HTTP，且演示密码公开，只用于试用环境，不应录入真实数据。
