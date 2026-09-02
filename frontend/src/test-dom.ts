import { GlobalRegistrator } from "@happy-dom/global-registrator";

// React DOM tests share one browser-like global in the Bun worker. Register it
// before test modules load so they exercise supported React 19 DOM rendering
// instead of the deprecated react-test-renderer package.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
