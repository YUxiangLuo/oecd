"""Default quizzes and pure grading against an explicit teacher-configured snapshot."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from gvcsim.indicator_schema import PRODUCTION_LENGTH_OPERATIONAL_DEFINITION
from gvcsim.request_validation import validate_text

QUIZ_VERSION = "course-quiz-v8"
# Regression defaults check basic concepts without requiring optional model experiments.
STEP_QUIZ_VERSIONS = {step: "course-quiz-v11" for step in range(10, 15)}


def quiz_version(step: int, bank: dict[str, Any] | None = None) -> str:
    """未修改的步骤沿用默认版本，局部换题只使本步旧答案失效。"""
    if bank is not None:
        return str(bank["steps"][str(step)]["version"])
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
            "介数是经过这个节点的最短路线所占比例，对所有节点对求和（未归一化；只看连接、不看金额）；它高说明较多最短路线经过这个节点，不等于贸易总额或直接伙伴数量。",
        )
    ],
    6: [
        _question(
            "s06-trade-viz",
            "假设 A 国的外国增加值项占比比 B 国高，能直接得出什么结论？",
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
            "前向 GVC 段长度 ÷ 后向 GVC 段长度（GVC 位置指数）大于 1，说明从增加值来源端向下游追踪的 GVC 段长于从最终品端回溯的 GVC 段，经济体相对更上游。",
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
            "s10-lag-v10",
            # Applied to one row, so the column's name ("上一年的 X") does not give the answer away.
            "逐年表里 2020 年那一行的 L1.X，取的是哪个值？",
            [
                _option("a", "同一国家和行业 2021 年的 X"),
                _option("b", "同一国家和行业 2019 年的 X"),
                _option("c", "2020 年的 X 乘以 2"),
            ],
            "b",
            "L1.X 就是上一年的 X。例如，2020 年这一行的 L1.X，取同一国家和行业在 2019 年的 X。",
        ),
        _question(
            "s10-fixed-w-v10",
            "计算 X 时，出口份额 w 使用哪一年的数据？",
            [
                _option("a", "每一年的当年数据"),
                _option("b", "加税结束后的数据"),
                _option("c", "固定使用首年（加税前）的数据"),
            ],
            "c",
            "w 固定使用首年、加税前的对美出口份额。对同一国家和行业，之后 X 的变化只来自税率 τ。",
        ),
    ],
    11: [
        _question(
            "s11-cumulative-v10",
            "默认模型的“两年累计”怎样得到？",
            [
                _option("a", "当年 X 的系数与上一年 X（L1.X）的系数之和"),
                _option("b", "当年 X 的系数乘以 2"),
                _option("c", "2018 年和 2019 年两年 Y 的平均值"),
            ],
            "a",
            "模型同时放入当年的 X 和上一年的 X：前者是加税当年的关联，后者是次年再出现的关联，两者之和是两年累计的关联。",
        ),
        _question(
            "s11-control-v10",
            "汇率变动等控制变量有什么作用？",
            [
                _option("a", "为了让 R² 变大"),
                _option("b", "因为汇率变动是关税暴露 X 的一部分"),
                _option("c", "在比较 X 与 Y 时，也考虑汇率等其他因素"),
            ],
            "c",
            "控制变量用于考虑其他相关因素，减少把它们与 Y 的关联混到 X 上。加入控制变量并不自动证明因果关系。",
        ),
        _question(
            "s11-reading-v10",
            "外国增加值项占比从 20% 变为 18%，相差多少个百分点？",
            [
                _option("a", "高 2 个百分点"),
                _option("b", "低 2 个百分点"),
                _option("c", "低 18 个百分点"),
            ],
            "b",
            "18% − 20% = −2 个百分点。“百分点”表示两个比例的差，不是相对变化的百分比。这是单位练习，不是本次回归结果。",
        ),
    ],
    12: [
        _question(
            "s12-metric",
            "步骤 12 默认的 Y——复杂 GVC 生产份额——表示什么？",
            [
                _option("a", "出口中外国增加值的比例"),
                _option("b", "多次跨境生产活动所占的比例"),
                _option("c", "最短路线经过某节点的次数"),
            ],
            "b",
            "复杂 GVC 生产份额看多次跨境生产活动的构成，不是出口外国增加值或网络介数。",
        ),
        _question(
            "s12-compare",
            "回归结果的 95% 区间包含 0，应该怎样表述？",
            [
                _option("a", "已经证明完全没有关联"),
                _option("b", "方向还不确定，不能判断 X 越高时 Y 越高还是越低"),
                _option("c", "应换用另一个指标的结果"),
            ],
            "b",
            "区间包含 0 表示方向还不确定，不等于证明没有关联。",
        ),
        _question(
            "s12-share-v11",
            # A case to reason through, not the result card's caution repeated as a question.
            "某国复杂 GVC 生产份额下降了，同期它的增加值总额上升了。复杂 GVC 生产的绝对量一定下降了吗？",
            [
                _option("a", "一定下降，份额下降就是绝对量下降"),
                _option("b", "一定上升，因为增加值总额上升了"),
                _option("c", "不一定：份额下降、总额上升时，绝对量可能下降、不变或上升"),
            ],
            "c",
            "绝对量 = 份额 × 增加值总额。份额下降、总额上升，两者相乘的结果要看各自变了多少，不能只凭份额判断。",
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
            "假如步骤 11 的估计是 -0.5 个百分点，步骤 13 的是 -0.02 个长度单位，能说步骤 11 的关联是步骤 13 的 25 倍吗？",
            [
                _option("a", "不能：两者单位不同，要先换算成同一尺度（如标准差）再比较"),
                _option("b", "能：0.5 ÷ 0.02 = 25"),
                _option("c", "能：两者都是 X 每高 1 个百分点时的变化"),
            ],
            "a",
            "百分点和长度单位不能直接相除比较。换算成标准差后，两步的幅度才在同一尺度上，可以并列比较。",
        ),
        _question(
            "s13-effects-v10",
            "“国家×行业”固定效应主要扣除什么差异？",
            [
                _option("a", "每一年所有国家共同的变化"),
                _option("b", "各个国家和行业组合长期不变的水平差异"),
                _option("c", "所有年份的关税变化"),
            ],
            "b",
            "每个国家×行业可以有自己的固定起点，模型扣除这些长期不变的差异。每年共同的变化由年份固定效应处理。",
        ),
    ],
    14: [
        _question(
            "s14-metric-v9",
            "步骤 14 默认的 Y——加权总度——表示什么？",
            [
                _option("a", "节点买入和卖出的流量之和"),
                _option("b", "有多少条最短路线经过这个节点"),
                _option("c", "该国出口额占世界出口的比例"),
            ],
            "a",
            "加权总度 = 加权入度 + 加权出度，量的是节点买入与卖出的流量规模（步骤 5 以百万美元计）；步骤 14 的 Y 按真实加权总度的排名校准生成，单位是中心性原始单位，读法相同，但不是金额。最短路线属于介数衡量的内容，出口占比不是网络指标。",
        ),
        _question(
            "s14-compare-v10",
            "汇总步骤 11–14 时，应该怎样做？",
            [
                _option("a", "只报告数值最大的结果"),
                _option("b", "报告四步的两年累计结果和区间，并说明每种结果的限制"),
                _option("c", "只报告方向明确的结果"),
            ],
            "b",
            "四步结果都应报告；单位不同的结果换算成标准差后再并列，看不出明确方向的结果也要保留，并说明各自的限制。",
        ),
        _question(
            "s14-source-v11",
            "本课程的模拟回归结果，可以直接当作真实关税政策的证据吗？",
            [
                _option("a", "可以，只要结果显著"),
                _option("b", "可以，只要样本数量多"),
                _option("c", "不可以，这些结果用于教学练习"),
            ],
            "c",
            "关税情景和回归的 Y 由课程设定或生成，用来练习建模和读结果，不能据此判断真实政策效果。",
        ),
    ],
}


def public_quiz(step: int, bank: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """返回不含答案与反馈的前端题目。"""
    questions = _questions(step, bank)
    if not questions:
        return None
    return {
        "version": quiz_version(step, bank),
        "questions": [
            {
                "id": question["id"],
                "kind": question.get("kind", "single_choice"),
                "prompt": question["prompt"],
                "options": deepcopy(question["options"]),
            }
            for question in questions
        ],
    }


# Shown after a wrong answer: where to look or what to tell apart, without naming the right option
# (retries are unlimited, so an explanation that states the answer would make the check meaningless).
# The full explanation is shown once the answer is correct.
HINTS: dict[str, str] = {
    "s01-z-cell": "提示：Z 表的行和列分别代表谁？回到表格，看左上角“列·使用方 → / 行·供给方 ↓”的标注。",
    "s02-fva": "提示：这个指标的分子和分母各是什么？它描述的是出口价值的构成，还是跨境次数？",
    "s03-complex": "提示：逐条核对：每条路径里跨境的是中间品还是最终品？在最终使用前一共跨境了几次？再对照本步对复杂 GVC 的定义。",
    "s04-position": "提示：这是前向 GVC 段长度与后向 GVC 段长度之比（GVCPs）。想想前向长度从哪一端开始追踪，比值大于 1 意味着哪一端更长。",
    "s05-between": "提示：回看本步“用小型网络演示度、介数与接近中心性的计算”，介数统计的是什么？",
    "s06-trade-viz": "提示：一张构成图能告诉你“比例是多少”，能否告诉你“为什么”？",
    "s07-prod-viz": "提示：国家整体值是怎样汇总出来的？到“行业排名”查看各行业是否相同。",
    "s08-length-viz": "提示：回忆步骤 4：前向 GVC 段长度 ÷ 后向 GVC 段长度（GVC 位置指数）大于 1 时，经济体更靠上游还是下游？",
    "s09-network-viz": "提示：中心性是在哪张网络上计算的？回看步骤 5 的计算方法，想想换选国家时这张网络本身有没有变。",
    "s10-x-definition-v8": "提示：回看本步“关税暴露 X”一节和所选例子的逐年读数：X 要同时反映对美出口占多大比重、加征的税率有多高，这两个量怎样组合？其中任一项为 0 时，X 应该是多少？",
    "s10-lag-v10": "提示：对照逐年读数中 X 和 L1.X 两列，看看相邻两行的数值。",
    "s10-fixed-w-v10": "提示：回看本步对 w 的说明。如果 w 每年都换成当年的数据，加税后出口结构本身的变化也会混进 X；要让 X 的变化只来自税率，w 应该怎样取？",
    "s11-cumulative-v10": "提示：回看“默认模型”的方程，β₁ 和 β₂ 分别乘的是什么？",
    "s11-control-v10": "提示：除了关税暴露，外国增加值项占比还可能随哪些因素变化？",
    "s11-reading-v10": "提示：先判断 18% 比 20% 高还是低，再用两者相减。",
    "s12-metric": "提示：复杂 GVC 生产份额的分子是哪类生产活动？回看步骤 3 的四类生产活动。",
    "s12-compare": "提示：想一想，区间里仍然有 0 时，能不能排除没有差异的可能？",
    "s12-share-v11": "提示：复杂 GVC 生产的绝对量等于份额乘以什么？两者一降一升时，乘积会怎样变？",
    "s13-metric": "提示：回看步骤 4：生产长度由累计总产出除以关联增加值得到，它是什么的平均数？",
    "s13-compare": "提示：比较两个数的大小之前要先确认什么？想想步骤 13、14 的条形图为什么换算成“个标准差”再并排画。",
    "s13-effects-v10": "提示：回看本步“公式里各项的意思”：α 和 λ 分别扣掉了什么？",
    "s14-metric-v9": "提示：回看步骤 5：加权总度把哪两个方向的流量加在一起？它衡量的是流量规模，还是最短路线？",
    "s14-compare-v10": "提示：只挑一部分结果会让结论产生什么偏差？单位不同的结果怎样才能并排比较？",
    "s14-source-v11": "提示：回看结果卡上的“教学数据”说明，确认这些数据是怎样得到的。",
}


def grade(
    step: int, version: str, answers: Any, bank: dict[str, Any] | None = None
) -> tuple[bool, dict[str, str], list[dict[str, Any]]]:
    """校验一整步的答案，返回是否全对、稳定化答案和逐题反馈。"""
    questions = _questions(step, bank)
    if not questions:
        raise ValueError(f"步骤 {step} 没有理解检查题")
    if version != quiz_version(step, bank):
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
                "explanation": (question.get("explanation") or "回答正确。")
                if answer == question["correct"]
                else (
                    question.get("hint", HINTS.get(question_id) if bank is None else None)
                    or "回答不正确，请重新阅读题目与选项后再试。"
                ),
            }
        )
    return all(result["correct"] for result in results), normalized, results


def correct_quiz(step: int, bank: dict[str, Any] | None = None) -> dict[str, Any]:
    """返回服务端/测试构造完整会话时使用的规范答案载荷。"""
    questions = _questions(step, bank)
    if not questions:
        raise ValueError(f"步骤 {step} 没有理解检查题")
    return {
        "version": quiz_version(step, bank),
        "answers": {str(question["id"]): str(question["correct"]) for question in questions},
    }


def selected_answers(step: int, quiz: Any, bank: dict[str, Any] | None = None) -> list[dict[str, str]]:
    """把已通过的稳定答案解析成报告可读的题干与选项文案。"""
    if not isinstance(quiz, dict):
        return []
    try:
        passed, normalized, _ = grade(step, str(quiz.get("version") or ""), quiz.get("answers"), bank)
    except ValueError:
        return []
    if not passed:
        return []
    rendered = []
    for question in _questions(step, bank):
        answer = normalized[str(question["id"])]
        label = next(str(option["label"]) for option in question["options"] if option["id"] == answer)
        rendered.append({"question": str(question["prompt"]), "answer": label})
    return rendered


def validate_bank() -> None:
    """导入时守住题库覆盖、数量和稳定 ID 不变量。"""
    if sorted(STEP_QUIZZES) != list(range(1, 15)):
        raise RuntimeError("题库必须完整覆盖步骤 1–14")
    if sum(len(items) for items in STEP_QUIZZES.values()) != 24:
        raise RuntimeError("题库必须恰好包含 24 题")
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


def _questions(step: int, bank: dict[str, Any] | None) -> list[dict[str, Any]]:
    if type(step) is not int or not 1 <= step <= 14:
        return []
    return STEP_QUIZZES[step] if bank is None else bank["steps"][str(step)]["questions"]


def default_bank() -> dict[str, Any]:
    """Return an independent, complete default snapshot; never consult storage."""
    return {
        "revision": 0,
        "steps": {
            str(step): {
                "version": quiz_version(step),
                "questions": [{**deepcopy(q), "kind": "single_choice", "hint": HINTS[q["id"]]} for q in questions],
                "updated_at": None,
                "updated_by": None,
            }
            for step, questions in STEP_QUIZZES.items()
        },
    }


def validate_questions(step: int, raw: Any) -> list[dict[str, Any]]:
    """Normalize teacher input: IDs ≤80, prompts ≤500, feedback ≤1000, labels ≤200 characters."""
    if type(step) is not int or not 1 <= step <= 14:
        raise ValueError("步骤必须为 1–14")
    if not isinstance(raw, list) or not 1 <= len(raw) <= 3:
        raise ValueError("每步必须有 1–3 题")

    def text(value: Any, limit: int, optional: bool = False) -> str:
        if optional and value is None:
            return ""
        if not isinstance(value, str) or len(value) > limit or (not optional and not value.strip()):
            raise ValueError("字段为空或超过长度限制")
        return validate_text(value).strip()

    normalized = []
    ids: set[str] = set()
    for q in raw:
        required = {"id", "kind", "prompt", "options", "correct"}
        if not isinstance(q, dict) or not required <= q.keys() or q.keys() - required - {"hint", "explanation"}:
            raise ValueError("题目字段缺失或包含未知字段")
        item = {key: text(q[key], 80 if key in {"id", "correct"} else 500) for key in ("id", "prompt", "correct")}
        if item["id"] in ids:
            raise ValueError("题目 ID 重复")
        ids.add(item["id"])
        kind = q["kind"]
        if kind not in ("true_false", "single_choice"):
            raise ValueError("无法识别的题型")
        options = q["options"]
        if not isinstance(options, list) or not 2 <= len(options) <= 4:
            raise ValueError("选项必须有 2–4 个")
        opts = []
        for option in options:
            if not isinstance(option, dict) or set(option) != {"id", "label"}:
                raise ValueError("选项包含未知或缺失字段")
            opts.append({"id": text(option["id"], 80), "label": text(option["label"], 200)})
        if len({o["id"] for o in opts}) != len(opts) or len({o["label"] for o in opts}) != len(opts):
            raise ValueError("选项重复")
        if kind == "true_false" and opts != [{"id": "true", "label": "正确"}, {"id": "false", "label": "错误"}]:
            raise ValueError("判断题选项必须固定为 true/false 正确/错误")
        if item["correct"] not in {o["id"] for o in opts}:
            raise ValueError("答案不属于选项")
        normalized.append(
            {
                **item,
                "kind": kind,
                "options": opts,
                "explanation": text(q.get("explanation", ""), 1000, True),
                "hint": text(q.get("hint", ""), 1000, True),
            }
        )
    return normalized


validate_bank()
