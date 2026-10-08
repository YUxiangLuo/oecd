/**
 * Keep the fixed application shell anchored to the viewport while revealing an element (a freshly calculated
 * verdict, a freshly generated report draft) inside the course's own scroll container.
 * `Element.scrollIntoView()` also scrolls the document in this nested layout, which can move the entire
 * 100vh application off screen.
 */
export function scrollIntoCourseContent(target: HTMLElement | null, behavior: ScrollBehavior): void {
  if (!target) return;
  const scroller = target.closest<HTMLElement>(".content");
  if (!scroller) {
    target.scrollIntoView({ behavior, block: "start" });
    return;
  }
  const top = scroller.scrollTop
    + target.getBoundingClientRect().top
    - scroller.getBoundingClientRect().top;
  scroller.scrollTo({ top, left: 0, behavior });
}
