# 101.201.151.30 当前演示服务器部署指南

> 最后核对：2026-07-22。
>
> 这台机器仍是演示环境：应用以 root 运行，通过明文 HTTP 对外服务，并在固定目录中原地更新。
> 本文只写当前可执行的流程；正式生产迁移要求见文末。

## 当前结构

| 项目 | 当前值 |
| --- | --- |
| SSH | `root@101.201.151.30` |
| 应用目录 | `/opt/oecd-icio-analysis` |
| systemd | `gvcsim-api.service` |
| 后端 | `127.0.0.1:18000` |
| 外部入口 | `http://101.201.151.30:6363` |
| 环境变量 | `/etc/gvcsim.env` |
| 当前数据 | `data/processed -> artifacts/<manifest_id>` |
| 备份目录 | `/var/backups/gvcsim` |

`deploy/gvcsim-api.service` 和 `deploy/nginx-gvcsim.conf` 面向未来的
`/opt/gvcsim/current`、非 root、HTTPS 架构，**不能直接安装到当前主机**。

## 1. 判断发布类型

| 变更范围 | 重算 artifact | 新建 assignment |
| --- | --- | --- |
| 仅前端、README、文档或测试 | 否 | 否 |
| `gvcsim/`、`pyproject.toml`、`uv.lock`、ICIO 输入或计算口径 | 是 | 是 |
| 无法确定 | 是 | 是 |

后端源码摘要属于 artifact manifest。修改后端却沿用旧 manifest，会使 `/health`
返回 503。切换 manifest 后，旧 assignment 会产生 409，因此完整发布必须安排维护窗口。

## 2. 本地构建

先提交代码并确保工作树干净：

```bash
git status --short --branch
test -z "$(git status --porcelain)"

uv sync --locked --group dev
uv run ruff format --check .
uv run ruff check .
uv run mypy
uv run pytest --cov=gvcsim --cov-report=term-missing -q

(
  cd frontend || exit
  bun install --frozen-lockfile
  bun run test:unit
  bun run build:demo
)

if ! grep -RIl "gvclab2026" frontend/dist/ >/dev/null; then
  echo "演示构建未包含默认演示口令" >&2
  exit 1
fi

git push
COMMIT=$(git rev-parse HEAD)
```

当前服务器默认部署演示前端：学生账号 `student`、教师账号 `teacher`，默认口令
`gvclab2026`。`build:demo` 只用于这台演示服务器；正式生产必须使用 `bun run build`，
并确认前端产物不包含演示口令。

完整发布还要在这个干净提交上重算并验证数据：

```bash
uv run gvcsim compute
uv run pytest -q tests/test_artifacts.py tests/test_quality.py tests/test_synthetic_compute.py
MANIFEST_ID=$(uv run python -c 'from gvcsim.artifacts import manifest_id; print(manifest_id())')

MANIFEST_ID="$MANIFEST_ID" COMMIT="$COMMIT" uv run python - <<'PY'
import os
from gvcsim.artifacts import manifest_id, manifest_provenance, validate_release
from gvcsim.config import PROCESSED_DIR

validate_release(PROCESSED_DIR, validate_sources=True)
p = manifest_provenance()
assert manifest_id() == os.environ["MANIFEST_ID"]
assert p["build"]["git_commit"] == os.environ["COMMIT"]
assert p["build"]["git_dirty"] is False
assert all(q["publishable"] and not q["fatal"] and not q["override"] for q in p["qc"]["years"].values())
print("artifact preflight: OK")
PY
```

普通发布不得使用 `--allow-qc-override`。仅前端/文档发布使用 `-` 表示不切换 manifest：

```bash
MANIFEST_ID=-
```

设置本次部署变量；后续命令在同一个本地 shell 中执行：

```bash
SERVER=root@101.201.151.30
APP=/opt/oecd-icio-analysis
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)"
UPLOAD="/var/tmp/gvcsim-upload-$RELEASE_ID"
BACKUP="/var/backups/gvcsim/releases/$RELEASE_ID-pre"
```

## 3. 部署前备份

同时备份 PostgreSQL、当前代码、虚拟环境和旧 manifest 链接：

```bash
ssh "$SERVER" bash -s -- "$APP" "$BACKUP" <<'REMOTE'
set -euo pipefail
app=$1
backup=$2
case "$backup" in /var/backups/gvcsim/releases/*-pre) ;; *) exit 64 ;; esac
test -d "$app"
install -d -m 0700 "$(dirname "$backup")"
test ! -e "$backup"
install -d -m 0700 "$backup/app"

set -a
. /etc/gvcsim.env
set +a
result=$(GVCSIM_BACKUP_DIR=/var/backups/gvcsim "$app/scripts/backup_classroom.sh")
printf '%s\n' "$result"
dump=$(printf '%s\n' "$result" | sed -n 's/^backup=//p')
test -n "$dump"
sha256sum -c "$dump.sha256"

rsync -a --delete \
  --exclude='/data/' --exclude='/OECD_ICIO/' --exclude='/reports/' \
  "$app/" "$backup/app/"
readlink "$app/data/processed" > "$backup/processed-target"
REMOTE
```

