"""Report appendix "学生设计的模型": the workbench models a student marked 放入报告 in steps 11–14.

Every number is recomputed here from the saved ``(outcome, baseline, spec)``; the page's snapshot is never read,
so editing it in the browser changes nothing in the report. Each Y gets one table, the course default model first.
"""

from __future__ import annotations

import math
import re
from typing import Any, cast

import numpy as np

from gvcsim.regression import workbench
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.spec import (
    CONTROLS,
    DEFAULT_SPEC,
    FIXED_EFFECT_INCLUDES,
    FIXED_EFFECT_LABELS,
    FIXED_EFFECTS,
    X_LAG_COLUMNS,
    ModelSpec,
    control_column,
    control_term_label,
    x_term_label,
)
from gvcsim.regression.teaching import selectable_baselines
from gvcsim.report_common import (
    UNIT_NAMES,
    _depvar_kind,
    _no_negative_zero,
    _safe,
    _signed,
    estimate_digits,
    with_count_unit,
    y_display,
)
from gvcsim.report_regression_chart import _chart_block, _finite
from gvcsim.report_saved_run import _STEP_OUTCOMES
from gvcsim.steps import STEPS

_STEP_TITLES = {
    cast(int, item["n"]): str(item["title"]).split("：")[0] for item in STEPS if item.get("regression_outcome")
}
_DEFAULT_NAME = "默认模型"
_TERM_LABELS = {X_LAG_COLUMNS[lag]: x_term_label(lag) for lag in X_LAG_COLUMNS} | {
    control_column(key, lag): control_term_label(key, lag) for key in CONTROLS for lag in (0, 1)
}
_OMITTED_REASONS = {"zero": "样本里全为 0", "collinear": "与其他变量完全共线"}
# What a column's X-terms sum covers (frontend ``xSpanLabel``).
_X_SPANS = {(0,): "仅当年", (0, 1): "两年累计", (0, 1, 2): "三年累计"}


def _x_span(spec: ModelSpec) -> str:
    """Named spans, or the terms themselves ("仅 L1.X", "X + L2.X 之和") so one coefficient is never called a sum."""
    lags = tuple(sorted(spec.x_lags))
    if lags in _X_SPANS:
        return _X_SPANS[lags]
    terms = [x_term_label(lag) for lag in lags]
    return f"仅 {terms[0]}" if len(terms) == 1 else " + ".join(terms) + " 之和"


def reported_models(session: dict[str, Any]) -> list[dict[str, Any]]:
    """The saved models marked 放入报告, step by step, in saved order: ``{step, name, outcome, baseline, spec}``.
    The session route checks them on save; an entry that no longer passes (an older release) is left out."""
    models: list[dict[str, Any]] = []
    for step, outcome in sorted(_STEP_OUTCOMES.items()):
        data = session.get("steps", {}).get(str(step), {}).get("data", {})
        saved = data.get("custom_results") if isinstance(data, dict) else None
        if not isinstance(saved, list) or workbench.custom_results_problem(saved, outcome):
            continue
        baselines = {item.key for item in selectable_baselines(outcome)}
        for item in workbench.reported_custom_results(saved):
            if item["baseline"] in baselines:
                models.append({"step": step, **item})
    return models


def run_designs(models: list[dict[str, Any]]) -> list[RegressionDesign]:
    """Every run ``recompute`` reads for these models: each (step, Y)'s default model and each model itself."""
    return [
        RegressionDesign(model["outcome"], teaching=True, baseline=model["baseline"], spec=spec)
        for model in models
        for spec in (DEFAULT_SPEC, ModelSpec.from_dict(model["spec"]))
    ]


def _run(panel: Any, release: str | None, outcome: str, baseline: str, spec: ModelSpec) -> dict[str, Any] | str:
    """The run's response from the shared run cache (the same numbers the page showed), or why it failed."""
    from gvcsim.regression_routes import cached_run

    try:
        return cached_run(panel, RegressionDesign(outcome, teaching=True, baseline=baseline, spec=spec), release)
    except (ValueError, KeyError, np.linalg.LinAlgError, FloatingPointError, OverflowError) as error:
        return str(error) or "计算失败"


