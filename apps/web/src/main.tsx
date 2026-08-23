import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initSentry } from "./lib/sentry";
import { App } from "./app";
import "./styles.css";

initSentry(import.meta.env.VITE_SENTRY_DSN);

const root = document.getElementById("root");
if (!root) throw new Error("root_missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
