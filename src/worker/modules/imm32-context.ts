/**
 * IMM32 input contexts: the HIMC table, window association, and the client-side
 * INPUTCONTEXT block that ImmLockIMC hands out.
 *
 * Modelled on NT5 imm32 (context.c / misc.c) and win32k ntimm.c:
 *  - every thread has a default HIMC, and a window is associated with its creator
 *    thread's default until ImmAssociateContext[Ex] says otherwise (NULL included);
 *  - the INPUTCONTEXT is created on the first ImmLockIMC, as a moveable LHND local block,
 *    and its five IMCC components are LHND blocks too — so ImmLockIMCC/ImmUnlockIMCC ARE
 *    LocalLock/LocalUnlock, and the lock counts the guest observes are the kernel32 ones.
 *
 * No IME is installed, so no ImeSelect runs and hPrivate carries the no-IME sizeof(UINT).
 */

import { Mem } from "../core/memory/mem-accessor";

/** LMEM_MOVEABLE | LMEM_ZEROINIT. */
export const LHND = 0x0042;

/** imm.h / immdev.h INPUTCONTEXT, 32-bit layout (LOGFONTW is the larger lfFont arm). */
export const INPUTCONTEXT = {
    hWnd: 0,
    fOpen: 4,
    ptStatusWndPos: 8,
    ptSoftKbdPos: 16,
    fdwConversion: 24,
    fdwSentence: 28,
    lfFont: 32,
    cfCompForm: 124,
    cfCandForm: 152,
    hCompStr: 280,
    hCandInfo: 284,
    hGuideLine: 288,
    hPrivate: 292,
    dwNumMsgBuf: 296,
    hMsgBuf: 300,
    fdwInit: 304,
    dwReserve: 308,
    SIZE: 320,
} as const;

const CANDIDATEFORM_SIZE = 32;
const COMPOSITIONSTRING_SIZE = 100;
const CANDIDATEINFO_SIZE = 144;
const GUIDELINE_SIZE = 28;
const UINT_SIZE = 4;

export const IACE_CHILDREN = 0x0001;
export const IACE_DEFAULT = 0x0010;
export const IACE_IGNORENOCONTEXT = 0x0020;

/** kernel32 moveable local memory, the allocator every IMM block comes from. */
export interface ImmLocalMemory {
    /** LocalAlloc(LHND, bytes) → handle, or 0. */
    alloc(bytes: number): number;
    lock(handle: number): number;
    /** LocalUnlock: TRUE while still locked, FALSE once the count reaches zero or on error. */
    unlock(handle: number): number;
    /** LocalFree: 0 on success, the handle on failure. */
    free(handle: number): number;
    /** LocalFlags(handle) & LMEM_LOCKCOUNT. */
    lockCount(handle: number): number;
    size(handle: number): number;
    realloc(handle: number, bytes: number): number;
}

/** The window-manager facts the context table needs, and nothing else. */
export interface ImmWindowHost {
    currentThreadId(): number;
    /** Creator thread of a live window, or undefined when hwnd is not a window. */
    windowThread(hwnd: number): number | undefined;
    /** Every descendant of hwnd (BWL_ENUMCHILDREN order is irrelevant here). */
    descendants(hwnd: number): number[];
}

interface ImcRecord {
    threadId: number;
    isDefault: boolean;
    /** LHND handle of the INPUTCONTEXT, 0 until the first lock creates it. */
    hInputContext: number;
}

const HIMC_BASE = 0x00011000;
const HIMC_STRIDE = 4;

export class ImmContextTable {
    private contexts = new Map<number, ImcRecord>();
    private defaultByThread = new Map<number, number>();
    /** hwnd → associated HIMC; absent means the creator thread's default, 0 means none. */
    private associations = new Map<number, number>();
    private nextHimc = HIMC_BASE;

    constructor(private readonly host: ImmWindowHost) {}

    reset(): void {
        this.contexts.clear();
        this.defaultByThread.clear();
        this.associations.clear();
        this.nextHimc = HIMC_BASE;
    }

    isContext(himc: number): boolean {
        return this.contexts.has(himc >>> 0);
    }

