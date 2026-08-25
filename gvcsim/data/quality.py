"""步骤2:数据质检。

每个检查返回 QcCheck(可序列化),供 CLI 打印和 API 前端渲染共用。
检查内容覆盖 ICIO 原始矩阵、政策冲击面板与国家-年份控制变量:
维度/索引、缺失值/负值、原始 OUT 双侧会计恒等式、VA/TLS 定义域、
里昂惕夫系统数值稳定性、国家/行业覆盖范围及控制变量 schema/范围。
"""

from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd
from scipy.sparse.linalg import eigs

from gvcsim.data.controls import ALL_CONTROL_COLUMNS
from gvcsim.shock_catalog import (
    EXPOSURE_MODES,
    EXPOSURE_SOURCE_OECD_ICIO,
    EXPOSURE_SOURCE_STYLIZED,
    EXPOSURE_SOURCES,
    SHOCK_FIELD_SPECS,
    STYLIZED_EXPOSURE_DISCLOSURE,
)

# OECD 宽表以 Million USD、四位小数发布。小规模部门汇总数千个舍入单元格时，
# 单看相对误差会被分母放大，因此只有绝对与缩放相对误差同时越界才判 fatal。
ACCOUNT_REL_TOLERANCE = 0.01
ACCOUNT_ABS_TOLERANCE = 1.0
ACCOUNT_RELATIVE_FLOOR = 1.0

LEONTIEF_RESIDUAL_TOLERANCE = 1e-8
LEONTIEF_NEGATIVE_TOLERANCE = 1e-10
LEONTIEF_RHO_WARNING = 0.98
LEONTIEF_RHO_FATAL_MARGIN = 1e-10
LEONTIEF_CONDITION_WARNING = 1e8
LEONTIEF_CONDITION_FATAL = 1e12
# 关键国家:缺了说明解析出了问题
KEY_REGIONS = ["CHN", "USA", "JPN", "DEU"]

SHOCK_VALUE_PAIRS = [(spec["shock_field"], spec["treated_field"]) for spec in SHOCK_FIELD_SPECS.values()]

SHOCK_EVENT_COLUMNS = [
    (
        spec["shock_field"],
        spec["announced_date_field"],
        spec["effective_date_field"],
        spec["note_field"],
    )
    for spec in SHOCK_FIELD_SPECS.values()
]

SHOCK_COLUMNS = [
    "country",
    "sector",
    "year",
    "shock_type",
    *(field for spec in SHOCK_FIELD_SPECS.values() for field in spec.values()),
    "tariff_exposure_source",
    "tariff_exposure_mode",
    "tariff_exposure_disclosure",
]

CONTROL_REQUIRED_COLUMNS = ["country", "year", *ALL_CONTROL_COLUMNS]

QC_OK = "ok"
QC_DISCLOSURE = "disclosure"
QC_WARNING = "warning"
QC_FATAL = "fatal"
QC_SEVERITIES = (QC_OK, QC_DISCLOSURE, QC_WARNING, QC_FATAL)

QC_CONTRACT_VERSION = 2
QC_SCOPE_ICIO = "icio"
QC_SCOPE_CONTROLS = "controls"
QC_SCOPE_SHOCKS = "shocks"
QC_EXPECTED_CHECKS: dict[str, tuple[str, ...]] = {
    QC_SCOPE_ICIO: (
        "维度一致性与索引对齐(Z/Y/A/L/x/OUT)",
        "缺失值 / 负值检查",
        "会计恒等式(原始OUT = Z行和 + Y行和)",
        "因子投入与派生指标定义域(VA/TLS)",
        "投入侧恒等式(原始OUT = Z列和 + VA + TLS)",
        "里昂惕夫逆矩阵数值稳定性(残差/谱半径/条件数/非负性)",
        "国家/行业覆盖范围",
    ),
    QC_SCOPE_CONTROLS: (
        "控制变量 schema(country/year + 控制列)",
        "控制变量维度对齐(country×year)",
        "控制变量数值有限性",
        "控制变量构造恒等式",
        "控制变量经济范围",
    ),
    QC_SCOPE_SHOCKS: (
        "冲击面板维度对齐(country×sector×year)",
        "冲击强度值域(*_shock ∈ [0,0.5])",
        "冲击事件时间线(宣布日≤生效日)",
        "treated 标记与阈值一致",
        "关税处理组覆盖比例合理性（制裁/出口管制仅描述）",
        "关税出口暴露度来源与口径",
    ),
}
QC_FAILURE_SEVERITIES: dict[str, dict[str, str]] = {
    scope: {
        name: (QC_WARNING if scope == QC_SCOPE_ICIO and name == "因子投入与派生指标定义域(VA/TLS)" else QC_FATAL)
        for name in names
    }
    for scope, names in QC_EXPECTED_CHECKS.items()
}


def qc_contract_metadata() -> dict:
    """Return the versioned exact-set and failure-severity contract for every release."""
    return {
        "version": QC_CONTRACT_VERSION,
        "scopes": {
            scope: [{"name": name, "failure_severity": QC_FAILURE_SEVERITIES[scope][name]} for name in names]
            for scope, names in QC_EXPECTED_CHECKS.items()
        },
    }


def validate_qc_contract_metadata(value: object) -> None:
    """Reject unsupported or incomplete release QC contracts."""
    if not isinstance(value, dict) or type(value.get("version")) is not int or value != qc_contract_metadata():
        raise ValueError(f"不支持或不完整的 QC contract；需要版本 {QC_CONTRACT_VERSION}")