def recompute(models: list[dict[str, Any]], panel: Any = None, release: str | None = None) -> list[dict[str, Any]]:
    """One table per (step, Y): the default model's run, then each reported model's run (or its failure)."""
    if not models:
        return []
    from gvcsim.regression_routes import read_teaching_panel

    if panel is None:
        release, panel = read_teaching_panel()
    tables: list[dict[str, Any]] = []
    for model in models:
        key = (model["step"], model["baseline"])
        table = next((item for item in tables if (item["step"], item["baseline"]) == key), None)
        if table is None:
            default = (
                _run(panel, release, model["outcome"], model["baseline"], DEFAULT_SPEC)
                if panel is not None
                else "课程数据暂时不可用"
            )
            table = {
                "step": model["step"],
                "outcome": model["outcome"],
                "baseline": model["baseline"],
                "columns": [{"name": _DEFAULT_NAME, "spec": DEFAULT_SPEC, "run": default}],
            }
            tables.append(table)
        spec = ModelSpec.from_dict(model["spec"])
        run = (
            _run(panel, release, model["outcome"], model["baseline"], spec)
            if panel is not None
            else "课程数据暂时不可用"
        )
        table["columns"].append({"name": model["name"], "spec": spec, "run": run})
    return tables


def _escape(text: str) -> str:
    """Markdown-literal text: stars (significance), a model name a student typed."""
    for char in "\\*_[]<>#":
        text = text.replace(char, "\\" + char)
    return text


# Any ASCII punctuation may be backslash-escaped in Markdown: escaping all of it in a typed name keeps it from turning
# into emphasis, strikethrough ("~~…~~") or a table cell break. GFM still reads "www.…", "http://…" and "a@b.cn" as
# links whatever the escapes, so an invisible word joiner (U+2060) goes where a link would start: before the "." of
# "www.", the "://" of a scheme and an "@". Elsewhere ("模型1.5", "x.cn") the name copies as typed.
_ASCII_PUNCTUATION = re.compile(r"([!-/:-@\[-`{-~])")
_WORD_JOINER = "\u2060"


def _name(value: Any) -> str:
    # Not _safe: its "|" → "¦" and "`" → "ʼ" would change the name; escaped, both print as typed (also in tables).
    text = " ".join(str(value).split())[:240]
    escaped = _ASCII_PUNCTUATION.sub(r"\\\1", text)
    escaped = re.sub(r"(?i)(?<=www)(\\\.)", _WORD_JOINER + r"\1", escaped)
    escaped = escaped.replace("\\:\\/\\/", _WORD_JOINER + "\\:\\/\\/")
    return escaped.replace("\\@", _WORD_JOINER + "\\@")


def _fixed(value: Any, digits: int) -> str:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
        return "—"
    return _no_negative_zero(f"{float(value):,.{digits}f}")


def _suppressed(result: dict[str, Any]) -> bool:
    support = result.get("support")
    suppressed = isinstance(support, dict) and bool(support.get("suppress_inference"))
    return result.get("status") == "invalid_design" or suppressed


def _x_terms(result: dict[str, Any]) -> int:
    return sum(1 for item in result.get("coefs", []) if item.get("name") in X_LAG_COLUMNS.values())


