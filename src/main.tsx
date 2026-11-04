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

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
