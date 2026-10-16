import { sameJsonValue } from "../session-store";
import { countryLabel, sectorLabel } from "../viz";

/**
 * Step 10 records its example once its data have loaded; a student who changed the example and left at once has a
 * newer choice on step 10 than the one steps 11–14 convert with. Said here, so the conversion is not taken as the new
 * one; null when the two agree.
 */
export function pendingStepTenExample(
  stepTen: { browse_selection?: { first: string; second?: string; industry: string } } | undefined,
  recorded: { first: string; second?: string; industry: string },
): string | null {
  const browsed = stepTen?.browse_selection;
  if (!browsed?.first || !browsed.industry) return null;
  const key = (item: { first: string; second?: string; industry: string }) => [item.first, item.second || "", item.industry];
  if (sameJsonValue(key(browsed), key(recorded))) return null;
  const name = `${countryLabel(browsed.first)} · ${sectorLabel(browsed.industry)}${browsed.second ? `（对比 ${countryLabel(browsed.second)}）` : ""}`;
  return `你在步骤 10 最后选的例子（${name}）还没有记录，这里仍按已记录的例子换算。回到步骤 10 等数据加载完，会自动记录；美国、或不在回归样本里的国家和行业不能作例子，步骤 10 会说明原因。`;
}
