/**
 * Per-OLE32-instance registration state for OLE drag-and-drop targets.
 *
 * RegisterDragDrop owns one reference to the IDropTarget for as long as the
 * HWND is registered; RevokeDragDrop relinquishes exactly that reference.
 */

export const S_OK = 0x00000000;
export const E_INVALIDARG = 0x80070057;
export const E_OUTOFMEMORY = 0x8007000e;
export const DRAGDROP_E_NOTREGISTERED = 0x80040100;
export const DRAGDROP_E_ALREADYREGISTERED = 0x80040101;
export const DRAGDROP_E_INVALIDHWND = 0x80040102;

export interface DragDropRegistryOptions {
    isOleInitialized(): boolean;
    isWindowValid(hwnd: number): boolean;
    addRef(dropTarget: number): void;
    release(dropTarget: number): void;
}

/** State machine behind ole32!RegisterDragDrop / ole32!RevokeDragDrop. */
export class DragDropRegistry {
    private readonly registrations = new Map<number, number>();

    constructor(private readonly options: DragDropRegistryOptions) {}

    register(hwnd: number, dropTarget: number): number {
        // Microsoft documents E_OUTOFMEMORY when OLE was not initialized with
        // OleInitialize (including the CoInitialize/CoInitializeEx-only case).
        if (!this.options.isOleInitialized()) return E_OUTOFMEMORY;
        if (!dropTarget) return E_INVALIDARG;
        if (!this.options.isWindowValid(hwnd)) return DRAGDROP_E_INVALIDHWND;
        if (this.registrations.has(hwnd)) return DRAGDROP_E_ALREADYREGISTERED;

        this.options.addRef(dropTarget);
        this.registrations.set(hwnd, dropTarget);
        return S_OK;
    }

    revoke(hwnd: number): number {
        if (!this.options.isWindowValid(hwnd)) return DRAGDROP_E_INVALIDHWND;

        const dropTarget = this.registrations.get(hwnd);
        if (dropTarget === undefined) return DRAGDROP_E_NOTREGISTERED;

        // Remove before Release: a Release implementation may re-enter OLE.
        this.registrations.delete(hwnd);
        this.options.release(dropTarget);
        return S_OK;
    }

    /**
     * The window is gone. Windows revokes the registration as part of destruction, so
     * without this the target's reference leaks and a recycled HWND is refused with
     * DRAGDROP_E_ALREADYREGISTERED against a target the app no longer owns.
     */
    windowDestroyed(hwnd: number): void {
        const dropTarget = this.registrations.get(hwnd);
        if (dropTarget === undefined) return;
        this.registrations.delete(hwnd);
        this.options.release(dropTarget);
    }

    /**
     * Release every target still owned by this OLE32 instance.
     *
     * The map is emptied before invoking Release because COM destructors can
     * re-enter OLE32, and reset must not leave registrations reachable after a
     * process reset even if that happens.
     */
    reset(): void {
        const targets = [...this.registrations.values()];
        this.registrations.clear();
        for (const dropTarget of targets) this.options.release(dropTarget);
    }
}