def validate_serialized_checks(
    checks: object,
    *,
    scope: str,
    contract_version: int = QC_CONTRACT_VERSION,
) -> list[dict]:
    """Validate one serialized QC scope against the current release contract."""
    if type(contract_version) is not int or contract_version != QC_CONTRACT_VERSION:
        raise ValueError(f"不支持的 QC contract 版本:{contract_version}")
    expected = QC_EXPECTED_CHECKS.get(scope)
    if expected is None:
        raise ValueError(f"未知 QC scope:{scope}")
    if not isinstance(checks, list) or not checks:
        raise ValueError(f"{scope} QC 结果必须是非空数组")

    required_types = {
        "name": str,
        "kind": str,
        "passed": bool,
        "detail": str,
        "warnings": list,
        "severity": str,
    }
    names: list[str] = []
    validated: list[dict] = []
    for index, raw in enumerate(checks):
        if not isinstance(raw, dict):
            raise ValueError(f"{scope} QC 第 {index + 1} 项必须是对象")
        for field_name, field_type in required_types.items():
            if field_name not in raw or type(raw[field_name]) is not field_type:
                raise ValueError(f"{scope} QC 第 {index + 1} 项字段 {field_name} 无效")
        name = raw["name"]
        kind = raw["kind"]
        detail = raw["detail"]
        warnings = raw["warnings"]
        passed = raw["passed"]
        severity = raw["severity"]
        if not name or not kind or not isinstance(detail, str):
            raise ValueError(f"{scope} QC 第 {index + 1} 项文本字段无效")
        if any(type(warning) is not str for warning in warnings):
            raise ValueError(f"{scope} QC 第 {index + 1} 项 warnings 无效")
        if severity not in QC_SEVERITIES:
            raise ValueError(f"{scope} QC 第 {index + 1} 项 severity 无效:{severity}")
        expected_severity = QC_DISCLOSURE if passed and warnings else QC_OK if passed else severity
        if passed and severity != expected_severity:
            raise ValueError(f"{scope} QC 第 {index + 1} 项 passed/severity 矛盾")
        if not passed and severity not in (QC_WARNING, QC_FATAL):
            raise ValueError(f"{scope} QC 第 {index + 1} 项 passed/severity 矛盾")
        allowed_failure_severity = QC_FAILURE_SEVERITIES[scope].get(name)
        if not passed and allowed_failure_severity is not None and severity != allowed_failure_severity:
            raise ValueError(f"{scope} QC 第 {index + 1} 项失败严重度必须为 {allowed_failure_severity}")
        names.append(name)
        validated.append(raw)

    if len(names) != len(set(names)):
        raise ValueError(f"{scope} QC 检查项重复")
    missing = sorted(set(expected) - set(names))
    unknown = sorted(set(names) - set(expected))
    if missing or unknown or len(names) != len(expected):
        raise ValueError(f"{scope} QC 检查项不完整；missing={missing}, unknown={unknown}")
    return validated


@dataclass
class QcCheck:
    name: str  # 质检项名称
    kind: str  # 类型(结构 / 数值 / 经济含义)
    passed: bool
    detail: str = ""
    warnings: list[str] = field(default_factory=list)
    # 该检查失败时的严重度。fatal 会阻断产物发布；warning 只有在显式
    # 接受并披露后才能继续。通过但仍带 warnings 的检查会序列化为 disclosure。
    severity: str = QC_FATAL

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["severity"] = self.effective_severity
        return payload

    @property
    def effective_severity(self) -> str:
        if not self.passed:
            return self.severity
        return QC_DISCLOSURE if self.warnings else QC_OK


def summarize_checks(checks: list[QcCheck], *, override: bool = False) -> dict:
    """把一组检查归纳为可机器执行、也可持续披露的发布结论。"""
    if type(override) is not bool:
        raise ValueError("QC override 必须是布尔值")
    if not checks:
        raise ValueError("QC 结果不能为空")
    by_severity: dict[str, list[str]] = {level: [] for level in QC_SEVERITIES}
    for check in checks:
        by_severity[check.effective_severity].append(check.name)
    fatal = by_severity[QC_FATAL]
    warning = by_severity[QC_WARNING]
    return {
        "publishable": not fatal or override,
        "override": bool(override and fatal),
        "requires_disclosure": bool(fatal or warning or by_severity[QC_DISCLOSURE]),
        "fatal": fatal,
        "warning": warning,
        "disclosure": by_severity[QC_DISCLOSURE],
        "passed": by_severity[QC_OK],
    }


def summarize_serialized_checks(checks: list[dict], *, override: bool = False) -> dict:
    """Rebuild the release summary from the exact QC records written to disk."""
    if type(override) is not bool:
        raise ValueError("QC override 必须是布尔值")
    if not checks:
        raise ValueError("QC 结果不能为空")
    by_severity: dict[str, list[str]] = {level: [] for level in QC_SEVERITIES}
    for check in checks:
        severity = check.get("severity")
        if severity not in by_severity:
            raise ValueError(f"未知 QC severity:{severity}")
        by_severity[severity].append(str(check.get("name") or "未命名检查"))
    fatal = by_severity[QC_FATAL]
    warning = by_severity[QC_WARNING]
    return {
        "publishable": not fatal or override,
        "override": bool(override and fatal),
        "requires_disclosure": bool(fatal or warning or by_severity[QC_DISCLOSURE]),
        "fatal": fatal,
        "warning": warning,
        "disclosure": by_severity[QC_DISCLOSURE],
        "passed": by_severity[QC_OK],
    }


