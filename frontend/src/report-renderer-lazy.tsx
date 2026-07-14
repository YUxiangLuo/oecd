/**
 * report-renderer 依赖 react-markdown + remark-gfm(及 micromark/mdast 全套),
 * 体积较大且只在步骤17与教师报告页用到。这里用 React.lazy 把它拆成异步 chunk,
 * 仅在真正渲染报告时才加载,避免拖累首屏主包。
 *
 * ErrorBoundary:异步 chunk 若因发布滚动(旧 hash 404)或断网加载失败,只降级本区域
 * 并提示重新加载,而不是让异常冒泡到根节点白屏。
 * preloadReportRenderer():供调用方在打印/渲染前预取,避免打印到 Suspense 占位文案。
 */
import { Component, lazy, Suspense } from "react";
import type { ReactNode } from "react";

let preloadPromise: Promise<typeof import("./report-renderer")> | null = null;

/** 触发(并复用)report-renderer chunk 的加载;可在渲染或打印前调用以预取。 */
export function preloadReportRenderer(): Promise<typeof import("./report-renderer")> {
  if (!preloadPromise) preloadPromise = import("./report-renderer");
  return preloadPromise;
}

// report-renderer.tsx 只导出具名 ReportMarkdown,而 React.lazy 需要 { default },故在此适配。
const Inner = lazy(() => preloadReportRenderer().then((m) => ({ default: m.ReportMarkdown })));

class RendererBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      // chunk 加载失败(常见于发布后旧 hash 404):整页重载会取到新的 index 与 chunk。
      return (
        <div className="error-box">
          报告渲染器加载失败(可能是刚发布或网络中断)。
          <button onClick={() => window.location.reload()} style={{ marginLeft: 8 }}>重新加载</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function ReportMarkdown(props: { markdown: string; className?: string }) {
  return (
    <RendererBoundary>
      <Suspense fallback={<div className="muted">正在加载报告渲染器…</div>}>
        <Inner {...props} />
      </Suspense>
    </RendererBoundary>
  );
}
