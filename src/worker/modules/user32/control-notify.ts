/**
 * WM_NOTIFY plumbing shared by the JS-managed comctl32 controls.
 *
 * The notification is POSTED, not sent: a JS control handler has no thunk context
 * to suspend into a guest wndproc with, so it cannot read an LRESULT back. The
 * NMHDR therefore has to outlive the pump hop, which a small ring of THUNK_DATA
 * slots gives it without reuse races on nested notifies.
 */

import { System } from '../../core/system';
import type { WindowInfo } from './shared-state';

const WM_NOTIFY = 0x004e;

export const NOTIFY_SLOT_SIZE = 64;
const NOTIFY_RING = 8;

let notifyScratchBase = 0;
let notifyScratchIndex = 0;

/** Next slot in the ring; allocates the arena on first use. 0 when unavailable. */
export function allocNotifySlot(): number {
    const process = System.getInstance().process;
    if (!process) return 0;
    if (!notifyScratchBase) {
        notifyScratchBase = process.memory.alloc(NOTIFY_SLOT_SIZE * NOTIFY_RING, 'THUNK_DATA', 'rw');
    }
    if (!notifyScratchBase) return 0;
    const slot = notifyScratchBase + (notifyScratchIndex % NOTIFY_RING) * NOTIFY_SLOT_SIZE;
    notifyScratchIndex++;
    return slot;
}

/** NMHDR { HWND hwndFrom; UINT_PTR idFrom; UINT code; } */
export function writeNmHdr(
    mem: Uint8Array, ptr: number, hwndFrom: number, idFrom: number, code: number,
): void {
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    v.setUint32(ptr, hwndFrom >>> 0, true);
    v.setUint32(ptr + 4, idFrom >>> 0, true);
    v.setUint32(ptr + 8, code >>> 0, true);
}

/**
 * Post WM_NOTIFY to `child`'s parent with a zeroed slot whose NMHDR is filled in;
 * `fill` writes the struct's own tail. Returns the slot pointer, 0 on failure.
 */
export function postNotify(
    child: WindowInfo, code: number, fill?: (ptr: number, mem: Uint8Array) => void,
): number {
    const parent = child.parent;
    if (!parent) return 0;
    const system = System.getInstance();
    const mem = system.process?.getCurrentMemory?.();
    if (!mem) return 0;
    const ptr = allocNotifySlot();
    if (!ptr || ptr + NOTIFY_SLOT_SIZE > mem.length) return 0;
    for (let i = 0; i < NOTIFY_SLOT_SIZE; i++) mem[ptr + i] = 0;
    writeNmHdr(mem, ptr, child.handle, (child.controlId ?? 0) >>> 0, code);
    fill?.(ptr, mem);
    system.windowManager.postMessage(parent, WM_NOTIFY, (child.controlId ?? 0) >>> 0, ptr);
    system.scheduler.wakeMessageWaiters();
    return ptr;
}

/** The arena address dies with the guest address space. */
export function resetNotifyScratch(): void {
    notifyScratchBase = 0;
    notifyScratchIndex = 0;
}