    ownerThread(himc: number): number | undefined {
        return this.contexts.get(himc >>> 0)?.threadId;
    }

    defaultContext(threadId: number): number {
        let himc = this.defaultByThread.get(threadId);
        if (himc === undefined) {
            himc = this.newHandle(threadId, true);
            this.defaultByThread.set(threadId, himc);
        }
        return himc;
    }

    create(): number {
        return this.newHandle(this.host.currentThreadId(), false);
    }

    /** ImmDestroyContext: never the default, never another thread's. */
    destroy(himc: number, local: ImmLocalMemory): boolean {
        const rec = this.contexts.get(himc >>> 0);
        if (!rec || rec.isDefault || rec.threadId !== this.host.currentThreadId()) return false;
        for (const [hwnd, assoc] of this.associations) {
            if (assoc === himc) this.associations.delete(hwnd);
        }
        if (rec.hInputContext) this.freeInputContext(rec.hInputContext, local);
        this.contexts.delete(himc >>> 0);
        return true;
    }

    /** The HIMC stored on the window (pwnd->hImc): 0 for a NULL association. */
    windowContext(hwnd: number): number | undefined {
        const thread = this.host.windowThread(hwnd);
        if (thread === undefined) return undefined;
        const assoc = this.associations.get(hwnd >>> 0);
        return assoc !== undefined ? assoc : this.defaultContext(thread);
    }

    /** ImmAssociateContext: the previous HIMC, or 0 on failure. */
    associate(hwnd: number, himc: number): number {
        if (this.host.windowThread(hwnd) === undefined) return 0;
        if (himc && this.ownerThread(himc) !== this.host.currentThreadId()) return 0;
        const prev = this.windowContext(hwnd) ?? 0;
        if (prev === himc) return himc;
        this.associations.set(hwnd >>> 0, himc >>> 0);
        return prev;
    }

    /** ImmAssociateContextEx, following ntimm.c AssociateInputContextEx. */
    associateEx(hwnd: number, himc: number, flags: number): boolean {
        const windowThread = this.host.windowThread(hwnd);
        if (windowThread === undefined) return false;
        if (himc && !(flags & IACE_DEFAULT) && this.ownerThread(himc) !== this.host.currentThreadId()) {
            return false;
        }
        let target = himc >>> 0;
        if (flags & IACE_DEFAULT) {
            target = this.defaultContext(windowThread);
        } else if (target && this.ownerThread(target) !== windowThread) {
            return false;
        }
        const ignoreNoContext = (flags & IACE_IGNORENOCONTEXT) !== 0;
        if (flags & IACE_CHILDREN) {
            for (const child of this.host.descendants(hwnd)) {
                const current = this.windowContext(child);
                if (current === undefined || current === target) continue;
                if (current === 0 && ignoreNoContext) continue;
                this.associations.set(child >>> 0, target);
            }
        }
        const own = this.windowContext(hwnd) ?? 0;
        if ((own !== 0 || !ignoreNoContext) && own !== target) {
            this.associations.set(hwnd >>> 0, target);
        }
        return true;
    }

    windowDestroyed(hwnd: number): void {
        this.associations.delete(hwnd >>> 0);
    }

    /** ImmLockIMC: the INPUTCONTEXT pointer, created on first use; 0 for an invalid HIMC. */
    lock(himc: number, local: ImmLocalMemory): number {
        const rec = this.contexts.get(himc >>> 0);
        if (!rec) return 0;
        if (!rec.hInputContext) {
            rec.hInputContext = this.createInputContext(local);
            if (!rec.hInputContext) return 0;
        }
        return local.lock(rec.hInputContext) >>> 0;
    }

    /** ImmUnlockIMC: TRUE for any valid HIMC, whatever the lock count was. */
    unlock(himc: number, local: ImmLocalMemory): boolean {
        const rec = this.contexts.get(himc >>> 0);
        if (!rec) return false;
        if (rec.hInputContext) local.unlock(rec.hInputContext);
        return true;
    }

