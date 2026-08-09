"""学生文案的事实边界与先教后测契约。"""

from pathlib import Path

from gvcsim.indicator_schema import INDICATOR_SCHEMA
from gvcsim.regression.design import GRANULARITY_LABELS, OUTCOME_DEPVARS
from gvcsim.steps import STEPS

ROOT = Path(__file__).resolve().parents[1]
FRONTEND_COPY_FILES = [
    ROOT / "frontend/src/demos.tsx",
    ROOT / "frontend/src/labs/steps/ind/step4.tsx",
    ROOT / "frontend/src/labs/steps/ind/step5.tsx",
    ROOT / "frontend/src/labs/steps/ind/step7.tsx",
    ROOT / "frontend/src/labs/steps/step2-shock.tsx",
    ROOT / "frontend/src/labs/steps/step2/selected-event.tsx",
    ROOT / "frontend/src/labs/steps/viz/step8.tsx",
    ROOT / "frontend/src/labs/steps/viz/step9.tsx",
    ROOT / "frontend/src/labs/steps/viz/step10.tsx",
    ROOT / "frontend/src/labs/steps/viz/step11.tsx",
]


def _step(number: int) -> dict:
    return next(item for item in STEPS if item["n"] == number)


def test_policy_exposure_copy_does_not_prejudge_exogeneity_or_causality() -> None:
    step = _step(11)
    copy = " ".join(str(step[field]) for field in ("goal", "concept", "tip"))
    assert "候选处理变量" in copy
    assert "是否足够外生" in copy
    assert "不能在接入阶段预先认定" in copy
    assert "外生的因" not in copy
    assert "必须补入外生" not in copy


def test_amounts_are_not_described_as_dependency_or_structure_shares() -> None:
    trade = " ".join(str(_step(3)[field]) for field in ("concept", "tip"))
    production = " ".join(str(_step(4)[field]) for field in ("concept", "tip"))
    assert "FVA 绝对金额还会受到出口规模影响" in trade
    assert "复杂 GVC 绝对金额还会受到经济规模影响" in production
    assert "应看各类份额" in production


def test_backend_method_metadata_matches_the_estimator() -> None:
    interaction = _step(13)["concept"]
    assert "减去样本均值" in interaction
    assert "中心化后的水平" in interaction
    assert "稳定单元处理值假设（SUTVA）" in _step(15)["concept"]
    assert "无干扰" in _step(15)["concept"]


def test_frontend_copy_does_not_restore_rejected_overclaims() -> None:
    copy = "\n".join(path.read_text(encoding="utf-8") for path in FRONTEND_COPY_FILES)
    for rejected in (
        "外生的因",
        "它造成的国家×行业冲击",
        "对政策冲击最敏感",
        "FVA 越大 = 越依赖",
        "复杂 GVC(3b) 越大 =",
        "该发现",
        "全球「国家×行业」",
        "经济体层贸易图接近完全图",
    ):
        assert rejected not in copy


def test_row_aggregate_is_not_counted_as_an_economy() -> None:
    copy = "\n".join(
        (ROOT / path).read_text(encoding="utf-8")
        for path in (
            "frontend/src/economy-coverage.ts",
            "frontend/src/login.tsx",
            "frontend/src/intro.tsx",
            "frontend/src/labs/steps/step2-shock.tsx",
            "frontend/src/labs/steps/step2/shock-panel.tsx",
        )
    )
    assert "77 个经济体" not in copy
    assert "treated_countries} 个经济体</span>" not in copy
    assert "经济体/地区账户达到处理阈值" in copy
    assert "世界其他地区" in copy
    assert "ROW" in copy


def test_indicator_and_regression_metadata_use_student_labels() -> None:
    schema = INDICATOR_SCHEMA
    labels = [str(group["label"]) for group in schema["groups"]]
    field_copy = " ".join(f"{meta['label']} {meta['desc']}" for meta in schema["fields"].values())
    assert "生产网络中心性" in labels
    assert "Gephi 口径" not in labels
    assert "国家–行业级" not in field_copy
    assert "出口保留的本国增加值越多" not in field_copy
    assert set(GRANULARITY_LABELS.values()) == {"经济体×行业", "经济体层"}
    assert all("复杂GVC" not in label for _, label in OUTCOME_DEPVARS.values())
