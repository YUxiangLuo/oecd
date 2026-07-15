# 101.201.151.30 部署指南

## 当前环境

| 项目 | 值 |
|---|---|
| 访问地址 | `http://101.201.151.30:6363/` |
| API 文档 | `http://101.201.151.30:6363/docs` |
| 部署来源 | `cc` @ `b11a80c` |
| 服务器目录 | `/opt/oecd-icio-analysis` |
| 后端服务 | `gvcsim-api.service` → `127.0.0.1:18000` |
| nginx 配置 | `/etc/nginx/conf.d/gvcsim.conf` |
| 前端目录 | `/opt/oecd-icio-analysis/frontend/dist` |
| Python 环境 | `/opt/oecd-icio-analysis/.venv311` |
| 教学数据库 | 本机 PostgreSQL，数据库 `gvclab` |

服务器部署目录不含 `.git`；线上代码属于哪个分支，取决于执行 `rsync` 时本地检出的分支。
当前入口仍是 HTTP，正式承载真实账号或学生数据前应先配置 HTTPS。

## 标准更新流程

### 1. 准备 `cc` 分支

```bash
git switch cc
git pull --ff-only origin cc
git status --short --branch

uv run ruff format --check .
uv run ruff check .
uv run mypy
uv run pytest -q

cd frontend
bun install --frozen-lockfile
bun run test:unit
bun run build
bun run test:e2e
cd ..
```

部署前工作区应保持干净；`frontend/dist/` 必须是刚构建的 `cc` 产物。

### 2. 全新部署：停止旧服务

本轮按全新环境部署，不恢复旧课程数据库、旧进度或旧运行目录。先停止旧 API，后续使用
`classroom-init --reset` 建立全新的 16 步教学库；因此无需为旧 17 步数据设计回滚。

```bash
ssh root@101.201.151.30 '
  set -euo pipefail
  systemctl stop gvcsim-api.service || true
'
```

若后续步骤失败，保持服务停止，修复后从本指南第 3 步重新执行完整部署。

### 3. 同步应用代码

```bash
EXCLUDES=(
  --exclude='.git/'
  --exclude='.pi-subagents/'
  --exclude='.venv/'
  --exclude='.venv311/'
  --exclude='frontend/node_modules/'
  --exclude='frontend/.vite/'
  --exclude='frontend/playwright-report/'
  --exclude='frontend/test-results/'
  --exclude='frontend/e2e/'
  --exclude='frontend/playwright.config.ts'
  --exclude='*.tsbuildinfo'
  --exclude='__pycache__/'
  --exclude='*.pyc'
  --exclude='.pytest_cache/'
  --exclude='.ruff_cache/'
  --exclude='.mypy_cache/'
  --exclude='.coverage'
  --exclude='htmlcov/'
  --exclude='data/'
  --exclude='OECD_ICIO/'
  --exclude='client-docs/'
  --exclude='reports/'
  --exclude='dogfood-output/'
  --exclude='prototype/'
  --exclude='tests/'
)

rsync -az --delete --info=progress2 \
  "${EXCLUDES[@]}" \
  ./ root@101.201.151.30:/opt/oecd-icio-analysis/
```

不要移除 `.venv311/` 和 `data/` 排除项：前者是线上运行环境，后者包含预计算产物与认证密钥。

### 4. 同步数据（全新部署必做）

先在本地生成完整预计算产物，再同步到全新服务器：

```bash
uv run gvcsim compute
ssh root@101.201.151.30 'mkdir -p /opt/oecd-icio-analysis/data/processed /opt/oecd-icio-analysis/data/shocks'

rsync -az --delete data/processed/ \
  root@101.201.151.30:/opt/oecd-icio-analysis/data/processed/
rsync -az --delete data/shocks/ \
  root@101.201.151.30:/opt/oecd-icio-analysis/data/shocks/
```

新增或替换原始 ICIO 年份时再同步大文件：

