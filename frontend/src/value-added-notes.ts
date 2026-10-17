/**
 * Value added below zero, explained where it is shown (steps 3, 4 and 7). It is real, not missing data: ten
 * industry-years of the 2016–2020 release (ITA C19 and five H51 in 2020, ISL C21 in 2017–2018, CYP H51 in 2016–2017,
 * EST H51 in 2016), every part of their decomposition negative with them.
 */

/** Why value added can be negative (step 4 says only this: its lengths need the shares, not the parts). */
export const NEGATIVE_VALUE_ADDED_CAUSE = "增加值为负不是数据错误：增加值是产出减去中间投入后的余额，为负说明这一年该行业的产出还抵不上它用掉的中间投入，多见于严重亏损的年份。";

/** And why its shares are left out although two negatives divide: a share of a loss is not a share of value added. */
export const NEGATIVE_VALUE_ADDED_NOTE = `${NEGATIVE_VALUE_ADDED_CAUSE}这时各分项也随之为负，两个负数相除虽然能得到正数，但那只是亏损怎样分到各分项，不是增加值的构成，所以不算比重。`;
