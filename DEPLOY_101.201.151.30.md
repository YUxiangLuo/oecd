# 101.201.151.30 部署指南

## 当前环境

| 项目 | 值 |
|---|---|
| 访问地址 | `http://101.201.151.30:6363/` |
| API 文档 | `http://101.201.151.30:6363/docs` |
| 部署来源 | `cc` @ `ef09cbb` |
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

### 2. 同步应用代码

```bash
EXCLUDES=(
  --exclude='.git/'
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

### 3. 按需同步数据

只有指标口径、冲击、控制变量或原始数据发生变化时才执行：

```bash
uv run gvcsim compute

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

### 4. 重启并验证

```bash
ssh root@101.201.151.30 '
  set -e
  systemctl restart gvcsim-api.service
  nginx -t
  systemctl reload nginx
  systemctl is-active gvcsim-api.service
'
```

公网冒烟检查：

```bash
set -euo pipefail
BASE=http://101.201.151.30:6363

curl -fsSI "$BASE/"
curl -fsSI "$BASE/docs"

TOKEN=$(curl -fsS \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"student\",\"password\":\"$GVCSIM_STUDENT_PASSWORD\"}" \
  "$BASE/api/auth/login" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/auth/me"
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/meta"
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
