import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useTip } from "./shared";

afterEach(cleanup);
function Chart() {
  const { wrapRef, Tip, show, hide } = useTip();
  return <div ref={wrapRef} data-testid="chart"><button onMouseMove={(event) => show(event, [["", "value"]])} onMouseLeave={hide}>mark</button>{Tip}</div>;
}
test("shared tooltip dismisses on Escape and ancestor scroll without swallowing other keys or reopening at the same pointer", () => {
  const view = render(<div data-testid="scroll"><Chart /></div>);
  const mark = view.getByText("mark");
  const tip = view.getByTestId("chart").lastElementChild as HTMLElement;
  fireEvent.mouseMove(mark, { clientX: 20, clientY: 30 });
  expect(tip.style.opacity).toBe("1");
  expect(fireEvent.keyDown(document, { key: "ArrowRight" })).toBe(true);
  expect(tip.style.opacity).toBe("1");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(tip.style.opacity).toBe("0");
  fireEvent.mouseMove(mark, { clientX: 20, clientY: 30 });
  expect(tip.style.opacity).toBe("0");
  fireEvent.mouseMove(mark, { clientX: 21, clientY: 30 });
  expect(tip.style.opacity).toBe("1");
  fireEvent.scroll(view.getByTestId("scroll"));
  expect(tip.style.opacity).toBe("0");
  fireEvent.mouseLeave(mark);
  fireEvent.mouseMove(mark, { clientX: 21, clientY: 30 });
  expect(tip.style.opacity).toBe("1");
});

test("scroll dismissal is scoped to ancestors and listeners are removed on unmount", () => {
  const view = render(<><Chart /><div data-testid="unrelated" /></>);
  const mark = view.getByText("mark");
  const tip = view.getByTestId("chart").lastElementChild as HTMLElement;
  fireEvent.mouseMove(mark, { clientX: 20, clientY: 30 });
  fireEvent.scroll(view.getByTestId("unrelated"));
  expect(tip.style.opacity).toBe("1");
  view.unmount();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.scroll(window);
  expect(tip.style.opacity).toBe("1");
});
