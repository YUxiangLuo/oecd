"""课程步骤的固定单选题题库。

题干和选项可以公开给前端；正确答案与反馈只在服务端判题后返回。题库版本
随不兼容的题目/答案变更提升；仅澄清措辞且题目 ID、选项 ID 和正确答案不变时
保持版本，避免让学生无意义地重答全部步骤。
"""

from __future__ import annotations

from typing import Any

from gvcsim.indicator_schema import PRODUCTION_LENGTH_OPERATIONAL_DEFINITION

QUIZ_VERSION = "course-quiz-v8"


def _option(option_id: str, label: str) -> dict[str, str]:
    return {"id": option_id, "label": label}


def _question(
    question_id: str,
    prompt: str,
    options: list[dict[str, str]],
    correct: str,
    explanation: str,
) -> dict[str, Any]:
    return {
        "id": question_id,
        "prompt": prompt,
        "options": options,
        "correct": correct,
        "explanation": explanation,
    }


STEP_QUIZZES: dict[int, list[dict[str, Any]]] = {
    1: [
        _question(
            "s01-z-cell",
            "Z 表的一格表示什么？",
            [
                _option("a", "行方向列方提供的中间投入"),
                _option("b", "列方向行方提供的最终产品"),
                _option("c", "行方与列方的产出差额"),
            ],
            "a",
            "Z 表中，行是供给方，列是使用方，所以一格表示行方向列方提供的中间投入。",
        )
    ],
    2: [
        _question(
            "s02-fva",
            "出口中的外国增加值项占比较高，表示什么？",
            [
                _option("a", "出口中的国内增加值更多"),
                _option("b", "出口中来自外国的增加值比例更高"),
                _option("c", "产品一定跨境了更多次"),
            ],
            "b",
            "这个指标看出口的价值构成：外国增加值在出口中占多大比例。它不能直接说明跨境次数。",
        )
    ],
    3: [
        _question(
            "s03-complex",
            "下面哪条生产路径属于复杂 GVC？",
            [
                _option("a", "在本国生产并在本国使用"),
                _option("b", "最终产品直接出口一次"),
                _option("c", "中间品先出口加工，之后产品再次跨境"),
            ],
            "c",
            "复杂 GVC 包含中间品跨境，而且产品在最终使用前累计跨境至少两次。",
        )
    ],
    4: [
        _question(
            "s04-position",
            "前向 GVC 长度大于后向 GVC 长度时，通常表示什么？",
            [
                _option("a", "在这个指标下相对更上游"),
                _option("b", "所有行业都是原材料行业"),
                _option("c", "生产链跨越的国家一定更多"),
            ],
            "a",
            "前向长度÷后向长度大于 1，表示在本课程口径下相对更上游；它不代表所有行业都一样。",
        )
    ],
    5: [
        _question(
            "s05-between",
            "一个节点的网络介数较高，表示什么？",
            [
                _option("a", "它的贸易额一定最大"),
                _option("b", "较多最短路径会经过它"),
                _option("c", "它的直接伙伴一定最多"),
            ],
            "b",
            "介数看多少最短路径经过该节点，不等于贸易总额或直接伙伴数量。",
        )
    ],
    6: [
        _question(
            "s06-trade-viz",
            "图中某国的外国增加值项占比较高，可以直接得出什么结论？",
            [
                _option("a", "它的国内增加值占比也更高"),
                _option("b", "其出口中外国增加值的比例更高"),
                _option("c", "关税造成了这种差异"),
            ],
            "b",
            "图表能显示构成比例，但不能只凭这张图判断差异由什么造成。",
        )
    ],
    7: [
        _question(
            "s07-prod-viz",
            "一个国家的复杂 GVC 份额较高，是否表示该国每个行业都较高？",
            [
                _option("a", "是，国家平均值代表每个行业"),
                _option("b", "否，不同行业可能有很大差异"),
                _option("c", "否，因为任何国家都不能比较"),
            ],
            "b",
            "国家汇总值不代表每个行业；查看行业数据才能发现国内差异。",
        )
    ],
    8: [
        _question(
            "s08-length-viz",
            "当前向 GVC 长度大于后向 GVC 长度时，该经济体相对处于哪里？",
            [
                _option("a", "相对更上游"),
                _option("b", "相对更下游"),
                _option("c", "完全无法判断"),
            ],
            "a",
            f"{PRODUCTION_LENGTH_OPERATIONAL_DEFINITION}在本课程口径下，前向÷后向大于 1 表示相对更上游。",
        )
    ],
    9: [
        _question(
            "s09-network-viz",
            "在网络图中选择一个国家后，中心性数值会重新计算吗？",
            [
                _option("a", "会，只用这个国家的节点计算"),
                _option("b", "不会，仍用全球网络，只改变显示范围"),
                _option("c", "会，改成只计算国家之间的网络"),
            ],
            "b",
            "中心性始终用完整的全球国家×行业网络计算；选择国家只改变屏幕上显示的范围。",
        )
    ],
    10: [
        _question(
            "s10-x-definition-v8",
            "模拟关税暴露 X 怎样计算？",
            [
                _option("a", "冲击前出口份额 × 模拟税率"),
                _option("b", "外国增加值份额 × 真实税率"),
                _option("c", "模拟税率 − 出口份额"),
            ],
            "a",
            "X=w×τ：w 是冲击前出口份额，τ 是模拟税率。X 是教学模拟值，不是真实历史政策。",
        ),
        _question(
            "s10-unit-v8",
            "出口份额为 0.25、模拟税率为 0.20，X 等于多少？",
            [
                _option("a", "0.05，数值越大表示模拟暴露越强"),
                _option("b", "0.45，数值越大表示模拟暴露越弱"),
                _option("c", "0.05，而且能证明真实关税产生了影响"),
            ],
            "a",
            "0.25×0.20=0.05。它只表示模拟暴露强度，不能证明真实关税产生了影响。",
        ),
    ],
    11: [
        _question(
            "s11-metric",
            "步骤 11 观察的结果是什么？",
            [
                _option("a", "网络中的最短路径"),
                _option("b", "出口中的外国增加值项占比"),
                _option("c", "生产链经过的环节数"),
            ],
            "b",
            "步骤 11 看出口的价值构成，不是生产链长度或网络位置。",
        ),
        _question(
            "s11-compare",
            "为什么步骤 11–14 要观察四种不同结果？",
            [
                _option("a", "因为四个结果可以直接相加"),
                _option("b", "因为它们反映贸易、生产、长度和网络的不同方面"),
                _option("c", "因为每一步都必须更换计算方法"),
            ],
            "b",
            "四种结果回答不同问题，应分别查看方向和区间，不能把系数直接相加或比较大小。",
        ),
    ],
    12: [
        _question(
            "s12-metric",
            "步骤 12 的复杂 GVC 份额表示什么？",
            [
                _option("a", "出口中外国增加值的比例"),
                _option("b", "多次跨境生产活动所占的比例"),
                _option("c", "最短路径经过某节点的次数"),
            ],
            "b",
            "复杂 GVC 份额看多次跨境生产活动的构成，不是出口外国增加值或网络介数。",
        ),
        _question(
            "s12-compare",
            "如果 95% 置信区间跨过 0，应该怎样表述？",
            [
                _option("a", "已经证明完全没有影响"),
                _option("b", "当前证据不足以判断变化方向"),
                _option("c", "应换用另一个指标的结果"),
            ],
            "b",
            "区间跨过 0 表示目前看不出明确方向，不等于证明没有影响。",
        ),
    ],
    13: [
        _question(
            "s13-metric",
            "步骤 13 的生产长度主要表示什么？",
            [
                _option("a", "生产过程平均经历多少阶段"),
                _option("b", "出口中外国增加值的比例"),
                _option("c", "一个国家参加了多少贸易协议"),
            ],
            "a",
            f"{PRODUCTION_LENGTH_OPERATIONAL_DEFINITION}它反映平均生产阶段长度，不是外国增加值占比或跨境次数。",
        ),
        _question(
            "s13-compare",
            "为什么不能直接比较生产长度系数和外国增加值占比系数的大小？",
            [
                _option("a", "两者单位不同，表示的内容也不同"),
                _option("b", "生产长度系数一定更大"),
                _option("c", "外国增加值占比没有单位"),
            ],
            "a",
            "单位和含义不同的系数不能直接比大小，也不应直接相加减。",
        ),
    ],
    14: [
        _question(
            "s14-metric",
            "步骤 14 的网络介数主要表示什么？",
            [
                _option("a", "较多最短路径是否经过该节点"),
                _option("b", "该国出口额占世界出口的比例"),
                _option("c", "复杂 GVC 活动所占的比例"),
            ],
            "a",
            "网络介数反映节点在最短路径中的中介位置，不等于出口规模。",
        ),
        _question(
            "s14-compare",
            "汇总步骤 11–14 时，应该怎样做？",
            [
                _option("a", "只报告数值最大的结果"),
                _option("b", "报告四种结果，并说明每种结果的限制"),
                _option("c", "只报告方向明确的结果"),
            ],
            "b",
            "四种结果都应报告；看不出明确方向的结果也要保留，并说明模拟数据和网络指标的限制。",
        ),
    ],
}


