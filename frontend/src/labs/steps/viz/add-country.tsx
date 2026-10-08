import { forwardRef, useState } from "react";
import { LabeledControl } from "../../../a11y";
import { countryLabel } from "../../../viz";

/**
 * Add one comparison economy. Choosing in the select only stages the country and 添加 (or Enter) commits it:
 * on a closed select every arrow-key press fires a change, which used to add a country per step through the
 * list. After the fifth economy this control unmounts, so the caller passes where focus should go next.
 */
export const AddCountryControl = forwardRef<HTMLSelectElement, {
  label: string;
  emptyLabel: string;
  candidates: readonly string[];
  name?: string;
  onAdd: (country: string) => void;
  focusAfterAdd: () => void;
}>(function AddCountryControl({ label, emptyLabel, candidates, name, onAdd, focusAfterAdd }, ref) {
  const [pending, setPending] = useState("");
  const add = () => {
    if (!pending) return;
    onAdd(pending);
    setPending("");
    window.requestAnimationFrame(() => {
      if (document.activeElement == null || document.activeElement === document.body) focusAfterAdd();
    });
  };
  return (
    <LabeledControl label={label}>
      {(id) => (
        <span className="add-country">
          <select
            id={id}
            ref={ref}
            name={name}
            value={pending}
            onChange={(event) => setPending(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && pending) { event.preventDefault(); add(); } }}
          >
            <option value="">{emptyLabel}</option>
            {candidates.map((candidate) => <option key={candidate} value={candidate}>{countryLabel(candidate)}</option>)}
          </select>
          <button type="button" className="secondary" aria-disabled={!pending || undefined} onClick={add}>添加</button>
        </span>
      )}
    </LabeledControl>
  );
});