def check_shapes(io) -> QcCheck:
    n = len(io.get_regions()) * len(io.get_sectors())
    expected_shapes = {"Z": (n, n), "A": (n, n), "L": (n, n), "x": (n, 1)}
    bad = []
    for name, expected in expected_shapes.items():
        frame = getattr(io, name, None)
        if frame is None or frame.shape != expected:
            bad.append(f"{name}{getattr(frame, 'shape', None)}≠{expected}")
    if io.Y.shape[0] != n:
        bad.append(f"Y{io.Y.shape} 行数≠{n}")

    index = io.Z.index
    aligned = {"Z列": io.Z.columns, "Y行": io.Y.index}
    for frame_name in ("A", "L", "x"):
        frame = getattr(io, frame_name, None)
        if frame is not None:
            aligned[f"{frame_name}行"] = frame.index
            if frame_name != "x":
                aligned[f"{frame_name}列"] = frame.columns
    for name, other in aligned.items():
        if not index.equals(other):
            bad.append(f"{name}与Z行索引未对齐")

    reported = getattr(io, "reported_output", None)
    if reported is None:
        bad.append("缺少原始 OUT 账户")
    elif not index.equals(reported.index):
        bad.append("原始 OUT 与Z行索引未对齐")

    unit = getattr(io, "unit", None)
    if not isinstance(unit, pd.DataFrame) or unit.empty:
        bad.append("缺少货币单位元数据")
    else:
        units = set(unit.iloc[:, 0].dropna().astype(str))
        if units != {"Million USD"}:
            bad.append(f"货币单位不是唯一的 Million USD: {sorted(units)}")

    return QcCheck(
        name="维度一致性与索引对齐(Z/Y/A/L/x/OUT)",
        kind="结构",
        passed=not bad,
        detail=f"{len(io.get_regions())} 个地区×{len(io.get_sectors())} 个行业={n} 个节点"
        + (f"；异常: {bad}" if bad else f"；Z/A/L={n}×{n},Y={io.Y.shape},索引完全对齐,单位=Million USD"),
    )


def check_missing_and_negative(io) -> QcCheck:
    warnings: list[str] = []
    fatal_problems: list[str] = []
    negative_counts: dict[str, int] = {}
    for name, df in [("Z", io.Z), ("Y", io.Y)]:
        values = df.to_numpy(dtype=float)
        n_nonfinite = int((~np.isfinite(values)).sum())
        n_neg = int((df < 0).sum().sum())
        negative_counts[name] = n_neg
        if n_nonfinite:
            fatal_problems.append(f"{name} 存在 {n_nonfinite} 个 NaN/Inf")

    if negative_counts["Z"]:
        warnings.append(f"Z 存在 {negative_counts['Z']} 个负值，需核实中间投入的调整项口径")
    if negative_counts["Y"]:
        y_negative = io.Y < 0
        categories = io.Y.columns.get_level_values("category") if "category" in io.Y.columns.names else None
        outside_inventory = (
            int(y_negative.loc[:, categories != "INVNT"].sum().sum())
            if categories is not None
            else negative_counts["Y"]
        )
        if outside_inventory == 0:
            warnings.append(f"Y 的 {negative_counts['Y']} 个负值全部位于 INVNT(库存变化)，按账户含义披露")
        else:
            warnings.append(f"Y 存在 {negative_counts['Y']} 个负值，其中 {outside_inventory} 个不在 INVNT，需逐项核实")

    x = io.x.iloc[:, 0].astype(float)
    n_nonfinite_x = int((~np.isfinite(x.to_numpy())).sum())
    if n_nonfinite_x:
        fatal_problems.append(f"总产出 x 存在 {n_nonfinite_x} 个 NaN/Inf")
    n_neg_x = int((x < -LEONTIEF_NEGATIVE_TOLERANCE).sum())
    if n_neg_x > 0:
        fatal_problems.append(f"总产出 x 存在 {n_neg_x} 个负值")

    zero_index = x.index[np.isclose(x.to_numpy(), 0.0, atol=LEONTIEF_NEGATIVE_TOLERANCE)]
    inconsistent_zero = []
    for idx in zero_index:
        activity = (
            float(io.Z.loc[idx].abs().sum()) + float(io.Z.loc[:, idx].abs().sum()) + float(io.Y.loc[idx].abs().sum())
        )
        if activity > LEONTIEF_NEGATIVE_TOLERANCE:
            inconsistent_zero.append(idx)
    if inconsistent_zero:
        fatal_problems.append(f"{len(inconsistent_zero)} 个零产出节点仍有非零交易流")
    elif len(zero_index):
        warnings.append(f"{len(zero_index)} 个零产出节点的 Z 行列与 Y 行均为零，按结构性空节点披露")

    warnings.extend(fatal_problems)
    return QcCheck(
        name="缺失值 / 负值检查",
        kind="数值",
        passed=not fatal_problems,
        detail=(
            f"Z负值 {negative_counts['Z']} 个,Y负值 {negative_counts['Y']} 个,"
            f"x负值 {n_neg_x} 个,x零值 {len(zero_index)} 个"
        ),
        warnings=warnings,
    )


