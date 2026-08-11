# 101.201.151.30 演示服务器部署指南

> 最后核对：2026-08-09。当前仍是 root、明文 HTTP、固定目录原地运行的演示环境，
> 不能承载真实学生密码或 Bearer token。

## 当前结构

| 项目 | 当前值 |
| --- | --- |
| SSH / 应用目录 | `root@101.201.151.30` / `/opt/oecd-icio-analysis` |
| systemd / 后端 | `gvcsim-api.service` / `127.0.0.1:18000` |
| Nginx 静态目录 | `/opt/oecd-icio-analysis/frontend/dist` |
| 外部入口 | `http://101.201.151.30:6363` |
| 环境变量 / 备份 | `/etc/gvcsim.env` / `/var/backups/gvcsim` |
| 当前数据 | `data/processed -> artifacts/<manifest_id>` |

`deploy/` 中的目标版配置面向未来的非 root、HTTPS、原子 release 架构，**不能直接安装
到当前主机**。

## 1. 选择发布路径

| 变更 | 操作 | Artifact / assignment | API 停机 |
| --- | --- | --- | --- |
| 仅文档、测试、CI、本地 smoke | 合并并等待 CI；服务器不部署 | 不变 | 否 |
| 仅前端运行时代码 | 本文前端-only 路径 | 不变 | 否 |
| `gvcsim/`、`pyproject.toml`、`uv.lock`、ICIO、计算口径或服务依赖 | [完整发布](docs/DEMO_FULL_RELEASE.md) | 重算并新建 | 是 |
| 无法确定 | 完整发布 | 重算并新建 | 是 |

前端-only 必须由 diff 证明没有后端、依赖或数据变更。后端源码属于 Manifest 输入；误用
旧 Artifact 会使 `/health` 返回 503。

硬约束：

- 远端切换前备份数据库、代码、虚拟环境和 processed 链接；
- 禁止 `classroom-init --reset`，禁止覆盖 Artifact 或删除历史课堂记录；
- 前端-only 不运行迁移、不切换 Artifact、不创建 assignment、不重置 attempt；
- smoke 使用专用探针账号；教师 smoke 会改密码，禁止对课堂账号运行；
- 任一步失败即停止；完整发布失败按完整发布文档回滚。

## 2. 公共变量与前端 bundle

服务器发布都先提交、推送并等待该提交的 CI 全绿，然后构建演示 bundle：

```bash
set -euo pipefail
test -z "$(git status --porcelain)"
git push

COMMIT=$(git rev-parse HEAD)
SERVER=root@101.201.151.30
APP=/opt/oecd-icio-analysis
BASE=http://101.201.151.30:6363
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-${COMMIT:0:12}"
UPLOAD="/var/tmp/gvcsim-upload-$RELEASE_ID"
BACKUP="/var/backups/gvcsim/releases/$RELEASE_ID-pre"

(
  cd frontend
  bun install --frozen-lockfile
  bun run test:unit
  bun run build:demo
)
grep -RIl "gvclab2026" frontend/dist/ >/dev/null
```

`build:demo` 只用于这台演示服务器。正式生产必须使用 `bun run build`，且产物不得包含
演示口令。

## 3. 部署前备份

```bash
ssh "$SERVER" bash -s -- "$APP" "$BACKUP" <<'REMOTE'
set -euo pipefail
app=$1
backup=$2
[[ "$app" == /opt/oecd-icio-analysis ]] || exit 64
case "$backup" in /var/backups/gvcsim/releases/*-pre) ;; *) exit 64 ;; esac

test -d "$app"
test ! -e "$backup"
install -d -m 0700 "$(dirname "$backup")" "$backup" "$backup/app"
stat -c '%a %u %g' "$app" > "$backup/app-root-stat"
chmod 0600 "$backup/app-root-stat"
set -a
. /etc/gvcsim.env
set +a
result=$(GVCSIM_BACKUP_DIR=/var/backups/gvcsim "$app/scripts/backup_classroom.sh")
printf '%s\n' "$result"
dump=$(printf '%s\n' "$result" | sed -n 's/^backup=//p')
test -n "$dump"
(cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256")

rsync -a --delete \
  --exclude='/data/' --exclude='/OECD_ICIO/' --exclude='/reports/' \
  "$app/" "$backup/app/"
readlink "$app/data/processed" > "$backup/processed-target"
chmod 0700 "$backup" "$backup/app"
REMOTE
```

必须看到 `classroom-*.dump: OK`，并确认 `$BACKUP/app`、
`$BACKUP/app-root-stat` 和 `$BACKUP/processed-target` 存在。根目录元数据用于避免安全的
`0700` 上传暂存目录经 `rsync -a` 意外覆盖应用目录权限。checksum 不替代隔离恢复演练。

## 4. 前端-only：上传与切换

Nginx 直接读取 `frontend/dist`。因此无需停 API、同步后端、运行 `uv sync`、迁移数据库、
验证 Artifact 或 reload Nginx。

只打包已提交的前端源码，并逐文件校验构建产物：

```bash
DIST_CHECKSUMS=$(mktemp)
trap 'rm -f "$DIST_CHECKSUMS"' EXIT
(
  cd frontend/dist
  find . -type f -print0 | sort -z | xargs -0 sha256sum
) > "$DIST_CHECKSUMS"

ssh "$SERVER" "test ! -e '$UPLOAD' && install -d -m 0700 '$UPLOAD'"
git archive --format=tar "$COMMIT" frontend | ssh "$SERVER" "tar -xf - -C '$UPLOAD'"
rsync -az --delete frontend/dist/ "$SERVER:$UPLOAD/frontend/dist/"
rsync -az "$DIST_CHECKSUMS" "$SERVER:$UPLOAD/frontend/dist.sha256"
ssh "$SERVER" "cd '$UPLOAD/frontend/dist' && sha256sum -c ../dist.sha256"
```

