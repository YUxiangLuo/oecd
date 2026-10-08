import { expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { AddCountryControl } from "./add-country";

test("stepping through the list does not add countries; 添加 adds the staged one", () => {
  const add = mock((_country: string) => {});
  render(<AddCountryControl label="再加一个对比国家" emptyLabel="选择国家…" candidates={["ARG", "AUS", "DEU"]} onAdd={add} focusAfterAdd={() => {}} />);
  const select = screen.getByLabelText("再加一个对比国家") as HTMLSelectElement;
  // Arrow keys on a closed select fire one change per press.
  fireEvent.change(select, { target: { value: "ARG" } });
  fireEvent.change(select, { target: { value: "AUS" } });
  expect(add).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  expect(add.mock.calls).toEqual([["AUS"]]);
  expect(select.value).toBe("");
});
