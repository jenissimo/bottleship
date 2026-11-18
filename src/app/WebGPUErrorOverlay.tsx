import { Warning } from "@phosphor-icons/react";
import React from "react";
import type { WebGPUProbeResult } from "../browser-support";

// Render `backtick`-wrapped tokens in a message as inline code spans (markdown-style). Odd split
// segments are the code runs. Used for literal URLs/identifiers like `chrome://gpu`.
function renderInline(text: string): React.ReactNode {
  return text.split("`").map((seg, i) =>
    i % 2 === 1
      ? (
        <code key={i} style={{
          fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
          fontSize: "0.86em",
          background: "rgba(255,157,99,.13)",
          border: "1px solid rgba(255,157,99,.22)",
          borderRadius: "4px",
          padding: "1px 5px",
          color: "#ffc7a3",
          whiteSpace: "nowrap",
        }}>{seg}</code>
      )
      : seg,
  );
}

/**
 * WebGPU-couldn't-start card. `variant="page"` is a full-screen takeover (used when the user lands
 * directly on a game URL); `variant="modal"` is a fixed backdrop that locks the library behind it.
 * Same card either way so the failure reads identically wherever it surfaces.
 */
export default function WebGPUErrorOverlay({
  probe,
  detectedBrowser,
  variant,
}: {
  probe: WebGPUProbeResult;
  detectedBrowser: string;
  variant: "page" | "modal";
}) {
  const diag =
    `Detected browser: ${detectedBrowser}`
    + (probe.adapter?.description ? ` · adapter: ${probe.adapter.description}` : "")
    + ` · stage: ${probe.stage}`;

  const card = (
    <div style={{
      width: "100%",
      maxWidth: "560px",
      border: "1px solid #3a281f",
      background: "#17110d",
      borderRadius: "16px",
      padding: "30px 32px",
      boxShadow: "0 24px 70px rgba(0,0,0,.55)",
      boxSizing: "border-box",
    }}>
      {/* Header: badge anchors the eye, title + one-line subject */}
      <div style={{ display: "flex", alignItems: "center", gap: "14px", marginBottom: "22px" }}>
        <div style={{
          width: "46px",
          height: "46px",
          flexShrink: 0,
          borderRadius: "12px",
          background: "rgba(255,157,99,.13)",
          border: "1px solid rgba(255,157,99,.32)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "22px",
        }}><Warning size={24} aria-hidden /></div>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.32rem", fontWeight: 700, color: "#ffe0cd", lineHeight: 1.15 }}>
            Can’t start graphics
          </h1>
          <div style={{ marginTop: "3px", fontSize: "0.82rem", color: "#9c8778", letterSpacing: ".02em" }}>
            WebGPU didn’t initialize on this machine
          </div>
        </div>
      </div>

      {/* The actual cause — visually lifted out as an accented callout */}
      <div style={{
        padding: "14px 16px",
        background: "rgba(255,120,70,.07)",
        borderLeft: "3px solid #ff9152",
        borderRadius: "0 9px 9px 0",
        color: "#ecd9cd",
        fontSize: "0.95rem",
        lineHeight: 1.5,
        marginBottom: "24px",
      }}>
        {renderInline(probe.reason)}
      </div>

      {/* Remediation — labelled section, accent markers so items don't blur together */}
      <div style={{
        fontSize: "0.72rem",
        fontWeight: 700,
        letterSpacing: ".09em",
        textTransform: "uppercase",
        color: "#8f7c6d",
        marginBottom: "12px",
      }}>
        How to fix it
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {probe.hints.map((h, i) => (
          <li key={i} style={{
            display: "flex",
            gap: "10px",
            marginBottom: "11px",
            color: "#c8b8ab",
            fontSize: "0.9rem",
            lineHeight: 1.45,
          }}>
            <span style={{ color: "#ff9152", flexShrink: 0, fontWeight: 700 }}>▸</span>
            <span>{renderInline(h)}</span>
          </li>
        ))}
      </ul>

      {/* Diagnostics — separated, muted, monospace for copy/paste into a report */}
      <div style={{
        marginTop: "22px",
        paddingTop: "16px",
        borderTop: "1px solid #2a1f18",
        fontSize: "0.76rem",
        color: "#7d6c60",
        fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
        wordBreak: "break-word",
      }}>
        {diag}
      </div>

      <div style={{ display: "flex", gap: "10px", marginTop: "22px" }}>
        <button className="wgpu-err__btn wgpu-err__btn--primary" onClick={() => window.location.reload()}>
          Retry
        </button>
        <button className="wgpu-err__btn wgpu-err__btn--ghost" onClick={() => window.location.assign("/")}>
          Back to library
        </button>
      </div>
    </div>
  );

  const styleTag = (
    <style>{`
      .wgpu-err__btn{border-radius:9px;padding:10px 18px;font-size:.92rem;font-weight:600;cursor:pointer;transition:background .12s,border-color .12s;}
      .wgpu-err__btn--primary{border:1px solid #d9762f;background:#c2611f;color:#fff;}
      .wgpu-err__btn--primary:hover{background:#d97431;}
      .wgpu-err__btn--ghost{border:1px solid #4a382e;background:transparent;color:#e2cdbf;}
      .wgpu-err__btn--ghost:hover{border-color:#6b5142;background:#20160f;}
    `}</style>
  );

  if (variant === "modal") {
    return (
      <div style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        boxSizing: "border-box",
        background: "rgba(6,5,4,.74)",
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
      }}>
        {styleTag}
        {card}
      </div>
    );
  }

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "radial-gradient(120% 120% at 50% 0%, #1a1310 0%, #0a0908 60%)",
      color: "#e8e8e8",
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      padding: "24px",
      boxSizing: "border-box",
    }}>
      {styleTag}
      {card}
    </div>
  );
}