def _coefficient_rows(columns: list[dict[str, Any]]) -> list[str]:
    # Rows in page order: X terms, controls, the cumulative relation (two or more X terms), a constant.
    order = [*X_LAG_COLUMNS.values(), *(control_column(key, lag) for key in CONTROLS for lag in (0, 1))]
    used = {
        item.get("name")
        for column in columns
        if isinstance(column["run"], dict)
        for item in [*column["run"]["result"].get("coefs", []), *column["run"]["result"].get("omitted", [])]
    }
    names = [name for name in order if name in used]
    rows: list[str] = []

    def cells(pick) -> str:
        values = []
        for column in columns:
            run = column["run"]
            if not isinstance(run, dict):
                values.append("")
                continue
            coefficient, omitted = pick(run["result"])
            if coefficient is None:
                values.append("（省略）" if omitted else "")
                continue
            stars = "" if _suppressed(run["result"]) else str(coefficient.get("stars") or "")
            # Inline code renders on its own line in report table cells, without permitting raw HTML.
            # One row keeps each coefficient together with its SE when printed across pages.
            value = _fixed(coefficient.get("coef"), 4) + _escape(stars)
            se = "—" if _suppressed(run["result"]) else f"({_fixed(coefficient.get('se'), 4)})"
            values.append(value + f" `{se}`")
        return " | ".join(values)

    for name in names:

        def pick(result: dict[str, Any], name: str = name) -> tuple[dict[str, Any] | None, bool]:
            found = next((item for item in result.get("coefs", []) if item.get("name") == name), None)
            return found, any(item.get("name") == name for item in result.get("omitted", []))

        rows.append(f"| {_TERM_LABELS.get(name, _safe(name))} | {cells(pick)} |")
    if any(isinstance(column["run"], dict) and _x_terms(column["run"]["result"]) > 1 for column in columns):
        total_cells = cells(lambda result: (result.get("cumulative") if _x_terms(result) > 1 else None, False))
        rows.append(f"| X 各项合计（累计效应） | {total_cells} |")
    rows += _per_point_rows(columns)
    if any(isinstance(column["run"], dict) and column["run"]["result"].get("constant") for column in columns):
        rows.append(f"| 常数项 | {cells(lambda result: (result.get('constant'), False))} |")
    return rows


def _x_sum(result: dict[str, Any], spec: ModelSpec) -> dict[str, Any] | None:
    """A column's X-terms sum: the single X term of a one-term model, else the cumulative relation. None when a term of
    a several-term model was dropped (the estimate then has no sum), so one coefficient is never called a sum."""
    if len(spec.x_lags) == 1:
        return next((item for item in result.get("coefs", []) if item.get("name") in X_LAG_COLUMNS.values()), None)
    cumulative = result.get("cumulative")
    return cumulative if isinstance(cumulative, dict) else None


def _per_point(
    kind: str, result: dict[str, Any], coefficient: dict[str, Any]
) -> tuple[float, tuple[float, float] | None]:
    """The X-terms sum per 1 percentage point of X in the step's unit (shares in points), with its interval."""
    scale = 1.0 if kind == "share" else 0.01
    low, high = coefficient.get("ci_low"), coefficient.get("ci_high")
    bounds = (
        (float(low) * scale, float(high) * scale)
        if not _suppressed(result) and isinstance(low, (int, float)) and isinstance(high, (int, float))
        else None
    )
    return float(coefficient["coef"]) * scale, bounds


def _per_point_rows(columns: list[dict[str, Any]]) -> list[str]:
    """The row "合计：X 每高 1 个百分点", as on the page (frontend ``perPointRow``): each column's X-terms sum in the
    step's unit, all at the first column's decimals so the row compares like with like, each naming its years."""

    def x_sum(column: dict[str, Any]) -> dict[str, Any] | None:
        run = column["run"]
        total = _x_sum(run["result"], column["spec"]) if isinstance(run, dict) else None
        return total if total is not None and isinstance(total.get("coef"), (int, float)) else None

    first = next((column for column in columns if x_sum(column)), None)
    if first is None:
        return []
    design = first["run"]["design"]
    kind = _depvar_kind(str(design.get("outcome", "")), design)
    digits = estimate_digits(kind, *_per_point(kind, first["run"]["result"], cast(dict[str, Any], x_sum(first))))
    cells = []
    for column in columns:
        total = x_sum(column)
        if total is None:
            cells.append("")
            continue
        value, _ = _per_point(kind, column["run"]["result"], total)
        span = _x_span(column["spec"])
        cells.append(f"{with_count_unit(_signed(value, digits), kind)}（{span}）")
    return [f"| 合计：X 每高 1 个百分点 | {' | '.join(cells)} |"]


