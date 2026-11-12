/**
 * Registry of per-session state: everything that belongs to one guest session (one game in
 * one worker) and must not carry over into the next. System.reset() walks it, so a store
 * that registers here is reset on a game switch without another hand-written call.
 *
 * Phases run in the order System.reset() calls them; within a phase, entries run in
 * registration order. Savestate participants will extend an entry with capture/restore
 * and a schema version (issue #66); this first step only owns reset.
 */

export type SessionStatePhase =
    /** Host-side per-game services, reset before the CPU restarts. */
    | 'game-switch'
    /** Engine subsystems, reset after the CPU restarts and before the process resets. */
    | 'subsystems';

export interface SessionState {
    readonly id: string;
    readonly phase: SessionStatePhase;
    reset(): void;
}

export interface SessionResetFailure { id: string; error: unknown }

export class SessionStateRegistry {
    private readonly entries: SessionState[] = [];

    /** Register `entry`; an id registered again (a recreated owner) replaces the old entry in place. */
    register(entry: SessionState): () => void {
        const existing = this.entries.findIndex(e => e.id === entry.id);
        if (existing >= 0) this.entries[existing] = entry;
        else this.entries.push(entry);
        return () => {
            const i = this.entries.indexOf(entry);
            if (i >= 0) this.entries.splice(i, 1);
        };
    }

    /** Reset every entry of `phase`; a failing entry is reported and does not stop the rest. */
    resetPhase(phase: SessionStatePhase): SessionResetFailure[] {
        const failures: SessionResetFailure[] = [];
        for (const entry of this.entries) {
            if (entry.phase !== phase) continue;
            try { entry.reset(); } catch (error) { failures.push({ id: entry.id, error }); }
        }
        return failures;
    }

    ids(phase?: SessionStatePhase): string[] {
        return this.entries.filter(e => phase === undefined || e.phase === phase).map(e => e.id);
    }
}

export const sessionState = new SessionStateRegistry();
