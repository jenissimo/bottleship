import { Power, Warning } from "@phosphor-icons/react";
import React from "react";
import { formatGuestReport } from "../guest-report";
import type { GuestExitInfo } from "../guest-report";
import { cx } from "../ui/cx";
import s from "./ExitOverlay.module.css";

interface ExitOverlayProps {
  exitInfo: GuestExitInfo | null;
  errorMessage: string | null;
  gameName: string;
  onDismissError: () => void;
}

export default function ExitOverlay({ exitInfo, errorMessage, gameName, onDismissError }: ExitOverlayProps) {
  if (!exitInfo && !errorMessage) return null;
  return (
    <div className={s["app__exit-overlay"]} role="dialog" aria-modal>
      <div className={s["app__exit-card"]}>
        {exitInfo ? (
          <>
            <div
              className={cx(s, "app__exit-glyph", exitInfo.crashed && "app__exit-glyph--crash")}
              aria-hidden
            >
              {exitInfo.crashed ? <Warning size={24} aria-hidden /> : <Power size={24} aria-hidden />}
            </div>
            <div className={s["app__exit-title"]}>{exitInfo.crashed ? "The game crashed" : "Game exited"}</div>
            <div className={s["app__exit-sub"]}>
              {exitInfo.crashed
                ? `${exitInfo.fault?.reason || "Unhandled access violation"}${exitInfo.fault ? ` — EIP 0x${(exitInfo.fault.eip >>> 0).toString(16)}, address 0x${(exitInfo.fault.faultAddr >>> 0).toString(16)}` : ""}.`
                : exitInfo.code === 0
                  ? "The process called ExitProcess (code 0)."
                  : `The process exited with code ${exitInfo.code}.`}
            </div>
            {exitInfo.fault?.lastThunk && (
              <div className={s["app__exit-sub"]} style={{ opacity: 0.7 }}>last call: {exitInfo.fault.lastThunk}</div>
            )}
            {exitInfo.fault && (
              <details className={s["app__exit-report"]}>
                <summary>{exitInfo.crashed ? "Crash report" : "Exit report"}</summary>
                <pre>{formatGuestReport(exitInfo.fault, gameName, !!exitInfo.crashed)}</pre>
              </details>
            )}
            <div className={s["app__exit-actions"]}>
              {exitInfo.fault && (
                <button
                  className={s["app__exit-btn"]}
                  onClick={() => { void navigator.clipboard?.writeText(formatGuestReport(exitInfo.fault!, gameName, !!exitInfo.crashed)); }}
                >
                  Copy report
                </button>
              )}
              <button className={cx(s, "app__exit-btn", "app__exit-btn--primary")} onClick={() => window.location.reload()}>
                Restart
              </button>
              <button className={s["app__exit-btn"]} onClick={() => window.location.assign("/")}>
                Back to library
              </button>
            </div>
          </>
        ) : (
          <>
            <div className={cx(s, "app__exit-glyph", "app__exit-glyph--crash")} aria-hidden><Warning size={24} /></div>
            <div className={s["app__exit-title"]}>Couldn't load the game</div>
            <div className={s["app__exit-sub"]}>{errorMessage}</div>
            <div className={s["app__exit-actions"]}>
              <button
                className={s["app__exit-btn"]}
                onClick={() => { void navigator.clipboard?.writeText(errorMessage ?? ""); }}
              >
                Copy
              </button>
              <button className={cx(s, "app__exit-btn", "app__exit-btn--primary")} onClick={onDismissError}>
                Dismiss
              </button>
              <button className={s["app__exit-btn"]} onClick={() => window.location.assign("/")}>
                Back to library
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
