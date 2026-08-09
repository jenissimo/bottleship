/**
 * User32 Window Class functions
 *
 * Atomic implementation for window class operations
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { Mem } from '../../core/memory/mem-accessor';
import { System } from '../../core/system';
import { getWindowByHandle } from './shared-state';
import { encodeAnsi } from '../codepage-utils';
import { getBuiltinSystemClass, getDefWindowProcAddress, resetDefWindowProcCache } from './system-classes';
import { getSystemCursorHandle } from './system-cursors';

// Store for registered window classes
const windowClasses: Map<number, any> = new Map();
const windowClassesByName: Map<string, number> = new Map();
let nextClassId = 1;

/**
 * Classes the APP registered itself (RegisterClass*), as opposed to the OS classes we
 * materialize (Button/Static/#32770) and the comctl32 classes we implement in JS.
 *
 * A window of an app class has no default appearance at all: Windows paints it solely by
 * running the app's own wndProc, so if we never deliver WM_PAINT to it, it is invisible
 * forever — no chrome, no fallback. That is the distinction our paint paths need, and it
 * is not derivable from the class NAME.
 */
const appRegisteredClasses = new Set<string>();

/** True if `className` was registered by the guest, not materialized by us. */
export function isAppRegisteredClass(className: string | undefined): boolean {
    return !!className && appRegisteredClasses.has(className.toLowerCase());
}

/**
 * Bundle-switch reset: app classes carry WNDPROC pointers into the old process
 * image, and the builtin materialization cache holds cursor handles / the
 * DefWindowProc thunk address from the old layout — all stale after an
 * in-worker game switch.
 */
export function resetUser32Classes(): void {
    windowClasses.clear();
    windowClassesByName.clear();
    appRegisteredClasses.clear();
    nextClassId = 1;
    builtinClassInfoCache.clear();
    resetDefWindowProcCache();
}

/**
 * Internal helper to register a window class
 * Handles storage in maps and registration with WindowManager
 */
function registerClassInternal(className: string, classInfo: any): number {
    const classId = nextClassId++;
    windowClasses.set(classId, classInfo);
    windowClassesByName.set(className.toLowerCase(), classId);
    // Everything routed here that is not a builtin materialization came from the app's
    // own RegisterClass* — see appRegisteredClasses.
    if (classInfo?.appRegistered) appRegisteredClasses.add(className.toLowerCase());

    // Also register in system WindowManager
    System.getInstance().windowManager.registerClass({
        name: className,
        wndProc: classInfo.lpfnWndProc,
        hInstance: classInfo.hInstance,
        style: classInfo.style,
        hbrBackground: classInfo.hbrBackground
    });

    return classId;
}

/** Register a built-in class if not already present (comctl32 common controls). */
export function registerBuiltinClass(className: string, classInfo: Partial<{
    style: number;
    lpfnWndProc: number;
    cbClsExtra: number;
    cbWndExtra: number;
    hInstance: number;
    hbrBackground: number;
    hCursor: number;
    /** When set, CreateWindowEx marks the window as a JS system control. */
    controlClass?: string;
    /** A dedicated HLE subsystem owns this class's pixels. */
    externalPaintManaged?: boolean;
}>): void {
    if (windowClassesByName.has(className.toLowerCase())) return;
    registerClassInternal(className, {
        className,
        style: classInfo.style ?? 0,
        lpfnWndProc: classInfo.lpfnWndProc ?? 0,
        cbClsExtra: classInfo.cbClsExtra ?? 0,
        cbWndExtra: classInfo.cbWndExtra ?? 0,
        hInstance: classInfo.hInstance ?? 0,
        hIcon: 0,
        hCursor: classInfo.hCursor ?? 0,
        hbrBackground: classInfo.hbrBackground ?? 0,
        lpszMenuName: 0,
        controlClass: classInfo.controlClass,
        externalPaintManaged: classInfo.externalPaintManaged,
    });
    Logger.log(LogCategory.USER32, `registerBuiltinClass: "${className}"`);
}

