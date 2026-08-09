/**
 * User32 dialog-item accessors (Get/SetDlgItemText, CheckDlgButton, GetDlgItemInt,
 * SendDlgItemMessage, …). Find a dialog's child control by id and read/write its
 * state.
 */
import { ThunkImplementation, ThunkResult } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { Mem } from '../../core/memory/mem-accessor';
import { System } from '../../core/system';
import { encodeAnsi } from '../codepage-utils';
import { windows, buttonCheckStates, findChildByControlId } from './shared-state';
import { applyControlSetText, handleSystemControlMessage, isContentChangingMessage } from './dialog-control-messages';
import { eraseControlOverlayRect, repaintDialogAfterContentChange } from './dialog-paint';
import { tryRichEditStreamMessage } from './rich-edit-stream';

export function registerDialogItemExports(exports: Record<string, ThunkImplementation>): void {
    exports['GetDlgItem'] = (ctx, mem, args) => {
        const hDlg = args[0];
        const nIDDlgItem = args[1];

        Logger.verbose(LogCategory.USER32, `GetDlgItem(0x${hDlg.toString(16)}, ${nIDDlgItem})`);

        // Search children for matching controlId
        const child = findChildByControlId(hDlg, nIDDlgItem);
        if (child) {
            Logger.verbose(LogCategory.USER32,
                `GetDlgItem: found child hwnd=0x${child.handle.toString(16)} for id=${nIDDlgItem}`);
            return child.handle;
        }

        // Win32/Wine: missing control → NULL (never a synthetic HWND).
        return 0;
    };

    /**
     * SetDlgItemTextA - Sets the title or text of a control in a dialog box
     */
    exports['SetDlgItemTextA'] = (ctx, mem, args) => {
        const hDlg = args[0];
        const nIDDlgItem = args[1];
        const lpString = args[2];

        const text = lpString ? Marshaler.readString(mem, lpString) : '';
        Logger.log(LogCategory.USER32, `SetDlgItemTextA(0x${hDlg.toString(16)}, id=${nIDDlgItem}, "${text}")`);

        const child = findChildByControlId(hDlg, nIDDlgItem);
        if (child) {
            eraseControlOverlayRect(child);
            applyControlSetText(child, text);
            repaintDialogAfterContentChange(hDlg);
        } else {
            Logger.warn(LogCategory.USER32, `SetDlgItemTextA: control id=${nIDDlgItem} not found in dialog 0x${hDlg.toString(16)}`);
        }

        return 1; // TRUE
    };

    exports['SetDlgItemTextW'] = (ctx, mem, args) => {
        const hDlg = args[0];
        const nIDDlgItem = args[1];
        const lpString = args[2];

        const text = lpString ? Marshaler.readWideString(mem, lpString) : '';
        Logger.log(LogCategory.USER32, `SetDlgItemTextW(0x${hDlg.toString(16)}, id=${nIDDlgItem}, "${text}")`);

        const child = findChildByControlId(hDlg, nIDDlgItem);
        if (child) {
            eraseControlOverlayRect(child);
            applyControlSetText(child, text);
            repaintDialogAfterContentChange(hDlg);
        }

        return 1; // TRUE
    };

    /**
     * GetDlgItemTextA - Retrieves the title or text of a control
     */
    exports['GetDlgItemTextA'] = (ctx, mem, args) => {
        const hDlg = args[0];
        const nIDDlgItem = args[1];
        const lpString = args[2];
        const cchMax = args[3];

        Logger.verbose(LogCategory.USER32, `GetDlgItemTextA(0x${hDlg.toString(16)}, ${nIDDlgItem}, buf, ${cchMax})`);

        const child = findChildByControlId(hDlg, nIDDlgItem);
        const text = child?.title ?? '';

        if (lpString && cchMax > 0) {
            const encoded = encodeAnsi(text);
            const writeLen = Math.min(encoded.length, cchMax - 1);
            mem.set(encoded.subarray(0, writeLen), lpString);
            mem[lpString + writeLen] = 0;
            return writeLen;
        }
        return 0;
    };

    exports['GetDlgItemTextW'] = (ctx, mem, args) => {
        const hDlg = args[0];
        const nIDDlgItem = args[1];
        const lpString = args[2];
        const cchMax = args[3];

        Logger.verbose(LogCategory.USER32, `GetDlgItemTextW(0x${hDlg.toString(16)}, ${nIDDlgItem}, buf, ${cchMax})`);

        const child = findChildByControlId(hDlg, nIDDlgItem);
        const text = child?.title ?? '';

        if (lpString && cchMax > 0) {
            const toWrite = text.substring(0, cchMax - 1);
            for (let i = 0; i < toWrite.length; i++) {
                const charCode = toWrite.charCodeAt(i);
                Mem.writeUint16(lpString + i * 2, charCode);
            }
            Mem.writeUint16(lpString + toWrite.length * 2, 0);
            return toWrite.length;
        }
        return 0;
    };

    /**
     * CheckDlgButton - Changes the check state of a button control
     */
    exports['CheckDlgButton'] = (ctx, mem, args) => {
        const hDlg = args[0];
        const nIDButton = args[1];
        const uCheck = args[2];

        Logger.verbose(LogCategory.USER32, `CheckDlgButton(0x${hDlg.toString(16)}, ${nIDButton}, ${uCheck})`);

        const child = findChildByControlId(hDlg, nIDButton);
        if (child) {
            buttonCheckStates.set(child.handle, uCheck);
            repaintDialogAfterContentChange(hDlg);
        }

        return 1; // TRUE
    };

    /**
     * CheckRadioButton - Checks a radio button and unchecks all others in range
     */
    exports['CheckRadioButton'] = (ctx, mem, args) => {
        const hDlg = args[0];
        const nIDFirstButton = args[1];
        const nIDLastButton  = args[2];
        const nIDCheckButton = args[3];

        Logger.verbose(LogCategory.USER32,
            `CheckRadioButton(0x${hDlg.toString(16)}, ${nIDFirstButton}, ${nIDLastButton}, ${nIDCheckButton})`);

        const dlgInfo = windows.get(hDlg);
        if (!dlgInfo) return 0;

        const BS_TYPEMASK = 0x000F;
        const BS_RADIOBUTTON = 0x0004;
        const BS_AUTORADIOBUTTON = 0x0009;
        const isRadio = (child: { style: number; systemControlClass?: string; isSystemControl?: boolean }) => {
            const cls = (child.systemControlClass ?? '').toLowerCase();
            if (cls && cls !== 'button') return false;
            const t = child.style & BS_TYPEMASK;
            return t === BS_RADIOBUTTON || t === BS_AUTORADIOBUTTON;
        };

        // Wine EnumChildWindows: walk the whole subtree, not just direct children.
        const stack = [...(dlgInfo.children ?? [])];
        const visited = new Set<number>();
        while (stack.length > 0) {
            const childHwnd = stack.pop()!;
            if (visited.has(childHwnd)) continue;
            visited.add(childHwnd);
            const child = windows.get(childHwnd);
            if (!child) continue;
            for (const nested of child.children) stack.push(nested);
            if (child.controlId === undefined) continue;
            const id = child.controlId;
            if (id < nIDFirstButton || id > nIDLastButton) continue;
            if (!isRadio(child) && !child.isSystemControl) {
                // Non-button with overlapping id — skip (Wine still BM_SETCHECKs any
                // window in range, but our check-state map is button-oriented).
                continue;
            }
            if (child.isSystemControl && (child.systemControlClass ?? '').toLowerCase() === 'button' && !isRadio(child)) {
                continue;
            }
            buttonCheckStates.set(childHwnd, id === nIDCheckButton ? 1 : 0);
        }

        repaintDialogAfterContentChange(hDlg);
        return 1; // TRUE
    };

    /**
     * IsDlgButtonChecked - Determines whether a button control is checked
     */
    exports['IsDlgButtonChecked'] = (ctx, mem, args) => {
        const hDlg = args[0];
        const nIDButton = args[1];

        Logger.verbose(LogCategory.USER32, `IsDlgButtonChecked(0x${hDlg.toString(16)}, ${nIDButton})`);

        const child = findChildByControlId(hDlg, nIDButton);
        if (child) return buttonCheckStates.get(child.handle) ?? 0;

        return 0; // BST_UNCHECKED
    };

    exports['GetDlgItemInt'] = (ctx, mem, args) => {
        const hDlg         = args[0];
        const nIDDlgItem   = args[1];
        const lpTranslated = args[2] >>> 0;
        const bSigned      = args[3] !== 0;

        Logger.verbose(LogCategory.USER32,
            `GetDlgItemInt(0x${hDlg.toString(16)}, ${nIDDlgItem}, translated=${lpTranslated}, signed=${bSigned})`);

        if (lpTranslated && lpTranslated + 4 <= mem.length) {
            Mem.writeUint32(lpTranslated, 0);
        }

        const child = findChildByControlId(hDlg, nIDDlgItem);
        const text = (child?.title ?? '').trim();
        if (!text) return 0;

        // Wine/NT: strtol/strtoul of the control text; translated only on full success.
        const match = bSigned
            ? /^[+-]?\d+/.exec(text)
            : /^\+?\d+/.exec(text);
        if (!match) return 0;

        const parsed = bSigned ? Number.parseInt(match[0], 10) : Number.parseInt(match[0], 10);
        if (!Number.isFinite(parsed)) return 0;

        if (lpTranslated && lpTranslated + 4 <= mem.length) {
            Mem.writeUint32(lpTranslated, 1);
        }
        return parsed >>> 0;
    };

    exports['SetDlgItemInt'] = (ctx, mem, args) => {
        const hDlg       = args[0];
        const nIDDlgItem = args[1];
        const uValue     = args[2] >>> 0;
        const bSigned    = args[3] !== 0;

        // Wine: sprintf("%d"/"%u") then WM_SETTEXT via SendDlgItemMessage.
        const text = bSigned ? String(uValue | 0) : String(uValue >>> 0);
        Logger.verbose(LogCategory.USER32,
            `SetDlgItemInt(0x${hDlg.toString(16)}, ${nIDDlgItem}, ${text}, signed=${bSigned})`);

        const child = findChildByControlId(hDlg, nIDDlgItem);
        if (child) {
            eraseControlOverlayRect(child);
            applyControlSetText(child, text);
            repaintDialogAfterContentChange(hDlg);
        }
        return 1; // TRUE
    };

    const sendDlgItemMessage = (ctx: any, mem: Uint8Array, args: number[]): number | ThunkResult => {
        const hDlg = args[0];
        const nIDDlgItem = args[1];
        const Msg = args[2];
        const wParam = args[3];
        const lParam = args[4];
        Logger.verbose(LogCategory.USER32, `SendDlgItemMessage(0x${hDlg.toString(16)}, ${nIDDlgItem}, 0x${Msg.toString(16)}, 0x${wParam.toString(16)}, 0x${lParam.toString(16)})`);

        const child = findChildByControlId(hDlg, nIDDlgItem);
        if (!child) return 0;

        // JS-managed system controls: handle in-process (Wine routes via SendMessage → control WndProc).
        if (child.isSystemControl) {
            const stream = tryRichEditStreamMessage(
                ctx, mem, child, Msg, wParam, lParam, 20, 'SendDlgItemMessageA');
            if (stream) return stream;
            const result = handleSystemControlMessage(child, Msg, wParam, lParam, mem, 'ansi');
            if (isContentChangingMessage(child, Msg)) {
                repaintDialogAfterContentChange(hDlg);
            }
            return result;
        }

        // Guest-owned child: post for async delivery (sync re-enter would need a suspended thunk).
        // Wine SendDlgItemMessage is synchronous; posting covers the common fire-and-forget path.
        const WM_SETTEXT = 0x000C;
        const WM_GETTEXT = 0x000D;
        if (Msg === WM_SETTEXT && lParam) {
            // Prefer updating title immediately so subsequent GetDlgItemText sees it.
            child.title = Marshaler.readString(mem, lParam);
            repaintDialogAfterContentChange(hDlg);
            return 1;
        }
        if (Msg === WM_GETTEXT) {
            return exports['GetDlgItemTextA'](ctx, mem, [hDlg, nIDDlgItem, lParam, wParam]) as number;
        }

        System.getInstance().windowManager.postMessage(child.handle, Msg, wParam, lParam);
        return 0;
    };

    exports['SendDlgItemMessageA'] = sendDlgItemMessage;
    exports['SendDlgItemMessageW'] = (ctx, mem, args) => {
        const hDlg = args[0];
        const nIDDlgItem = args[1];
        const Msg = args[2];
        const wParam = args[3];
        const lParam = args[4];
        const child = findChildByControlId(hDlg, nIDDlgItem);
        if (!child) return 0;

        const WM_SETTEXT = 0x000C;
        const WM_GETTEXT = 0x000D;
        if (child.isSystemControl) {
            const stream = tryRichEditStreamMessage(
                ctx, mem, child, Msg, wParam, lParam, 20, 'SendDlgItemMessageW');
            if (stream) return stream;
            // The W entry KNOWS its strings are wide — pass that rather than re-probing bytes
            // that a 1-char ANSI string is indistinguishable from.
            const result = handleSystemControlMessage(child, Msg, wParam, lParam, mem, 'wide');
            if (isContentChangingMessage(child, Msg)) {
                repaintDialogAfterContentChange(hDlg);
            }
            return result;
        }
        if (Msg === WM_SETTEXT && lParam) {
            child.title = Marshaler.readWideString(mem, lParam);
            repaintDialogAfterContentChange(hDlg);
            return 1;
        }
        if (Msg === WM_GETTEXT) {
            return exports['GetDlgItemTextW'](ctx, mem, [hDlg, nIDDlgItem, lParam, wParam]) as number;
        }
        System.getInstance().windowManager.postMessage(child.handle, Msg, wParam, lParam);
        return 0;
    };
}
