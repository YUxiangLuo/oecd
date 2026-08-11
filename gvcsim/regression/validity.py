"""处理支持度与设计有效性判定。

聚类稳健推断的有效性取决于**处理聚类数**,而不是总聚类数或总样本量。
本模块把"能否算出数字"与"结果能否用于推断"分开:估计照常进行,但当处理
支持度不足、或处理路径与估计量不相容时,明确抑制 p 值、星号与置信区间。

与 :func:`gvcsim.regression.panel._pretrend_diagnostic` 同一原则:宁可返回
"不可评估",也不制造一个看似有效的显著性。
"""

from dataclasses import dataclass, field

import pandas as pd

# 处理聚类数低于此值时抑制推断。
#
# 这是**课程政策**,不是统计定理:处理聚类极少时聚类稳健方差退化,t 检验严重
# 过度拒绝(few treated clusters 文献,如 Conley–Taber、MacKinnon–Webb)。
# 单个处理聚类下,处理效应的组间方差根本无法从数据中识别。
# 阈值取 5 是保守的教学取舍;真实研究应改用 wild cluster bootstrap 等方法。
MIN_TREATED_CLUSTERS = 5

# 吸收型编码与真实政策路径不一致的个体-年占比超过此值时判定 invalid_design。
#
# 同样是课程政策。少量撤销(如关税 mock 中加拿大/墨西哥钢铝关税 2019 年取消,
# 约占处理后个体-年 0.4%)只需披露,估计对象基本未变;大比例撤销
# (如制裁 mock 中 RUSAL 解除,约 9.5%)会实质改变估计对象,必须停止推断。
MAX_REVERSAL_SHARE = 0.05

STATUS_OK = "ok"
STATUS_WARNING = "warning"
STATUS_INSUFFICIENT = "insufficient"
STATUS_INVALID_DESIGN = "invalid_design"

# 严重度排序,用于在多个问题同时出现时取最严重者作为总状态。
_SEVERITY = {STATUS_OK: 0, STATUS_WARNING: 1, STATUS_INSUFFICIENT: 2, STATUS_INVALID_DESIGN: 3}


@dataclass
class TreatmentSupport:
    """一次估计的处理支持度与设计有效性。"""

    treated_clusters: int
    untreated_clusters: int
    treated_entities: int
    untreated_entities: int
    total_entities: int
    reversal_entities: list[str]
    reversal_share: float
    absorbing: bool
    status: str
    reasons: list[str] = field(default_factory=list)

    @property
    def suppress_inference(self) -> bool:
        """是否抑制 p 值、星号与置信区间。"""
        return self.status in (STATUS_INSUFFICIENT, STATUS_INVALID_DESIGN)

    def to_dict(self) -> dict:
        return {
            "treated_clusters": self.treated_clusters,
            "untreated_clusters": self.untreated_clusters,
            "treated_entities": self.treated_entities,
            "untreated_entities": self.untreated_entities,
            "total_entities": self.total_entities,
            "reversal_entities": list(self.reversal_entities),
            "reversal_share": self.reversal_share,
            "absorbing": self.absorbing,
            "status": self.status,
            "reasons": list(self.reasons),
            "min_treated_clusters": MIN_TREATED_CLUSTERS,
            "max_reversal_share": MAX_REVERSAL_SHARE,
            "suppress_inference": self.suppress_inference,
        }


@dataclass
class ReversalScan:
    """吸收型编码与真实政策路径的偏离程度。"""

    entities: list[str]  # 首次处理后又回到未处理的个体
    miscoded_rows: int  # 吸收型编码为 1、实际为 0 的个体-年数
    post_rows: int  # 处理后个体-年总数(吸收型编码为 1 的行)

    @property
    def share(self) -> float:
        """误编码占处理后个体-年的比例。"""
        return self.miscoded_rows / self.post_rows if self.post_rows else 0.0


def scan_reversal(
    data: pd.DataFrame,
    entity: str,
    time: str,
    status_col: str,
) -> ReversalScan:
    """扫描处理状态被撤销的个体,并量化吸收型编码的误编码比例。

    吸收型估计量把处理编码为 1[t≥G_i],首次处理后永久为 1。若个体实际
    路径在之后关闭,估计量的处理变量与真实政策路径不一致,估计对象被静默改变。
    误编码比例衡量这种偏离有多大:少量撤销只需披露,大比例撤销必须停止推断。

    ``status_col`` 应优先传**冲击强度**列而非阈值化的处理指示列:后者会把
    "强度略微跌破 treated 阈值"(如 0.0011→0.0009,政策仍在生效)误报为撤销,
    而真正的撤销在 mock 中表现为强度归零(如加拿大钢铝关税 2019 年取消)。
    """
    on_series = pd.to_numeric(data[status_col], errors="coerce").fillna(0) > 0
    frame = pd.DataFrame({entity: data[entity].values, time: data[time].values, "on": on_series.values})
    # 整表排序一次 + 按个体 cummax:累计最大值恰好就是"首次处理起恒为 1"的吸收型窗口,
    # 与逐组取 path[argmax():] 等价。原本是逐个体 groupby + sort_values 的 Python 循环,
    # 每次估计多花约 0.3 秒;实体置换要重估几十次,40 draws 因此从 16.5 秒降到 2.4 秒。
    frame = frame.sort_values([entity, time], kind="stable")
    post = frame.groupby(entity, sort=False)["on"].cummax().to_numpy(dtype=bool)
    on = frame["on"].to_numpy(dtype=bool)
    # 处理后窗口里仍为"未处理"的行,就是吸收型编码与真实路径不符的行。
    off_after_on = post & ~on
    entities = sorted(frame.loc[off_after_on, entity].astype(str).unique())
    return ReversalScan(
        entities=entities,
        miscoded_rows=int(off_after_on.sum()),
        post_rows=int(post.sum()),
    )