必须看到数据库备份校验结果 `OK` 后才能继续。

## 4. 上传

代码先上传到临时目录：

```bash
ssh "$SERVER" "test ! -e '$UPLOAD' && install -d -m 0700 '$UPLOAD'"
rsync -az --delete \
  --exclude='/.git/' --exclude='/.venv/' --exclude='/frontend/node_modules/' \
  --exclude='/data/' --exclude='/OECD_ICIO/' --exclude='/reports/' \
  --exclude='/.pytest_cache/' --exclude='/.ruff_cache/' --exclude='/.mypy_cache/' \
  ./ "$SERVER:$UPLOAD/"

ssh "$SERVER" \
  "test -f '$UPLOAD/gvcsim/data/loader.py' && test -f '$UPLOAD/frontend/dist/index.html'"
```

排除规则的前导 `/` 不能删除；未锚定的 `data/` 会误排除 `gvcsim/data/` 源码。

完整发布还要上传不可变 artifact。不要同步 `data/processed/`：

```bash
if [[ "$MANIFEST_ID" != "-" ]]; then
  ARTIFACT_STAGE="$APP/data/.artifact-staging-$RELEASE_ID"
  ssh "$SERVER" "test ! -e '$ARTIFACT_STAGE' && install -d -m 0755 '$ARTIFACT_STAGE'"
  rsync -az --delete "data/artifacts/$MANIFEST_ID/" "$SERVER:$ARTIFACT_STAGE/"
  ssh "$SERVER" \
    "test ! -e '$APP/data/artifacts/$MANIFEST_ID' && mv '$ARTIFACT_STAGE' '$APP/data/artifacts/$MANIFEST_ID'"
fi
```

同一 manifest ID 不得覆盖；失败重试前先用 `rsync -naci` 确认远端内容是否完整一致。
本流程假设远端 `OECD_ICIO/` 原始文件不变；若原始输入也变更，应作为独立数据迁移，
先备份并逐文件同步，再核对 manifest 中的摘要。

## 5. 切换服务

此步骤会短暂停止 API。任一命令失败时，不要继续，直接执行第 9 节回滚。

```bash
ssh "$SERVER" bash -s -- \
  "$APP" "$UPLOAD" "$RELEASE_ID" "$MANIFEST_ID" "$COMMIT" <<'REMOTE'
set -euo pipefail
app=$1
upload=$2
release_id=$3
new_manifest=$4
expected_commit=$5

[[ "$app" == "/opt/oecd-icio-analysis" ]] || exit 64
case "$upload" in /var/tmp/gvcsim-upload-*) ;; *) exit 64 ;; esac
test -d "$upload"
if [[ "$new_manifest" == "-" ]]; then
  new_manifest=
fi
systemctl stop gvcsim-api.service

rsync -a --delete \
  --exclude='/.venv/' --exclude='/data/' --exclude='/OECD_ICIO/' --exclude='/reports/' \
  "$upload/" "$app/"

cd "$app"
uv sync --locked
set -a
. /etc/gvcsim.env
set +a
.venv/bin/gvcsim classroom-init

MANIFEST_ID="$new_manifest" EXPECTED_COMMIT="$expected_commit" .venv/bin/python - <<'PY'
import os
from pathlib import Path
from gvcsim.artifacts import manifest_id, manifest_provenance, validate_release
from gvcsim.config import PROCESSED_DIR

mid = os.environ["MANIFEST_ID"]
target = Path("data/artifacts") / mid if mid else PROCESSED_DIR
validate_release(target, validate_sources=True)
if mid:
    assert manifest_id(target) == mid
    p = manifest_provenance(target)
    assert p["build"]["git_commit"] == os.environ["EXPECTED_COMMIT"]
    assert p["build"]["git_dirty"] is False
print("remote artifact preflight: OK")
PY

if [[ -n "$new_manifest" ]]; then
  next_link="$app/data/processed.next-$release_id"
  rm -f -- "$next_link"
  ln -s "artifacts/$new_manifest" "$next_link"
  mv -Tf "$next_link" "$app/data/processed"
fi

systemctl start gvcsim-api.service
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:18000/health && break
  sleep 1
done
curl -fsS http://127.0.0.1:18000/health
nginx -t
systemctl reload nginx
systemctl is-active --quiet gvcsim-api.service
# 上传目录清理失败不影响已经通过的服务切换。
rm -rf -- "$upload" || true
REMOTE
```

`classroom-init --reset` 会删除教学数据，日常部署绝对不能使用。

## 6. manifest 变更后新建作业

仅完整发布需要此步骤。保持维护窗口，通过教师管理界面或
`POST /api/classroom/assignments` 新建绑定 `MANIFEST_ID` 的 assignment：

- 保留旧 assignment、attempt、session 和答题/运行审计事件；
- 不要改写旧 session 或审计事件的 manifest；
- 新 assignment 验证通过后再结束维护窗口。

用探针学生登录后确认作用域：

