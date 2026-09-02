from gvcsim.indicator_schema import (
    INDICATOR_SCHEMA,
    PRODUCTION_LENGTH_OPERATIONAL_DEFINITION,
)
from gvcsim.quizzes import STEP_QUIZZES
from gvcsim.steps import STEPS


def test_length_schema_uses_operational_average_stage_definition():
    fields = INDICATOR_SCHEMA["fields"]
    for key in ("PLv", "PLv_GVC", "PLy", "PLy_GVC"):
        description = fields[key]["desc"]
        assert "平均" in description
        assert "生产阶段数" in description
        assert "不是跨境次数" in description
        assert "国家数" in description
        assert "网络边数" in description


def test_step_and_quiz_copy_share_the_operational_definition():
    by_step = {step["n"]: step for step in STEPS}
    assert PRODUCTION_LENGTH_OPERATIONAL_DEFINITION in by_step[8]["concept"]
    assert PRODUCTION_LENGTH_OPERATIONAL_DEFINITION in by_step[13]["concept"]
    assert PRODUCTION_LENGTH_OPERATIONAL_DEFINITION in STEP_QUIZZES[8][0]["explanation"]
    assert PRODUCTION_LENGTH_OPERATIONAL_DEFINITION in STEP_QUIZZES[13][0]["explanation"]
    assert "平均生产阶段长度" in STEP_QUIZZES[13][0]["options"][0]["label"]

    teaching_text = " ".join(
        [
            by_step[8]["concept"],
            by_step[13]["concept"],
            STEP_QUIZZES[8][0]["explanation"],
            STEP_QUIZZES[13][0]["explanation"],
        ]
    )
    assert "经历的跨境环节" not in teaching_text
    assert "跨境生产有多长" not in teaching_text
