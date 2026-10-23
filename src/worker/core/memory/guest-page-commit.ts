import { System } from '../system';

type CommitNotifier = (addr: number, sizeBytes: number) => void;
let commitNotifier: CommitNotifier | null = null;
let resetNotifier: (() => void) | null = null;
let committedProbe: ((addr: number, sizeBytes: number) => boolean) | null = null;

/** kernel32 owns the logical VA state, including while CPU paging is disabled. */
export function registerGuestCommitNotifier(fn: CommitNotifier): void {
    commitNotifier = fn;
}

export function registerGuestMemoryResetNotifier(fn: () => void): void {
    resetNotifier = fn;
}

export function notifyGuestMemoryReset(memory: object): void {
    if (System.getInstance().process?.memory === memory) resetNotifier?.();
}

export function registerGuestCommittedProbe(fn: (addr: number, sizeBytes: number) => boolean): void {
    committedProbe = fn;
}

export function isGuestRangeCommitted(addr: number, sizeBytes: number): boolean {
    return committedProbe?.(addr, sizeBytes) ?? true;
}

/** A MemoryManager handout revives CPU pages and retires stale VA state together. */
export function ensureGuestPagesCommitted(addr: number, sizeBytes: number): void {
    if (addr === 0 || sizeBytes <= 0) return;
    const ptm = System.getInstance().process?.pageTableManager;
    if (ptm?.isPagingEnabled()) ptm.ensurePagesCommitted(addr, sizeBytes);
    commitNotifier?.(addr, sizeBytes);
}
