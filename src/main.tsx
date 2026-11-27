// First: arms the remote harness bridge's console/error capture before App evaluates
// (dev-only, inert without ?bridge=<token>; see tools/remote-bridge.ts).
import "./debug/remote-bridge-client";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./styles/tokens.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

const query = new URLSearchParams(location.search);
if (query.get("engine") === "wwt" && (import.meta.env.DEV || import.meta.env.VITE_WWT_EXPERIMENT === "1")) {
  import("./experimental/wwt-player").then(m => m.openWwtPlayer(root, query.get("load"))).catch(e => { root.textContent = String(e); });
} else createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
