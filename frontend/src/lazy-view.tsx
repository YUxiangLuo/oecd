import { Component, Suspense, type ReactNode } from "react";

/** Keep the surrounding workspace usable while a screen's code arrives. */
export class LazyView extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <div className="error-box" role="alert">
      <p>页面模块未能载入，请检查网络后刷新页面。</p>
      <button type="button" onClick={() => window.location.reload()}>刷新页面</button>
    </div>;
    return <Suspense fallback={<p className="muted" role="status">正在载入页面…</p>}>
      {this.props.children}
    </Suspense>;
  }
}
