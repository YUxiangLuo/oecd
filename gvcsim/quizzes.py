"""课程步骤的固定单选题题库。

题干和选项可以公开给前端；正确答案与反馈只在服务端判题后返回。题库版本
随不兼容的题目/答案变更提升；仅澄清措辞且题目 ID、选项 ID 和正确答案不变时
保持版本，避免让学生无意义地重答全部步骤。
"""

from __future__ import annotations

from typing import Any


QUIZ_VERSION = "course-quiz-v4"


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
            "s02-fatal",
            "正式研究或可发布数据仍存在 fatal 问题时，哪种处置才允许进入下游分析？",
            [
                _option("a", "在报告中披露后直接继续"),
                _option("b", "停止分析，或修正并复检通过后继续"),
                _option("c", "把 fatal 手工改成 warning 后继续"),
            ],
            "b",
            "fatal 是正式研究与发布门禁；必须停止，或完成真实修正并通过复检。教学演示可在显式 override、完整披露且不冒充研究结论的边界内继续。",
        ),
        _question(
            "s02-leontief",
            "为什么不能只看 (I−A)⁻¹ 是否能被程序算出来？",
            [
                _option("a", "只要矩阵维度一致就足够"),
                _option("b", "还要检查谱半径、条件数、逆残差和非负性"),
                _option("c", "只要所有回归系数显著就足够"),
            ],
            "b",
            "数值上能求逆不等于经济和数值上稳定；谱半径、条件数、残差与非负性共同约束可用性。",
        ),
    ],
    3: [
        _question(
            "s03-fva",
            "FVA 份额较高最直接说明什么？",
            [
                _option("a", "国内增加值返回本国更多"),
                _option("b", "毛出口中的外国增加值占比更高，后向依赖更强"),
                _option("c", "产品跨境次数必然更多"),
            ],
            "b",
            "FVA_share 衡量毛出口中的外国增加值占比，反映进口投入依赖和后向 GVC 参与。",
        )
    ],
    4: [
        _question(
            "s04-complex",
            "下面哪种活动属于复杂 GVC？",
            [
                _option("a", "增加值只满足国内最终需求"),
                _option("b", "最终品直接出口一次后被吸收"),
                _option("c", "增加值在最终吸收前经历多次跨境生产"),
            ],
            "c",
            "复杂 GVC 的关键是增加值在最终吸收前至少经历多次跨境生产分工。",
        )
    ],
    5: [
        _question(
            "s05-position",
            "GVCPs > 1 通常怎样解释？",
            [
                _option("a", "前向 GVC 长度大于后向长度，位置相对更上游"),
                _option("b", "更靠近最终消费端"),
                _option("c", "该指标没有经济含义"),
            ],
            "a",
            "GVCPs 是前向与后向 GVC 长度之比；大于 1 通常表示相对更靠近上游投入端。",
        )
    ],
    6: [
        _question(
            "s06-between",
            "高介数中心性表示什么？",
            [
                _option("a", "节点的贸易总额一定最大"),
                _option("b", "节点位于较多有向最短路径上"),
                _option("c", "节点的直接贸易伙伴一定最多"),
            ],
            "b",
            "介数中心性统计节点经过的有向无权最短路径数量；它刻画拓扑中介位置，不等同于总流量、伙伴数或经济上的不可替代瓶颈。",
        )
    ],
    7: [
        _question(
            "s07-trade-viz",
            "一个经济体的 FVA 份额较高，最稳妥的读图结论是什么？",
            [
                _option("a", "它的国内增加值占比一定更高"),
                _option("b", "它的出口更依赖外国投入，后向参与更强"),
                _option("c", "已经证明关税造成了这种结构"),
            ],
            "b",
            "较高 FVA 份额支持更强的外国投入依赖这一描述性判断，但不能单独识别因果。",
        )
    ],
    8: [
        _question(
            "s08-prod-viz",
            "国家复杂 GVC 份额较高，能否说明该国所有行业都同样高？",
            [
                _option("a", "能，国家汇总可以代表每个行业"),
                _option("b", "不能，国家汇总可能掩盖显著的行业异质性"),
                _option("c", "不能，因为国家之间完全无法比较"),
            ],
            "b",
            "国家汇总是行业加总结果；必须下钻行业才能判断一国内部异质性。",
        )
    ],
    9: [
        _question(
            "s09-length-viz",
            "当 PLv_GVC 大于 PLy_GVC 时，该经济体通常处于什么位置？",
            [
                _option("a", "相对更上游"),
                _option("b", "相对更下游"),
                _option("c", "因为是比值，所以无法判断"),
            ],
            "a",
            "前向 GVC 长度相对更长会使 GVCPs 大于 1，通常对应更上游的位置。",
        )
    ],
    10: [
        _question(
            "s10-network-viz",
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
    11: [
        _question(
            "s11-role",
            "ICIO 指标与政策冲击在后续回归中分别扮演什么角色？",
            [
                _option("a", "ICIO 指标是结果变量，政策冲击是处理变量"),
                _option("b", "ICIO 指标是处理变量，政策冲击是结果变量"),
                _option("c", "两者都是结果变量"),
            ],
            "a",
            "ICIO 计算 GVC 结果指标，政策冲击提供用于比较处理与对照的解释变量。",
        ),
        _question(
            "s11-types",
            "为什么要分别查看关税、制裁和出口管制三类冲击？",
            [
                _option("a", "它们只是界面颜色不同"),
                _option("b", "它们的处理密度、支持度和识别难度不同"),
                _option("c", "同时查看三类即可保证因果识别"),
            ],
            "b",
            "密集、稀疏和单国处理带来不同的对照支持与识别风险；查看三类并不自动保证因果性。",
        ),
    ],
    12: [
        _question(
            "s12-did",
            "双重差分 DID 比较的是什么？",
            [
                _option("a", "只比较处理组自身的前后变化"),
                _option("b", "比较处理组相对对照组的处理后变化"),
                _option("c", "只比较处理后的横截面差异"),
            ],
            "b",
            "DID 用处理组的前后变化减去对照组的同期变化，估计相对变化。",
        ),
        _question(
            "s12-controls",
            "怎样解释加入控制变量后估计结果的变化？",
            [
                _option("a", "加入控制变量就证明了因果关系"),
                _option("b", "其他设定一致时，可检查结果对遗漏变量的敏感性"),
                _option("c", "应同时更换冲击类型和估计方法"),
            ],
            "b",
            "保持其他设计一致才能把差异解释为控制口径敏感性；控制变量本身不能证明识别假设。",
        ),
    ],
    13: [
        _question(
            "s13-marginal",
            "模型含有“冲击 × 处理前 GVC”交互项时，冲击边际效应怎样计算？",
            [
                _option("a", "只读取交互项系数"),
                _option("b", "主效应加上交互系数乘以处理前 GVC 水平"),
                _option("c", "直接使用组内 R²"),
            ],
            "b",
            "有交互项时，特定处理前 GVC 水平下的边际效应由主效应与交互部分共同组成；处理个体的基期不得混入处理当年或处理后观测。",
        ),
        _question(
            "s13-compare",
            "比较无交互与有交互模型时，哪些设置应保持一致？",
            [
                _option("a", "除交互开关外，冲击、样本、方法和控制均保持一致"),
                _option("b", "同时改变冲击类型和方法"),
                _option("c", "无需保存无交互模型"),
            ],
            "a",
            "只改变交互设定，才能把两个模型的差异聚焦在异质性结构上。",
        ),
    ],
    14: [
        _question(
            "s14-pretrend",
            "事件研究的事前联合检验不显著，能够说明什么？",
            [
                _option("a", "已经证明平行趋势成立"),
                _option("b", "当前样本未发现明显事前差异，但不能证明平行趋势"),
                _option("c", "已经识别出政策作用机制"),
            ],
            "b",
            "未拒绝零假设只表示没有检测到明显预趋势，不等于证明平行趋势成立。",
        ),
        _question(
            "s14-dynamic",
            "应当怎样阅读事件研究的事后动态结果？",
            [
                _option("a", "用任意一个系数代表永久效应"),
                _option("b", "结合时期、系数和置信区间判断动态路径与不确定性"),
                _option("c", "只查看组内 R²"),
            ],
            "b",
            "动态效应必须结合相对时期和置信区间读取，单个系数不能概括全部路径或机制。",
        ),
    ],
    15: [
        _question(
            "s15-placebo",
            "当前实体置换敏感性分析显示原始估计位于伪处理分布尾部时，最恰当的解释是什么？",
            [
                _option("a", "已经证明真实因果效应"),
                _option("b", "原始估计在这套非校准置换规则下较极端，但尾部占比不是 p 值，也没有复现真实政策分配机制"),
                _option("c", "实体置换可以替代主回归"),
            ],
            "b",
            "当前置换只保留处理实体数与 cohort 数量分布；它可用于描述设定敏感性，但不是校准随机化推断或因果证明。",
        ),
        _question(
            "s15-sutva",
            "网络回归为什么必须讨论 SUTVA、干扰或网络外溢？",
            [
                _option("a", "网络节点彼此独立"),
                _option("b", "一个节点受冲击可能通过网络改变其他节点"),
                _option("c", "SUTVA 只与样本量有关"),
            ],
            "b",
            "网络连接会让一个节点的处理影响其他节点，传统的无干扰假设可能不成立。",
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
    if sorted(STEP_QUIZZES) != list(range(1, 16)):
        raise RuntimeError("题库必须完整覆盖步骤 1–15")
    if sum(len(items) for items in STEP_QUIZZES.values()) != 21:
        raise RuntimeError(f"{QUIZ_VERSION} 必须恰好包含 21 题")
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