def analyze_support(
    data: pd.DataFrame,
    entity: str,
    time: str,
    cluster: str,
    treated_col: str,
    absorbing: bool,
    intensity_col: str | None = None,
) -> TreatmentSupport:
    """统计处理/对照聚类数与处理路径,判定设计有效性状态。

    ``absorbing`` 表示估计量是否把处理编码为"首次处理后永久处理"
    (DID 与事件研究为 True;连续强度 TWFE 为 False)。
    ``intensity_col`` 用于识别真正的政策撤销,缺省时退回 ``treated_col``。
    """
    exposure = pd.to_numeric(data[treated_col], errors="coerce").fillna(0) > 0
    clusters = data[cluster]
    treated_cluster_ids = set(clusters[exposure].unique())
    all_cluster_ids = set(clusters.unique())
    treated_clusters = len(treated_cluster_ids)
    untreated_clusters = len(all_cluster_ids - treated_cluster_ids)
    entity_exposure = (
        pd.DataFrame({"entity": data[entity].astype(str).to_numpy(), "exposed": exposure.to_numpy(dtype=bool)})
        .groupby("entity", sort=False)["exposed"]
        .any()
    )
    treated_entities = int(entity_exposure.sum())
    untreated_entities = int((~entity_exposure).sum())
    total_entities = int(len(entity_exposure))

    status_col = intensity_col if intensity_col and intensity_col in data.columns else treated_col
    scan = scan_reversal(data, entity, time, status_col) if absorbing else ReversalScan([], 0, 0)
    reversal_entities = scan.entities

    reasons: list[str] = []
    status = STATUS_OK

    def escalate(new_status: str, reason: str) -> None:
        nonlocal status
        reasons.append(reason)
        if _SEVERITY[new_status] > _SEVERITY[status]:
            status = new_status

    if reversal_entities:
        shown = "、".join(reversal_entities[:3])
        more = f" 等 {len(reversal_entities)} 个" if len(reversal_entities) > 3 else ""
        share_text = f"占处理后个体-年 {scan.share:.2%}({scan.miscoded_rows}/{scan.post_rows})"
        if scan.share >= MAX_REVERSAL_SHARE:
            escalate(
                STATUS_INVALID_DESIGN,
                f"处理可逆且比例过高:{shown}{more}个体在首次处理后又回到未处理状态,{share_text},"
                f"超过教学上限 {MAX_REVERSAL_SHARE:.0%}。吸收型估计量把处理编码为首次处理后永久为 1,"
                f"与真实政策路径不一致,估计对象已被实质改变,不能作推断;"
                f"改用连续强度双向固定效应可让处理逐年跟随真实路径。",
            )
        else:
            escalate(
                STATUS_WARNING,
                f"存在处理撤销:{shown}{more}个体在首次处理后又回到未处理状态,{share_text},"
                f"未超过教学上限 {MAX_REVERSAL_SHARE:.0%}。吸收型编码把这些个体在撤销后仍记为处理,"
                f"估计对象因此略有偏离;比例较小,推断仍予保留,解释时应排除这些个体。",
            )

    if treated_clusters < MIN_TREATED_CLUSTERS:
        escalate(
            STATUS_INSUFFICIENT,
            f"处理支持度不足:只有 {treated_clusters} 个处理聚类(按 {cluster} 聚类),"
            f"低于教学下限 {MIN_TREATED_CLUSTERS}。总聚类数 {len(all_cluster_ids)} 不能补救这一点——"
            f"聚类稳健方差由处理聚类的组间差异识别,已抑制 p 值、星号与置信区间。",
        )

    if absorbing and untreated_clusters == 0 and treated_clusters > 0:
        if untreated_entities > 0:
            escalate(
                STATUS_WARNING,
                f"没有完全未处理的对照聚类:全部 {treated_clusters} 个聚类都至少包含一个处理实体,"
                f"但样本仍有 {untreated_entities} 个从未处理实体。比较并非只来自尚未处理者；"
                f"不过没有整个聚类都未处理,聚类层面的共同冲击辨识更依赖模型设定。"
                f"传统 staggered TWFE 在处理效应异质时仍可能有偏。",
            )
        else:
            escalate(
                STATUS_WARNING,
                f"没有从未处理实体或完全未处理聚类:全部 {treated_clusters} 个聚类和"
                f"全部 {treated_entities} 个实体都曾受处理,识别依赖处理时点差异。"
                f"传统 staggered TWFE 在处理效应异质时尤其容易有偏。",
            )

    return TreatmentSupport(
        treated_clusters=treated_clusters,
        untreated_clusters=untreated_clusters,
        treated_entities=treated_entities,
        untreated_entities=untreated_entities,
        total_entities=total_entities,
        reversal_entities=reversal_entities,
        reversal_share=scan.share,
        absorbing=absorbing,
        status=status,
        reasons=reasons,
    )