def _reported_output(io) -> pd.Series | None:
    reported = getattr(io, "reported_output", None)
    if reported is None:
        return None
    if isinstance(reported, pd.DataFrame):
        if reported.shape[1] != 1:
            return None
        reported = reported.iloc[:, 0]
    if not isinstance(reported, pd.Series):
        return None
    return pd.to_numeric(reported, errors="coerce").reindex(io.Z.index)


def _accounting_check(name: str, formula: str, computed: pd.Series, reported: pd.Series | None) -> QcCheck:
    if reported is None:
        return QcCheck(
            name=name,
            kind="经济含义",
            passed=False,
            detail="无法读取并对齐 OECD 原始 OUT 账户，不能进行独立对账",
        )

    computed = pd.to_numeric(computed, errors="coerce").reindex(reported.index)
    finite = np.isfinite(computed.to_numpy()) & np.isfinite(reported.to_numpy())
    if not finite.all():
        count = int((~finite).sum())
        return QcCheck(
            name=name,
            kind="经济含义",
            passed=False,
            detail=f"{formula} 对账中存在 {count} 个 NaN/Inf",
        )

    absolute = (computed - reported).abs()
    scaled_relative = absolute / reported.abs().clip(lower=ACCOUNT_RELATIVE_FLOOR)
    bad = (absolute > ACCOUNT_ABS_TOLERANCE) & (scaled_relative > ACCOUNT_REL_TOLERANCE)
    single_threshold = ((absolute > ACCOUNT_ABS_TOLERANCE) | (scaled_relative > ACCOUNT_REL_TOLERANCE)) & ~bad
    warnings = [
        f"{idx}: OUT={reported[idx]:.4f},计算值={computed[idx]:.4f},"
        f"绝对误差={absolute[idx]:.4f},缩放相对误差={scaled_relative[idx]:.4%}"
        for idx in bad[bad].index[:5]
    ]
    if single_threshold.any():
        worst_rounding = scaled_relative[single_threshold].sort_values(ascending=False).head(3)
        warnings.extend(
            f"{idx}: 仅单项容差越界，绝对误差={absolute[idx]:.4f},缩放相对误差={value:.4%}，按舍入/规模效应披露"
            for idx, value in worst_rounding.items()
        )

    return QcCheck(
        name=name,
        kind="经济含义",
        passed=not bad.any(),
        detail=(
            f"{formula};最大绝对误差 {absolute.max():.4f} Million USD,"
            f"最大缩放相对误差 {scaled_relative.max():.4%},双阈值异常 {int(bad.sum())} 个"
        ),
        warnings=warnings,
    )


def check_accounting_identity(io) -> QcCheck:
    """用源文件 OUT 独立复核供给侧恒等式，而不是复核 calc_all 派生的 x。"""
    computed = io.Z.sum(axis=1) + io.Y.sum(axis=1)
    return _accounting_check(
        "会计恒等式(原始OUT = Z行和 + Y行和)",
        "原始OUT = 中间使用行和 + 最终需求行和",
        computed,
        _reported_output(io),
    )


def _factor_frame(io) -> pd.DataFrame | None:
    factor_inputs = getattr(io, "factor_inputs", None)
    frame = getattr(factor_inputs, "F", None)
    return frame if isinstance(frame, pd.DataFrame) else None


def check_factor_inputs(io) -> QcCheck:
    """检查 OECD VA/TLS 账户，并显式披露负 VA 对行业级份额的定义域影响。"""
    frame = _factor_frame(io)
    structural = []
    if frame is None:
        structural.append("缺少 factor_inputs.F")
    elif not frame.index.is_unique:
        structural.append("factor_inputs.F 行索引重复")
    elif not {"VA", "TLS"}.issubset(set(frame.index.astype(str))):
        structural.append("factor_inputs.F 缺少 VA 或 TLS 行")
    elif not frame.columns.is_unique:
        structural.append("factor_inputs.F 列索引重复")

    if structural:
        return QcCheck(
            name="因子投入与派生指标定义域(VA/TLS)",
            kind="经济含义",
            passed=False,
            detail="；".join(structural),
        )

    assert frame is not None
    aligned = frame.reindex(columns=io.Z.index)
    va = pd.to_numeric(aligned.loc["VA"], errors="coerce")
    tls = pd.to_numeric(aligned.loc["TLS"], errors="coerce")
    finite = np.isfinite(va.to_numpy()) & np.isfinite(tls.to_numpy())
    if not finite.all():
        return QcCheck(
            name="因子投入与派生指标定义域(VA/TLS)",
            kind="经济含义",
            passed=False,
            detail=f"VA/TLS 存在 {int((~finite).sum())} 个缺失或非有限值",
        )

    negative_va = va[va < 0].sort_values()
    negative_tls = tls[tls < 0]
    negative_net = (va + tls)[va + tls < 0]
    negative_abs = max(0.0, float(-negative_va.sum()))
    global_va = float(va.sum())
    share = negative_abs / abs(global_va) if global_va else np.nan
    warnings: list[str] = []
    if len(negative_va):
        output = io.x.iloc[:, 0].reindex(va.index)
        col_sums = io.A.sum(axis=0).reindex(va.index)
        warnings.extend(
            f"{idx}: VA={value:.4f},TLS={tls[idx]:.4f},OUT={output[idx]:.4f},"
            f"A列和={col_sums[idx]:.6f};SVA≤0，行业级生产份额必须置空"
            for idx, value in negative_va.head(10).items()
        )
    if len(negative_tls):
        warnings.append(f"TLS 有 {len(negative_tls)} 个负值，表示产品补贴净额，保留符号并披露")
    if len(negative_net):
        warnings.append(f"VA+TLS 为负的节点 {len(negative_net)} 个；这会令相应 A 列和超过 1，但不单独判定矩阵失稳")

    return QcCheck(
        name="因子投入与派生指标定义域(VA/TLS)",
        kind="经济含义",
        passed=len(negative_va) == 0,
        detail=(
            f"VA负值 {len(negative_va)} 个,TLS负值 {len(negative_tls)} 个,VA+TLS负值 {len(negative_net)} 个;"
            f"负VA绝对额/全球VA={share:.6%}"
        ),
        warnings=warnings,
        severity=QC_WARNING,
    )


