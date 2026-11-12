/**
 * Per-process modal-dialog state: the active-dialog registry and the lifetime
 * binding of the modal message pump.
 *
 * The pump is anchored to ONE process: its steps dispatch through a suspended
 * thunk frame that dies with that process, yet the steps themselves are re-armed
 * from setTimeout, which does not. A pump left running by a torn-down guest would
 * otherwise keep firing and dispatch into the NEXT guest loaded into this worker,
 * where its frame does not exist. Every pump therefore captures the epoch it was
 * armed in; resetDialogPumps() bumps the epoch and drops the queued timers, so a
 * surviving pump is inert instead of fatal.
 */

export interface ActiveDialog {
    hwnd: number;
    dlgProc: number;
    result: number;
    closed: boolean;
    teardownStarted?: boolean;
    /** Owner we disabled for modality (Wine/NT); re-enabled on EndDialog. */
    disabledOwner?: number;
}

/** Modal dialogs of the CURRENT process, keyed by HWND (EndDialog result capture). */
// @refuse(a modal dialog is open)
export const activeDialogs = new Map<number, ActiveDialog>();

export interface PumpScheduler {
    /** Arm the next step. A no-op once the pump is no longer live. */
    schedule(step: () => void, delayMs: number): void;
    isLive(): boolean;
    /** Terminal: the pump cannot make progress and must never re-arm. */
    abandon(): void;
}

// @transient(generation of the host modal pump timers)
let pumpEpoch = 0;
// @transient(host timers of a modal pump, which only runs while a modal dialog is open)
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

export function createPumpScheduler(): PumpScheduler {
    const armedEpoch = pumpEpoch;
    let abandoned = false;
    const isLive = (): boolean => !abandoned && armedEpoch === pumpEpoch;
    return {
        isLive,
        abandon(): void { abandoned = true; },
        schedule(step: () => void, delayMs: number): void {
            if (!isLive()) return;
            const timer = setTimeout(() => {
                pendingTimers.delete(timer);
                // Re-checked at fire time: teardown can happen between arm and fire.
                if (!isLive()) return;
                step();
            }, delayMs);
            pendingTimers.add(timer);
        },
    };
}

/**
 * A modal pump with its next step armed is a thread blocked in the dialog's GetMessage:
 * like a GetMessage waiter, it can only be woken by a message, and USER timers are on
 * the virtual-time wheel, so the scheduler must keep that clock moving for it.
 */
export function hasWaitingModalPump(): boolean {
    return pendingTimers.size > 0;
}

/** Process teardown / new bundle load: no pump armed so far may run again. */
export function resetDialogPumps(): void {
    pumpEpoch++;
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    activeDialogs.clear();
}
