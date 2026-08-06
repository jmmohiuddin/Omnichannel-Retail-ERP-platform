import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import { applyDocumentLang, getLang } from "./lib/langStore.js";
import "./styles.css";

// Stamp <html lang/dir> from the persisted language before first paint so a
// returning Arabic user gets RTL immediately (logical CSS does the mirroring).
applyDocumentLang(getLang());

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