def public_quiz(step: int) -> dict[str, Any] | None:
    """返回不含答案与反馈的前端题目。"""
    questions = STEP_QUIZZES.get(step)
    if not questions:
        return None
    return {
        "version": QUIZ_VERSION,
        "questions": [
            {"id": question["id"], "prompt": question["prompt"], "options": question["options"]}
            for question in questions
        ],
    }


def grade(step: int, version: str, answers: Any) -> tuple[bool, dict[str, str], list[dict[str, Any]]]:
    """校验一整步的答案，返回是否全对、稳定化答案和逐题反馈。"""
    questions = STEP_QUIZZES.get(step)
    if not questions:
        raise ValueError(f"步骤 {step} 没有理解检查题")
    if version != QUIZ_VERSION:
        raise ValueError("题目版本已更新，请刷新页面后重新作答")
    if not isinstance(answers, dict):
        raise ValueError("answers 必须是题号到选项的对象")

    expected_ids = [str(question["id"]) for question in questions]
    supplied_ids = {str(key) for key in answers}
    missing = [question_id for question_id in expected_ids if question_id not in supplied_ids]
    unknown = sorted(supplied_ids - set(expected_ids))
    if missing:
        raise ValueError("还有题目未作答:" + "、".join(missing))
    if unknown:
        raise ValueError("包含无法识别的题目:" + "、".join(unknown))

    normalized: dict[str, str] = {}
    results: list[dict[str, Any]] = []
    for question in questions:
        question_id = str(question["id"])
        answer = answers.get(question_id)
        option_ids = {str(option["id"]) for option in question["options"]}
        if not isinstance(answer, str) or answer not in option_ids:
            raise ValueError(f"题目 {question_id} 的选项无法识别")
        normalized[question_id] = answer
        results.append(
            {
                "question_id": question_id,
                "correct": answer == question["correct"],
                "explanation": question["explanation"],
            }
        )
    return all(result["correct"] for result in results), normalized, results


