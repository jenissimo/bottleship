/**
 * Edge detector for the pad-present SAB slot: turns a polled level into the
 * arrival/removal events Windows announces with WM_DEVICECHANGE.
 *
 * The FIRST observation only seeds the tracked level. The host asserts a virtual
 * pad as present from boot on touch devices, before the guest has created any
 * window — that is initial state, not a hot-plug, and announcing it would post a
 * phantom arrival nobody can receive.
 *
 * Pure leaf (no imports) so the sequencing is unit-testable on its own.
 */

export type GamepadPresenceEvent = 'arrival' | 'removal';

export class GamepadPresenceTracker {
    private last: boolean | null = null;
    private transitions = 0;

    /** Level from the SAB. Returns the event to announce, or null (seed / no change). */
    observe(connected: boolean): GamepadPresenceEvent | null {
        if (this.last === null) {
            this.last = connected;
            return null;
        }
        if (this.last === connected) return null;
        this.last = connected;
        this.transitions++;
        return connected ? 'arrival' : 'removal';
    }

    /** False until the first observation — the next one seeds instead of announcing. */
    get seeded(): boolean {
        return this.last !== null;
    }

    /** Announced transitions since construction/reset. */
    get transitionCount(): number {
        return this.transitions;
    }

    /** Re-arm seeding (new process, or a new SAB whose initial level is unknown). */
    reset(): void {
        this.last = null;
        this.transitions = 0;
    }
}
