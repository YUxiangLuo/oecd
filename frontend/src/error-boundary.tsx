/**
 * Render errors end in a message instead of an empty page. The root boundary covers everything (the page reloads,
 * and the saved record comes back from the server); the step boundary keeps the shell and the session alive, so a
 * step that fails to draw loses nothing that was typed elsewhere and the student can move on or try again.
 */
import { Component, createRef, type ErrorInfo, type ReactNode } from "react";

interface BoundaryState { failed: boolean }

/** Focus goes to the message's button when it appears (the content it replaced, focus included, is gone), and again
 *  when a retry failed again: React then draws a new message, the focused button is gone and focus is on <body>.
 *  Focus the student moved elsewhere (the sidebar, another step) is left there. */
function focusWhenShown(button: HTMLButtonElement | null, failed: boolean, wasFailed: boolean) {
  const lost = document.activeElement == null || document.activeElement === document.body;
  if (failed && (!wasFailed || lost)) button?.focus();
}

export class RootErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { failed: false };
  private button = createRef<HTMLButtonElement>();

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("页面渲染出错", error, info.componentStack);
  }

  componentDidMount() {
    focusWhenShown(this.button.current, this.state.failed, false);
  }

  componentDidUpdate(_props: unknown, previous: BoundaryState) {
    focusWhenShown(this.button.current, this.state.failed, previous.failed);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="boot-failure">
        <div className="panel" role="alert">
          <h1>页面出错了</h1>
          <p>页面没能显示出来。已保存到服务器的实验记录不受影响；刷新页面后会重新载入。</p>
          <button ref={this.button} type="button" className="primary" onClick={() => window.location.reload()}>刷新页面</button>
        </div>
      </div>
    );
  }
}

/** Around one step's content: `resetKey` (the step) changing gives it another try. */
export class StepErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, BoundaryState & { key: string }> {
  state = { failed: false, key: this.props.resetKey };
  private button = createRef<HTMLButtonElement>();

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidMount() {
    focusWhenShown(this.button.current, this.state.failed, false);
  }

  componentDidUpdate(_props: unknown, previous: BoundaryState) {
    focusWhenShown(this.button.current, this.state.failed, previous.failed);
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: BoundaryState & { key: string }) {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("本步渲染出错", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="error-box" role="alert">
        <b>本步没能显示出来</b>
        <p>其他步骤和已保存的记录不受影响。可以再试一次，或先去别的步骤。</p>
        <button ref={this.button} type="button" className="secondary" onClick={() => this.setState({ failed: false })}>再试一次</button>
      </div>
    );
  }
}
