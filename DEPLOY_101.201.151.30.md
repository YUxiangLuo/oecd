# 101.201.151.30 部署指南

## 当前拓扑

| 项目 | 值 |
|---|---|
| 访问地址 | `http://101.201.151.30:6363/` |
| API 文档 | `http://101.201.151.30:6363/docs` |
| 应用目录 | `/opt/oecd-icio-analysis` |
| API 服务 | `gvcsim-api.service` → `127.0.0.1:18000` |
| Python 环境 | `/opt/oecd-icio-analysis/.venv`（Python 3.13） |
| 前端目录 | `/opt/oecd-icio-analysis/frontend/dist` |
| 环境文件 | `/etc/gvcsim.env`（权限 `600`） |
| 教学数据库 | 本机 PostgreSQL，数据库 `gvclab` |

nginx 在 `6363` 端口提供前端并反向代理 API。当前入口是 HTTP，承载正式账号或敏感数据前应配置 HTTPS。

## 日常更新

日常更新保留 `OECD_ICIO/`、`data/`、`reports/` 和 PostgreSQL 教学数据，不执行
`classroom-init --reset`。

### 1. 本地检查与构建

```bash
git switch cc
git pull --ff-only origin cc
git status --short --branch

uv sync --locked --group dev
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

### 2. 同步应用

```bash
SERVER=root@101.201.151.30
APP=/opt/oecd-icio-analysis

ssh "$SERVER" 'systemctl stop gvcsim-api.service'

rsync -az --delete \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='.venv/' \
  --exclude='.env*' \
  --exclude='.pi-subagents/' \
  --exclude='AGENTS.md' \
  --exclude='CLAUDE.md' \
  --exclude='frontend/node_modules/' \
  --exclude='frontend/.vite/' \
  --exclude='frontend/playwright-report/' \
  --exclude='frontend/test-results/' \
  --exclude='frontend/e2e/' \
  --exclude='frontend/playwright.config.ts' \
  --exclude='*.tsbuildinfo' \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  --exclude='.pytest_cache/' \
  --exclude='.ruff_cache/' \
  --exclude='.mypy_cache/' \
  --exclude='.coverage' \
  --exclude='data/' \
  --exclude='OECD_ICIO/' \
  --exclude='reports/' \
  --exclude='dogfood-output/' \
  --exclude='tests/' \
  ./ "$SERVER:$APP/"
```

`frontend/dist/` 会随应用同步；本地缓存、测试文件、密钥和运行数据不会上传。

### 3. 同步预计算数据（仅数据或算法变化时）

```bash
uv run gvcsim compute

rsync -az --delete data/processed/ \
  "$SERVER:$APP/data/processed/"
rsync -az --delete data/shocks/ \
  "$SERVER:$APP/data/shocks/"
```

网络算法或产物 schema 变化时必须同步完整 `data/processed/`，不能混用旧 CSV。

### 4. 更新依赖并启动

```bash
ssh "$SERVER" '
  set -euo pipefail
  cd /opt/oecd-icio-analysis
  set -a; . /etc/gvcsim.env; set +a

  uv sync --locked
  .venv/bin/gvcsim classroom-init

  systemctl daemon-reload
  nginx -t
  systemctl start gvcsim-api.service
  systemctl reload nginx
  systemctl is-active gvcsim-api.service
'
```

若更新失败，保持 API 停止，修复后重新执行同步和启动步骤。

## 部署验证

```bash
BASE=http://101.201.151.30:6363

curl -fsSI "$BASE/"
curl -fsSI "$BASE/docs"

TOKEN=$(curl -fsS \
  -H 'Content-Type: application/json' \
  -d '{"username":"student","password":"gvclab2026"}' \
  "$BASE/api/auth/login" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/meta" \
  | python3 -c '
import json, sys
body = json.load(sys.stdin)
assert body["years"] == [2016, 2017, 2018, 2019, 2020]
assert len(body["countries"]) == 77
assert len(body["sectors"]) == 45
assert body["artifact_contract"] == {
    "schema_version": 2,
    "network_algorithm": "gephi-compatible-directed-unweighted-positive-v1",
}
'
```

浏览器再检查登录、步骤 11 网络指标和步骤 15 网络回归，并确认控制台没有错误。

## 运维与数据重置

```bash
# 服务与日志
ssh root@101.201.151.30 'systemctl status gvcsim-api.service --no-pager -l'
ssh root@101.201.151.30 'journalctl -u gvcsim-api.service -f'

# 仅在明确要求清空课堂数据时执行
ssh root@101.201.151.30 '
  cd /opt/oecd-icio-analysis
  set -a; . /etc/gvcsim.env; set +a
  .venv/bin/gvcsim classroom-init --reset
'
```

代码回滚必须与同一算法契约的 `data/processed/` 一起回滚；不要让旧代码读取新产物或反之。