def _included(spec: ModelSpec, key: str) -> bool:
    return key in spec.fixed_effects or any(
        key in FIXED_EFFECT_INCLUDES.get(chosen, ()) for chosen in spec.fixed_effects
    )


def _summary_rows(columns: list[dict[str, Any]]) -> list[str]:
    def row(label: str, value) -> str:
        values = [value(column["run"]["result"]) if isinstance(column["run"], dict) else "" for column in columns]
        return f"| {label} | " + " | ".join(values) + " |"

    rows = [
        f"| {FIXED_EFFECT_LABELS[key]} | "
        + " | ".join("是" if _included(column["spec"], key) else "否" for column in columns)
        + " |"
        for key in FIXED_EFFECTS
    ]

    def years(result: dict[str, Any]) -> str:
        span = (result.get("sample_flow") or {}).get("years")
        return f"{span[0]}–{span[1]}" if isinstance(span, list) and len(span) == 2 else "—"

    def f_value(result: dict[str, Any]) -> str:
        df = result.get("f_df")
        if _suppressed(result) or not isinstance(df, list) or len(df) != 2:
            return "—"
        return f"{_fixed(result.get('f_stat'), 2)}（{df[0]}, {df[1]}）"

    rows += [
        row("观测值", lambda result: f"{int(result.get('n_obs') or 0):,}"),
        row("年份", years),
        row("聚类数（国家）", lambda result: str(result.get("n_clusters") or "—")),
        row("R²", lambda result: _fixed(result.get("r2"), 4)),
        row("调整 R²", lambda result: _fixed(result.get("r2_adj"), 4)),
        # Without fixed effects nothing is "within": the row would repeat R².
        "| 组内 R² | "
        + " | ".join(
            (_fixed(column["run"]["result"].get("r2_within"), 4) if column["spec"].fixed_effects else "—")
            if isinstance(column["run"], dict)
            else ""
            for column in columns
        )
        + " |",
        row("F（自由度）", f_value),
    ]
    return rows


def _omitted_groups(omitted: list[dict[str, Any]]) -> list[str]:
    """Omitted terms grouped by why, as the page says it: "被国家×年份 FE 吸收：汇率变动、GDP（取对数）"."""
    groups: dict[str, list[str]] = {}
    for item in omitted:
        if item.get("reason") == "absorbed":
            by = item.get("by")
            reason = f"被{_safe(str(by))} FE 吸收" if by and by != "常数项" else "在样本里不变，与常数项重合"
        else:
            reason = _OMITTED_REASONS.get(str(item.get("reason")), "无法估计")
        label = _TERM_LABELS.get(str(item.get("name")), _safe(str(item.get("name"))))
        groups.setdefault(reason, []).append(label)
    return [f"{reason}：{'、'.join(labels)}" for reason, labels in groups.items()]