def check_input_accounting_identity(io) -> QcCheck:
    """复核成本侧恒等式 OUT = 中间投入列和 + VA + TLS。"""
    frame = _factor_frame(io)
    valid = (
        frame is not None
        and frame.index.is_unique
        and frame.columns.is_unique
        and {"VA", "TLS"}.issubset(set(frame.index.astype(str)))
    )
    if not valid:
        return QcCheck(
            name="投入侧恒等式(原始OUT = Z列和 + VA + TLS)",
            kind="经济含义",
            passed=False,
            detail="缺少 VA/TLS，无法执行投入侧独立对账",
        )
    assert frame is not None
    aligned = frame.reindex(columns=io.Z.index)
    computed = io.Z.sum(axis=0) + aligned.loc["VA"] + aligned.loc["TLS"]
    return _accounting_check(
        "投入侧恒等式(原始OUT = Z列和 + VA + TLS)",
        "原始OUT = 中间投入列和 + VA + TLS",
        computed,
        _reported_output(io),
    )


def _spectral_radius(A: np.ndarray) -> float:
    """小矩阵精确求特征值，大矩阵用 ARPACK，避免生产数据上的 O(N³) 分解。"""
    if A.shape[0] <= 64:
        return float(np.max(np.abs(np.linalg.eigvals(A))))
    value = eigs(
        A,
        k=1,
        which="LM",
        return_eigenvectors=False,
        v0=np.ones(A.shape[0]),
        tol=1e-9,
    )[0]
    return float(abs(value))


def check_leontief_inverse(io) -> QcCheck:
    """检查逆矩阵数值正确性、生产系统谱半径、非负性与敏感度。"""
    A = np.asarray(io.A, dtype=float)
    L = np.asarray(io.L, dtype=float)
    if A.ndim != 2 or A.shape[0] != A.shape[1] or L.shape != A.shape:
        return QcCheck(
            name="里昂惕夫逆矩阵数值稳定性(残差/谱半径/条件数/非负性)",
            kind="数值",
            passed=False,
            detail=f"A{A.shape} 与 L{L.shape} 不是同维方阵",
        )
    if not np.isfinite(A).all() or not np.isfinite(L).all():
        return QcCheck(
            name="里昂惕夫逆矩阵数值稳定性(残差/谱半径/条件数/非负性)",
            kind="数值",
            passed=False,
            detail="A 或 L 含 NaN/Inf",
        )

    identity = np.eye(A.shape[0])
    system = identity - A
    max_err = float(np.max(np.abs(system @ L - identity)))
    min_l = float(np.min(L))
    condition_1 = float(np.linalg.norm(system, 1) * np.linalg.norm(L, 1))
    warnings: list[str] = []
    try:
        rho = _spectral_radius(A)
    except Exception as error:  # ARPACK 失败意味着无法完成发布所需的稳定性证明
        return QcCheck(
            name="里昂惕夫逆矩阵数值稳定性(残差/谱半径/条件数/非负性)",
            kind="数值",
            passed=False,
            detail=f"谱半径计算失败: {type(error).__name__}: {error}",
        )

    fatal = []
    if max_err >= LEONTIEF_RESIDUAL_TOLERANCE:
        fatal.append(f"逆残差 {max_err:.2e} 超过 {LEONTIEF_RESIDUAL_TOLERANCE:.0e}")
    if rho >= 1.0 - LEONTIEF_RHO_FATAL_MARGIN:
        fatal.append(f"谱半径 {rho:.6f}≥1，生产系统不满足 Leontief 可行性")
    elif rho >= LEONTIEF_RHO_WARNING:
        warnings.append(f"谱半径 {rho:.6f} 接近 1，冲击可能被显著放大")
    if min_l < -LEONTIEF_NEGATIVE_TOLERANCE:
        fatal.append(f"L 最小值 {min_l:.3e} 为实质负值")
    if not np.isfinite(condition_1) or condition_1 >= LEONTIEF_CONDITION_FATAL:
        fatal.append(f"1-范数条件数 {condition_1:.3e} 过高或非有限")
    elif condition_1 >= LEONTIEF_CONDITION_WARNING:
        warnings.append(f"1-范数条件数 {condition_1:.3e} 较高，需做数值敏感性分析")
    warnings.extend(fatal)

    return QcCheck(
        name="里昂惕夫逆矩阵数值稳定性(残差/谱半径/条件数/非负性)",
        kind="数值",
        passed=not fatal,
        detail=(f"(I-A)L 最大误差 {max_err:.2e},谱半径 {rho:.6f},1-范数条件数 {condition_1:.3e},L最小值 {min_l:.3e}"),
        warnings=warnings,
    )