```bash
BASE=http://101.201.151.30:6363
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/classroom/context" |
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["assignment_manifest_id"], d["manifest_mismatch"])'
```

期望输出新 manifest 和 `False`。不要把密码或 token 写入仓库或脚本。

## 7. 验收

当前 Nginx 未对外代理 `/health`，健康检查必须从服务器内部执行：

```bash
ssh "$SERVER" '
  systemctl is-active gvcsim-api.service
  curl -fsS http://127.0.0.1:18000/health
  readlink /opt/oecd-icio-analysis/data/processed
  journalctl -u gvcsim-api.service -n 80 --no-pager
'
```

使用专用探针账号运行真实浏览器检查：

```bash
GVCSIM_BASE_URL=http://101.201.151.30:6363 \
GVCSIM_E2E_USERNAME=<探针学生> \
GVCSIM_E2E_PASSWORD=<临时口令> \
scripts/agent_browser_smoke.sh
```

完整发布还要检查 `/api/meta`、assignment/manifest、步骤 1 ICIO 切片和 regression
design。探针可能创建 attempt，不要使用真实学生账号。

## 8. 验收通过后切换学习记录

只有第 7 节全部通过后才执行。此后不再安排可能触发代码回滚的发布步骤：

```bash
ssh "$SERVER" bash -s -- "$APP" <<'REMOTE'
set -euo pipefail
app=$1
[[ "$app" == "/opt/oecd-icio-analysis" ]] || exit 64
cd "$app"

# 所有失败风险较高的检查必须在数据库变更之前完成。
systemctl is-active --quiet gvcsim-api.service
curl -fsS http://127.0.0.1:18000/health
nginx -t
set -a
. /etc/gvcsim.env
set +a

# 最后一条命令才切换 attempt；命令在数据库事务内执行，并按题库版本保持幂等。
.venv/bin/gvcsim classroom-reset-attempts --quiz-version course-quiz-v2 --confirm
REMOTE
```

`classroom-reset-attempts` 不删除历史 session、报告、提交或评分；它只撤销旧 attempt
的答题/运行收据、归档旧 attempt 并建立新 attempt。升级下一版题库时必须同时更换版本号，
不能复用 `course-quiz-v2`。如果 SSH 在最后一步附近中断，先原样重跑命令确认幂等结果，
不要直接回滚代码。

## 9. 回滚

使用第 3 节生成的备份恢复代码、虚拟环境和旧 manifest：

```bash
ssh "$SERVER" bash -s -- "$APP" "$BACKUP" "$RELEASE_ID" <<'REMOTE'
set -euo pipefail
app=$1
backup=$2
release_id=$3
[[ "$app" == "/opt/oecd-icio-analysis" ]] || exit 64
case "$backup" in /var/backups/gvcsim/releases/*-pre) ;; *) exit 64 ;; esac
test -d "$backup/app"
old_target=$(cat "$backup/processed-target")

systemctl stop gvcsim-api.service
rsync -a --delete \
  --exclude='/data/' --exclude='/OECD_ICIO/' --exclude='/reports/' \
  "$backup/app/" "$app/"
next_link="$app/data/processed.rollback-$release_id"
rm -f -- "$next_link"
ln -s "$old_target" "$next_link"
mv -Tf "$next_link" "$app/data/processed"
systemctl restart gvcsim-api.service
curl -fsS http://127.0.0.1:18000/health
REMOTE
```

如果已创建新 assignment，回滚后由教师将它停用；已有 attempt 或审计事件时不要删除。
新 artifact 保留用于审计。

数据库不会自动回滚。确需恢复时，先在新建的隔离数据库中执行 `pg_restore --list`
和试恢复，确认后再切换 DSN；不要覆盖唯一数据库。

## 日常检查

```bash
ssh root@101.201.151.30 '
  systemctl status gvcsim-api.service --no-pager -l
  journalctl -u gvcsim-api.service --since today --no-pager
  find /var/backups/gvcsim -maxdepth 1 -type f -name "*.dump" \
    -printf "%TY-%Tm-%Td %TT %s %p\n"
'
```

至少监控登录失败/限流、401/403/5xx、报告失败、manifest stale、QC override 和
assignment 变更。备份应定期在隔离数据库做恢复演练。

## 正式生产迁移

当前演示布局不得承载真实学生密码和 Bearer token。正式上线至少需要：

- `gvcsim` 非 root 服务账号；
- `/opt/gvcsim/releases/<release-id>` 和原子 `current` 链接；
- 独立共享数据目录；
- 正式域名、受信任 HTTPS 证书和登录限流；
- `GVCSIM_ENV=production`、`GVCSIM_DEMO_MODE=0`；
- 两把独立随机密钥，并移除 `GVCSIM_BOOTSTRAP_PASSWORD`。

完成迁移后才能安装仓库中的目标版 systemd/nginx 配置。生产化迁移应作为独立变更，
不要和日常代码发布混在一起。生产构建使用 `bun run build`，并执行：

```bash
if grep -RIl "gvclab2026" frontend/dist/; then
  echo "生产前端包含演示口令" >&2
  exit 1
fi
```
