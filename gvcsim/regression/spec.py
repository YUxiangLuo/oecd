"""What a regression of steps 11–14 contains: X terms, controls and fixed effects.

The course default and every model a student designs in the workbench are a ``ModelSpec``; one estimator
serves both. A spec is validated against the whitelist below and normalised (``canonical``) so the same model
written in a different order, or with a fixed effect that another one already contains, is one model.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# The X columns the teaching panel carries, by lag. Lags of X come from the tariff schedule (before the first tariff
# year τ is 0, so they are exact zeros, not missing); the generator writes them, the estimator only selects them.
from gvcsim.regression.teaching import EXCHANGE_RATE_COLUMN, X_LAG_COLUMNS

X_LAGS = tuple(X_LAG_COLUMNS)
CONTROL_LAGS = (0, 1)


@dataclass(frozen=True)
class ControlInfo:
    label: str
    definition: str
    source: str  # "generated" (made by the course) or "icio" (computed from the ICIO tables)


# Order is the order of the page and of a normalised spec.
CONTROLS: dict[str, ControlInfo] = {
    EXCHANGE_RATE_COLUMN: ControlInfo("汇率变动", "本币兑美元的年变动（百分点，负为贬值）", "generated"),
    "log_gdp_proxy": ControlInfo("增加值总额对数", "ln（国家增加值总额，百万美元）；用作 GDP 代理，并非正式 GDP", "icio"),
    "export_intensity": ControlInfo("出口强度", "总出口 / 增加值总额", "icio"),
    "manufacturing_va_share": ControlInfo("制造业增加值占比", "制造业增加值 / 增加值总额", "icio"),
}

# Fixed effects in page order. A combined effect contains its parts, so checking it makes them redundant.
FIXED_EFFECTS = ("country", "industry", "country_industry", "year", "country_year")
FIXED_EFFECT_LABELS = {
    "country": "国家 FE",
    "industry": "行业 FE",
    "country_industry": "国家×行业 FE",
    "year": "年份 FE",
    "country_year": "国家×年份 FE",
}
FIXED_EFFECT_INCLUDES: dict[str, tuple[str, ...]] = {
    "country_industry": ("country", "industry"),
    "country_year": ("country", "year"),
}
# Panel column that holds each effect's groups; country × year is built from its two parts when needed.
FIXED_EFFECT_COLUMNS = {
    "country": "country",
    "industry": "industry",
    "country_industry": "entity_id",
    "year": "year",
    "country_year": "_fe_country_year",
}


def x_term_label(lag: int) -> str:
    return "X" if lag == 0 else f"L{lag}.X"


def control_column(key: str, lag: int) -> str:
    """The estimation column of a control at a lag (lagged copies are built by the sample preparation)."""
    return key if lag == 0 else f"{key}__lag{lag}"


def control_term_label(key: str, lag: int) -> str:
    label = CONTROLS[key].label
    return label if lag == 0 else f"L{lag}.{label}"


@dataclass(frozen=True)
class ModelSpec:
    """X lags, (control, lag) pairs and fixed-effect keys; ``canonical()`` validates and normalises."""

    x_lags: tuple[int, ...]
    controls: tuple[tuple[str, int], ...]
    fixed_effects: tuple[str, ...]

    def canonical(self) -> ModelSpec:
        x_lags = tuple(self.x_lags)
        if not x_lags:
            raise ValueError("至少要放入一项关税暴露 X")
        # Exactly int: 1.0 == 1 would pass a membership test and then print as "L1.0.X".
        if any(type(lag) is not int or lag not in X_LAGS for lag in x_lags):
            raise ValueError(f"X 的滞后期只能是 {list(X_LAGS)}")
        if len(set(x_lags)) != len(x_lags):
            raise ValueError("X 的同一滞后期不能重复放入")
        keys = [key for key, _ in self.controls]
        if not all(isinstance(key, str) for key in keys) or not all(isinstance(key, str) for key in self.fixed_effects):
            raise ValueError("控制变量和固定效应应写成名称")
        unknown = [key for key in keys if key not in CONTROLS]
        if unknown:
            raise ValueError("不提供的控制变量")
        if len(set(keys)) != len(keys):
            raise ValueError("同一个控制变量只能放入一次")
        if any(type(lag) is not int or lag not in CONTROL_LAGS for _, lag in self.controls):
            raise ValueError(f"控制变量的滞后期只能是 {list(CONTROL_LAGS)}")
        unknown_effects = [key for key in self.fixed_effects if key not in FIXED_EFFECTS]
        if unknown_effects:
            raise ValueError("不提供的固定效应")
        if len(set(self.fixed_effects)) != len(self.fixed_effects):
            raise ValueError("同一项固定效应只能勾选一次")
        chosen = set(self.fixed_effects)
        implied = {part for key in chosen for part in FIXED_EFFECT_INCLUDES.get(key, ())}
        order = list(CONTROLS)
        return ModelSpec(
            tuple(sorted(x_lags)),
            tuple(sorted(self.controls, key=lambda item: order.index(item[0]))),
            tuple(key for key in FIXED_EFFECTS if key in chosen and key not in implied),
        )

    @property
    def x_columns(self) -> list[str]:
        return [X_LAG_COLUMNS[lag] for lag in self.x_lags]

    @property
    def control_columns(self) -> list[str]:
        return [control_column(key, lag) for key, lag in self.controls]

    @property
    def fixed_effect_columns(self) -> list[str]:
        return [FIXED_EFFECT_COLUMNS[key] for key in self.fixed_effects]

    def term_labels(self) -> dict[str, str]:
        labels = {X_LAG_COLUMNS[lag]: x_term_label(lag) for lag in self.x_lags}
        labels.update({control_column(key, lag): control_term_label(key, lag) for key, lag in self.controls})
        return labels

    def to_dict(self) -> dict[str, Any]:
        return {
            "x_lags": list(self.x_lags),
            "controls": [{"name": key, "lag": lag} for key, lag in self.controls],
            "fixed_effects": list(self.fixed_effects),
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> ModelSpec:
        """A spec from its JSON form (``to_dict``); validated and normalised."""
        if not isinstance(value, dict) or set(value) != {"x_lags", "controls", "fixed_effects"}:
            raise ValueError("模型设定必须且只能包含 x_lags、controls、fixed_effects")
        controls = value["controls"]
        if not isinstance(controls, list) or not all(
            isinstance(item, dict) and set(item) == {"name", "lag"} for item in controls
        ):
            raise ValueError("控制变量的格式应为 {name, lag}")
        if not isinstance(value["x_lags"], list) or not isinstance(value["fixed_effects"], list):
            raise ValueError("x_lags 与 fixed_effects 必须是列表")
        return cls(
            tuple(value["x_lags"]),
            tuple((item["name"], item["lag"]) for item in controls),
            tuple(value["fixed_effects"]),
        ).canonical()

    def summary(self) -> str:
        """Short description for saved-result lists: "X + L1.X；汇率变动；国家×行业 + 年份 FE"."""
        x_part = " + ".join(x_term_label(lag) for lag in self.x_lags)
        controls = "、".join(control_term_label(key, lag) for key, lag in self.controls) or "无控制变量"
        effects = (
            " + ".join(FIXED_EFFECT_LABELS[key].removesuffix(" FE") for key in self.fixed_effects) + " FE"
            if self.fixed_effects
            else "无固定效应"
        )
        return f"{x_part}；{controls}；{effects}"

    def equation(self, depvar: str = "Y") -> str:
        """``Y = β₁·X + β₂·L1.X + γ₁·汇率变动 + 国家×行业 FE + 年份 FE + ε``."""
        terms = [f"β{_subscript(index + 1)}·{x_term_label(lag)}" for index, lag in enumerate(self.x_lags)]
        terms += [
            f"γ{_subscript(index + 1)}·{control_term_label(key, lag)}" for index, (key, lag) in enumerate(self.controls)
        ]
        terms += [FIXED_EFFECT_LABELS[key] for key in self.fixed_effects] or ["常数项"]
        return f"{depvar} = " + " + ".join(terms) + " + ε"


def _subscript(number: int) -> str:
    return str(number).translate(str.maketrans("0123456789", "₀₁₂₃₄₅₆₇₈₉"))


# The course default of steps 11–14 for teaching data v10: the tariff's relation shows over two years and the
# exchange rate confounds it, so the correct model has X, L1.X and the exchange rate with unit and year effects.
DEFAULT_SPEC = ModelSpec((0, 1), ((EXCHANGE_RATE_COLUMN, 0),), ("country_industry", "year"))