def check_coverage(io) -> QcCheck:
    regions = set(io.get_regions())
    missing = [r for r in KEY_REGIONS if r not in regions]
    return QcCheck(
        name="国家/行业覆盖范围",
        kind="结构",
        passed=not missing,
        detail=f"{len(regions)} 个国家/地区 × {len(io.get_sectors())} 个行业"
        + (f",缺少关键国家: {missing}" if missing else ""),
    )


def run_all(io) -> list[QcCheck]:
    return [
        check_shapes(io),
        check_missing_and_negative(io),
        check_accounting_identity(io),
        check_factor_inputs(io),
        check_input_accounting_identity(io),
        check_leontief_inverse(io),
        check_coverage(io),
    ]


def check_controls_country(
    controls_df: pd.DataFrame,
    countries: list[str] | None = None,
    years: list[int] | None = None,
) -> list[QcCheck]:
    """国家-年份控制变量产物质检。

    controls_country.csv 是回归面板的重要右表:一旦 schema、维度或数值范围异常,
    DID/FE 控制变量会静默缺失或引入不可解释的尺度问题。因此这里独立检查
    country×year 完整性、数值有限性、构造恒等式和主要取值范围。
    """
    df = controls_df.copy()
    checks: list[QcCheck] = []

    missing_cols = [c for c in CONTROL_REQUIRED_COLUMNS if c not in df.columns]
    extra_cols = [c for c in df.columns if c not in CONTROL_REQUIRED_COLUMNS]
    checks.append(
        QcCheck(
            name="控制变量 schema(country/year + 控制列)",
            kind="结构",
            passed=not missing_cols,
            detail=(
                f"期望 {len(CONTROL_REQUIRED_COLUMNS)} 列,实际 {len(df.columns)} 列;"
                f"缺失 {len(missing_cols)} 列,额外 {len(extra_cols)} 列"
            ),
            warnings=[
                *[f"缺失列:{c}" for c in missing_cols[:8]],
                *[f"额外列:{c}" for c in extra_cols[:5]],
            ],
        )
    )
    if missing_cols:
        return checks

    countries = sorted(countries if countries is not None else df["country"].dropna().unique().tolist())
    years = sorted(int(y) for y in (years if years is not None else df["year"].dropna().unique().tolist()))
    expected = pd.MultiIndex.from_product([countries, years], names=["country", "year"])
    actual = pd.MultiIndex.from_frame(df[["country", "year"]])
    missing = expected.difference(actual)
    extra = actual.difference(expected)
    duplicated = int(actual.duplicated().sum())
    checks.append(
        QcCheck(
            name="控制变量维度对齐(country×year)",
            kind="结构",
            passed=len(missing) == 0 and len(extra) == 0 and duplicated == 0,
            detail=(
                f"期望 {len(expected)} 行,实际 {len(df)} 行;"
                f"缺失组合 {len(missing)} 个,额外组合 {len(extra)} 个,重复组合 {duplicated} 个"
            ),
            warnings=[
                *[f"缺失:{m}" for m in list(missing[:3])],
                *[f"额外:{m}" for m in list(extra[:3])],
            ],
        )
    )

    numeric = df[ALL_CONTROL_COLUMNS].apply(pd.to_numeric, errors="coerce")
    n_missing = int(numeric.isna().sum().sum())
    finite_mask = np.isfinite(numeric.to_numpy(dtype=float))
    n_non_finite = int(finite_mask.size - finite_mask.sum())
    checks.append(
        QcCheck(
            name="控制变量数值有限性",
            kind="数值",
            passed=n_missing == 0 and n_non_finite == 0,
            detail=f"缺失/非数值 {n_missing} 个,非有限值 {n_non_finite} 个",
            warnings=[
                f"{col}: 缺失/非数值 {int(numeric[col].isna().sum())} 个"
                for col in ALL_CONTROL_COLUMNS
                if numeric[col].isna().any()
            ][:6],
        )
    )

    identity_diff = (
        numeric["macro_log_gdp_usd"] - numeric["macro_log_population"] - numeric["macro_log_gdp_per_capita"]
    ).abs()
    max_identity_diff = float(identity_diff.max()) if len(identity_diff) else 0.0
    base = df.assign(_row=np.arange(len(df))).sort_values(["country", "year"])
    first_idx = base.groupby("country", sort=False)["_row"].first().to_numpy()
    base_checks = []
    for col, expected_value in [
        ("trade_gross_exports_index", 1.0),
        ("prod_va_total_index", 1.0),
        ("gdp_deflator", 1.0),
    ]:
        vals = numeric.iloc[first_idx][col]
        bad = int((vals - expected_value).abs().gt(1e-9).sum())
        if bad:
            base_checks.append(f"{col} 首年不等于 {expected_value:g}: {bad} 国")
    checks.append(
        QcCheck(
            name="控制变量构造恒等式",
            kind="经济含义",
            passed=max_identity_diff < 1e-9 and not base_checks,
            detail=f"log GDP - log population - log per capita 最大误差 {max_identity_diff:.2e}",
            warnings=base_checks,
        )
    )

    range_specs = {
        "export_intensity": (0.0, 10.0),
        "manufacturing_va_share": (0.0, 1.0),
        "services_va_share": (0.0, 1.0),
        "trade_gross_exports_index": (0.0, np.inf),
        "prod_va_total_index": (0.0, np.inf),
        "macro_exchange_rate_change": (-0.20, 0.20),
        "macro_fdi_inflow_gdp": (0.0, 0.25),
        "gdp_deflator": (0.0, np.inf),
        "inflation_rate": (0.0, 0.20),
    }
    range_warnings = []
    for col, (lo, hi) in range_specs.items():
        bad = numeric[col].lt(lo) | numeric[col].gt(hi)
        if bad.any():
            range_warnings.append(f"{col} 超出 [{lo:g},{hi:g}] 共 {int(bad.sum())} 行")
    share_sum = numeric["manufacturing_va_share"] + numeric["services_va_share"]
    bad_share_sum = int(share_sum.gt(1.05).sum())
    if bad_share_sum:
        range_warnings.append(f"制造业+服务业份额超过 105% 共 {bad_share_sum} 行")
    checks.append(
        QcCheck(
            name="控制变量经济范围",
            kind="经济含义",
            passed=not range_warnings,
            detail="份额、指数、通胀/汇率/FDI mock 均在预设范围内" if not range_warnings else "存在越界值",
            warnings=range_warnings[:8],
        )
    )

    return checks


