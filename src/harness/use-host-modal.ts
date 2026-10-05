/**
 * Publish a HOST modal to the harness while it is on screen.
 *
 * `report().pendingModals` is built in the worker from the guest's MessageBox bridge,
 * so it can only ever see dialogs the GUEST asked for. A host dialog — the storage
 * manager, the WGB wizard, a manifest editor — is pure page DOM: it covers the canvas
 * and swallows the clicks a harness chain sends, while every worker-side verb keeps
 * answering normally. The chain then stalls with nothing anywhere reporting why, which
 * is the one failure shape a diagnostic must not have: blocked and slow must not look
 * alike.
 *
 * One line in a modal component keeps the census honest; the facade folds these into
 * the same `pendingModals` list, tagged `source:"host"`.
 */
import { useEffect } from "react";

export interface HostModalInfo {
    /** Shown to the operator — the dialog's title, when it has one. */
    caption?: string;
    /** Any extra detail worth reading in a report (a path, a game name). */
    text?: string;
}

/**
 * @param name  Stable identifier, unique per modal component (e.g. "storageManager").
 * @param open  Whether it is mounted/visible right now.
 */
export function useHostModal(name: string, open: boolean, info?: HostModalInfo): void {
    const caption = info?.caption;
    const text = info?.text;
    useEffect(() => {
        const harness = (window as unknown as {
            __BS__?: { harness?: { setHostModal?: (n: string, i: HostModalInfo | null) => void } };
        }).__BS__?.harness;
        if (!harness?.setHostModal) return;
        if (!open) { harness.setHostModal(name, null); return; }
        harness.setHostModal(name, { caption, text });
        // Unregister on unmount too: a modal torn down without its `open` flag going
        // false would otherwise stay in the census forever and fail every later load.
        return () => harness.setHostModal?.(name, null);
    }, [name, open, caption, text]);
}
