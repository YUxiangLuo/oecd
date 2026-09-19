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
            "Z 表的一格应该怎样解释？",
            [
                _option("a", "行方国家×行业向列方国家×行业提供的中间投入"),
                _option("b", "列方向行方提供的最终需求"),
                _option("c", "两个国家的总产出之差"),
            ],
            "a",
            "Z 的行是供给方、列是使用方；单元格记录供给方向使用方提供的中间投入。",
        )
    ],
    2: [
        _question(
            "s02-fva",
            "外国增加值项占比较高最直接说明什么？",
            [
                _option("a", "国内增加值返回本国更多"),
                _option("b", "出口分解中外国增加值这一项所占比例更高"),
                _option("c", "产品跨境次数必然更多"),
            ],
            "b",
            "占比读的是构成：外国增加值这一项在出口中占多少。它不直接告诉我们产品跨境多少次，也不代表这一项的金额一定更大。",
        )
    ],
    3: [
        _question(
            "s03-complex",
            "下面哪种活动属于复杂 GVC？",
            [
                _option("a", "增加值只满足国内最终需求"),
                _option("b", "最终品直接出口一次后被吸收"),
                _option("c", "增加值至少一次中间品跨境，最终吸收前累计跨境两次及以上"),
            ],
            "c",
            "复杂 GVC 至少含一次中间品跨境，且累计跨境两次及以上；例如 A 的中间品进入 B，再由 B 以最终品形式出口到 C。",
        )
    ],
    4: [
        _question(
            "s04-position",
            "某经济体的前向 GVC 段长度为 5.4，后向 GVC 段长度为 3.0。最稳妥的结论是什么？",
            [
                _option("a", "GVCPs=1.8，在该口径下位置相对更上游"),
                _option("b", "该经济体的所有行业都属于原材料行业"),
                _option("c", "生产链一定恰好跨越 5.4 个国家"),
            ],
            "a",
            "GVCPs=5.4/3.0=1.8，大于 1 表示相对更靠近上游投入端；它是加权平均后的相对位置，不能给所有行业贴标签，也不是跨境国家数。",
        )
    ],
    5: [
        _question(
            "s05-between",
            "本课程全正边二值介数较高表示什么？",
            [
                _option("a", "节点的贸易总额一定最大"),
                _option("b", "节点位于较多有向最短路径上"),
                _option("c", "节点的直接贸易伙伴一定最多"),
            ],
            "b",
            "介数看最短路径经过节点的份额，等长路径会分摊；每条正流量边都视为等长。它不是总流量或伙伴数，也不能在未做边阈值敏感性检验时当作经济瓶颈证据。",
        )
    ],
    6: [
        _question(
            "s06-trade-viz",
            "一个经济体的外国增加值项占比较高，最稳妥的读图结论是什么？",
            [
                _option("a", "它的国内增加值占比一定更高"),
                _option("b", "出口分解中外国增加值这一项所占比例更高"),
                _option("c", "已经证明关税造成了这种结构"),
            ],
            "b",
            "图表可以说明这一项的构成比例较高，但不能仅凭它判断差异是不是由关税造成的。",
        )
    ],
    7: [
        _question(
            "s07-prod-viz",
            "国家复杂 GVC 份额较高，能否说明该国所有行业都同样高？",
            [
                _option("a", "能，国家汇总可以代表每个行业"),
                _option("b", "不能，国家汇总可能掩盖明显的行业差异"),
                _option("c", "不能，因为国家之间完全无法比较"),
            ],
            "b",
            "国家汇总不代表每个行业。切到行业明细，才能看出一国内部的差异。",
        )
    ],
    8: [
        _question(
            "s08-length-viz",
            "当 PLv_GVC 大于 PLy_GVC 时，该经济体通常处于什么位置？",
            [
                _option("a", "相对更上游"),
                _option("b", "相对更下游"),
                _option("c", "因为是比值，所以无法判断"),
            ],
            "a",
            f"{PRODUCTION_LENGTH_OPERATIONAL_DEFINITION}按本课程位置口径，GVCPs 大于 1 表示相对更上游；应比较前后向 GVC 长度，而不是用图中的中位数象限判断上下游。",
        )
    ],
    9: [
        _question(
            "s09-network-viz",
            "在网络图中下钻某个国家后，中心性数值是怎样得到的？",
            [
                _option("a", "只用筛选后的节点重新计算"),
                _option("b", "仍在完整全球国家×行业网络上计算，只改变展示范围"),
                _option("c", "改用国家完全图的中心性"),
            ],
            "b",
            "中心性始终基于完整全球国家×行业网络；国家筛选只用于展示，不改变计算图。",
        )
    ],
    10: [
        _question(
            "s10-x-definition-v8",
            "步骤 10 的教学关税 X 怎样计算？",
            [
                _option("a", "固定冲击前销往模拟加税市场的出口份额 × 模拟税率"),
                _option("b", "当年 OECD 外国增加值份额 × 真实税率"),
                _option("c", "模拟税率减去出口份额"),
            ],
            "a",
            "w 是固定冲击前出口份额，τ 是小数形式模拟税率，X=w×τ；X 不是历史政策观测。",
        ),
        _question(
            "s10-unit-v8",
            "若 w=0.25、模拟税率 τ=0.20，则 X 及其方向如何解释？",
            [
                _option("a", "X=0.05，数值越大表示模拟关税暴露越强"),
                _option("b", "X=0.45，数值越大表示暴露越弱"),
                _option("c", "X=5%，因此已证明现实关税造成结果变化"),
            ],
            "a",
            "0.25×0.20=0.05，单位为 share×decimal tariff rate；这是模拟暴露，不支持现实因果结论。",
        ),
    ],
    11: [
        _question(
            "s11-metric",
            "本步的外国增加值项占比主要观察什么？",
            [
                _option("a", "一国生产网络里各节点对最短路径经过该节点的份额之和"),
                _option("b", "出口分解中外国增加值这一项所占的比例"),
                _option("c", "增加值到最终吸收经历了多少个跨境生产环节"),
            ],
            "b",
            "本步看出口价值构成，不是生产链长度或网络位置。占比下降不能直接证明生产回流，也不能拿它与长度、网络系数比大小。",
        ),
        _question(
            "s11-compare",
            "步骤 11–14 为什么要分别回归四类指标，而不能只看其中一个系数？",
            [
                _option("a", "四个系数量纲相同，取平均就是总效应"),
                _option("b", "同一套冲击可能打在贸易结构、生产分工、链条长度和网络位置上，需要并读方向和区间是否过 0"),
                _option("c", "每一步必须换一种估计方法，否则回归无效"),
            ],
            "b",
            "四步是同一研究问题换指标。先看是否允许推断，再并读方向与区间；无法评估时写明原因。不同指标的系数不能直接比大小。",
        ),
    ],
    12: [
        _question(
            "s12-metric",
            "本步的复杂 GVC 生产份额主要衡量什么？",
            [
                _option("a", "出口里外国增加值的比重"),
                _option("b", "增加值在最终吸收前是否经历多次跨境生产"),
                _option("c", "节点在无权最短路径上的中介位置"),
            ],
            "b",
            "复杂 GVC 份额描述多次跨境活动在 SVA 中的构成，不是规模或嵌入深度的通用标尺，也不是贸易流 FVA 或网络介数。",
        ),
        _question(
            "s12-compare",
            "如果本步或另外一步的 95% 置信区间跨过 0，最稳妥的读法是什么？",
            [
                _option("a", "已经证明冲击没有影响复杂 GVC 份额"),
                _option("b", "当前证据不足以判断变化方向，这不等于「没有效应」"),
                _option("c", "应改用网络介数的系数代替本步结论"),
            ],
            "b",
            "区间跨 0 是「看不出方向」，不是零效应证明。四步并读时，这一步可以记成「看不出」，另一步仍可能看得出方向。",
        ),
    ],
    13: [
        _question(
            "s13-metric",
            "本步的前向 GVC 生产长度主要衡量什么？",
            [
                _option("a", "GVC 活动诱发累计总产出相对关联增加值的平均生产阶段长度"),
                _option("b", "总出口中外国增加值的份额"),
                _option("c", "一国是否位于最多的贸易协议中"),
            ],
            "a",
            f"PLv_GVC 采用前向口径。{PRODUCTION_LENGTH_OPERATIONAL_DEFINITION}VA 为正时可理解为加权阶段数，负 VA 时为有符号比值。长度变短有多种机制，不能单凭系数判定回流或近岸。",
        ),
        _question(
            "s13-compare",
            "把本步的长度系数和步骤 11 的外国增加值项占比系数直接相减，为什么不妥当？",
            [
                _option("a", "两个数字的单位不同，回答的也不是同一个量"),
                _option("b", "长度系数永远更大，相减没有意义"),
                _option("c", "只有事件研究的结果才能和份额相比"),
            ],
            "a",
            "先核对结果状态，再并读方向与区间；不要对不同单位的点估计做算术。四步不必换方法才能比较。",
        ),
    ],
    14: [
        _question(
            "s14-metric",
            "本步的全正边二值网络介数主要衡量什么？",
            [
                _option("a", "各节点对有向无权最短路径经过该节点的份额之和，即拓扑中介位置"),
                _option("b", "该国出口总额在世界出口中的比重"),
                _option("c", "复杂 GVC 生产活动占增加值的份额"),
            ],
            "a",
            "该介数描述全正边二值拓扑位置，微小边与大额边等长且未做边阈值敏感性；它不自动等于经济规模、枢纽或不可替代瓶颈。",
        ),
        _question(
            "s14-compare",
            "读完四步回归后，怎样并排使用这些结果最稳妥？",
            [
                _option("a", "选出绝对值最大的系数作为政策总效应"),
                _option("b", "完整报告全部预设结果，并把未做阈值敏感性的网络项标为探索性证据"),
                _option("c", "只有四步都显著才能写进报告"),
            ],
            "b",
            "四项构成预先指定的结果族，区间跨 0 的步骤仍应写入「看不出」；网络项还必须披露全正边二值口径与缺少阈值敏感性，不能只挑显著项。",
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