def correct_quiz(step: int) -> dict[str, Any]:
    """返回服务端/测试构造完整会话时使用的规范答案载荷。"""
    questions = STEP_QUIZZES.get(step)
    if not questions:
        raise ValueError(f"步骤 {step} 没有理解检查题")
    return {
        "version": QUIZ_VERSION,
        "answers": {str(question["id"]): str(question["correct"]) for question in questions},
    }


def selected_answers(step: int, quiz: Any) -> list[dict[str, str]]:
    """把已通过的稳定答案解析成报告可读的题干与选项文案。"""
    if not isinstance(quiz, dict):
        return []
    try:
        passed, normalized, _ = grade(step, str(quiz.get("version") or ""), quiz.get("answers"))
    except ValueError:
        return []
    if not passed:
        return []
    rendered = []
    for question in STEP_QUIZZES[step]:
        answer = normalized[str(question["id"])]
        label = next(str(option["label"]) for option in question["options"] if option["id"] == answer)
        rendered.append({"question": str(question["prompt"]), "answer": label})
    return rendered


def validate_bank() -> None:
    """导入时守住题库覆盖、数量和稳定 ID 不变量。"""
    if sorted(STEP_QUIZZES) != list(range(1, 15)):
        raise RuntimeError("题库必须完整覆盖步骤 1–14")
    if sum(len(items) for items in STEP_QUIZZES.values()) != 19:
        raise RuntimeError(f"{QUIZ_VERSION} 必须恰好包含 19 题")
    ids = [str(question["id"]) for questions in STEP_QUIZZES.values() for question in questions]
    if len(ids) != len(set(ids)):
        raise RuntimeError("题目 ID 必须全局唯一")
    for questions in STEP_QUIZZES.values():
        if not 1 <= len(questions) <= 3:
            raise RuntimeError("每步必须有 1–3 题")
        for question in questions:
            options = question["options"]
            option_ids = [option["id"] for option in options]
            if len(options) != 3 or len(option_ids) != len(set(option_ids)):
                raise RuntimeError(f"题目 {question['id']} 必须有三个不同选项")
            if question["correct"] not in option_ids:
                raise RuntimeError(f"题目 {question['id']} 的正确答案不属于选项")


validate_bank()
