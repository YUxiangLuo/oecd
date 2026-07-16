"""第 16 步的报告闭环:前置门槛、服务端复估、溯源绑定、不可伪造。

HEAD 的第 16 步只能证明“有人上传过一段 Markdown”。这些用例守住相反的契约:
报告只能由服务端从学生自己的实验会话生成。
"""

import pytest

from gvcsim import evidence
from gvcsim.config import PROCESSED_DIR
from gvcsim.session import empty_session, make_record
from gvcsim.teaching_report import GATE_STEPS, ReportGateError, build, check_gate

needs_artifacts = pytest.mark.skipif(
    not (PROCESSED_DIR / "panel_industry.csv").exists(),
    reason="需要 gvcsim compute 产出的面板与产物清单",
)

JUDGMENT = "处理聚类只有 2 个,推断已被抑制,不能作因果解释"


def _complete_session(manifest_id: str) -> dict:
    """一份 1–15 步证据齐全的会话。"""
    session = empty_session(manifest_id)
    payload = {
        "db": {"slice": {"year": 2020, "table": "z", "row_country": "CHN", "col_country": "USA"}},
        "shock": {"viewed_shock_types": list(evidence.REQUIRED_SHOCK_TYPES)},
        "qc": {"disposition": "disclose", "judgment": JUDGMENT},
        "ind": {"compared": ["CHN", "USA"]},
        "viz": {"chart": "quadrant", "compared": ["CHN", "USA"]},
        "reg": {"run": {"depvar": "FVA_share", "settings": {"shockType": "export_control"}}, "judgment": JUDGMENT},
    }
    for step, lab in evidence.STEP_LABS.items():
        if lab == "rep":
            continue
        session["steps"][str(step)] = make_record(payload[lab])
    return session


def test_gate_lists_every_incomplete_step():
    blocked = check_gate(empty_session("mid"))
    assert [item["step"] for item in blocked] == list(GATE_STEPS)
    assert all(item["missing"] for item in blocked)
    # 第 16 步自己不在门槛里,否则永远无法生成。
    assert 16 not in GATE_STEPS


def test_gate_is_empty_when_evidence_is_complete():
    assert check_gate(_complete_session("mid")) == []


def test_build_refuses_when_evidence_is_missing():
    with pytest.raises(ReportGateError) as excinfo:
        build(empty_session("mid"), "同学", 1)
    assert len(excinfo.value.missing) == len(GATE_STEPS)


@needs_artifacts
def test_build_refuses_a_session_from_other_artifacts():
    """产物换代后不能拿旧会话生成报告:里面的结果已不对应当前数据。"""
    with pytest.raises(ReportGateError):
        build(_complete_session("deadbeefdeadbeef"), "同学", 1)


@needs_artifacts
def test_report_reruns_regressions_server_side_and_records_status():
    from gvcsim import artifacts

    mid = artifacts.manifest_id()
    report = build(_complete_session(mid), "同学", 7)
    # 学生保存的是出口管制(单处理聚类):服务端复估必须自己得出 insufficient,
    # 而不是相信客户端说了什么。
    statuses = {run["step"]: run["status"] for run in report.provenance["runs"]}
    assert statuses[12] == "insufficient"
    assert "处理支持度不足" in report.markdown
    # 被抑制的推断不能在报告里出现 p 值或星号。
    assert "***" not in report.markdown


@needs_artifacts
def test_report_binds_provenance_and_student_judgments():
    from gvcsim import artifacts

    mid = artifacts.manifest_id()
    report = build(_complete_session(mid), "同学", 7)
    assert report.provenance["manifest_id"] == mid
    assert report.provenance["session_revision"] == 7
    assert report.report_key in report.markdown
    assert mid in report.markdown
    # 学生自己的判断必须原样进入报告——这是机器复算不出来的部分。
    assert JUDGMENT in report.markdown
    # 真实/mock 边界必须写在报告里。
    assert "mock" in report.markdown and "OECD ICIO" in report.markdown


@needs_artifacts
def test_report_key_is_content_addressed():
    """同一份会话内容 → 同一个 key;证据一变 → key 变。"""
    from gvcsim import artifacts

    mid = artifacts.manifest_id()
    first = build(_complete_session(mid), "同学", 1)
    again = build(_complete_session(mid), "同学", 2)  # revision 变,内容没变
    assert first.report_key == again.report_key

    changed = _complete_session(mid)
    changed["steps"]["3"] = make_record({"disposition": "stop", "judgment": JUDGMENT})
    assert build(changed, "同学", 1).report_key != first.report_key


@needs_artifacts
def test_report_is_plain_markdown_without_private_chart_blocks():
    """报告要能复制到任何 Markdown 阅读器完整阅读。"""
    from gvcsim import artifacts

    report = build(_complete_session(artifacts.manifest_id()), "同学", 1)
    assert "gvcsim-chart" not in report.markdown
    assert "| 变量 | 系数 |" in report.markdown


# ------------------------------------------------- 从 HEAD 找回的两节
#
# 重建第 16 步时,这两节连同参数表单一起被丢掉了——但它们与证据闭环正交:
# 都是服务端从产物算出的描述性内容和静态披露,不需要任何客户端输入。


@needs_artifacts
def test_report_keeps_descriptive_indicator_summary():
    """报告要有描述性画面:学生做完 11 步指标与可视化,不能在报告里一点不体现。"""
    from gvcsim import artifacts

    report = build(_complete_session(artifacts.manifest_id()), "同学", 1)
    assert "GVC 指标摘要" in report.markdown
    assert "FVA 份额最高" in report.markdown
    assert "GVC 位置指数最高" in report.markdown
    assert "网络介数中心性最高" in report.markdown
    # Top5 用普通表格,不是私有图表块——离开本系统仍可读。
    assert "| 经济体 | FVA 份额 |" in report.markdown
    assert "| 国家×行业节点 | 介数中心性 |" in report.markdown


@needs_artifacts
def test_report_keeps_methodology_and_limitations_disclosure():
    """方法学出处与 mock 身份必须写进报告——这是可审计报告的一部分。"""
    from gvcsim import artifacts

    report = build(_complete_session(artifacts.manifest_id()), "同学", 1)
    assert "结论与限制" in report.markdown
    # 方法学引用
    assert "WWZ (2013)" in report.markdown
    assert "WWYZ (2017)" in report.markdown
    assert "Gephi" in report.markdown
    # 控制变量的真实/mock 边界
    assert "GDP 平减指数为拟真 mock" in report.markdown
    # 明确声明不输出什么
    assert "不输出 exporter-importer-sector" in report.markdown


@needs_artifacts
def test_report_suggests_a_filename_bound_to_the_report_key():
    from gvcsim import artifacts

    report = build(_complete_session(artifacts.manifest_id()), "同学", 1)
    assert report.suggested_filename.endswith(".md")
    assert report.report_key in report.suggested_filename
