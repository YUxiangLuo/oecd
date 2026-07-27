"""全局路径与常量配置。所有模块统一从这里取路径,避免各自写死。"""

import os
from pathlib import Path

# 仓库根目录(gvcsim/ 的上一级)
ROOT = Path(__file__).resolve().parent.parent

# 原始 OECD ICIO 数据(pymrio 下载的 ICIO2023_<year>.csv)
RAW_DATA_DIR = ROOT / "OECD_ICIO"

# 预计算产物:面板指标 CSV、质检 JSON、网络指标等
PROCESSED_DIR = ROOT / "data" / "processed"

# 政策冲击数据(关税/制裁/出口管制清单)
SHOCKS_DIR = ROOT / "data" / "shocks"

# 自动生成的实验报告
REPORTS_DIR = ROOT / "reports"

# 运行环境。生产环境必须显式提供所有安全配置；开发环境可通过
# ``GVCSIM_DEMO_MODE=1`` 主动开启演示账号/数据库故障回退。
APP_ENV = os.environ.get("GVCSIM_ENV", "development").strip().lower()
IS_PRODUCTION = APP_ENV in {"production", "prod"}
DEMO_MODE = os.environ.get("GVCSIM_DEMO_MODE", "0").strip().lower() in {"1", "true", "yes", "on"}

# 教学数据库连接串不再包含仓库内默认凭证。空字符串会由数据库层转换成
# 可读的 503/fail-closed，而不会悄悄连接某个开发者账号。
PG_DSN = os.environ.get("GVCSIM_PG_DSN", "").strip()

# PostgreSQL 每个 API worker 使用独立的同步连接池。生产推荐 16 workers ×
# 4 connections = 最多 64 个应用连接，给 100 个学生留下足够吞吐，同时不会
# 打穿 PostgreSQL 默认的连接预算。池满时有界等待，禁止无界堆积请求。
DB_POOL_MIN_SIZE = int(os.environ.get("GVCSIM_DB_POOL_MIN_SIZE", "1"))
DB_POOL_MAX_SIZE = int(os.environ.get("GVCSIM_DB_POOL_MAX_SIZE", "4"))
DB_POOL_TIMEOUT_SECONDS = float(os.environ.get("GVCSIM_DB_POOL_TIMEOUT_SECONDS", "5"))
DB_POOL_MAX_WAITING = int(os.environ.get("GVCSIM_DB_POOL_MAX_WAITING", "64"))
DB_POOL_MAX_LIFETIME_SECONDS = float(os.environ.get("GVCSIM_DB_POOL_MAX_LIFETIME_SECONDS", "1800"))
DB_POOL_MAX_IDLE_SECONDS = float(os.environ.get("GVCSIM_DB_POOL_MAX_IDLE_SECONDS", "300"))
DB_CONNECT_TIMEOUT_SECONDS = int(os.environ.get("GVCSIM_DB_CONNECT_TIMEOUT_SECONDS", "3"))
DB_STATEMENT_TIMEOUT_MS = int(os.environ.get("GVCSIM_DB_STATEMENT_TIMEOUT_MS", "120000"))

# FastAPI 的同步端点在线程池中运行。每 worker 限制线程令牌，配合连接池形成
# 两级背压；worker 数量由 gvcsim serve / systemd 决定。
THREAD_TOKENS = int(os.environ.get("GVCSIM_THREAD_TOKENS", "16"))

# 回归、安慰剂与报告复估是 CPU 密集路径。fcntl 槽在同一台服务器的所有
# Uvicorn worker 之间共享；队列满或等待超时会返回带 Retry-After 的 429。
RUNTIME_DIR = Path(os.environ.get("GVCSIM_RUNTIME_DIR", str(ROOT / "data" / "runtime")))
CPU_CONCURRENCY = int(os.environ.get("GVCSIM_CPU_CONCURRENCY", "16"))
CPU_QUEUE_SIZE = int(os.environ.get("GVCSIM_CPU_QUEUE_SIZE", "128"))
CPU_ACQUIRE_TIMEOUT_SECONDS = float(os.environ.get("GVCSIM_CPU_ACQUIRE_TIMEOUT_SECONDS", "90"))
CPU_RETRY_AFTER_SECONDS = int(os.environ.get("GVCSIM_CPU_RETRY_AFTER_SECONDS", "3"))
REGRESSION_CPU_PERMITS = int(os.environ.get("GVCSIM_REGRESSION_CPU_PERMITS", "1"))
PLACEBO_CPU_PERMITS = int(os.environ.get("GVCSIM_PLACEBO_CPU_PERMITS", "2"))
REPORT_CPU_PERMITS = int(os.environ.get("GVCSIM_REPORT_CPU_PERMITS", "2"))

