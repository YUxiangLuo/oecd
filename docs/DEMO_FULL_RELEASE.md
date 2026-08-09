# 演示服务器完整发布附录

本页只用于 `101.201.151.30` 的后端、依赖或数据变更。日常前端发布使用
[`DEPLOY_101.201.151.30.md`](../DEPLOY_101.201.151.30.md)，不要套用本流程。

完整发布会切换 Manifest，必须安排维护窗口并新建 assignment。禁止使用
`--allow-qc-override`、`classroom-init --reset` 或覆盖同名 Artifact。

## 1. 本地 Artifact 门禁

先完成主指南第 2 节的变量设置和演示前端构建，再执行：

```bash
uv sync --locked --group dev
uv run ruff format --check .
uv run ruff check .
uv run mypy
uv run pytest --cov=gvcsim --cov-report=term-missing -q
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

完成主指南第 3 节数据库、代码、虚拟环境和 processed 链接备份后再继续。

## 2. 上传提交与不可变 Artifact

`git archive` 只包含已提交文件，避免把本地缓存或 `dogfood-output/` 上传到服务器；被 Git
忽略的演示 bundle 单独同步：

```bash
ssh "$SERVER" "test ! -e '$UPLOAD' && install -d -m 0700 '$UPLOAD'"
git archive --format=tar "$COMMIT" | ssh "$SERVER" "tar -xf - -C '$UPLOAD'"
rsync -az --delete frontend/dist/ "$SERVER:$UPLOAD/frontend/dist/"
ssh "$SERVER" "test -f '$UPLOAD/gvcsim/data/loader.py' && test -f '$UPLOAD/frontend/dist/index.html'"

ARTIFACT_STAGE="$APP/data/.artifact-staging-$RELEASE_ID"
ssh "$SERVER" "test ! -e '$ARTIFACT_STAGE' && install -d -m 0755 '$ARTIFACT_STAGE'"
rsync -az --delete "data/artifacts/$MANIFEST_ID/" "$SERVER:$ARTIFACT_STAGE/"
ssh "$SERVER" \
  "test ! -e '$APP/data/artifacts/$MANIFEST_ID' && mv '$ARTIFACT_STAGE' '$APP/data/artifacts/$MANIFEST_ID'"
```

同一 Manifest ID 不得覆盖。失败重试前用 `rsync -naci` 比较。原始 ICIO 文件变化时应作为
独立数据迁移逐文件备份、同步和复核，不能依赖上述代码上传。

## 3. 停机切换

任一命令失败时停止，执行第 6 节完整回滚：

```bash
ssh "$SERVER" bash -s -- \
  "$APP" "$UPLOAD" "$RELEASE_ID" "$MANIFEST_ID" "$COMMIT" <<'REMOTE'
set -euo pipefail
app=$1
upload=$2
release_id=$3
new_manifest=$4
expected_commit=$5
[[ "$app" == /opt/oecd-icio-analysis ]] || exit 64
case "$upload" in /var/tmp/gvcsim-upload-*) ;; *) exit 64 ;; esac
[[ "$new_manifest" =~ ^[0-9a-f]{16}$ ]] || exit 64
[[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]] || exit 64
test -d "$upload"

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

target = Path("data/artifacts") / os.environ["MANIFEST_ID"]
validate_release(target, validate_sources=True)
assert manifest_id(target) == os.environ["MANIFEST_ID"]
p = manifest_provenance(target)
assert p["build"]["git_commit"] == os.environ["EXPECTED_COMMIT"]
assert p["build"]["git_dirty"] is False
print("remote artifact preflight: OK")
PY

next_link="$app/data/processed.next-$release_id"
ln -s "artifacts/$new_manifest" "$next_link"
mv -Tf "$next_link" "$app/data/processed"
next_marker="$app/.deployed-commit-$release_id"
printf '%s\n' "$expected_commit" > "$next_marker"
mv -Tf "$next_marker" "$app/.deployed-commit"

systemctl start gvcsim-api.service
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:18000/health && break
  sleep 1
done
curl -fsS http://127.0.0.1:18000/health
nginx -t
systemctl reload nginx
systemctl is-active --quiet gvcsim-api.service
rm -rf -- "$upload" || true
REMOTE
```

## 4. 新建 assignment

保持维护窗口，通过教师管理界面或 `POST /api/classroom/assignments` 新建绑定新
`MANIFEST_ID` 的 assignment：

- 保留旧 assignment、attempt、session 和全部审计事件；
- 不改写历史 session 的 Manifest；
- 新 assignment 验证通过后才结束维护窗口。

## 5. 完整验收

先执行主指南第 5 节，再检查 `/api/meta`、新 assignment/Manifest、步骤 1 ICIO 切片和
regression design。探针上下文必须满足：

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/classroom/context" |
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["assignment_manifest_id"], d["manifest_mismatch"])'
```

期望输出新 Manifest 和 `False`。不要把密码或 token 写入仓库或验收脚本。

## 6. 完整回滚

```bash
ssh "$SERVER" bash -s -- "$APP" "$BACKUP" "$RELEASE_ID" <<'REMOTE'
set -euo pipefail
app=$1
backup=$2
release_id=$3
[[ "$app" == /opt/oecd-icio-analysis ]] || exit 64
case "$backup" in /var/backups/gvcsim/releases/*-pre) ;; *) exit 64 ;; esac
test -d "$backup/app"
old_target=$(cat "$backup/processed-target")

systemctl stop gvcsim-api.service
rsync -a --delete \
  --exclude='/data/' --exclude='/OECD_ICIO/' --exclude='/reports/' \
  "$backup/app/" "$app/"
next_link="$app/data/processed.rollback-$release_id"
ln -s "$old_target" "$next_link"
mv -Tf "$next_link" "$app/data/processed"
systemctl restart gvcsim-api.service
curl -fsS http://127.0.0.1:18000/health
REMOTE
```

如果已创建新 assignment，回滚后由教师将它停用；不要删除。新 Artifact 保留用于审计。
数据库不会自动回滚；确需恢复时，必须按 [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) 先在
隔离空库完成试恢复，禁止覆盖唯一课堂库。

## 可选：题库版本升级

这不是普通发布步骤。只有题库版本明确变化并单独批准后，才在所有验收通过后执行：

```bash
NEW_QUIZ_VERSION=course-quiz-v3  # 替换为本次不可复用的新版本号
ssh "$SERVER" bash -s -- "$APP" "$NEW_QUIZ_VERSION" <<'REMOTE'
set -euo pipefail
app=$1
quiz_version=$2
cd "$app"
systemctl is-active --quiet gvcsim-api.service
curl -fsS http://127.0.0.1:18000/health
nginx -t
set -a
. /etc/gvcsim.env
set +a
.venv/bin/gvcsim classroom-reset-attempts --quiz-version "$quiz_version" --confirm
REMOTE
```

该命令归档旧 attempt 并建立新 attempt，不删除历史 session、报告、提交或评分。同一题库
版本号不得复用；SSH 在最后一步附近中断时原样重跑确认幂等，不要直接回滚代码。
