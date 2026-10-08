"""课程步骤的固定单选题题库。

题干和选项可以公开给前端；正确答案与反馈只在服务端判题后返回。题库版本
随不兼容的题目/答案变更按步骤提升；仅澄清措辞且题目 ID、选项 ID 和正确答案不变时
保持版本，避免让学生无意义地重答其他步骤。
"""

from __future__ import annotations

from typing import Any

from gvcsim.indicator_schema import PRODUCTION_LENGTH_OPERATIONAL_DEFINITION

QUIZ_VERSION = "course-quiz-v8"
STEP_QUIZ_VERSIONS = {11: "course-quiz-v9", 14: "course-quiz-v9"}


def quiz_version(step: int) -> str:
    """未修改的步骤沿用默认版本，局部换题只使本步旧答案失效。"""
    return STEP_QUIZ_VERSIONS.get(step, QUIZ_VERSION)


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
            "Z 表的一个单元格表示什么？",
            [
                _option("a", "行方（供给方）为列方（使用方）提供的中间投入"),
                _option("b", "列方为行方提供的最终产品"),
                _option("c", "行方与列方的产出差额"),
            ],
            "a",
            "Z 表中，行是供给方，列是使用方，所以一个单元格表示行方为列方提供的中间投入。",
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
            "前向 GVC 段长度大于后向 GVC 段长度时，通常表示什么？",
            [
                _option("a", "在这个指标下相对更上游"),
                _option("b", "所有行业都是原材料行业"),
                _option("c", "生产链跨越的国家一定更多"),
            ],
            "a",
            "前向 GVC 段长度 ÷ 后向 GVC 段长度（GVCPs）大于 1，表示相对更上游（更靠近原料、零部件这一端）；它不说明该国都是原材料行业，也不说明生产链经过的国家更多。",
        )
    ],
    5: [
        _question(
            "s05-between",
            "一个节点的介数较高，表示什么？",
            [
                _option("a", "它的贸易额一定最大"),
                _option("b", "较多最短路线会经过它"),
                _option("c", "它的直接伙伴一定最多"),
            ],
            "b",
            "介数看有多少条最短路线经过这个节点（只看连接、不看金额），不等于贸易总额或直接伙伴数量。",
        )
    ],
    6: [
        _question(
            "s06-trade-viz",
            "图中 A 国的外国增加值项占比比 B 国高，能直接得出什么结论？",
            [
                _option("a", "A 国的国内增加值占比也更高"),
                _option("b", "A 国出口中外国增加值的比例更高"),
                _option("c", "关税造成了这种差异"),
            ],
            "b",
            "图表能显示构成比例，但不能只凭这张图判断差异由什么造成。",
        )
    ],
    7: [
        _question(
            "s07-prod-viz",
            "一个国家的复杂 GVC 生产份额较高，是否表示该国每个行业都较高？",
            [
                _option("a", "是，国家平均值代表每个行业"),
                _option("b", "否，不同行业可能有很大差异"),
                _option("c", "否，因为任何国家都不能比较"),
            ],
            "b",
            "国家汇总值不代表每个行业；到“行业排名”看各行业，才能看出一国内部的差别。",
        )
    ],
    8: [
        _question(
            "s08-length-viz",
            "如果前向 GVC 段长度大于后向 GVC 段长度，该经济体相对处在上游还是下游？",
            [
                _option("a", "相对更上游"),
                _option("b", "相对更下游"),
                _option("c", "完全无法判断"),
            ],
            "a",
            "前向 GVC 段长度 ÷ 后向 GVC 段长度（GVC 位置指数）大于 1，说明从产地往后追的 GVC 段比从最终品往回追的更长，经济体相对更上游。",
        )
    ],
    9: [
        _question(
            "s09-network-viz",
            "在本步图表里换选国家后，中心性数值会重新计算吗？",
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
            "关税暴露 X 怎样计算？",
            [
                _option("a", "首年对美出口份额 w × 加征税率 τ"),
                _option("b", "外国增加值项占比 × 加征税率 τ"),
                _option("c", "加征税率 τ − 首年对美出口份额 w"),
            ],
            "a",
            "X = w × τ：w 是首年对美出口份额，τ 是加征税率。",
        ),
        _question(
            "s10-unit-v8",
            "首年对美出口份额 w 为 25%、加征税率 τ 为 20%，X 等于多少？",
            [
                _option("a", "0.05，即 5 个百分点；数值越大表示暴露越强"),
                _option("b", "0.45，即 45 个百分点；数值越大表示暴露越弱"),
                _option("c", "0.05，即 5 个百分点；数值越大表示暴露越弱"),
            ],
            "a",
            "25% × 20% = 0.25 × 0.20 = 0.05，即 5 个百分点。X 越大，表示这个国家×行业的出口受新关税影响越大，暴露越强。",
        ),
    ],
    11: [
        _question(
            "s11-metric",
            "步骤 11 默认的结果变量 Y 是什么？",
            [
                _option("a", "网络中的最短路径"),
                _option("b", "出口中的外国增加值项占比"),
                _option("c", "生产链经过的环节数"),
            ],
            "b",
            "步骤 11 看出口的价值构成，不是生产链长度或网络位置。",
        ),
        _question(
            "s11-reading-v9",
            "独立读数练习：估计值为 −1.20 个百分点（X 每高 1 个百分点，Y 平均相差多少），"
            "95% 区间为 [−1.50, −0.90] 个百分点。哪种表述正确？",
            [
                _option("a", "X 每高 1 个百分点的国家×行业，Y 平均低 1.20 个百分点"),
                _option("b", "X 每高 1 个百分点的国家×行业，Y 相对低 1.20%"),
                _option("c", "X 每高 1 个百分点的国家×行业，Y 平均低 1.50 个百分点"),
            ],
            "a",
            "−1.20 表示 X 每高 1 个百分点的国家×行业，Y 平均低 1.20 个百分点，不是相对低 1.20%。"
            "整个区间都低于 0，方向明确；−1.50 只是区间的一端，不是平均差异。"
            "这是独立算例，不是你本次回归的实际结果。",
        ),
    ],
    12: [
        _question(
            "s12-metric",
            "步骤 12 默认的 Y——复杂 GVC 生产份额——表示什么？",
            [
                _option("a", "出口中外国增加值的比例"),
                _option("b", "多次跨境生产活动所占的比例"),
                _option("c", "最短路径经过某节点的次数"),
            ],
            "b",
            "复杂 GVC 生产份额看多次跨境生产活动的构成，不是出口外国增加值或网络介数。",
        ),
        _question(
            "s12-compare",
            "如果 95% 区间包含 0，应该怎样表述？",
            [
                _option("a", "已经证明完全没有影响"),
                _option("b", "方向还不确定，不能判断 X 越高时 Y 越高还是越低"),
                _option("c", "应换用另一个指标的结果"),
            ],
            "b",
            "区间包含 0 表示方向还不确定，不等于证明没有影响。",
        ),
    ],
    13: [
        _question(
            "s13-metric",
            "步骤 13 默认的 Y——前向 GVC 段长度——主要表示什么？",
            [
                _option("a", "增加值平均经过多少个生产环节"),
                _option("b", "出口中外国增加值的比例"),
                _option("c", "一个国家参加了多少贸易协议"),
            ],
            "a",
            f"{PRODUCTION_LENGTH_OPERATIONAL_DEFINITION}它也不是外国增加值项占比。",
        ),
        _question(
            "s13-compare",
            "为什么不能直接比较前向 GVC 段长度和外国增加值项占比这两个估计值的大小？",
            [
                _option("a", "两者单位不同，表示的内容也不同"),
                _option("b", "长度的估计值一定更大"),
                _option("c", "外国增加值项占比没有单位"),
            ],
            "a",
            "单位和含义不同的估计值不能直接比大小，也不应直接相加减。",
        ),
    ],
    14: [
        _question(
            "s14-metric-v9",
            "步骤 14 默认的 Y——加权总度——表示什么？",
            [
                _option("a", "节点买入和卖出的流量之和"),
                _option("b", "有多少条最短路径经过这个节点"),
                _option("c", "该国出口额占世界出口的比例"),
            ],
            "a",
            "加权总度 = 加权入度 + 加权出度，量的是节点买入与卖出的流量规模；最短路径是介数看的东西，出口占比不是网络指标。",
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
            "四种结果都应报告；看不出明确方向的结果也要保留，并说明网络指标单位不同的限制。",
        ),
    ],
}


