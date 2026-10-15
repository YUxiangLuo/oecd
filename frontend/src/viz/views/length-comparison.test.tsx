import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { CAT } from "../shared";
import { LengthViz } from "./length-comparison";

afterEach(cleanup);
test("selected lengths retain legend colors", () => {
  const { container } = render(<LengthViz rows={[{ country: "CHN", PLv: 3, PLy: 2, PLv_GVC: 2, PLy_GVC: 1, GVCPs: 2 }]} highlight={new Set(["CHN"])} />);
  const selected = container.querySelector<HTMLElement>('[data-selected="true"]')!;
  const bars = selected.children[1].children;
  const probe = document.createElement("div");
  probe.style.background = CAT[0];
  expect((bars[0] as HTMLElement).style.background).toBe(probe.style.background);
  probe.style.background = CAT[1];
  expect((bars[1] as HTMLElement).style.background).toBe(probe.style.background);
});
