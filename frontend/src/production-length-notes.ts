/**
 * Equal production lengths that would read as an error, explained where they are shown (steps 4 and 8). Both are
 * identities of the WWYZ lengths, not coincidences: they hold on every country-year and on every industry row that has
 * both lengths in the 2016–2020 release.
 */

/** Country level: summed over a country's industries, the pure-domestic and traditional-trade segments are the same
 *  production, read from the value-added end (forward) and from the final-goods end (backward). */
export const DOMESTIC_SEGMENTS_IDENTITY_NOTE = "国家整体上，纯国内段与传统贸易段的前向长度和后向长度总是相等，这是恒等关系，不是数据错误：这两段的生产全部在本国内部完成（传统贸易只把最终品出口一次），按增加值来源（前向）和按最终品（后向）汇总的是同一批生产活动。只有 GVC 段涉及外国的生产环节，前后向长度一般不同。";

/** One industry: its backward pure-domestic and traditional-trade segments trace the same domestic production of the
 *  industry's final goods, whether they are used at home or exported. */
export const BACKWARD_SEGMENTS_IDENTITY_NOTE = "单个行业的后向纯国内段和传统贸易段长度总是相等，这也是恒等关系：两段回溯的都是这个行业的最终品在本国的生产链；不论最终品在国内使用还是直接出口，这条生产链都一样长。";

const defined = (row: Record<string, unknown>, keys: readonly string[]) =>
  keys.every((key) => typeof row[key] === "number" && Number.isFinite(row[key]));

/** Step 4's note for the lengths on screen (the whole country, or one industry), when every length it speaks of is
 *  there: a "—" segment has nothing to be equal to. Step 4 defines the position index, so it adds why it compares
 *  only the GVC segments. */
export function segmentIdentityNote(row: Record<string, unknown>, countryLevel: boolean): string | null {
  if (countryLevel) {
    return defined(row, ["PLv_D", "PLy_D", "PLv_RT", "PLy_RT"]) ? `${DOMESTIC_SEGMENTS_IDENTITY_NOTE}所以 GVC 位置指数只比较 GVC 段。` : null;
  }
  return defined(row, ["PLy_D", "PLy_RT"]) ? BACKWARD_SEGMENTS_IDENTITY_NOTE : null;
}
