/**
 * User32 window lookup / hierarchy handlers: FindWindow/Enum* family,
 * parent/child navigation (GetWindow, GetParent, SetParent, IsChild) and
 * IsWindow-style state queries. These only read/reparent the shared window map —
 * Z-order / focus / capture core stays in window.ts.
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { WindowInfo, windows, getChildZOrderSibling } from './shared-state';
import { getWindowClass } from './class';

export function registerWindowQueryExports(exports: Record<string, ThunkImplementation>): void {
    const getClassFilter = (memory: Uint8Array, ptr: number, isWide: boolean): string | number | null => {
        if (!ptr) return null;
        if (ptr > 0 && ptr <= 0xFFFF) return ptr >>> 0;
        return isWide ? Marshaler.readWideString(memory, ptr) : Marshaler.readString(memory, ptr);
    };

    const matchesFindWindowFilters = (
        window: WindowInfo,
        classFilter: string | number | null,
        titleFilter: string | null
    ): boolean => {
        if (classFilter !== null) {
            if (typeof classFilter === "number") {
                if ((window.classId ?? 0) !== classFilter) {
                    return false;
                }
            } else {
                const windowClass = getWindowClass(window.classId || 0);
                const className = windowClass ? (typeof windowClass.className === "string" ? windowClass.className : "") : "";
                if (className !== classFilter) {
                    return false;
                }
            }
        }
        if (titleFilter !== null && window.title !== titleFilter) {
            return false;
        }
        return true;
    };

    const findWindowCore = (
        hWndParent: number,
        hWndChildAfter: number,
        classFilter: string | number | null,
        titleFilter: string | null
    ): number => {
        let passedChildAfter = hWndChildAfter === 0;
        for (const window of windows.values()) {
            const parent = window.parent ?? 0;
            if (hWndParent !== 0) {
                if (parent !== hWndParent) continue;
            } else if (parent !== 0) {
                continue;
            }

            if (!passedChildAfter) {
                if (window.handle === hWndChildAfter) {
                    passedChildAfter = true;
                }
                continue;
            }

            if (matchesFindWindowFilters(window, classFilter, titleFilter)) {
                return window.handle >>> 0;
            }
        }
        return 0;
    };

    // FindWindowA/W - find top-level window by class name or window name
    exports['FindWindowA'] = (ctx, mem, args) => {
        const classFilter = getClassFilter(mem, args[0], false);
        const titleFilter = args[1] ? Marshaler.readString(mem, args[1]) : null;
        const hwnd = findWindowCore(0, 0, classFilter, titleFilter);
        Logger.verbose(LogCategory.USER32, `FindWindowA -> 0x${hwnd.toString(16)}`);
        return hwnd;
    };

    exports['FindWindowW'] = (ctx, mem, args) => {
        const classFilter = getClassFilter(mem, args[0], true);
        const titleFilter = args[1] ? Marshaler.readWideString(mem, args[1]) : null;
        const hwnd = findWindowCore(0, 0, classFilter, titleFilter);
        Logger.verbose(LogCategory.USER32, `FindWindowW -> 0x${hwnd.toString(16)}`);
        return hwnd;
    };

    // FindWindowExA/W - find child window by parent/after handle and filters
    exports['FindWindowExA'] = (ctx, mem, args) => {
        const hWndParent = args[0] >>> 0;
        const hWndChildAfter = args[1] >>> 0;
        const classFilter = getClassFilter(mem, args[2], false);
        const titleFilter = args[3] ? Marshaler.readString(mem, args[3]) : null;
        const hwnd = findWindowCore(hWndParent, hWndChildAfter, classFilter, titleFilter);
        Logger.verbose(LogCategory.USER32, `FindWindowExA(parent=0x${hWndParent.toString(16)}, after=0x${hWndChildAfter.toString(16)}) -> 0x${hwnd.toString(16)}`);
        return hwnd;
    };

    exports['FindWindowExW'] = (ctx, mem, args) => {
        const hWndParent = args[0] >>> 0;
        const hWndChildAfter = args[1] >>> 0;
        const classFilter = getClassFilter(mem, args[2], true);
        const titleFilter = args[3] ? Marshaler.readWideString(mem, args[3]) : null;
        const hwnd = findWindowCore(hWndParent, hWndChildAfter, classFilter, titleFilter);
        Logger.verbose(LogCategory.USER32, `FindWindowExW(parent=0x${hWndParent.toString(16)}, after=0x${hWndChildAfter.toString(16)}) -> 0x${hwnd.toString(16)}`);
        return hwnd;
    };

    // EnumChildWindows - enumerates child windows of a parent
    exports['EnumChildWindows'] = (ctx, mem, args) => {
        const hWndParent = args[0];
        const lpEnumFunc = args[1];
        const lParam = args[2];
        Logger.verbose(LogCategory.USER32, `EnumChildWindows(0x${hWndParent.toString(16)}, 0x${lpEnumFunc.toString(16)}, 0x${lParam.toString(16)})`);
        // No child controls to enumerate — return 0
        return 0;
    };

    // EnumThreadWindows - enumerates the top-level windows owned by a thread.
    // Signature: BOOL EnumThreadWindows(DWORD dwThreadId, WNDENUMPROC lpfn, LPARAM lParam)
    // — 3 args (12 bytes). A wrong arg count here (it was declared as 2) makes the OUT
    // stub do `RET 8` instead of `RET 12`, leaking 4 bytes of the caller's stack on every
    // call → desync → the caller's later RET pops garbage and execution escapes to the
    // bootloader (0x7c07). Watcom's CRT startup calls GetCurrentThreadId then
    // EnumThreadWindows(tid, cb, lp), which is what surfaced this (Discworld Noir boot).
    // Like the sibling EnumWindows/EnumChildWindows, we do not re-enter the guest callback;
    // we report success with no windows enumerated (vacuously TRUE), which is correct for
    // the no-window state and keeps the stack balanced.
    exports['EnumThreadWindows'] = (ctx, mem, args) => {
        const dwThreadId = args[0] >>> 0;
        const lpfn = args[1] >>> 0;
        const lParam = args[2] >>> 0;
        Logger.verbose(LogCategory.USER32, `EnumThreadWindows(tid=${dwThreadId}, lpfn=0x${lpfn.toString(16)}, lParam=0x${lParam.toString(16)})`);
        return 1; // TRUE — enumeration completed (no thread-owned top-level windows to visit)
    };

    // GetWindow(hWnd, uCmd) - navigate window Z-order / hierarchy
    // GW_HWNDFIRST=0, GW_HWNDLAST=1, GW_HWNDNEXT=2, GW_HWNDPREV=3, GW_OWNER=4, GW_CHILD=5, GW_ENABLEDPOPUP=6
    exports['GetWindow'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const uCmd = args[1];
        const window = windows.get(hWnd);
        let result = 0;
        if (window) {
            if (uCmd === 5 /* GW_CHILD */) {
                result = (window.children && window.children.length > 0) ? window.children[0] : 0;
            } else if (uCmd === 4 /* GW_OWNER */) {
                result = window.parent || 0;
            } else if (uCmd === 2 /* GW_HWNDNEXT */) {
                result = getChildZOrderSibling(hWnd, 'next');
            } else if (uCmd === 3 /* GW_HWNDPREV */) {
                result = getChildZOrderSibling(hWnd, 'prev');
            }
        }
        Logger.verbose(LogCategory.USER32, `GetWindow(0x${hWnd.toString(16)}, ${uCmd}) -> 0x${result.toString(16)}`);
        return result;
    };

    // GetTopWindow - returns the first child window (topmost in Z-order)
    exports['GetTopWindow'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const window = hWnd ? windows.get(hWnd) : undefined;
        const result = (window?.children?.length) ? window.children[0] : 0;
        Logger.verbose(LogCategory.USER32, `GetTopWindow(0x${hWnd.toString(16)}) -> 0x${result.toString(16)}`);
        return result;
    };

    exports['GetWindowThreadProcessId'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpdwProcessId = args[1];
        if (lpdwProcessId && lpdwProcessId + 4 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpdwProcessId, 1, true);
        }
        return 1; // Stub: fake thread id
    };

    // SetParent - changes the parent of a child window
    exports['SetParent'] = (ctx, mem, args) => {
        const hWndChild = args[0];
        const hWndNewParent = args[1];
        Logger.log(LogCategory.USER32, `SetParent(0x${hWndChild.toString(16)}, 0x${hWndNewParent.toString(16)})`);
        const childWin = windows.get(hWndChild);
        if (!childWin) return 0;
        const oldParent = childWin.parent || 0;
        // Remove from old parent's children list
        if (childWin.parent) {
            const parent = windows.get(childWin.parent);
            if (parent) {
                const idx = parent.children.indexOf(hWndChild);
                if (idx >= 0) parent.children.splice(idx, 1);
            }
        }
        // Add to new parent's children list
        childWin.parent = hWndNewParent || undefined;
        if (hWndNewParent) {
            const newParent = windows.get(hWndNewParent);
            if (newParent) newParent.children.push(hWndChild);
        }
        return oldParent;
    };

    // GetParent - returns the parent window handle
    exports['GetParent'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const win = windows.get(hWnd);
        const parent = win?.parent || 0;
        // Don't return a parent handle whose window no longer exists. A child can
        // outlive its stored parent ref during teardown; returning a dead handle makes
        // callers that walk the parent chain (e.g. MFC CWnd::WalkPreTranslateTree →
        // FromHandlePermanent) deref a freed CWnd → garbage-vtable crash.
        if (parent && !windows.has(parent)) return 0;
        return parent;
    };

    // IsChild - determines whether a window is a child of a specified parent window
    exports['IsChild'] = (ctx, mem, args) => {
        const hWndParent = args[0];
        const hWnd = args[1];
        Logger.verbose(LogCategory.USER32, `IsChild(hWndParent=0x${hWndParent.toString(16)}, hWnd=0x${hWnd.toString(16)})`);
        // Check if hWnd is a child of hWndParent
        const childWindow = windows.get(hWnd);
        if (childWindow && childWindow.parent === hWndParent) {
            return 1; // TRUE
        }
        return 0; // FALSE
    };

    exports['IsWindow'] = (ctx, mem, args) => {
        const hWnd = args[0];
        // Check if window handle exists in our window map. A window mid deferred-destroy
        // (WM_NCDESTROY not yet dispatched) counts as already gone — Win32 IsWindow is
        // FALSE once DestroyWindow returns.
        const wi = hWnd !== 0 ? windows.get(hWnd) : undefined;
        const exists = !!wi && !wi.pendingDestroy;
        Logger.verbose(LogCategory.USER32, `IsWindow(0x${hWnd.toString(16)}) -> ${exists ? 1 : 0}`);
        return exists ? 1 : 0;
    };

    exports['IsWindowVisible'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const window = windows.get(hWnd);
        const visible = window ? window.visible : false;
        Logger.verbose(LogCategory.USER32, `IsWindowVisible(0x${hWnd.toString(16)}) -> ${visible ? 1 : 0}`);
        return visible ? 1 : 0;
    };

    exports['IsWindowEnabled'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const window = windows.get(hWnd);
        const enabled = !!window && (window.style & 0x08000000 /* WS_DISABLED */) === 0;
        Logger.verbose(LogCategory.USER32,
            `IsWindowEnabled(0x${hWnd.toString(16)}) -> ${enabled ? 1 : 0}`);
        return enabled ? 1 : 0;
    };

    exports['IsWindowUnicode'] = (ctx, mem, args) => {
        const hWnd = args[0];
        Logger.verbose(LogCategory.USER32, `IsWindowUnicode(0x${hWnd.toString(16)})`);
        return 0; // FALSE - we use ANSI
    };

    exports['IsIconic'] = (ctx, mem, args) => {
        // const hWnd = args[0];
        // Logger.verbose(LogCategory.USER32, `IsIconic(0x${hWnd.toString(16)})`);
        return 0; // FALSE – we don't track minimized state
    };

    exports['IsZoomed'] = (ctx, mem, args) => {
        // const hWnd = args[0];
        // Logger.verbose(LogCategory.USER32, `IsZoomed(0x${hWnd.toString(16)})`);
        return 0; // FALSE – fullscreen emulator; no WS_MAXIMIZE tracking
    };
}
