/**
 * Dialog bridge: links worker MessageBox requests to host UI (postMessage).
 * Host shows native alert/confirm and posts message_box_result; we resolve the Promise.
 */

import { harnessBus } from "../harness/event-bus";

let nextId = 0;
const pending = new Map<number, (result: number) => void>();
const pendingText = new Map<number, { text: string; caption: string; uType: number; sinceMs: number }>();

/**
 * The message boxes still waiting for an answer. The host draws them as DOM, so they are
 * invisible to every canvas capture: a guest blocked on one looks exactly like a hang, and
 * the one string that says what went wrong is nowhere in the picture. report() carries this
 * so the diagnosis is "waiting on <text>", not "frozen".
 */
export function pendingMessageBoxes(): Array<{ id: number; text: string; caption: string; uType: number; waitingMs: number }> {
    const now = performance.now();
    return [...pendingText.entries()].map(([id, m]) => ({
        id, text: m.text, caption: m.caption, uType: m.uType, waitingMs: Math.round(now - m.sinceMs),
    }));
}

export function requestMessageBox(text: string, caption: string, uType: number): Promise<number> {
    const id = ++nextId;
    return new Promise((resolve) => {
        pending.set(id, resolve);
        pendingText.set(id, { text, caption, uType, sinceMs: performance.now() });
        self.postMessage({ type: "show_message_box", id, text, caption, uType });
        // Harness modalShown event — lets unattended runs auto-answer.
        harnessBus.emit("modalShown", { id, text, caption, uType });
    });
}

export function resolveMessageBox(id: number, result: number): void {
    const resolve = pending.get(id);
    pendingText.delete(id);
    if (resolve) {
        pending.delete(id);
        resolve(result);
    }
}