def check_shock_panel(
    shock_df: pd.DataFrame,
    countries: list[str],
    sectors: list[str],
    years: list[int],
    treated_threshold: float = 0.001,
) -> list[QcCheck]:
    """政策冲击面板质检。

    目标是补齐步骤11的第二类数据质检:冲击面板必须覆盖完整
    country×sector×year,与 ICIO 指标维度严格对齐,且事件时间线与
    treated 标记可用于 DID / 事件研究。
    """
    df = shock_df.copy()
    checks: list[QcCheck] = []

    missing_cols = [c for c in SHOCK_COLUMNS if c not in df.columns]
    # Keep returning the exact six-check contract even for malformed input. Missing
    # columns become NA so dependent checks fail closed without an ad-hoc check name.
    for column in missing_cols:
        df[column] = pd.NA

    expected = pd.MultiIndex.from_product([countries, sectors, years], names=["country", "sector", "year"])
    actual = pd.MultiIndex.from_frame(df[["country", "sector", "year"]])
    missing = expected.difference(actual)
    extra = actual.difference(expected)
    duplicated = int(actual.duplicated().sum())
    checks.append(
        QcCheck(
            name="冲击面板维度对齐(country×sector×year)",
            kind="结构",
            passed=not missing_cols and len(missing) == 0 and len(extra) == 0 and duplicated == 0,
            detail=(
                f"期望 {len(expected)} 行,实际 {len(df)} 行;"
                f"缺少必要列 {len(missing_cols)} 个,缺失组合 {len(missing)} 个,"
                f"额外组合 {len(extra)} 个,重复组合 {duplicated} 个"
            ),
            warnings=[
                *[f"缺少列:{column}" for column in missing_cols[:8]],
                *[f"缺失:{m}" for m in list(missing[:3])],
                *[f"额外:{m}" for m in list(extra[:3])],
            ],
        )
    )

    present_pairs = SHOCK_VALUE_PAIRS
    missing_values = 0
    out_rows = []
    numeric_shocks = {}
    for shock_col, _treated_col in present_pairs:
        shock = pd.to_numeric(df[shock_col], errors="coerce")
        numeric_shocks[shock_col] = shock
        missing_values += int(shock.isna().sum())
        bad = df[(shock < 0) | (shock > 0.5)].copy()
        if not bad.empty:
            bad["_shock_col"] = shock_col
            out_rows.append(bad)
    out_of_range = pd.concat(out_rows, ignore_index=True) if out_rows else pd.DataFrame()
    checks.append(
        QcCheck(
            name="冲击强度值域(*_shock ∈ [0,0.5])",
            kind="数值",
            passed=missing_values == 0 and out_of_range.empty,
            detail=f"检查 {len(present_pairs)} 类冲击;缺失/非数值 {missing_values} 个,越界 {len(out_of_range)} 个",
            warnings=[
                f"{r['country']}-{r['sector']}-{r['year']}: {r['_shock_col']}={r[r['_shock_col']]}"
                for _, r in out_of_range.head(5).iterrows()
            ],
        )
    )

    missing_dates = pd.Series(False, index=df.index)
    reversed_dates = pd.Series(False, index=df.index)
    hit_total = 0
    missing_notes = pd.Series(False, index=df.index)
    for shock_col, ann_col, eff_col, note_col in SHOCK_EVENT_COLUMNS:
        hit = numeric_shocks[shock_col] > 0
        hit_total += int(hit.sum())
        ann = pd.to_datetime(df[ann_col].replace("", pd.NA), errors="coerce")
        eff = pd.to_datetime(df[eff_col].replace("", pd.NA), errors="coerce")
        note = df[note_col].fillna("").astype(str).str.strip()
        missing_dates |= hit & (ann.isna() | eff.isna())
        missing_notes |= hit & note.eq("")
        reversed_dates |= hit & ann.notna() & eff.notna() & (ann > eff)
    checks.append(
        QcCheck(
            name="冲击事件时间线(宣布日≤生效日)",
            kind="结构",
            passed=not missing_dates.any() and not missing_notes.any() and not reversed_dates.any(),
            detail=(
                f"受冲击记录 {hit_total} 条;缺少日期 {int(missing_dates.sum())} 条,"
                f"缺少事件说明 {int(missing_notes.sum())} 条,日期倒置 {int(reversed_dates.sum())} 条"
            ),
            warnings=[
                f"{r.country}-{r.sector}-{r.year}: 事件日期/说明缺失或倒置"
                for r in df[missing_dates | missing_notes | reversed_dates].head(5).itertuples(index=False)
            ],
        )
    )

    invalid_treated = pd.Series(False, index=df.index)
    mismatch = pd.Series(False, index=df.index)
    for shock_col, treated_col in present_pairs:
        shock = numeric_shocks[shock_col]
        treated = pd.to_numeric(df[treated_col], errors="coerce")
        invalid_treated |= ~treated.isin([0, 1])
        mismatch |= treated.fillna(-1).astype(int) != (shock > treated_threshold).astype(int)
    checks.append(
        QcCheck(
            name="treated 标记与阈值一致",
            kind="数值",
            passed=not invalid_treated.any() and not mismatch.any(),
            detail=(
                f"非法 treated 值 {int(invalid_treated.sum())} 个;"
                f"与 *_shock>{treated_threshold:g} 不一致 {int(mismatch.sum())} 个"
            ),
            warnings=[
                f"{r['country']}-{r['sector']}-{r['year']}: "
                + "; ".join(f"{s}={r[s]}, {t}={r[t]}" for s, t in present_pairs)
                for _, r in df[invalid_treated | mismatch].head(5).iterrows()
            ],
        )
    )

    total_pairs = max(len(countries) * len(sectors), 1)
    yearly = []
    bad_years = []
    main_shock = numeric_shocks.get("tariff_shock", pd.Series(0.0, index=df.index))
    main_treated = pd.to_numeric(df["treated"], errors="coerce")
    sanction_treated = pd.to_numeric(df["sanction_treated"], errors="coerce")
    export_control_treated = pd.to_numeric(df["export_control_treated"], errors="coerce")
    coverage_frame = df.assign(
        _tariff_shock=main_shock,
        _tariff_treated=main_treated,
        _sanction_treated=sanction_treated,
        _export_control_treated=export_control_treated,
    )
    for year, group in coverage_frame.groupby("year"):
        tariff_count = int((group["_tariff_treated"] == 1).sum())
        share = float(tariff_count / total_pairs)
        mean_hit = float(group.loc[group["_tariff_treated"] == 1, "_tariff_shock"].mean()) if tariff_count else 0.0
        sanction_count = int((group["_sanction_treated"] == 1).sum())
        export_control_count = int((group["_export_control_treated"] == 1).sum())
        yearly.append(
            f"{int(year)}:关税处理 {tariff_count}/{total_pairs} ({share:.2%}),"
            f"关税受处理均值 {mean_hit:.3%};制裁处理 {sanction_count}（描述性）;"
            f"出口管制处理 {export_control_count}（描述性）"
        )
        if group["_tariff_shock"].gt(0).any() and not (0 < share <= 0.25):
            bad_years.append(int(year))
    checks.append(
        QcCheck(
            name="关税处理组覆盖比例合理性（制裁/出口管制仅描述）",
            kind="经济含义",
            passed=not bad_years,
            detail="; ".join(yearly),
            warnings=[f"{year} 年关税处理组合占比超出 (0,25%] 合理区间" for year in bad_years],
        )
    )

    source = df["tariff_exposure_source"].fillna("").astype(str).str.strip()
    mode = df["tariff_exposure_mode"].fillna("").astype(str).str.strip()
    disclosure = df["tariff_exposure_disclosure"].fillna("").astype(str).str.strip()
    source_values = sorted(set(source) - {""})
    mode_values = sorted(set(mode) - {""})
    unknown_sources = sorted(set(source_values) - set(EXPOSURE_SOURCES))
    unknown_modes = sorted(set(mode_values) - set(EXPOSURE_MODES))
    missing_provenance = int(source.eq("").sum() + mode.eq("").sum())
    mixed = len(source_values) != 1 or len(mode_values) != 1
    stylized = source.eq(EXPOSURE_SOURCE_STYLIZED)
    oecd = source.eq(EXPOSURE_SOURCE_OECD_ICIO)
    missing_stylized_disclosure = int((stylized & disclosure.ne(STYLIZED_EXPOSURE_DISCLOSURE)).sum())
    invalid_oecd_disclosure = int((oecd & disclosure.ne("")).sum())
    provenance_ok = (
        missing_provenance == 0
        and not mixed
        and not unknown_sources
        and not unknown_modes
        and missing_stylized_disclosure == 0
        and invalid_oecd_disclosure == 0
    )
    warnings = []
    if stylized.any() and provenance_ok:
        warnings.append(STYLIZED_EXPOSURE_DISCLOSURE)
    if not provenance_ok:
        warnings.append(
            f"sources={source_values}, modes={mode_values}, unknown_sources={unknown_sources}, "
            f"unknown_modes={unknown_modes}, missing={missing_provenance}, "
            f"missing_fallback_disclosure={missing_stylized_disclosure}, "
            f"invalid_oecd_disclosure={invalid_oecd_disclosure}"
        )
    checks.append(
        QcCheck(
            name="关税出口暴露度来源与口径",
            kind="来源",
            passed=provenance_ok,
            detail=(
                f"source={source_values or ['缺失']},mode={mode_values or ['缺失']};"
                "全表来源/口径必须唯一且属于版本化允许集合"
            ),
            warnings=warnings,
        )
    )

    return checks
