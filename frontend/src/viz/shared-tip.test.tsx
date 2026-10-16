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

function FocusChart() {
  const { wrapRef, Tip, show, hide } = useTip();
  return (
    <div ref={wrapRef} data-testid="chart">
      <button
        onFocus={(event) => show(event as never, [["", "focused"]], event.currentTarget.getBoundingClientRect())}
        onMouseMove={(event) => show(event, [["", "value"]])}
        onMouseLeave={hide}
      >mark</button>
      {Tip}
    </div>
  );
}

test("a hidden tip is hidden from screen readers and emptied; a focus tip survives the scroll that focus causes", async () => {
  const view = render(<div data-testid="scroll"><FocusChart /></div>);
  const mark = view.getByText("mark");
  const tip = view.getByTestId("chart").lastElementChild as HTMLElement;
  expect(tip.getAttribute("aria-hidden")).toBe("true");
  fireEvent.mouseMove(mark, { clientX: 20, clientY: 30 });
  expect(tip.getAttribute("aria-hidden")).toBeNull();
  expect(tip.textContent).toBe("value");
  fireEvent.mouseLeave(mark);
  expect(tip.getAttribute("aria-hidden")).toBe("true");
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(tip.textContent).toBe("");
  // Tab onto the bar: the browser scrolls it into view right away, and the tip stays.
  fireEvent.focus(mark);
  fireEvent.scroll(view.getByTestId("scroll"));
  expect(tip.style.opacity).toBe("1");
  expect(tip.textContent).toBe("focused");
});

test("a wheel scroll right after a focus tip still dismisses it", () => {
  const view = render(<div data-testid="scroll"><FocusChart /></div>);
  const mark = view.getByText("mark");
  const tip = view.getByTestId("chart").lastElementChild as HTMLElement;
  fireEvent.focus(mark);
  fireEvent.wheel(mark);
  fireEvent.scroll(view.getByTestId("scroll"));
  expect(tip.style.opacity).toBe("0");
});

function TwoBars() {
  const { wrapRef, Tip, show } = useTip();
  const focusTip = (name: string) => (event: React.FocusEvent<HTMLButtonElement>) =>
    show(event as never, [["", name]], event.currentTarget.getBoundingClientRect());
  return (
    <div ref={wrapRef} data-testid="chart">
      <button onFocus={focusTip("first")} onKeyDown={(event) => { if (event.key === "ArrowDown") (event.currentTarget.nextElementSibling as HTMLElement).focus(); }}>first</button>
      <button onFocus={focusTip("second")}>second</button>
      {Tip}
    </div>
  );
}

test("an arrow key that moves focus to the next bar keeps its tip through the scroll into view; PageDown dismisses it", () => {
  const view = render(<div data-testid="scroll"><TwoBars /></div>);
  const tip = view.getByTestId("chart").lastElementChild as HTMLElement;
  const first = view.getByText("first");
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  fireEvent.scroll(view.getByTestId("scroll"));
  expect(tip.style.opacity).toBe("1");
  expect(tip.textContent).toBe("second");
  fireEvent.keyDown(view.getByRole("button", { name: "second" }), { key: "PageDown" });
  fireEvent.scroll(view.getByTestId("scroll"));
  expect(tip.style.opacity).toBe("0");
});
