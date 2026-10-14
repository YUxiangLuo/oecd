import { expect, test } from "bun:test";
import fixtures from "../../tests/fixtures/name_keys.json";
import { nameKey } from "./name-keys";

test("shared backend/frontend comparison keys, including non-casefold and contextual casing", () => {
  for (const [name, key] of fixtures) expect(nameKey(name!)).toBe(key!);
});