def _comparison_chart(table: dict[str, Any], label: str) -> list[str]:
    """Compare the same Y in native units; missing estimates are omitted, never zero placeholders."""
    items: list[dict[str, Any]] = []
    notes: list[str] = []
    kind = ""
    for column in table["columns"]:
        run, spec = column["run"], column["spec"]
        reason = ""
        if not isinstance(run, dict):
            reason = "重算失败"
        else:
            result = run["result"]
            total = _x_sum(result, spec)
            if _suppressed(result):
                reason = "已停止推断"
            elif total is None or not _finite(total.get("coef")):
                reason = "无法计算所选 X 项效应"
            elif not all(_finite(total.get(key)) for key in ("ci_low", "ci_high")):
                reason = "没有有效的 95% 区间"
            elif not total["ci_low"] <= total["coef"] <= total["ci_high"]:
                reason = "没有有效的 95% 区间"
            else:
                kind = _depvar_kind(table["outcome"], run["design"])
                value, bounds = _per_point(kind, result, total)
                assert bounds is not None
                years = (result.get("sample_flow") or {}).get("years")
                years_text = f"{years[0]}–{years[1]}" if isinstance(years, list) and len(years) == 2 else "未记录"
                n = result.get("n_obs")
                n_text = f"{int(n):,}" if _finite(n) else "未记录"
                items.append(
                    {
                        "label": " ".join(str(column["name"]).split())[:120],
                        "sub": _x_span(spec),
                        "value": value,
                        "text": with_count_unit(_signed(value, estimate_digits(kind, value, bounds)), kind),
                        "ci_low": bounds[0],
                        "ci_high": bounds[1],
                    }
                )
                notes.append(f"- {_name(column['name'])}：{_x_span(spec)}；N = {n_text}；年份 {years_text}。")
        if reason:
            notes.append(f"- {_name(column['name'])}：{reason}，不绘制对应模型。")
    lines: list[str] = []
    # The existing renderer accepts at most eight bars per block.
    for start in range(0, len(items), 8):
        lines += _chart_block(
            {
                "version": 1,
                "type": "diverging-bar",
                "title": f"步骤 {table['step']} · 模型 X 效应及 95% 区间（Y：{label}）",
                "x_label": f"X 每高 1 个百分点，所选 X 项效应（{UNIT_NAMES.get(kind, '原始单位')}）",
                "note": "同一 Y 使用原始单位（份额转换为百分点），不按各模型标准差归一化；"
                "单项用该项系数，多项用累计系数；X 项范围见各条标签，样本数和年份见图下说明。不同跨度不是同一个估计量。",
                "items": items[start : start + 8],
            }
        )
    return lines + notes + ([""] if notes else [])


def custom_model_sections(tables: list[dict[str, Any]]) -> list[str]:
    if not tables:
        return []
    lines = [
        "## 附录：学生设计的模型",
        "",
        "以下是你在步骤 11–14 的“自己设计模型（选做）”中保存、并勾选了“放入报告”的模型。"
        "数字由服务器在生成报告时按保存的设定重新计算；每张表的第一列是本步的默认模型，便于对照。",
        "",
    ]
    used = {key for table in tables for column in table["columns"] for key, _ in column["spec"].controls}
    if used:
        definitions = "；".join(
            f"{info.label} = {info.definition}（{'课程生成' if info.source == 'generated' else '按 OECD ICIO 计算'}）"
            for key, info in CONTROLS.items()
            if key in used
        )
        lines += [f"控制变量都是国家层面的逐年数值：{definitions}。", ""]
    for table in tables:
        columns = table["columns"]
        first = next((column["run"] for column in columns if isinstance(column["run"], dict)), None)
        label = y_display(first["design"]["depvar_label"]) if first else table["baseline"]
        lines += [f"### 步骤 {table['step']} · {_STEP_TITLES.get(table['step'], '')}（Y：{_safe(label)}）", ""]
        header = " | ".join(_name(column["name"]) for column in columns)
        lines += [f"| 变量 | {header} |", "|---|" + "---:|" * len(columns)]
        lines += _coefficient_rows(columns)
        lines += _summary_rows(columns)
        lines.append("")
        lines += _comparison_chart(table, label)
        for column in columns:
            run = column["run"]
            text = f"- {_name(column['name'])}：{column['spec'].summary()}"
            if not isinstance(run, dict):
                text += f"。这次没能重算：{_safe(run)}"
            else:
                omitted = run["result"].get("omitted") or []
                if omitted:
                    text += "；已省略（" + "；".join(_omitted_groups(omitted)) + "）"
                if _suppressed(run["result"]):
                    text += "。" + workbench.SUPPRESSED_NOTE
            lines.append(text)
        computed = [column["run"]["result"] for column in columns if isinstance(column["run"], dict)]
        samples = {(result.get("n_obs"), str((result.get("sample_flow") or {}).get("years"))) for result in computed}
        if len(samples) > 1:
            lines.append(f"- {workbench.SAMPLE_DIFFERS_NOTE}")
        lines += ["", _escape(workbench.FOOTNOTE), ""]
    return lines