```bash
rsync -az --delete OECD_ICIO/ \
  root@101.201.151.30:/opt/oecd-icio-analysis/OECD_ICIO/
```

### 5. 重建教学库、启动并验证

先用 `systemctl cat gvcsim-api.service` 确认服务实际加载的环境文件；下例假定为
`/etc/gvcsim.env`。该步骤会删除现有教学表并重新播种演示账号，符合本轮全新部署策略。

```bash
ssh root@101.201.151.30 '
  set -euo pipefail
  cd /opt/oecd-icio-analysis
  ENV_FILE=/etc/gvcsim.env  # 按实际 service 单元调整
  test -r "$ENV_FILE"
  set -a; . "$ENV_FILE"; set +a
  : "${GVCSIM_PG_DSN:?必须使用 gvcsim-api.service 的真实 DSN}"

  .venv311/bin/gvcsim classroom-init --reset
  psql --dbname="$GVCSIM_PG_DSN" -v ON_ERROR_STOP=1 -Atc \
    "SELECT count(*) FROM step_progress;" | grep -qx 0
  psql --dbname="$GVCSIM_PG_DSN" -v ON_ERROR_STOP=1 -Atc \
    "SELECT count(*) FROM schema_migrations WHERE id='\''2026_course_16_reset_progress'\'';" | grep -qx 1

  nginx -t
  systemctl start gvcsim-api.service
  systemctl reload nginx
  systemctl is-active gvcsim-api.service
'
```

失败时保持 API 停止，修复配置或依赖后重新执行第 3–5 步；不恢复旧数据库。

本次重构不改变 WWZ/WWYZ/网络指标算法；但由于采用全新部署，仍须同步完整
`data/processed/` 与 `data/shocks/`，不能依赖旧服务器残留产物。

公网冒烟检查：

```bash
set -euo pipefail
BASE=http://101.201.151.30:6363
GVCSIM_STUDENT_PASSWORD=${GVCSIM_STUDENT_PASSWORD:-gvclab2026}

curl -fsSI "$BASE/"
curl -fsSI "$BASE/docs"

TOKEN=$(curl -fsS \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"student\",\"password\":\"$GVCSIM_STUDENT_PASSWORD\"}" \
  "$BASE/api/auth/login" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/auth/me"
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/meta"

STEPS=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/steps")
printf '%s' "$STEPS" | python3 -c '
import json, sys
body = json.load(sys.stdin)
assert [row["n"] for row in body["steps"]] == list(range(1, 17))
assert [row.get("regression_outcome") for row in body["steps"][11:15]] == ["trade", "production", "length", "network"]
assert body["steps"][15]["lab"] == "rep"
'

curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/regression/design?outcome=trade" \
  | python3 -c 'import json,sys; assert json.load(sys.stdin)["outcome"] == "trade"'

curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"outcome":"trade","granularity":"国家级"}' \
  "$BASE/api/regression/run" \
  | python3 -c 'import json,sys; body=json.load(sys.stdin); assert body["design"]["outcome"] == "trade" and body["result"]["coefs"]'

OLD_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/regression/design?outcome=trade&step=12")
test "$OLD_STATUS" = 422
```

## 运维命令

```bash
# 服务状态与日志
ssh root@101.201.151.30 'systemctl status gvcsim-api.service --no-pager -l'
ssh root@101.201.151.30 'journalctl -u gvcsim-api.service -f'

# PostgreSQL
ssh root@101.201.151.30 'systemctl status postgresql --no-pager'

# 端口
ssh root@101.201.151.30 "ss -ltnp | grep -E ':(6363|18000)'"
```

若 Python 依赖发生变化，不要直接覆盖 `.venv311`；先在服务器验证兼容环境，再切换 systemd 的 `ExecStart`。数据库连接信息通过 `GVCSIM_PG_DSN` 注入，不要把密码写入本文档。
