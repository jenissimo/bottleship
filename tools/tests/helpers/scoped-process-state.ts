/**
 * Process-wide singletons a test file replaces, put back when the file ends.
 * Sibling of scoped-globals.ts: that one covers globalThis, this one the emulator's own statics.
 */
import { afterAll } from "bun:test";
import { Mem } from "../../../src/worker/core/memory/mem-accessor";
import { snapshotComVtableOwners } from "../../../src/worker/core/com/com-memory";
import { System } from "../../../src/worker/core/system";
import { savestateParticipants } from "../../../src/worker/savestate/participant";

const MEM_KEYS = ["memoryGetter", "validateRange", "getRegion", "dataRoutes"] as const;

/** Mem.bind(...) replaces four statics at once; a later file that never binds would read this file's memory. */
export function preserveMemBinding(): void {
    const saved = MEM_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(Mem, key)] as const);
    afterAll(() => {
        for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(Mem, key, descriptor);
    });
}

/** Participants this file registers (and any it replaces by id) are taken out and the earlier ones put back. */
export function preserveSavestateParticipants(): void {
    const before = savestateParticipants.all();
    afterAll(() => {
        for (const p of savestateParticipants.all()) savestateParticipants.add(p)();
        for (const p of before) savestateParticipants.add(p);
    });
}

/** Releasing COM objects feeds System.trackComRelease: a counter, a 100 ms reset timer and the cleanup-mode flag. */
export function preserveComReleaseTracking(): void {
    const system = System.getInstance() as unknown as { isCleaningUp: boolean; _releaseCount: number; _releaseResetTimeout: ReturnType<typeof setTimeout> | null };
    const saved = { cleaning: system.isCleaningUp, count: system._releaseCount, timer: system._releaseResetTimeout };
    afterAll(() => {
        if (system._releaseResetTimeout !== saved.timer) clearTimeout(system._releaseResetTimeout ?? undefined);
        system._releaseResetTimeout = saved.timer;
        system._releaseCount = saved.count;
        system.isCleaningUp = saved.cleaning;
    });
}

/** Which HLE module owns a COM vtable is a process-global table; fake modules register their own addresses in it. */
export function preserveComVtableOwners(): void {
    const restore = snapshotComVtableOwners();
    afterAll(restore);
}