def public_quiz(step: int) -> dict[str, Any] | None:
    """返回不含答案与反馈的前端题目。"""
    questions = STEP_QUIZZES.get(step)
    if not questions:
        return None
    return {
        "version": quiz_version(step),
        "questions": [
            {"id": question["id"], "prompt": question["prompt"], "options": question["options"]}
            for question in questions
        ],
    }


# Shown after a wrong answer: where to look or what to tell apart, without naming the right option
# (retries are unlimited, so an explanation that states the answer would make the check meaningless).
# The full explanation is shown once the answer is correct.
HINTS: dict[str, str] = {
    "s01-z-cell": "提示：Z 表的行和列分别代表谁？回到表格，看左上角“列·使用方 → / 行·供给方 ↓”的标注。",
    "s02-fva": "提示：这个指标的分子和分母各是什么？它描述的是出口价值的构成，还是跨境次数？",
    "s03-complex": "提示：逐条数一数：每条路径里跨境的是中间品还是最终品？在最终使用前一共跨境了几次？再对照本步对复杂 GVC 的定义。",
    "s04-position": "提示：这是前向 GVC 段长度与后向 GVC 段长度之比（GVCPs）。想想前向长度从哪一端开始追踪，比值大于 1 意味着哪一端更长。",
    "s05-between": "提示：回看本步“在一个小网络上看度与介数怎么数”，介数数的是什么？",
    "s06-trade-viz": "提示：一张构成图能告诉你“比例是多少”，能否告诉你“为什么”？",
    "s07-prod-viz": "提示：国家整体值是怎样汇总出来的？到“行业排名”看看各行业是否一样。",
    "s08-length-viz": "提示：回忆步骤 4：前向 GVC 段长度 ÷ 后向 GVC 段长度（GVC 位置指数）大于 1 时，经济体更靠上游还是下游？",
    "s09-network-viz": "提示：中心性是在哪张网络上计算的？回看步骤 5 的计算方法，想想换选国家时这张网络本身有没有变。",
    "s10-x-definition-v8": "提示：X 由哪两个量相乘？对照本步逐年表中的“X = w × τ”。",
    "s10-unit-v8": "提示：先算 25% × 20%（即 0.25 × 0.20）；再想想这个数越大，表示暴露越强还是越弱。",
    "s11-metric": "提示：看本步标题和“结果指标 Y”下拉框里标着“本步默认”的那一项。",
    "s11-reading-v9": "提示：分清“个百分点”和“%”；估计值和区间端点，哪个才是平均差异？",
    "s12-metric": "提示：复杂 GVC 生产份额的分子是哪类生产活动？回看步骤 3 的四类生产活动。",
    "s12-compare": "提示：区间包含 0 时，正负两个方向都在区间内。这能说明“没有影响”吗？",
    "s13-metric": "提示：回看步骤 4：生产长度由累计总产出除以关联增加值得到，它是什么的平均数？",
    "s13-compare": "提示：两个估计值的单位分别是什么？单位不同的数能直接比大小吗？",
    "s14-metric-v9": "提示：回看步骤 5：加权总度把哪两个方向的流量加在一起？它量的是金额还是路径？",
    "s14-compare": "提示：只挑一部分结果会让结论产生什么偏差？想想读者只看到被挑出的结果时会得出什么印象。",
}


def grade(step: int, version: str, answers: Any) -> tuple[bool, dict[str, str], list[dict[str, Any]]]:
    """校验一整步的答案，返回是否全对、稳定化答案和逐题反馈。"""
    questions = STEP_QUIZZES.get(step)
    if not questions:
        raise ValueError(f"步骤 {step} 没有理解检查题")
    if version != quiz_version(step):
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
                "explanation": question["explanation"] if answer == question["correct"] else HINTS[question_id],
            }
        )
    return all(result["correct"] for result in results), normalized, results


def correct_quiz(step: int) -> dict[str, Any]:
    """返回服务端/测试构造完整会话时使用的规范答案载荷。"""
    questions = STEP_QUIZZES.get(step)
    if not questions:
        raise ValueError(f"步骤 {step} 没有理解检查题")
    return {
        "version": quiz_version(step),
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
            if not HINTS.get(str(question["id"])):
                raise RuntimeError(f"题目 {question['id']} 缺少答错时的提示")


validate_bank()
