/**
 * Value added below zero, explained where it is shown (steps 3, 4 and 7). It is real, not missing data: ten
 * industry-years of the 2016–2020 release (ITA C19 and five H51 in 2020, ISL C21 in 2017–2018, CYP H51 in 2016–2017,
 * EST H51 in 2016), every part of their decomposition negative with them.
 */

/** Why value added can be negative (step 4 says only this: its lengths need the shares, not the parts). */
export const NEGATIVE_VALUE_ADDED_CAUSE = "增加值为负不一定是数据错误：增加值是基本价产出减去购买者价中间消耗。项目的 Z 按基本价记录，产品税减补贴 TLS 单列，因此纯增加值约为 OUT − Z 列合计 − TLS。增加值包含劳动报酬等，不等于利润，负增加值也不能直接称为亏损。";

/** Negative nonzero denominators allow signed ratios; omitting them is a display policy, not a mathematical limit. */
export const NEGATIVE_VALUE_ADDED_NOTE = `${NEGATIVE_VALUE_ADDED_CAUSE}总增加值为负且非零时，仍可计算有符号比率和加权贡献；但不宜按通常的非负构成份额解读，本页面不展示这类比重或加权分解。分母为零时才无法作除法。`;
