import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { RootErrorBoundary } from "./error-boundary";
import "./styles.css";
import "./login.css";
import "./course-shell.css";
import "./teacher.css";
import "./workbench.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
