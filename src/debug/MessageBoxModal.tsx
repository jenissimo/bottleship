import React from "react";
import { cx } from "../ui/cx";
import s from "./MessageBoxModal.module.css";
import ms from "../ui/Modal/Modal.module.css";
import { ActionButton } from "../ui/ActionButton";

export interface MsgBoxButton { label: string; result: number; primary?: boolean }
export function messageBoxButtons(typeMask: number): MsgBoxButton[] {
  switch (typeMask) {
    case 1: return [{ label: "OK", result: 1, primary: true }, { label: "Cancel", result: 2 }];
    case 2: return [{ label: "Abort", result: 3 }, { label: "Retry", result: 4 }, { label: "Ignore", result: 5, primary: true }];
    case 3: return [{ label: "Yes", result: 6, primary: true }, { label: "No", result: 7 }, { label: "Cancel", result: 2 }];
    case 4: return [{ label: "Yes", result: 6, primary: true }, { label: "No", result: 7 }];
    case 5: return [{ label: "Retry", result: 4, primary: true }, { label: "Cancel", result: 2 }];
    case 6: return [{ label: "Cancel", result: 2 }, { label: "Try Again", result: 10 }, { label: "Continue", result: 11, primary: true }];
    default: return [{ label: "OK", result: 1, primary: true }];
  }
}
export function messageBoxEscResult(buttons: MsgBoxButton[]): number {
  return (buttons.find((b) => b.result === 2)
    ?? buttons.find((b) => b.result === 7)
    ?? buttons.find((b) => b.primary)
    ?? buttons[0]).result;
}

export interface MessageBoxRequest {
  id: number;
  text: string;
  caption: string;
  typeMask: number;
  worker: Worker | MessagePort;
}

interface MessageBoxModalProps {
  messageBox: MessageBoxRequest;
  onClose: () => void;
}

export default function MessageBoxModal({ messageBox, onClose }: MessageBoxModalProps) {
  const buttons = messageBoxButtons(messageBox.typeMask);
  const close = (result: number) => {
    messageBox.worker.postMessage({ type: "message_box_result", id: messageBox.id, result });
    onClose();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(messageBoxEscResult(buttons)); }
    else if (e.key === "Enter") { e.preventDefault(); close((buttons.find((b) => b.primary) ?? buttons[0]).result); }
  };
  return (
    <div className={ms["modal-overlay"]} onKeyDown={onKeyDown}>
      <div
        className={cx(ms, "modal-content") + " " + s["messagebox-modal"]}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal={true}
        aria-label={messageBox.caption || "Message"}
        ref={(el) => el?.focus()}
        tabIndex={-1}
      >
        <div className={ms["modal-header"]}>
          <h2>{messageBox.caption || "Message"}</h2>
          <button className={ms["modal-close"]} onClick={() => close(messageBoxEscResult(buttons))}>×</button>
        </div>
        <div className={ms["modal-body"]}>
          <p className={s["messagebox-text"]}>{messageBox.text}</p>
        </div>
        <div className={s["messagebox-buttons"]}>
          {buttons.map((b) => (
            <ActionButton
              key={b.result}
              variant={b.primary ? "default" : "secondary"}
              autoFocus={b.primary}
              onClick={() => close(b.result)}
            >
              {b.label}
            </ActionButton>
          ))}
        </div>
      </div>
    </div>
  );
}