    lockCount(himc: number, local: ImmLocalMemory): number {
        const rec = this.contexts.get(himc >>> 0);
        return rec?.hInputContext ? local.lockCount(rec.hInputContext) : 0;
    }

    /** Lock, hand the INPUTCONTEXT to fn, unlock — the ImmLockIMC/ImmUnlockIMC bracket. */
    withInputContext<T>(himc: number, local: ImmLocalMemory, fn: (ic: number) => T): T | undefined {
        const ic = this.lock(himc, local);
        if (!ic) return undefined;
        try {
            return fn(ic);
        } finally {
            this.unlock(himc, local);
        }
    }

    private newHandle(threadId: number, isDefault: boolean): number {
        const himc = this.nextHimc >>> 0;
        this.nextHimc += HIMC_STRIDE;
        this.contexts.set(himc, { threadId, isDefault, hInputContext: 0 });
        return himc;
    }

    /** context.c CreateInputContext, for a thread with no IME selected. */
    private createInputContext(local: ImmLocalMemory): number {
        const handle = local.alloc(INPUTCONTEXT.SIZE);
        if (!handle) return 0;
        const ic = local.lock(handle) >>> 0;
        if (!ic) {
            local.free(handle);
            return 0;
        }
        const hCompStr = createSizedImcc(local, COMPOSITIONSTRING_SIZE, true);
        const hCandInfo = createSizedImcc(local, CANDIDATEINFO_SIZE, true);
        const hGuideLine = createSizedImcc(local, GUIDELINE_SIZE, true);
        const hMsgBuf = createSizedImcc(local, UINT_SIZE, false);
        const hPrivate = createSizedImcc(local, UINT_SIZE, false);
        if (!hCompStr || !hCandInfo || !hGuideLine || !hMsgBuf || !hPrivate) {
            for (const h of [hCompStr, hCandInfo, hGuideLine, hMsgBuf, hPrivate]) if (h) local.free(h);
            local.unlock(handle);
            local.free(handle);
            return 0;
        }
        Mem.writeUint32(ic + INPUTCONTEXT.hCompStr, hCompStr);
        Mem.writeUint32(ic + INPUTCONTEXT.hCandInfo, hCandInfo);
        Mem.writeUint32(ic + INPUTCONTEXT.hGuideLine, hGuideLine);
        Mem.writeUint32(ic + INPUTCONTEXT.hMsgBuf, hMsgBuf);
        Mem.writeUint32(ic + INPUTCONTEXT.hPrivate, hPrivate);
        Mem.writeUint32(ic + INPUTCONTEXT.dwNumMsgBuf, 0);
        Mem.writeUint32(ic + INPUTCONTEXT.fOpen, 0);
        Mem.writeUint32(ic + INPUTCONTEXT.fdwConversion, 0);
        Mem.writeUint32(ic + INPUTCONTEXT.fdwSentence, 0);
        for (let i = 0; i < 4; i++) {
            Mem.writeUint32(ic + INPUTCONTEXT.cfCandForm + i * CANDIDATEFORM_SIZE, 0xffffffff);
        }
        local.unlock(handle);
        return handle;
    }

    private freeInputContext(handle: number, local: ImmLocalMemory): void {
        const ic = local.lock(handle) >>> 0;
        if (ic) {
            for (const off of [INPUTCONTEXT.hCompStr, INPUTCONTEXT.hCandInfo, INPUTCONTEXT.hGuideLine,
                               INPUTCONTEXT.hMsgBuf, INPUTCONTEXT.hPrivate]) {
                const h = Mem.readUint32(ic + off) ?? 0;
                if (h) local.free(h);
            }
            local.unlock(handle);
        }
        local.free(handle);
    }
}

/** ImmCreateIMCC: at least a DWORD, LHND. `stampSize` writes the struct's own dwSize. */
function createSizedImcc(local: ImmLocalMemory, bytes: number, stampSize: boolean): number {
    const h = local.alloc(Math.max(UINT_SIZE, bytes));
    if (!h || !stampSize) return h;
    const p = local.lock(h) >>> 0;
    if (p) {
        Mem.writeUint32(p, bytes);
        local.unlock(h);
    }
    return h;
}