# 只在显式 demo 模式播种演示账号。生产启动校验会拒绝 demo 模式和空值。
BOOTSTRAP_PASSWORD = os.environ.get("GVCSIM_BOOTSTRAP_PASSWORD", "")
AUTH_SECRET = os.environ.get("GVCSIM_AUTH_SECRET", "")
EVIDENCE_SECRET = os.environ.get("GVCSIM_EVIDENCE_SECRET", "")
# 访问令牌有效期上限。一轮完整实验要跑四次服务端回归,原先 1 小时的上限会让
# 学生在课中被登出;令牌可撤销(登出)且服务端有会话表逐请求复查账号状态,因此
# 放宽到 2 小时。上限只定义在这里,auth.py 签发时复用同一常量,避免两处漂移。
MAX_TOKEN_TTL_SECONDS = 7200
TOKEN_TTL_SECONDS = int(os.environ.get("GVCSIM_TOKEN_TTL_SECONDS", "1800"))
LOGIN_WINDOW_SECONDS = int(os.environ.get("GVCSIM_LOGIN_WINDOW_SECONDS", "300"))
LOGIN_MAX_ATTEMPTS = int(os.environ.get("GVCSIM_LOGIN_MAX_ATTEMPTS", "8"))
_origins_raw = os.environ.get("GVCSIM_ALLOWED_ORIGINS", "")
ALLOWED_ORIGINS = [item.strip() for item in _origins_raw.split(",") if item.strip()]


class ConfigurationError(RuntimeError):
    """缺少会导致认证/持久化降级的安全配置。"""


def validate_capacity_config() -> None:
    """拒绝会造成连接风暴、无界排队或永远无法获准的并发配置。"""
    if DB_POOL_MIN_SIZE < 0 or DB_POOL_MAX_SIZE <= 0 or DB_POOL_MIN_SIZE > DB_POOL_MAX_SIZE:
        raise ConfigurationError("数据库连接池必须满足 0 <= min_size <= max_size")
    if DB_POOL_TIMEOUT_SECONDS <= 0 or DB_POOL_MAX_WAITING <= 0:
        raise ConfigurationError("数据库连接池 timeout/max_waiting 必须为正数")
    if DB_CONNECT_TIMEOUT_SECONDS <= 0 or DB_STATEMENT_TIMEOUT_MS <= 0:
        raise ConfigurationError("数据库 connect/statement timeout 必须为正数")
    if DB_POOL_MAX_LIFETIME_SECONDS <= 0 or DB_POOL_MAX_IDLE_SECONDS <= 0:
        raise ConfigurationError("数据库连接池 lifetime/idle 必须为正数")
    if THREAD_TOKENS <= 0:
        raise ConfigurationError("GVCSIM_THREAD_TOKENS 必须为正数")
    if CPU_CONCURRENCY <= 0 or CPU_QUEUE_SIZE < CPU_CONCURRENCY:
        raise ConfigurationError("CPU 队列必须至少容纳全部运行槽")
    if CPU_ACQUIRE_TIMEOUT_SECONDS <= 0 or CPU_RETRY_AFTER_SECONDS <= 0:
        raise ConfigurationError("CPU 排队 timeout/retry-after 必须为正数")
    for name, permits in (
        ("GVCSIM_REGRESSION_CPU_PERMITS", REGRESSION_CPU_PERMITS),
        ("GVCSIM_PLACEBO_CPU_PERMITS", PLACEBO_CPU_PERMITS),
        ("GVCSIM_REPORT_CPU_PERMITS", REPORT_CPU_PERMITS),
    ):
        if permits <= 0 or permits > CPU_CONCURRENCY:
            raise ConfigurationError(f"{name} 必须在 1..GVCSIM_CPU_CONCURRENCY 之间")


def validate_security_config() -> None:
    """生产配置 fail-closed；在服务启动或首次安全操作时调用。"""
    validate_capacity_config()
    if not PG_DSN:
        raise ConfigurationError("缺少 GVCSIM_PG_DSN；教学数据库和认证不可用")
    if TOKEN_TTL_SECONDS <= 0 or TOKEN_TTL_SECONDS > MAX_TOKEN_TTL_SECONDS:
        raise ConfigurationError(f"GVCSIM_TOKEN_TTL_SECONDS 必须在 1..{MAX_TOKEN_TTL_SECONDS} 秒之间")
    if LOGIN_WINDOW_SECONDS <= 0 or LOGIN_MAX_ATTEMPTS <= 0:
        raise ConfigurationError("登录限流窗口和次数必须为正数")
    if IS_PRODUCTION:
        if DEMO_MODE:
            raise ConfigurationError("生产环境禁止 GVCSIM_DEMO_MODE")
        if not AUTH_SECRET or len(AUTH_SECRET.encode()) < 32:
            raise ConfigurationError("生产环境必须提供至少 32 字节的 GVCSIM_AUTH_SECRET")
        if not EVIDENCE_SECRET or len(EVIDENCE_SECRET.encode()) < 32:
            raise ConfigurationError("生产环境必须提供至少 32 字节的 GVCSIM_EVIDENCE_SECRET")
        # 空列表表示只允许同源请求，不安装宽松的跨域来源；这是安全默认值。


def available_years(raw_dir: Path = RAW_DATA_DIR) -> list[int]:
    """扫描本地已下载的原始数据年份(升序、去重)。"""
    years = set()
    for f in raw_dir.glob("ICIO*_*.csv"):
        try:
            years.add(int(f.stem.rsplit("_", 1)[1]))
        except ValueError:
            continue
    return sorted(years)


def processed_years() -> list[int]:
    """返回当前产物契约登记的完整指标年份。"""
    from gvcsim.artifacts import current_artifact_years

    if not any(PROCESSED_DIR.glob("indicators_country_*.csv")):
        return []
    return current_artifact_years(PROCESSED_DIR)