export function createClassExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['RegisterClassExA'] = (ctx, mem, args) => {
        const lpWndClass = args[0];

        Logger.verbose(LogCategory.USER32, `RegisterClassExA(0x${lpWndClass.toString(16)})`);

        if (lpWndClass) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Read WNDCLASSEXA structure
            const cbSize = view.getUint32(lpWndClass, true);
            const style = view.getUint32(lpWndClass + 4, true);
            const lpfnWndProc = view.getUint32(lpWndClass + 8, true);
            const cbClsExtra = view.getUint32(lpWndClass + 12, true);
            const cbWndExtra = view.getUint32(lpWndClass + 16, true);
            const hInstance = view.getUint32(lpWndClass + 20, true);
            const hIcon = view.getUint32(lpWndClass + 24, true);
            const hCursor = view.getUint32(lpWndClass + 28, true);
            const hbrBackground = view.getUint32(lpWndClass + 32, true);
            const lpszMenuName = view.getUint32(lpWndClass + 36, true);
            const lpszClassName = view.getUint32(lpWndClass + 40, true);

            const className = Marshaler.readString(mem, lpszClassName);

            Logger.log(LogCategory.USER32, `RegisterClassExA: class "${className}" (cbSize: ${cbSize})`);

            // Store class info
            const classInfo = {
                className,
                style,
                lpfnWndProc,
                cbClsExtra,
                cbWndExtra,
                hInstance,
                hIcon,
                hCursor,
                hbrBackground,
                lpszMenuName,
                appRegistered: true,
            };

            const classId = registerClassInternal(className, classInfo);
            return classId; // Return atom/class ID
        }

        return 0; // Failure
    };

    exports['RegisterClassExW'] = (ctx, mem, args) => {
        const lpWndClass = args[0];

        Logger.verbose(LogCategory.USER32, `RegisterClassExW(0x${lpWndClass.toString(16)})`);

        if (lpWndClass) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Read WNDCLASSEXW structure
            const cbSize = view.getUint32(lpWndClass, true);
            const style = view.getUint32(lpWndClass + 4, true);
            const lpfnWndProc = view.getUint32(lpWndClass + 8, true);
            const cbClsExtra = view.getUint32(lpWndClass + 12, true);
            const cbWndExtra = view.getUint32(lpWndClass + 16, true);
            const hInstance = view.getUint32(lpWndClass + 20, true);
            const hIcon = view.getUint32(lpWndClass + 24, true);
            const hCursor = view.getUint32(lpWndClass + 28, true);
            const hbrBackground = view.getUint32(lpWndClass + 32, true);
            const lpszMenuName = view.getUint32(lpWndClass + 36, true);
            const lpszClassName = view.getUint32(lpWndClass + 40, true);

            const className = Marshaler.readWideString(mem, lpszClassName);

            Logger.log(LogCategory.USER32, `RegisterClassExW: class "${className}" (cbSize: ${cbSize})`);

            // Store class info
            const classInfo = {
                className,
                style,
                lpfnWndProc,
                cbClsExtra,
                cbWndExtra,
                hInstance,
                hIcon,
                hCursor,
                hbrBackground,
                lpszMenuName,
                appRegistered: true,
            };

            const classId = registerClassInternal(className, classInfo);
            return classId; // Return atom/class ID
        }

        return 0; // Failure
    };

    exports['RegisterClassA'] = (ctx, mem, args) => {
        const lpWndClass = args[0];

        Logger.verbose(LogCategory.USER32, `RegisterClassA(0x${lpWndClass.toString(16)})`);

        if (lpWndClass) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Heuristic: Some apps pass WNDCLASSEX to RegisterClassA (cbSize present at offset 0)
            const first = view.getUint32(lpWndClass, true);
            const looksLikeEx = first === 0x30 || first === 0x2c;

            let style = 0;
            let lpfnWndProc = 0;
            let cbClsExtra = 0;
            let cbWndExtra = 0;
            let hInstance = 0;
            let hIcon = 0;
            let hCursor = 0;
            let hbrBackground = 0;
            let lpszMenuName = 0;
            let lpszClassName = 0;

            if (looksLikeEx) {
                const cbSize = first;
                style = view.getUint32(lpWndClass + 4, true);
                lpfnWndProc = view.getUint32(lpWndClass + 8, true);
                cbClsExtra = view.getUint32(lpWndClass + 12, true);
                cbWndExtra = view.getUint32(lpWndClass + 16, true);
                hInstance = view.getUint32(lpWndClass + 20, true);
                hIcon = view.getUint32(lpWndClass + 24, true);
                hCursor = view.getUint32(lpWndClass + 28, true);
                hbrBackground = view.getUint32(lpWndClass + 32, true);
                lpszMenuName = view.getUint32(lpWndClass + 36, true);
                lpszClassName = view.getUint32(lpWndClass + 40, true);
                Logger.warn(LogCategory.USER32, `RegisterClassA: detected WNDCLASSEX (cbSize=${cbSize})`);
            } else {
                // Read WNDCLASSA structure (no cbSize field, starts with style)
                style = first;
                lpfnWndProc = view.getUint32(lpWndClass + 4, true);
                cbClsExtra = view.getUint32(lpWndClass + 8, true);
                cbWndExtra = view.getUint32(lpWndClass + 12, true);
                hInstance = view.getUint32(lpWndClass + 16, true);
                hIcon = view.getUint32(lpWndClass + 20, true);
                hCursor = view.getUint32(lpWndClass + 24, true);
                hbrBackground = view.getUint32(lpWndClass + 28, true);
                lpszMenuName = view.getUint32(lpWndClass + 32, true);
                lpszClassName = view.getUint32(lpWndClass + 36, true);
            }

            const className = Marshaler.readString(mem, lpszClassName);

            Logger.log(LogCategory.USER32,
                `RegisterClassA: class "${className}" wndProc=0x${lpfnWndProc.toString(16)}`);

            // Store class info
            const classInfo = {
                className,
                style,
                lpfnWndProc,
                cbClsExtra,
                cbWndExtra,
                hInstance,
                hIcon,
                hCursor,
                hbrBackground,
                lpszMenuName,
                appRegistered: true,
            };

            const classId = registerClassInternal(className, classInfo);
            return classId; // Return atom/class ID
        }

        return 0; // Failure
    };

    exports['RegisterClassW'] = (ctx, mem, args) => {
        const lpWndClass = args[0];

        Logger.verbose(LogCategory.USER32, `RegisterClassW(0x${lpWndClass.toString(16)})`);

        if (lpWndClass) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Heuristic: Some apps pass WNDCLASSEX to RegisterClassW (cbSize present at offset 0)
            const first = view.getUint32(lpWndClass, true);
            const looksLikeEx = first === 0x30 || first === 0x2c;

            let style = 0;
            let lpfnWndProc = 0;
            let cbClsExtra = 0;
            let cbWndExtra = 0;
            let hInstance = 0;
            let hIcon = 0;
            let hCursor = 0;
            let hbrBackground = 0;
            let lpszMenuName = 0;
            let lpszClassName = 0;

            if (looksLikeEx) {
                const cbSize = first;
                style = view.getUint32(lpWndClass + 4, true);
                lpfnWndProc = view.getUint32(lpWndClass + 8, true);
                cbClsExtra = view.getUint32(lpWndClass + 12, true);
                cbWndExtra = view.getUint32(lpWndClass + 16, true);
                hInstance = view.getUint32(lpWndClass + 20, true);
                hIcon = view.getUint32(lpWndClass + 24, true);
                hCursor = view.getUint32(lpWndClass + 28, true);
                hbrBackground = view.getUint32(lpWndClass + 32, true);
                lpszMenuName = view.getUint32(lpWndClass + 36, true);
                lpszClassName = view.getUint32(lpWndClass + 40, true);
                Logger.warn(LogCategory.USER32, `RegisterClassW: detected WNDCLASSEX (cbSize=${cbSize})`);
            } else {
                // Read WNDCLASSW structure (no cbSize field, starts with style)
                style = first;
                lpfnWndProc = view.getUint32(lpWndClass + 4, true);
                cbClsExtra = view.getUint32(lpWndClass + 8, true);
                cbWndExtra = view.getUint32(lpWndClass + 12, true);
                hInstance = view.getUint32(lpWndClass + 16, true);
                hIcon = view.getUint32(lpWndClass + 20, true);
                hCursor = view.getUint32(lpWndClass + 24, true);
                hbrBackground = view.getUint32(lpWndClass + 28, true);
                lpszMenuName = view.getUint32(lpWndClass + 32, true);
                lpszClassName = view.getUint32(lpWndClass + 36, true);
            }

            const className = Marshaler.readWideString(mem, lpszClassName);

            Logger.log(LogCategory.USER32,
                `RegisterClassW: class "${className}" wndProc=0x${lpfnWndProc.toString(16)}`);

            // Store class info
            const classInfo = {
                className,
                style,
                lpfnWndProc,
                cbClsExtra,
                cbWndExtra,
                hInstance,
                hIcon,
                hCursor,
                hbrBackground,
                lpszMenuName,
                appRegistered: true,
            };

            const classId = registerClassInternal(className, classInfo);
            return classId; // Return atom/class ID
        }

        return 0; // Failure
    };

    // GetClassInfoA - retrieves information about a window class
    exports['GetClassInfoA'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpClassName = args[1];
        const lpWndClass = args[2];

        let className: string;
        if (lpClassName > 0 && lpClassName <= 0xFFFF) {
            // It's an atom (class ID)
            const classInfo = windowClasses.get(lpClassName);
            className = classInfo?.className ?? `atom_${lpClassName}`;
        } else if (lpClassName) {
            className = Marshaler.readString(mem, lpClassName);
        } else {
            Logger.warn(LogCategory.USER32, 'GetClassInfoA: NULL class name');
            return 0; // FALSE
        }

        Logger.verbose(LogCategory.USER32, `GetClassInfoA(0x${hInstance.toString(16)}, "${className}", 0x${lpWndClass.toString(16)})`);

        // Look up the class by name
        const classInfo = getWindowClassByName(className);

        if (!classInfo) {
            Logger.verbose(LogCategory.USER32, `GetClassInfoA: Class "${className}" not found`);
            return 0; // FALSE - class not found
        }

        // Fill in WNDCLASSA structure if lpWndClass is provided
        if (lpWndClass && lpWndClass + 40 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            // WNDCLASSA structure (40 bytes):
            // UINT      style;           offset 0
            // WNDPROC   lpfnWndProc;     offset 4
            // int       cbClsExtra;      offset 8
            // int       cbWndExtra;      offset 12
            // HINSTANCE hInstance;       offset 16
            // HICON     hIcon;           offset 20
            // HCURSOR   hCursor;         offset 24
            // HBRUSH    hbrBackground;   offset 28
            // LPCSTR    lpszMenuName;    offset 32
            // LPCSTR    lpszClassName;   offset 36
            view.setUint32(lpWndClass, classInfo.style ?? 0, true);
            view.setUint32(lpWndClass + 4, classInfo.lpfnWndProc ?? 0, true);
            view.setInt32(lpWndClass + 8, classInfo.cbClsExtra ?? 0, true);
            view.setInt32(lpWndClass + 12, classInfo.cbWndExtra ?? 0, true);
            view.setUint32(lpWndClass + 16, classInfo.hInstance ?? hInstance, true);
            view.setUint32(lpWndClass + 20, classInfo.hIcon ?? 0, true);
            view.setUint32(lpWndClass + 24, classInfo.hCursor ?? 0, true);
            view.setUint32(lpWndClass + 28, classInfo.hbrBackground ?? 0, true);
            view.setUint32(lpWndClass + 32, classInfo.lpszMenuName ?? 0, true);
            // lpszClassName - we can't easily provide this since it's a pointer
            // Apps typically don't use this field from the output
            view.setUint32(lpWndClass + 36, 0, true);
        }

        Logger.verbose(LogCategory.USER32, `GetClassInfoA: Class "${className}" found`);
        return 1; // TRUE - class found
    };

    // GetClassInfoW - retrieves information about a window class (wide)
    exports['GetClassInfoW'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpClassName = args[1];
        const lpWndClass = args[2];

        let className: string;
        if (lpClassName > 0 && lpClassName <= 0xFFFF) {
            const classInfo = windowClasses.get(lpClassName);
            className = classInfo?.className ?? `atom_${lpClassName}`;
        } else if (lpClassName) {
            className = Marshaler.readWideString(mem, lpClassName);
        } else {
            Logger.warn(LogCategory.USER32, 'GetClassInfoW: NULL class name');
            return 0; // FALSE
        }

        Logger.verbose(LogCategory.USER32, `GetClassInfoW(0x${hInstance.toString(16)}, "${className}", 0x${lpWndClass.toString(16)})`);

        const classInfo = getWindowClassByName(className);

        if (!classInfo) {
            Logger.verbose(LogCategory.USER32, `GetClassInfoW: Class "${className}" not found`);
            return 0; // FALSE
        }

        if (lpWndClass && lpWndClass + 40 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpWndClass, classInfo.style ?? 0, true);
            view.setUint32(lpWndClass + 4, classInfo.lpfnWndProc ?? 0, true);
            view.setInt32(lpWndClass + 8, classInfo.cbClsExtra ?? 0, true);
            view.setInt32(lpWndClass + 12, classInfo.cbWndExtra ?? 0, true);
            view.setUint32(lpWndClass + 16, classInfo.hInstance ?? hInstance, true);
            view.setUint32(lpWndClass + 20, classInfo.hIcon ?? 0, true);
            view.setUint32(lpWndClass + 24, classInfo.hCursor ?? 0, true);
            view.setUint32(lpWndClass + 28, classInfo.hbrBackground ?? 0, true);
            view.setUint32(lpWndClass + 32, classInfo.lpszMenuName ?? 0, true);
            view.setUint32(lpWndClass + 36, 0, true);
        }

        Logger.verbose(LogCategory.USER32, `GetClassInfoW: Class "${className}" found`);
        return 1; // TRUE
    };

    // GetClassInfoExA - retrieves information about a window class (extended)
    exports['GetClassInfoExA'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpClassName = args[1];
        const lpWndClassEx = args[2];

        let className: string;
        if (lpClassName > 0 && lpClassName <= 0xFFFF) {
            const classInfo = windowClasses.get(lpClassName);
            className = classInfo?.className ?? `atom_${lpClassName}`;
        } else if (lpClassName) {
            className = Marshaler.readString(mem, lpClassName);
        } else {
            Logger.warn(LogCategory.USER32, 'GetClassInfoExA: NULL class name');
            return 0;
        }

        // Use registered class or fall back to system class stub
        // When hInstance=NULL, Windows searches system/global classes (LISTBOX, BUTTON,
        // msctls_trackbar32, etc.) — always return success for these lookups
        const classInfo = getWindowClassByName(className) ?? (hInstance === 0 ? SYSTEM_CLASS_STUB : null);
        if (!classInfo) return 0;

        if (lpWndClassEx) {
            const cbSize = Mem.readUint32(lpWndClassEx) ?? 48;
            if (cbSize < 40) {
                return 0;
            }
            Mem.writeUint32(lpWndClassEx + 0, cbSize || 48); // cbSize
            Mem.writeUint32(lpWndClassEx + 4, (classInfo.style ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 8, (classInfo.lpfnWndProc ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 12, (classInfo.cbClsExtra ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 16, (classInfo.cbWndExtra ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 20, (classInfo.hInstance ?? hInstance) >>> 0);
            Mem.writeUint32(lpWndClassEx + 24, (classInfo.hIcon ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 28, (classInfo.hCursor ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 32, (classInfo.hbrBackground ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 36, (classInfo.lpszMenuName ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 40, 0); // lpszClassName (not materialized)
            if (cbSize >= 48) {
                Mem.writeUint32(lpWndClassEx + 44, (classInfo.hIcon ?? 0) >>> 0); // hIconSm
            }
        }

        return 1;
    };

    // GetClassInfoExW - retrieves information about a window class (extended, wide)
    exports['GetClassInfoExW'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpClassName = args[1];
        const lpWndClassEx = args[2];

        let className: string;
        if (lpClassName > 0 && lpClassName <= 0xFFFF) {
            const classInfo = windowClasses.get(lpClassName);
            className = classInfo?.className ?? `atom_${lpClassName}`;
        } else if (lpClassName) {
            className = Marshaler.readWideString(mem, lpClassName);
        } else {
            Logger.warn(LogCategory.USER32, 'GetClassInfoExW: NULL class name');
            return 0;
        }

        const classInfo = getWindowClassByName(className) ?? (hInstance === 0 ? SYSTEM_CLASS_STUB : null);
        if (!classInfo) return 0;

        if (lpWndClassEx) {
            const cbSize = Mem.readUint32(lpWndClassEx) ?? 48;
            if (cbSize < 40) {
                return 0;
            }
            Mem.writeUint32(lpWndClassEx + 0, cbSize || 48); // cbSize
            Mem.writeUint32(lpWndClassEx + 4, (classInfo.style ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 8, (classInfo.lpfnWndProc ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 12, (classInfo.cbClsExtra ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 16, (classInfo.cbWndExtra ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 20, (classInfo.hInstance ?? hInstance) >>> 0);
            Mem.writeUint32(lpWndClassEx + 24, (classInfo.hIcon ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 28, (classInfo.hCursor ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 32, (classInfo.hbrBackground ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 36, (classInfo.lpszMenuName ?? 0) >>> 0);
            Mem.writeUint32(lpWndClassEx + 40, 0); // lpszClassName (not materialized)
            if (cbSize >= 48) {
                Mem.writeUint32(lpWndClassEx + 44, (classInfo.hIcon ?? 0) >>> 0); // hIconSm
            }
        }

        return 1;
    };

    // UnregisterClassA - unregisters a window class
    exports['UnregisterClassA'] = (ctx, mem, args) => {
        const lpClassName = args[0];
        const hInstance = args[1];

        let className: string;
        if (lpClassName <= 0xFFFF) {
            // It's an atom (class ID)
            className = `atom_${lpClassName}`;
        } else {
            className = Marshaler.readString(mem, lpClassName);
        }

        Logger.verbose(LogCategory.USER32, `UnregisterClassA: "${className}" hInstance=0x${hInstance.toString(16)}`);

        // Find and remove the class
        for (const [classId, classInfo] of windowClasses.entries()) {
            if (classInfo.className.toLowerCase() === className.toLowerCase()) {
                windowClasses.delete(classId);
                Logger.log(LogCategory.USER32, `UnregisterClassA: Removed class "${className}"`);
                return 1; // TRUE = success
            }
        }

        // Class not found - still return success (common behavior)
        return 1;
    };

    // UnregisterClassW - unregisters a window class (wide)
    exports['UnregisterClassW'] = (ctx, mem, args) => {
        const lpClassName = args[0];
        const hInstance = args[1];

        let className: string;
        if (lpClassName <= 0xFFFF) {
            className = `atom_${lpClassName}`;
        } else {
            className = Marshaler.readWideString(mem, lpClassName);
        }

        Logger.verbose(LogCategory.USER32, `UnregisterClassW: "${className}" hInstance=0x${hInstance.toString(16)}`);

        for (const [classId, classInfo] of windowClasses.entries()) {
            if (classInfo.className.toLowerCase() === className.toLowerCase()) {
                windowClasses.delete(classId);
                return 1;
            }
        }

        return 1;
    };

    const ERROR_INVALID_WINDOW_HANDLE = 1400;

    /** Resolve the registered class name for a window handle (null = invalid hWnd). */
    function resolveWindowClassName(hWnd: number): string | null {
        const win = getWindowByHandle(hWnd);
        if (!win) return null;
        if (win.nativeClassName) return win.nativeClassName;
        if (win.classId !== undefined) {
            const classInfo = getWindowClass(win.classId);
            if (classInfo?.className) return classInfo.className;
        }
        return win.systemControlClass ?? '';
    }

    // GetClassNameA - retrieves the name of the class a window belongs to.
    // Returns chars copied (excluding NUL); truncates to nMaxCount incl. NUL.
    exports['GetClassNameA'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const lpClassName = args[1] >>> 0;
        const nMaxCount = args[2] | 0;
        if (!lpClassName || nMaxCount <= 0) return 0;

        const className = resolveWindowClassName(hWnd);
        if (className === null) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }

        const encoded = encodeAnsi(className);
        const writeLen = Math.min(encoded.length, nMaxCount - 1);
        if (writeLen > 0) {
            Mem.writeBytes(lpClassName, encoded.subarray(0, writeLen));
        }
        Mem.writeBytes(lpClassName + writeLen, new Uint8Array([0]));

        Logger.verbose(LogCategory.USER32,
            `GetClassNameA(0x${hWnd.toString(16)}, nMax=${nMaxCount}) -> ${writeLen} "${className}"`);
        return writeLen;
    };

    exports['GetClassNameW'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const lpClassName = args[1] >>> 0;
        const nMaxCount = args[2] | 0;
        if (!lpClassName || nMaxCount <= 0) return 0;

        const className = resolveWindowClassName(hWnd);
        if (className === null) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }

        const writeLen = Math.min(className.length, nMaxCount - 1);
        Marshaler.writeWideString(mem, lpClassName, className, nMaxCount);

        Logger.verbose(LogCategory.USER32,
            `GetClassNameW(0x${hWnd.toString(16)}, nMax=${nMaxCount}) -> ${writeLen} "${className}"`);
        return writeLen;
    };

    // GetClassLongA/W and SetClassLongA/W (legacy 32-bit APIs)
    const GCL_WNDPROC = -24;
    const GCL_CBCLSEXTRA = -20;
    const GCL_CBWNDEXTRA = -18;
    const GCL_HICON = -14;
    const GCL_HCURSOR = -12;
    const GCL_HBRBACKGROUND = -10;
    const GCL_STYLE = -26;

    function getClassInfoByHandle(hWnd: number): any | null {
        if (!hWnd) return null;
        const win = getWindowByHandle(hWnd);
        if (!win) return null;
        if (win.classId !== undefined) {
            return getWindowClass(win.classId) ?? null;
        }
        return getWindowClassByName(win.title) ?? null;
    }

    exports['GetClassLongA'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const nIndex = args[1] | 0;
        const classInfo = getClassInfoByHandle(hWnd);
        if (!classInfo) return 0;

        switch (nIndex) {
            case GCL_WNDPROC: return classInfo.lpfnWndProc ?? 0;
            case GCL_CBCLSEXTRA: return classInfo.cbClsExtra ?? 0;
            case GCL_CBWNDEXTRA: return classInfo.cbWndExtra ?? 0;
            case GCL_HICON: return classInfo.hIcon ?? 0;
            case GCL_HCURSOR: return classInfo.hCursor ?? 0;
            case GCL_HBRBACKGROUND: return classInfo.hbrBackground ?? 0;
            case GCL_STYLE: return classInfo.style ?? 0;
            default: return 0;
        }
    };

    exports['GetClassLongW'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const nIndex = args[1] | 0;
        const classInfo = getClassInfoByHandle(hWnd);
        if (!classInfo) return 0;

        switch (nIndex) {
            case GCL_WNDPROC: return classInfo.lpfnWndProc ?? 0;
            case GCL_CBCLSEXTRA: return classInfo.cbClsExtra ?? 0;
            case GCL_CBWNDEXTRA: return classInfo.cbWndExtra ?? 0;
            case GCL_HICON: return classInfo.hIcon ?? 0;
            case GCL_HCURSOR: return classInfo.hCursor ?? 0;
            case GCL_HBRBACKGROUND: return classInfo.hbrBackground ?? 0;
            case GCL_STYLE: return classInfo.style ?? 0;
            default: return 0;
        }
    };

    exports['SetClassLongA'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const nIndex = args[1] | 0;
        const dwNewLong = args[2] >>> 0;
        const classInfo = getClassInfoByHandle(hWnd);
        if (!classInfo) return 0;

        let prev = 0;
        switch (nIndex) {
            case GCL_WNDPROC:
                prev = classInfo.lpfnWndProc ?? 0;
                classInfo.lpfnWndProc = dwNewLong;
                break;
            case GCL_CBCLSEXTRA:
                prev = classInfo.cbClsExtra ?? 0;
                classInfo.cbClsExtra = dwNewLong;
                break;
            case GCL_CBWNDEXTRA:
                prev = classInfo.cbWndExtra ?? 0;
                classInfo.cbWndExtra = dwNewLong;
                break;
            case GCL_HICON:
                prev = classInfo.hIcon ?? 0;
                classInfo.hIcon = dwNewLong;
                break;
            case GCL_HCURSOR:
                prev = classInfo.hCursor ?? 0;
                classInfo.hCursor = dwNewLong;
                break;
            case GCL_HBRBACKGROUND:
                prev = classInfo.hbrBackground ?? 0;
                classInfo.hbrBackground = dwNewLong;
                break;
            case GCL_STYLE:
                prev = classInfo.style ?? 0;
                classInfo.style = dwNewLong;
                break;
            default:
                prev = 0;
                break;
        }

        Logger.log(LogCategory.USER32,
            `SetClassLongA(hWnd=0x${hWnd.toString(16)}, idx=${nIndex}) -> prev=0x${prev.toString(16)} new=0x${dwNewLong.toString(16)}`);
        return prev >>> 0;
    };

    exports['SetClassLongW'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const nIndex = args[1] | 0;
        const dwNewLong = args[2] >>> 0;
        const classInfo = getClassInfoByHandle(hWnd);
        if (!classInfo) return 0;

        let prev = 0;
        switch (nIndex) {
            case GCL_WNDPROC:
                prev = classInfo.lpfnWndProc ?? 0;
                classInfo.lpfnWndProc = dwNewLong;
                break;
            case GCL_CBCLSEXTRA:
                prev = classInfo.cbClsExtra ?? 0;
                classInfo.cbClsExtra = dwNewLong;
                break;
            case GCL_CBWNDEXTRA:
                prev = classInfo.cbWndExtra ?? 0;
                classInfo.cbWndExtra = dwNewLong;
                break;
            case GCL_HICON:
                prev = classInfo.hIcon ?? 0;
                classInfo.hIcon = dwNewLong;
                break;
            case GCL_HCURSOR:
                prev = classInfo.hCursor ?? 0;
                classInfo.hCursor = dwNewLong;
                break;
            case GCL_HBRBACKGROUND:
                prev = classInfo.hbrBackground ?? 0;
                classInfo.hbrBackground = dwNewLong;
                break;
            case GCL_STYLE:
                prev = classInfo.style ?? 0;
                classInfo.style = dwNewLong;
                break;
            default:
                prev = 0;
                break;
        }

        Logger.log(LogCategory.USER32,
            `SetClassLongW(hWnd=0x${hWnd.toString(16)}, idx=${nIndex}) -> prev=0x${prev.toString(16)} new=0x${dwNewLong.toString(16)}`);
        return prev >>> 0;
    };

    return exports;
}

// Export helper functions for use by other modules
export function getWindowClass(classId: number) {
    return windowClasses.get(classId);
}

const SYSTEM_CLASS_STUB = Object.freeze({
    style: 0,
    lpfnWndProc: 0,
    cbClsExtra: 0,
    cbWndExtra: 0,
    hInstance: 0,
    hIcon: 0,
    hCursor: 0,
    hbrBackground: 0,
    lpszMenuName: 0,
    className: '',
});

// Materialized descriptors for built-in user32 classes (Button/Static/Edit/...).
// Cached so SetClassLong mutations stick, like the real per-process global class.
const builtinClassInfoCache = new Map<string, any>();

function getBuiltinClassInfo(nameLower: string): any | undefined {
    const cached = builtinClassInfoCache.get(nameLower);
    if (cached) return cached;
    const descr = getBuiltinSystemClass(nameLower);
    if (!descr) return undefined;
    const info = {
        className: descr.name,
        style: descr.style,
        lpfnWndProc: getDefWindowProcAddress(),
        cbClsExtra: 0,
        cbWndExtra: descr.cbWndExtra,
        hInstance: 0,
        hIcon: 0,
        hCursor: getSystemCursorHandle(descr.idcCursor),
        hbrBackground: 0,
        lpszMenuName: 0,
        isBuiltinSystemClass: true,
    };
    builtinClassInfoCache.set(nameLower, info);
    // Mirror it into the WindowManager as well. Materializing it only here left
    // createWindow to fall back on its "unknown class" stub, which registers style 0 —
    // so every class-style behaviour of a system control (CS_DBLCLKS, CS_VREDRAW,
    // CS_PARENTDC, CS_SAVEBITS) silently evaporated, and a listbox never produced a
    // double-click.
    System.getInstance().windowManager.registerClass({
        name: descr.name,
        wndProc: info.lpfnWndProc,
        hInstance: 0,
        style: descr.style,
        hbrBackground: 0,
    });
    return info;
}

export function getWindowClassByName(name: string) {
    const nameLower = name.toLowerCase();
    const classId = windowClassesByName.get(nameLower);
    if (classId) return windowClasses.get(classId);
    // Built-in user32 control classes — pre-registered by the real OS, an
    // app-registered class of the same name shadows them (checked above).
    const builtin = getBuiltinClassInfo(nameLower);
    if (builtin) return builtin;
    // Built-in common controls (registered lazily by comctl32 / CreateWindowEx)
    if (nameLower === 'sysanimate32' || nameLower === 'sysanimate32_class') {
        return SYSTEM_CLASS_STUB;
    }
    return undefined;
}
