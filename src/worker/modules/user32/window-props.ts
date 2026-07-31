/**
 * User32 per-window property handlers: GWL_* window longs / DWL extra bytes,
 * window text and the enable flag — plain reads/writes of WindowInfo fields on
 * the shared window map. Z-order / focus / capture core stays in window.ts.
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Marshaler } from '../../core/memory/marshaler';
import { Mem } from '../../core/memory/mem-accessor';
import { windows } from './shared-state';
import { eraseControlOverlayRect, repaintDialogAfterContentChange } from './dialog-paint';
import { applyControlSetText } from './dialog-control-messages';
import { encodeAnsi } from '../codepage-utils';

export function registerWindowPropExports(exports: Record<string, ThunkImplementation>): void {
    exports['SetWindowLongA'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const nIndex = args[1];
        const dwNewLong = args[2];
        Logger.verbose(LogCategory.USER32, `SetWindowLongA(0x${hWnd.toString(16)}, ${nIndex}, 0x${dwNewLong.toString(16)})`);
        const window = windows.get(hWnd);
        if (!window) return 0;

        const GWL_WNDPROC = -4;
        const GWL_STYLE = -16;
        const GWL_EXSTYLE = -20;
        const GWL_USERDATA = -21;

        let prev = 0;
        const idx = nIndex | 0;
        if (idx >= 0) {
            const bytes = window.extraBytes;
            if (!bytes) return 0;
            const wordIndex = (idx >>> 2);
            if (wordIndex < 0 || wordIndex >= bytes.length) return 0;
            prev = bytes[wordIndex] >>> 0;
            bytes[wordIndex] = dwNewLong >>> 0;
            // DWLP_DLGPROC (offset 4) on a #32770 dialog re-installs the dialog
            // procedure — ATL CDialogImpl::StartDialogProc builds a per-window thunk
            // (`mov [esp+4], this; jmp RealProc`) and installs it here on the first
            // message; MFC and manual subclassers do the same. Our message dispatch
            // reads window.wndProc, so mirror the new proc into it — otherwise every
            // subsequent message re-enters the one-shot StartDialogProc, which has
            // already consumed its thread-local `this` and wild-calls through NULL.
            const DWLP_DLGPROC = 4;
            if (idx === DWLP_DLGPROC && window.nativeClassName === '#32770') {
                window.wndProc = dwNewLong >>> 0;
            }
            Logger.log(LogCategory.USER32,
                `SetWindowLongA extraBytes: hwnd=0x${hWnd.toString(16)} idx=${idx} ` +
                `prev=0x${prev.toString(16)} new=0x${(dwNewLong >>> 0).toString(16)}`);
            return prev >>> 0;
        }

        switch (idx) {
            case GWL_WNDPROC:
                prev = window.wndProc >>> 0;
                window.wndProc = dwNewLong >>> 0;
                // A system control given a guest wndProc is subclassed (e.g. MFC custom
                // CStatic/CButton that paints itself). It now owns its own painting —
                // we deliver WM_PAINT to it rather than drawing default chrome.
                if (window.isSystemControl && (dwNewLong >>> 0) !== 0) {
                    window.wndProcSubclassed = true;
                }
                break;
            case GWL_STYLE:
                prev = window.style >>> 0;
                window.style = dwNewLong >>> 0;
                break;
            case GWL_EXSTYLE:
                prev = window.exStyle ?? 0;
                window.exStyle = dwNewLong >>> 0;
                break;
            case GWL_USERDATA:
                prev = window.userData ?? 0;
                window.userData = dwNewLong >>> 0;
                break;
            default:
                // Unhandled index - return 0
                prev = 0;
                break;
        }

        return prev >>> 0;
    };

    exports['SetWindowLongW'] = exports['SetWindowLongA'];
    // 32-bit: SetWindowLongPtr is the SetWindowLong macro. ATL CDialogImpl uses it.
    exports['SetWindowLongPtrA'] = exports['SetWindowLongA'];
    exports['SetWindowLongPtrW'] = exports['SetWindowLongA'];

    exports['GetWindowLongA'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const nIndex = args[1];
        const window = windows.get(hWnd);
        if (!window) return 0;

        const GWL_WNDPROC = -4;
        const GWL_STYLE = -16;
        const GWL_EXSTYLE = -20;
        const GWL_USERDATA = -21;

        const idx = nIndex | 0;
        if (idx >= 0) {
            const bytes = window.extraBytes;
            if (!bytes) return 0;
            const wordIndex = (idx >>> 2);
            if (wordIndex < 0 || wordIndex >= bytes.length) return 0;
            return bytes[wordIndex] >>> 0;
        }

        switch (idx) {
            case GWL_WNDPROC:
                return window.wndProc >>> 0;
            case GWL_STYLE:
                return window.style >>> 0;
            case GWL_EXSTYLE:
                return (window.exStyle ?? 0) >>> 0;
            case GWL_USERDATA:
                return (window.userData ?? 0) >>> 0;
            default:
                return 0;
        }
    };

    exports['GetWindowLongW'] = exports['GetWindowLongA'];
    exports['GetWindowLongPtrA'] = exports['GetWindowLongA'];
    exports['GetWindowLongPtrW'] = exports['GetWindowLongA'];

    // DWORD GetWindowContextHelpId(HWND hwnd)
    exports['GetWindowContextHelpId'] = (ctx, mem, args) => {
        // Context help IDs are not used in our emulator — return 0
        return 0;
    };

    exports['GetWindowTextLengthA'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const window = windows.get(hWnd);
        const length = window ? window.title.length : 0;
        Logger.verbose(LogCategory.USER32, `GetWindowTextLengthA(0x${hWnd.toString(16)}) -> ${length}`);
        return length;
    };

    exports['GetWindowTextLengthW'] = exports['GetWindowTextLengthA'];

    exports['GetWindowTextA'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const lpString = args[1] >>> 0;
        const nMaxCount = args[2] | 0;
        if (!lpString || nMaxCount <= 0) return 0;

        const window = windows.get(hWnd);
        if (!window) return 0;

        const encoded = encodeAnsi(window.title);
        const writeLen = Math.min(encoded.length, nMaxCount - 1);
        if (writeLen > 0) {
            Mem.writeBytes(lpString, encoded.subarray(0, writeLen));
        }
        Mem.writeBytes(lpString + writeLen, new Uint8Array([0]));

        Logger.verbose(LogCategory.USER32,
            `GetWindowTextA(0x${hWnd.toString(16)}, nMax=${nMaxCount}) -> ${writeLen} "${window.title}"`);
        return writeLen;
    };

    exports['GetWindowTextW'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const lpString = args[1] >>> 0;
        const nMaxCount = args[2] | 0;
        if (!lpString || nMaxCount <= 0) return 0;

        const window = windows.get(hWnd);
        if (!window) return 0;

        const writeLen = Marshaler.writeWideString(mem, lpString, window.title, nMaxCount);
        const charCount = writeLen > 0 ? Math.min(window.title.length, nMaxCount - 1) : 0;

        Logger.verbose(LogCategory.USER32,
            `GetWindowTextW(0x${hWnd.toString(16)}, nMax=${nMaxCount}) -> ${charCount} "${window.title}"`);
        return charCount;
    };

    exports['SetWindowTextA'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpString = args[1];
        const text = lpString ? Marshaler.readString(mem, lpString) : '';
        const window = windows.get(hWnd);
        if (window) {
            // Win32 invalidates the window on a caption change and it repaints. Without
            // that the control keeps its OLD pixels until something else happens to stamp
            // it, and on a guest-painted parent the new caption then lands ON TOP of the
            // old one (both strings readable). Erase first so the repair restores the
            // background, then let the parent re-stamp its controls.
            const changed = window.title !== text;
            if (changed) eraseControlOverlayRect(window);
            applyControlSetText(window, text);
            if (!window.parent) System.getInstance().notifyWindowTitle(text, 'SetWindowText');
            else if (changed) repaintDialogAfterContentChange(window.parent);
        }
        Logger.log(LogCategory.USER32, `SetWindowTextA(0x${hWnd.toString(16)}, "${text}")`);
        return 1; // TRUE
    };

    exports['SetWindowTextW'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpString = args[1];
        const text = lpString ? Marshaler.readWideString(mem, lpString) : '';
        const window = windows.get(hWnd);
        if (window) {
            // Win32 invalidates the window on a caption change and it repaints. Without
            // that the control keeps its OLD pixels until something else happens to stamp
            // it, and on a guest-painted parent the new caption then lands ON TOP of the
            // old one (both strings readable). Erase first so the repair restores the
            // background, then let the parent re-stamp its controls.
            const changed = window.title !== text;
            if (changed) eraseControlOverlayRect(window);
            applyControlSetText(window, text);
            if (!window.parent) System.getInstance().notifyWindowTitle(text, 'SetWindowText');
            else if (changed) repaintDialogAfterContentChange(window.parent);
        }
        Logger.log(LogCategory.USER32, `SetWindowTextW(0x${hWnd.toString(16)}, "${text}")`);
        return 1; // TRUE
    };

    exports['EnableWindow'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const bEnable = args[1] !== 0;
        Logger.verbose(LogCategory.USER32, `EnableWindow(0x${hWnd.toString(16)}, ${bEnable})`);
        const window = windows.get(hWnd);
        if (!window) return 0;
        const WS_DISABLED_FLAG = 0x08000000;
        const wasDisabled = (window.style & WS_DISABLED_FLAG) !== 0;
        if (bEnable) window.style &= ~WS_DISABLED_FLAG;
        else window.style |= WS_DISABLED_FLAG;
        // Real EnableWindow: returns TRUE if the window was PREVIOUSLY disabled.
        return wasDisabled ? 1 : 0;
    };
}
