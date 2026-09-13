"""全局路径与常量配置。所有模块统一从这里取路径,避免各自写死。"""

import os
from pathlib import Path

# 仓库根目录(gvcsim/ 的上一级)
ROOT = Path(__file__).resolve().parent.parent


class ConfigurationError(RuntimeError):
    """缺少或无效且会导致认证、持久化或容量边界降级的配置。"""


def _positive_int_setting(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as error:
        raise ConfigurationError(f"{name} 必须为正整数") from error
    if value <= 0:
        raise ConfigurationError(f"{name} 必须为正整数")
    return value


# 原始数据和持久产物在本地开发时沿用仓库内目录；生产部署显式指向
# /opt/gvcsim/shared，避免代码换版覆盖数据。
_raw_data_dir_setting = os.environ.get("GVCSIM_RAW_DATA_DIR", "").strip()
_data_dir_setting = os.environ.get("GVCSIM_DATA_DIR", "").strip()
RAW_DATA_DIR = Path(_raw_data_dir_setting or ROOT / "OECD_ICIO").resolve()
DATA_DIR = Path(_data_dir_setting or ROOT / "data").resolve()

# 预计算产物:面板指标 CSV、质检 JSON、网络指标等
PROCESSED_DIR = DATA_DIR / "processed"

# 自动生成的实验报告
REPORTS_DIR = ROOT / "reports"

# 运行环境。生产环境必须显式提供所有安全配置；开发环境可通过
# ``GVCSIM_DEMO_MODE=1`` 只在空数据库初始化时创建演示账号。
APP_ENV = os.environ.get("GVCSIM_ENV", "development").strip().lower()
IS_PRODUCTION = APP_ENV in {"production", "prod"}
DEMO_MODE = os.environ.get("GVCSIM_DEMO_MODE", "0").strip().lower() in {"1", "true", "yes", "on"}

# 教学数据库连接串不再包含仓库内默认凭证。空字符串会由数据库层转换成
# 可读的 503/fail-closed，而不会悄悄连接某个开发者账号。
PG_DSN = os.environ.get("GVCSIM_PG_DSN", "").strip()

THREAD_TOKENS = _positive_int_setting("GVCSIM_THREAD_TOKENS", 16)
LOGIN_ATTEMPTS_PER_MINUTE = _positive_int_setting("GVCSIM_LOGIN_ATTEMPTS_PER_MINUTE", 10)
LOGIN_SOURCE_ATTEMPTS_PER_MINUTE = _positive_int_setting("GVCSIM_LOGIN_SOURCE_ATTEMPTS_PER_MINUTE", 120)
REGRESSION_RUNS_PER_MINUTE = _positive_int_setting("GVCSIM_REGRESSION_RUNS_PER_MINUTE", 12)
PLACEBO_RUNS_PER_MINUTE = _positive_int_setting("GVCSIM_PLACEBO_RUNS_PER_MINUTE", 4)

# 课程内容发布边界；数据库 schema 可保持不变，但学习记录不能跨学期复用。
COURSE_RELEASE = "2026-fall-15-step-economics-v2"
COURSE_TERM = "2026 秋"

# 只在显式 demo 模式播种演示账号。生产启动校验会拒绝 demo 模式和空值。
BOOTSTRAP_PASSWORD = os.environ.get("GVCSIM_BOOTSTRAP_PASSWORD", "")
AUTH_SECRET = os.environ.get("GVCSIM_AUTH_SECRET", "")
TOKEN_TTL_SECONDS = _positive_int_setting("GVCSIM_TOKEN_TTL_SECONDS", 30 * 24 * 60 * 60)
_origins_raw = os.environ.get("GVCSIM_ALLOWED_ORIGINS", "")
ALLOWED_ORIGINS = [item.strip() for item in _origins_raw.split(",") if item.strip()]


def validate_capacity_config() -> None:
    """Validate worker and request-capacity settings."""
    positive_settings = {
        "GVCSIM_THREAD_TOKENS": THREAD_TOKENS,
        "GVCSIM_LOGIN_ATTEMPTS_PER_MINUTE": LOGIN_ATTEMPTS_PER_MINUTE,
        "GVCSIM_LOGIN_SOURCE_ATTEMPTS_PER_MINUTE": LOGIN_SOURCE_ATTEMPTS_PER_MINUTE,
        "GVCSIM_REGRESSION_RUNS_PER_MINUTE": REGRESSION_RUNS_PER_MINUTE,
        "GVCSIM_PLACEBO_RUNS_PER_MINUTE": PLACEBO_RUNS_PER_MINUTE,
    }
    invalid = [name for name, value in positive_settings.items() if value <= 0]
    if invalid:
        raise ConfigurationError("以下容量配置必须为正整数:" + "、".join(invalid))


def validate_security_config() -> None:
    """生产配置 fail-closed；在服务启动或首次安全操作时调用。"""
    validate_capacity_config()
    if not PG_DSN:
        raise ConfigurationError("缺少 GVCSIM_PG_DSN；教学数据库和认证不可用")
    if TOKEN_TTL_SECONDS <= 0:
        raise ConfigurationError("GVCSIM_TOKEN_TTL_SECONDS 必须为正数")
    if IS_PRODUCTION:
        if DEMO_MODE:
            raise ConfigurationError("生产环境禁止 GVCSIM_DEMO_MODE")
        if "change_me" in PG_DSN.casefold():
            raise ConfigurationError("生产环境 GVCSIM_PG_DSN 仍包含部署占位符")
        if "change_me" in AUTH_SECRET.casefold():
            raise ConfigurationError("生产环境 GVCSIM_AUTH_SECRET 仍包含部署占位符")
        if not AUTH_SECRET or len(AUTH_SECRET.encode()) < 32:
            raise ConfigurationError("生产环境必须提供至少 32 字节的 GVCSIM_AUTH_SECRET")
        if not _data_dir_setting or not _raw_data_dir_setting:
            raise ConfigurationError("生产环境必须显式配置 GVCSIM_DATA_DIR 和 GVCSIM_RAW_DATA_DIR")
        configured_paths = (Path(_data_dir_setting), Path(_raw_data_dir_setting))
        if any(
            not path.is_absolute() or path.resolve() == ROOT or ROOT in path.resolve().parents
            for path in configured_paths
        ):
            raise ConfigurationError("生产数据目录必须是代码目录之外的绝对路径")
        # 空列表表示只允许同源请求，不安装宽松的跨域来源；这是安全默认值。


def available_years(raw_dir: Path = RAW_DATA_DIR) -> list[int]:
    """扫描本地原始年份，并拒绝同年多个候选来源。"""
    from gvcsim.data.raw_icio import discover_years

    return discover_years(raw_dir)


def processed_years() -> list[int]:
    """扫描固定目录中五类年度产物都完整的年份。"""
    from gvcsim.artifacts import current_artifact_years

    if not any(PROCESSED_DIR.glob("indicators_country_*.csv")):
        return []
    return current_artifact_years(PROCESSED_DIR)
