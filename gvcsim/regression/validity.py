"""处理支持度与设计有效性判定。

聚类稳健推断依赖聚类间独立性、解释变量信息分布、杠杆和有效处理支持等条件。
处理聚类数是课程停止门槛之一；通过数量门槛不保证有限样本覆盖率达到标称水平。
本模块把"能否算出数字"与"结果能否用于推断"分开:估计照常进行,但当处理
支持度不足、或处理路径与估计量不相容时,明确抑制 p 值、星号与置信区间。

课程采用保守的停止规则：宁可返回“不可评估”，也不制造一个看似有效的显著性。
"""

from dataclasses import dataclass, field

import pandas as pd

CLUSTER_INTERVAL_NOTE = "标准误（估计值的不确定程度）按国家聚类计算（同一国家的记录允许一起波动），95% 区间据此计算，是近似值；结果主要由少数国家决定时，区间可能偏窄。"

# 处理聚类数低于此值时抑制推断。
#
# 这是**课程政策**,不是统计定理:处理聚类极少时聚类稳健方差退化,t 检验严重
# 过度拒绝(few treated clusters 文献,如 Conley–Taber、MacKinnon–Webb)。
# 单个处理聚类下,处理效应的组间方差根本无法从数据中识别。
# 阈值取 12 只是“低于即停止”的课程发布门禁，不是“达到即有效”的统计定理。
# 真实的少处理聚类研究仍应按设计采用 wild cluster bootstrap、随机化推断等专门方法；
# 固定教学 TWFE 不试图替代这些研究工具。
MIN_TREATED_CLUSTERS = 12

# 吸收型 ATT 要求处理不可逆；行数占比不能界定估计对象的偏差。
# 保留字段供报告读取，0 表示不允许任何撤销，不是容忍区间。
MAX_REVERSAL_SHARE = 0.0
MIN_CONTROL_CLUSTERS = 12

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
    paired_control_clusters: int | None = None
    support_basis: str = "row_exposure"

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
            "paired_control_clusters": self.paired_control_clusters,
            "support_basis": self.support_basis,
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
    first_by_entity: pd.Series | None = None,
) -> ReversalScan:
    """扫描处理状态被撤销的个体,并量化吸收型编码的误编码比例。

    吸收型估计量把处理编码为 1[t≥G_i],首次处理后永久为 1。若个体实际
    路径在之后关闭,估计量的处理变量与真实政策路径不一致,估计对象被静默改变。
    误编码比例只描述行数；任何撤销都与本课程持续暴露的吸收型 ATT 不相容。

    ``status_col`` 应优先传**冲击强度**列而非阈值化的处理指示列:后者会把
    "强度略微跌破 treated 阈值"(如 0.0011→0.0009,政策仍在生效)误报为撤销,
    而真正的撤销在 mock 中表现为强度归零(如加拿大钢铝关税 2019 年取消)。
    ``first_by_entity`` 存在时，它是吸收型窗口的唯一 G_i 来源；强度列只判断
    窗口内实际 on/off，处理阈值以下的正强度不能提前开启窗口。
    """
    on_series = pd.to_numeric(data[status_col], errors="coerce").fillna(0) > 0
    frame = pd.DataFrame({entity: data[entity].values, time: data[time].values, "on": on_series.values})
    frame = frame.sort_values([entity, time], kind="stable")
    if first_by_entity is not None:
        frozen = first_by_entity.copy()
        frozen.index = frozen.index.astype(str)
        first_year = frame[entity].astype(str).map(frozen)
        post = (first_year.notna() & (pd.to_numeric(frame[time], errors="coerce") >= first_year)).to_numpy(dtype=bool)
    else:
        # 兼容无冻结时点的底层调用:累计最大值等价于从 status_col 首次为正起开启窗口。
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
    first_by_entity: pd.Series | None = None,
    timeline_data: pd.DataFrame | None = None,
) -> TreatmentSupport:
    """统计处理/对照聚类数与处理路径,判定设计有效性状态。

    ``absorbing`` 表示估计量是否把处理编码为"首次处理后永久处理"
    (DID 与事件研究为 True;连续强度 TWFE 为 False)。
    ``intensity_col`` 用于识别真正的政策撤销,缺省时退回 ``treated_col``。
    """
    entity_text = data[entity].astype(str)
    if absorbing and first_by_entity is not None:
        frozen = first_by_entity.copy()
        frozen.index = frozen.index.astype(str)
        first_year = entity_text.map(frozen)
        # 推断支持只来自最终样本中真正保留的 post 行；仅保留 pre 行的 cohort
        # 实体仍在 timeline totals 中，但不能满足处理聚类门槛。
        exposure = first_year.notna() & (pd.to_numeric(data[time], errors="coerce") >= first_year)
    else:
        # 连续强度 FE 保留逐年、最终样本的实际 exposure 语义。
        exposure = pd.to_numeric(data[treated_col], errors="coerce").fillna(0) > 0
    clusters = data[cluster]
    treated_cluster_ids = set(clusters[exposure].unique())
    all_cluster_ids = set(clusters.unique())
    treated_clusters = len(treated_cluster_ids)
    untreated_clusters = len(all_cluster_ids - treated_cluster_ids)
    entity_exposure = (
        pd.DataFrame({"entity": entity_text.to_numpy(), "exposed": exposure.to_numpy(dtype=bool)})
        .groupby("entity", sort=False)["exposed"]
        .any()
    )
    treated_entities = int(entity_exposure.sum())
    untreated_entities = int((~entity_exposure).sum())
    total_entities = int(len(entity_exposure))

    scan_source = timeline_data if timeline_data is not None else data
    retained_ids = (
        set(entity_exposure[entity_exposure].index) if absorbing and first_by_entity is not None else set(entity_text)
    )
    scan_source = scan_source.loc[scan_source[entity].astype(str).isin(retained_ids)]
    status_col = intensity_col if intensity_col and intensity_col in scan_source.columns else treated_col
    scan = (
        scan_reversal(scan_source, entity, time, status_col, first_by_entity=first_by_entity)
        if absorbing
        else ReversalScan([], 0, 0)
    )
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
        share_text = f"占受影响之后记录的 {scan.share:.2%}（{scan.miscoded_rows}/{scan.post_rows}）"
        escalate(
            STATUS_INVALID_DESIGN,
            f"有国家×行业（{shown}{more}）开始受关税影响后又回到零，{share_text}。"
            "这种情况下不能判断方向，所以不显示 95% 区间和 p 值；可以把这个原因写进报告。",
        )

    if treated_clusters < MIN_TREATED_CLUSTERS:
        escalate(
            STATUS_INSUFFICIENT,
            f"受关税影响的国家太少：只有 {treated_clusters} 个（至少需要 {MIN_TREATED_CLUSTERS} 个），"
            f"所以不显示 95% 区间和 p 值；一共有 {len(all_cluster_ids)} 个国家也弥补不了这一点。",
        )

    if absorbing and untreated_clusters == 0 and treated_clusters > 0:
        if untreated_entities > 0:
            escalate(
                STATUS_WARNING,
                f"没有完全不受关税影响的国家可以对照：{treated_clusters} 个国家都至少有一个行业受到影响"
                f"（仍有 {untreated_entities} 个国家×行业没受影响），所以结果更依赖模型假设。",
            )
        else:
            escalate(
                STATUS_WARNING,
                f"所有 {treated_clusters} 个国家、{treated_entities} 个国家×行业都受到关税影响，"
                "没有不受影响的对照，所以结果更依赖模型假设。",
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
