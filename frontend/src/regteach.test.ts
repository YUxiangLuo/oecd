import { expect, test } from "bun:test";
import { splitPolicyCoefficients } from "./regteach";
import type { RegressionResponse } from "./types";

test("selects only the signed teaching regressor", () => {
  const response = {
    design: { shock_col: "teaching_tariff_exposure" },
    result: { coefs: [
      { name: "teaching_tariff_exposure" },
      { name: "unexpected_column" },
    ] },
  } as RegressionResponse;
  expect(splitPolicyCoefficients(response).policy.map((item) => item.name))
    .toEqual(["teaching_tariff_exposure"]);
});