先复制内容摘要资源，最后原子替换 `index.html`：

```bash
ssh "$SERVER" bash -s -- "$APP" "$UPLOAD" "$RELEASE_ID" "$COMMIT" <<'REMOTE'
set -euo pipefail
app=$1
upload=$2
release_id=$3
commit=$4
[[ "$app" == /opt/oecd-icio-analysis ]] || exit 64
case "$upload" in /var/tmp/gvcsim-upload-*) ;; *) exit 64 ;; esac
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || exit 64

dist="$app/frontend/dist"
upload_dist="$upload/frontend/dist"
test -f "$upload/frontend/package.json"
test -f "$upload_dist/index.html"
test -d "$dist/assets"
nginx -T 2>/dev/null | grep -F "root $dist;" >/dev/null

# 源码与提交保持一致，但不触碰运行中的 API 或现有 dist。
rsync -a --delete --exclude='/dist/' --exclude='/node_modules/' \
  "$upload/frontend/" "$app/frontend/"
# 不删除旧摘要资源：旧缓存仍可读取，回滚也只需恢复旧 index。
rsync -a --exclude='/index.html' "$upload_dist/" "$dist/"
next_index="$app/frontend/.index-$release_id"
install -m 0644 "$upload_dist/index.html" "$next_index"
mv -Tf "$next_index" "$dist/index.html"

next_marker="$app/.deployed-commit-$release_id"
printf '%s\n' "$commit" > "$next_marker"
chmod 0644 "$next_marker"
mv -Tf "$next_marker" "$app/.deployed-commit"
nginx -t
rm -rf -- "$upload"
REMOTE
```

旧 assets 仅占少量空间，另行按回滚保留窗口清理，不能在切换命令中 `--delete`。

## 5. 验收

```bash
ssh "$SERVER" '
  set -e
  systemctl is-active gvcsim-api.service
  curl -fsS http://127.0.0.1:18000/health
  readlink /opt/oecd-icio-analysis/data/processed
  nginx -t
  journalctl -u gvcsim-api.service -n 80 --no-pager
'

curl -fsS "$BASE/" > /tmp/gvcsim-index.html
cmp frontend/dist/index.html /tmp/gvcsim-index.html
rm -f /tmp/gvcsim-index.html

read -r -p '探针用户名: ' PROBE_USERNAME
read -r -s -p '探针临时口令: ' PROBE_PASSWORD; printf '\n'
GVCSIM_BASE_URL="$BASE" \
GVCSIM_E2E_USERNAME="$PROBE_USERNAME" \
GVCSIM_E2E_PASSWORD="$PROBE_PASSWORD" \
scripts/agent_browser_smoke.sh
unset PROBE_PASSWORD
```

确认 `/health` 的 Manifest、schema 和 processed 链接未变；确认 assignment 列表未增加，
浏览器无 4xx/5xx、console error 或 axe violation。探针可能创建 attempt，不要使用真实学生。

## 6. 前端-only 回滚

旧资源在第 4 节中未删除；恢复其他文件后，最后原子恢复旧 index：

```bash
ssh "$SERVER" bash -s -- "$APP" "$BACKUP" "$RELEASE_ID" <<'REMOTE'
set -euo pipefail
app=$1
backup=$2
release_id=$3
[[ "$app" == /opt/oecd-icio-analysis ]] || exit 64
case "$backup" in /var/backups/gvcsim/releases/*-pre) ;; *) exit 64 ;; esac
old_frontend="$backup/app/frontend"
old="$old_frontend/dist"
current="$app/frontend/dist"
test -f "$old/index.html"

rsync -a --delete --exclude='/dist/' --exclude='/node_modules/' \
  "$old_frontend/" "$app/frontend/"
rsync -a --exclude='/index.html' "$old/" "$current/"
next_index="$app/frontend/.index-rollback-$release_id"
install -m 0644 "$old/index.html" "$next_index"
mv -Tf "$next_index" "$current/index.html"
if [[ -f "$backup/app/.deployed-commit" ]]; then
  install -m 0644 "$backup/app/.deployed-commit" "$app/.deployed-commit"
else
  rm -f -- "$app/.deployed-commit"
fi
nginx -t
REMOTE
```

前端-only 回滚不恢复数据库、不重启 API。回滚后重新执行第 5 节。

## 日常检查与生产边界

```bash
ssh root@101.201.151.30 '
  systemctl status gvcsim-api.service --no-pager -l
  journalctl -u gvcsim-api.service --since today --no-pager
  find /var/backups/gvcsim -maxdepth 1 -type f -name "*.dump" \
    -printf "%TY-%Tm-%Td %TT %s %p\n"
'
```

至少监控登录失败/限流、401/403/5xx、报告失败、Manifest stale、QC override 和 assignment
变更，并定期按 [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md) 做隔离恢复演练。

当前布局不作为生产或 100 人容量达标证据。正式迁移至少需要非 root 服务账号、原子 release
链接、共享数据目录、HTTPS、正式安全配置和独立随机密钥；容量验收见
[`docs/CAPACITY_100_STUDENTS.md`](docs/CAPACITY_100_STUDENTS.md)。
