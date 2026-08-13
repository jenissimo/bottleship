/**
 * User32 system-control message handlers. handleSystemControlMessage is the
 * SendMessage/SendDlgItemMessage sink for JS-managed controls
 * (Button/Static/Edit/ListBox/ComboBox/Trackbar/Progress): it implements the
 * WM_, BM_, STM_, CB_, LB_, TBM_ and PBM_ protocols over the shared-state
 * control stores instead of a real control window-proc.
 */
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { System } from '../../core/system';
import { WindowInfo, windows, buttonCheckStates, getOrCreateListState, getOrCreateTrackbarState, controlImageHandles } from './shared-state';
import { handleAnimateMessage } from './animate-control';
import { handleEditMessage, isEditContentMessage, isEditControl, setEditControlText } from './edit-control';
import {
    handleRichEditMessage,
    isRichEditContentMessage,
    isRichEditControl,
    setRichEditContent,
} from './rich-edit-control';
import {
    handleListViewMessage,
    isListViewContentMessage,
    isListViewControl,
} from './list-view-control';
import {
    handleTabMessage,
    isTabContentMessage,
    isTabControl,
} from './tab-control';
import { setScrollPos, getScrollPos, setScrollRange, getScrollRange, applyScrollInfo, readScrollInfo } from './scroll-state';
import {
    paintSystemControl,
    clampListTopIndexOf,
    listVisibleCountOf,
    applyComboBoxClosedHeight,
    comboDropTopIndex,
    comboBoxItemHeight,
} from './controls';
import { repaintDialogAfterContentChange, restampOwnedPopupsAbove } from './dialog-paint';
import { closeOpenComboboxes } from './control-interaction';
import { getBitmapObjectDimensions, getIconObjectDimensions } from '../gdi32/bitmap-resolve';
import { encodeAnsi, readAnsiOrWideFromGuest } from '../codepage-utils';

const SS_TYPEMASK = 0x001F;
const SS_BITMAP = 0x000E;
const SS_ICON = 0x0003;
const SS_CENTERIMAGE = 0x0200;
const IMAGE_BITMAP = 0;
const IMAGE_ICON = 1;

// BS_* button styles (low nibble)
const BS_TYPEMASK = 0x000F;
const BS_PUSHBUTTON = 0x0000;
const BS_DEFPUSHBUTTON = 0x0001;
const BS_RADIOBUTTON = 0x0004;
const BS_AUTORADIOBUTTON = 0x0009;

const WS_DISABLED = 0x08000000;

const WM_PAINT = 0x000F;

/** Return whether a control message changes what `child` shows (the caller then
 *  erases and restamps the control set, so a false positive costs a full repaint of
 *  the dialog on the message-pump hot path). */
export function isContentChangingMessage(child: WindowInfo, msg: number): boolean {
    const WM_SETTEXT = 0x000C;
    const CB_ADDSTRING = 0x0143;
    const CB_DELETESTRING = 0x0144;
    const CB_INSERTSTRING = 0x014A;
    const CB_RESETCONTENT = 0x014B;
    const CB_SETCURSEL = 0x014E;
    const CB_SHOWDROPDOWN = 0x014F;
    const LB_ADDSTRING = 0x0180;
    const LB_INSERTSTRING = 0x0181;
    const LB_DELETESTRING = 0x0182;
    const LB_RESETCONTENT = 0x0184;
    const LB_SETCURSEL = 0x0186;
    const LB_SELECTSTRING = 0x018C;
    const LB_SETTOPINDEX = 0x0197;
    const BM_SETCHECK = 0x00F1;
    const BM_SETIMAGE = 0x00F7;
    const STM_SETIMAGE = 0x0172;
    const TBM_SETPOS = 0x0405;
    const TBM_SETRANGE = 0x0406;
    const TBM_SETRANGEMAX = 0x0408;

    const TBM_SETTICFREQ = 0x0414;

    return msg === WM_SETTEXT || msg === BM_SETCHECK || msg === STM_SETIMAGE || msg === BM_SETIMAGE
        || msg === TBM_SETTICFREQ
        || msg === LB_SELECTSTRING
        || msg === LB_SETTOPINDEX
        || msg === CB_SHOWDROPDOWN
        || (msg >= CB_ADDSTRING && msg <= CB_SETCURSEL)
        || (msg >= LB_ADDSTRING && msg <= LB_SETCURSEL)
        || (msg >= TBM_SETPOS && msg <= TBM_SETRANGEMAX)
        || (msg >= 0x0401 && msg <= 0x0406)
        || (isEditControl(child) && isEditContentMessage(msg))
        || (isRichEditControl(child) && (isEditContentMessage(msg) || isRichEditContentMessage(msg)))
        || (isListViewControl(child) && isListViewContentMessage(msg))
        || (isTabControl(child) && isTabContentMessage(msg));
}

/**
 * Win32 SS_BITMAP / SS_ICON: a static with an image resizes itself to the image's
 * natural dimensions, keeping its TOP-LEFT corner fixed (this is what lets an RC
 * editor place a small placeholder slot and have it grow to the real artwork at
 * the slot's origin). Two styles opt out of the auto-size:
 *   - SS_CENTERIMAGE: keep the template rect; the image is drawn centered & clipped.
 *   - SS_REALSIZECONTROL: keep the template rect; the image is stretched to fill it.
 * Both are honored by the painter (layoutStaticControlImage); here we just skip the
 * resize so the control keeps its template size.
 */
export function applyStaticSetImageAutoSize(child: WindowInfo, imageType: number, hImage: number): void {
    const SS_REALSIZECONTROL = 0x0040;
    if (!hImage || (child.style & (SS_CENTERIMAGE | SS_REALSIZECONTROL)) !== 0) return;
    const styleType = child.style & SS_TYPEMASK;
    let dims: { width: number; height: number } | null = null;
    if (imageType === IMAGE_BITMAP && styleType === SS_BITMAP) {
        dims = getBitmapObjectDimensions(hImage);
    } else if (imageType === IMAGE_ICON && styleType === SS_ICON) {
        dims = getIconObjectDimensions(hImage);
    }
    if (!dims) return;
    if (child.width === dims.width && child.height === dims.height) return;

    // Resize to the image's natural size, anchored at the control's top-left.
    child.width = dims.width;
    child.height = dims.height;

    const wmWin = System.getInstance().windowManager.getWindow(child.handle);
    if (wmWin) {
        wmWin.rect.w = dims.width;
        wmWin.rect.h = dims.height;
    }
}

/**
 * WM_SETTEXT with the string already decoded by the caller. SetWindowText and
 * SetDlgItemText ARE SendMessage(WM_SETTEXT) on Win32, so they must land in the
 * control class's handler — on an EDIT, assigning the title instead silently drops
 * EN_UPDATE/EN_CHANGE, the case styles, the caret reset and the modify flag.
 */
export function applyControlSetText(win: WindowInfo, text: string): void {
    if (!win.isSystemControl) { win.title = text; return; }
    // Plain text replaces a Rich Edit's streamed runs — setRichEditContent drops them
    // and then goes through the same EDIT path.
    if (isRichEditControl(win)) setRichEditContent(win, text, []);
    else if (isEditControl(win)) setEditControlText(win, text);
    else win.title = text;
}

/**
 * Handle a message sent to a system control (Button, Static, Edit, etc.).
 * Returns the LRESULT.
 */
export function handleSystemControlMessage(
    child: WindowInfo, msg: number, wParam: number, lParam: number, mem: Uint8Array,
    /** Text width of the A/W entry the message came through, when known — see handleEditMessage. */
    textWidth?: 'ansi' | 'wide',
): number {
    const anim = handleAnimateMessage(child.handle, msg, wParam, lParam, mem);
    if (anim !== null) return anim;

    // Rich Edit is a superset of EDIT and falls through to it internally.
    if (isRichEditControl(child)) {
        const richResult = handleRichEditMessage(child, msg, wParam, lParam, mem, textWidth);
        if (richResult !== null) return richResult;
    }

    // EDIT owns EM_* plus text-editing WM_SETTEXT/WM_CHAR/WM_KEYDOWN semantics.
    if (isEditControl(child)) {
        const editResult = handleEditMessage(child, msg, wParam, lParam, mem, textWidth);
        if (editResult !== null) return editResult;
    }

    // SysListView32 owns LVM_* (0x1000+); must run before the WM_USER trackbar gate.
    if (isListViewControl(child)) {
        const lvResult = handleListViewMessage(child, msg, wParam, lParam, mem);
        if (lvResult !== null) return lvResult;
    }

    // SysTabControl32 owns TCM_* (0x1300+); same gate reasoning as the listview.
    if (isTabControl(child)) {
        const tabResult = handleTabMessage(child, msg, wParam, lParam, mem);
        if (tabResult !== null) return tabResult;
    }

    const readAnsiOrWideString = (ptr: number): string => readAnsiOrWideFromGuest(mem, ptr, textWidth);

    const WM_SETTEXT = 0x000C;
    const WM_GETTEXT = 0x000D;
    const WM_GETTEXTLENGTH = 0x000E;
    const WM_ENABLE = 0x000A;
    const WM_SIZE = 0x0005;
    const WM_SHOWWINDOW = 0x0018;
    const WM_SETFONT = 0x0030;
    const WM_GETFONT = 0x0031;
    const WM_GETDLGCODE = 0x0087;
    const WM_PRINTCLIENT = 0x0318;
    const BM_SETCHECK = 0x00F1;
    const BM_GETCHECK = 0x00F0;
    const BM_SETSTYLE = 0x00F4;
    const BM_SETIMAGE = 0x00F7;
    const BM_GETIMAGE = 0x00F6;
    const STM_SETIMAGE = 0x0172;
    const STM_GETIMAGE = 0x0173;
    const IMAGE_BITMAP = 0;
    const IMAGE_ICON = 1;
    const DLGC_WANTARROWS = 0x0001;
    const DLGC_HASSETSEL = 0x0008;
    const DLGC_DEFPUSHBUTTON = 0x0010;
    const DLGC_UNDEFPUSHBUTTON = 0x0020;
    const DLGC_RADIOBUTTON = 0x0040;
    const DLGC_WANTCHARS = 0x0080;
    const DLGC_STATIC = 0x0100;
    const DLGC_BUTTON = 0x2000;

    // Combobox messages
    const CB_ADDSTRING      = 0x0143;
    const CB_DELETESTRING   = 0x0144;
    const CB_GETCOUNT       = 0x0146;
    const CB_GETCURSEL      = 0x0147;
    const CB_GETLBTEXT      = 0x0148;
    const CB_GETLBTEXTLEN   = 0x0149;
    const CB_INSERTSTRING   = 0x014A;
    const CB_RESETCONTENT   = 0x014B;
    const CB_FINDSTRING     = 0x014C;
    const CB_SELECTSTRING   = 0x014D;
        const CB_SETCURSEL      = 0x014E;
        const CB_SHOWDROPDOWN   = 0x014F;
        const CB_GETITEMDATA    = 0x0150;
    const CB_SETITEMDATA    = 0x0151;
    const CB_SETITEMHEIGHT  = 0x0153;
    const CB_GETITEMHEIGHT  = 0x0154;
    const CB_FINDSTRINGEXACT = 0x0158;

    // Listbox messages
    const LB_ADDSTRING      = 0x0180;
    const LB_DELETESTRING   = 0x0182;
    const LB_GETCOUNT       = 0x018B;
    const LB_GETCURSEL      = 0x0188;
    const LB_GETTEXT        = 0x0189;
    const LB_GETTEXTLEN     = 0x018A;
    const LB_SELECTSTRING   = 0x018C;
    const LB_INSERTSTRING   = 0x0181;
    const LB_RESETCONTENT   = 0x0184;
    const LB_SETCURSEL      = 0x0186;
    const LB_GETITEMDATA    = 0x0199;
    const LB_SETITEMDATA    = 0x019A;
    const LB_SETCARETINDEX  = 0x019E;
    const LB_GETCARETINDEX  = 0x019F;

    const CB_ERR = -1 >>> 0; // 0xFFFFFFFF
    const LB_ERR = CB_ERR;

    const controlDlgCode = (): number => {
        const cls = (child.systemControlClass ?? '').toLowerCase();
        if (cls === 'button') {
            const buttonType = child.style & BS_TYPEMASK;
            switch (buttonType) {
                case BS_PUSHBUTTON:
                    return DLGC_BUTTON | DLGC_UNDEFPUSHBUTTON;
                case BS_DEFPUSHBUTTON:
                    return DLGC_BUTTON | DLGC_DEFPUSHBUTTON;
                case BS_RADIOBUTTON:
                case BS_AUTORADIOBUTTON:
                    return DLGC_BUTTON | DLGC_RADIOBUTTON;
                case 0x0007: // BS_GROUPBOX
                    return DLGC_STATIC;
                default:
                    return DLGC_BUTTON;
            }
        }
        if (cls === 'edit' || cls === 'richedit') return DLGC_WANTCHARS | DLGC_WANTARROWS | DLGC_HASSETSEL;
        if (cls === 'static') return DLGC_STATIC;
        return 0;
    };

    const findStringIndex = (
        state: ReturnType<typeof getOrCreateListState>,
        startAfter: number,
        search: string,
        exact: boolean,
    ): number => {
        if (state.items.length === 0) return -1;
        const normalized = search.toLowerCase();
        const start = startAfter < 0 ? -1 : Math.min(startAfter, state.items.length - 1);
        for (let i = 0; i < state.items.length; i++) {
            const idx = (start + 1 + i) % state.items.length;
            const itemText = state.items[idx].text.toLowerCase();
            if (exact ? itemText === normalized : itemText.startsWith(normalized)) return idx;
        }
        return -1;
    };

    // WM_USER-range common-control messages are class-specific — gate on the
    // control class so a game's custom WM_USER+n protocol on its own controls
    // is not misinterpreted as TBM_*/PBM_*.
    if (msg >= 0x0400 && msg <= 0x04FF) {
        const cls = (child.systemControlClass ?? '').trim().toLowerCase();
        if (cls === 'msctls_trackbar32') return handleTrackbarMessage(child, msg, wParam, lParam);
        if (cls === 'msctls_progress32') return handleProgressMessage(child, msg, wParam, lParam);
    }

    // SBM_* (0x00E0..0x00EA) on a ScrollBar-class control (SB_CTL protocol).
    if (msg >= 0x00E0 && msg <= 0x00EA
        && (child.systemControlClass ?? '').trim().toLowerCase() === 'scrollbar') {
        return handleScrollBarControlMessage(child, msg, wParam, lParam, mem);
    }

    const LB_GETTOPINDEX = 0x018E;
    const LB_SETTOPINDEX = 0x0197;

    switch (msg) {
        case WM_GETDLGCODE:
            return controlDlgCode();
        case WM_SETFONT: {
            child.fontHandle = wParam >>> 0;
            // The selection field is text-sized, so a font change re-sizes the window
            // (Wine combo.c COMBO_Font → CBCalcPlacement + SetWindowPos).
            const resized = applyComboBoxClosedHeight(child);
            if ((lParam || resized) && child.parent) repaintDialogAfterContentChange(child.parent);
            return 0;
        }
        case WM_SIZE:
            // A combobox answers every size change by shrinking itself back to the
            // closed height — that is where the app's "height includes the list"
            // argument is discarded (Wine combo.c COMBO_Size).
            if (applyComboBoxClosedHeight(child) && child.parent) {
                repaintDialogAfterContentChange(child.parent);
            }
            return 0;
        case WM_GETFONT: {
            const parent = child.parent !== undefined ? windows.get(child.parent) : undefined;
            return (child.fontHandle || parent?.fontHandle || 0) >>> 0;
        }
        case WM_SHOWWINDOW:
            child.visible = !!wParam;
            {
                const wmWin = System.getInstance().windowManager.getWindow(child.handle);
                if (wmWin) wmWin.visible = child.visible;
            }
            // The show is a SetWindowPos, so a combobox sizes itself here too — a control
            // created hidden gets no WM_SIZE until then.
            applyComboBoxClosedHeight(child);
            if (child.parent) repaintDialogAfterContentChange(child.parent);
            return 0;
        case WM_PRINTCLIENT:
            if (wParam) {
                paintSystemControl(child, wParam, System.getInstance().gdiContext);
            }
            return 0;
        case WM_PAINT: {
            const gdi = System.getInstance().gdiContext;
            const hdc = wParam || gdi.createOverlayDC();
            if (hdc) {
                paintSystemControl(child, hdc, gdi);
                if (!wParam) {
                    gdi.releaseDC(hdc);
                    // Painting a control straight to the flat overlay can bleed over a
                    // modal its owner sits under; keep the modal on top (no Z-clip).
                    if (child.parent) restampOwnedPopupsAbove(child.parent);
                }
            }
            return 0;
        }
        case BM_SETSTYLE: {
            if ((child.systemControlClass ?? '').toLowerCase() === 'button') {
                const oldType = child.style & BS_TYPEMASK;
                const newType = wParam & BS_TYPEMASK;
                child.style = (child.style & ~BS_TYPEMASK) | newType;
                const parent = child.parent !== undefined ? windows.get(child.parent) : undefined;
                if (newType === BS_DEFPUSHBUTTON && child.controlId !== undefined) {
                    if (parent) parent.dialogDefaultId = child.controlId;
                } else if (oldType === BS_DEFPUSHBUTTON && parent && parent.dialogDefaultId === child.controlId) {
                    parent.dialogDefaultId = undefined;
                }
                const wmWin = System.getInstance().windowManager.getWindow(child.handle);
                if (wmWin) wmWin.style = child.style;
                if (lParam && child.parent) repaintDialogAfterContentChange(child.parent);
            }
            return 0;
        }
        case LB_GETTOPINDEX: {
            return getOrCreateListState(child.handle).topIndex;
        }
        case LB_SETTOPINDEX: {
            const state = getOrCreateListState(child.handle);
            state.topIndex = wParam | 0;
            clampListTopIndexOf(state, child);
            return 0;
        }
        case LB_GETCARETINDEX:
            return getOrCreateListState(child.handle).caretIndex;
        case LB_SETCARETINDEX: {
            const state = getOrCreateListState(child.handle);
            const idx = wParam | 0;
            const LBS_MULTIPLESEL = 0x0008;
            const LBS_EXTENDEDSEL = 0x0800;
            const multiSelect = (child.style & (LBS_MULTIPLESEL | LBS_EXTENDEDSEL)) !== 0;

            // NT5 lb1.c / Wine listbox.c: reject an invalid caret. A single-select list
            // that ALREADY has a selection rejects this message too — there the caret is
            // the selection, and LB_SETCURSEL has moved iSelBase with it.
            if (idx < 0 || idx >= state.items.length || (!multiSelect && state.selectedIndex !== -1)) {
                return LB_ERR;
            }
            state.caretIndex = idx;
            if (!lParam) {
                const visible = listVisibleCountOf(child);
                if (idx < state.topIndex) state.topIndex = idx;
                else if (idx >= state.topIndex + visible) state.topIndex = idx - visible + 1;
                clampListTopIndexOf(state, child);
            }
            return 0; // LB_OKAY
        }
        case WM_SETTEXT:
            if (lParam) {
                child.title = readAnsiOrWideString(lParam);
                Logger.log(LogCategory.USER32, `handleSysCtrlMsg WM_SETTEXT: hwnd=0x${child.handle.toString(16)} id=${child.controlId ?? '?'} -> "${child.title}"`);
            }
            return 1;
        case WM_GETTEXT:
            if (lParam && wParam > 0) {
                const text = child.title;
                const encoded = encodeAnsi(text);
                const writeLen = Math.min(encoded.length, wParam - 1);
                mem.set(encoded.subarray(0, writeLen), lParam);
                mem[lParam + writeLen] = 0;
                return writeLen;
            }
            return 0;
        case WM_GETTEXTLENGTH:
            return child.title.length;
        case WM_ENABLE:
            if (wParam) child.style &= ~WS_DISABLED;
            else child.style |= WS_DISABLED;
            {
                const wmWin = System.getInstance().windowManager.getWindow(child.handle);
                if (wmWin) wmWin.style = child.style;
            }
            if (child.parent) repaintDialogAfterContentChange(child.parent);
            return 0;
        case STM_SETIMAGE: {
            const prevHandle = controlImageHandles.get(child.handle) ?? 0;
            if (wParam === IMAGE_BITMAP || wParam === IMAGE_ICON) {
                controlImageHandles.set(child.handle, lParam);
                applyStaticSetImageAutoSize(child, wParam, lParam);
            }
            return prevHandle;
        }
        case STM_GETIMAGE:
            return controlImageHandles.get(child.handle) ?? 0;
        case BM_SETCHECK:
            buttonCheckStates.set(child.handle, wParam);
            return 0;
        case BM_GETCHECK:
            return buttonCheckStates.get(child.handle) ?? 0;
        case BM_SETIMAGE: {
            const prevHandle = controlImageHandles.get(child.handle) ?? 0;
            if (wParam === IMAGE_BITMAP || wParam === IMAGE_ICON) {
                controlImageHandles.set(child.handle, lParam);
            }
            return prevHandle;
        }
        case BM_GETIMAGE:
            return controlImageHandles.get(child.handle) ?? 0;

        // --- Combobox messages ---
        case CB_SETITEMHEIGHT: {
            // wParam -1 addresses the selection field, any other index the list rows;
            // we keep one height for both, as the classic non-owner-draw combo does.
            const h = lParam & 0xFFFF;
            if (h <= 0) return CB_ERR;
            getOrCreateListState(child.handle).itemHeight = h;
            if (applyComboBoxClosedHeight(child) && child.parent) {
                repaintDialogAfterContentChange(child.parent);
            }
            return 0;
        }
        case CB_GETITEMHEIGHT:
            return comboBoxItemHeight(child);
        case CB_ADDSTRING:
        case LB_ADDSTRING: {
            const state = getOrCreateListState(child.handle);
            const text = readAnsiOrWideString(lParam);
            const index = state.items.length;
            state.items.push({ text, data: 0 });
            Logger.log(LogCategory.USER32,
                `handleSysCtrlMsg ${msg === CB_ADDSTRING ? 'CB_ADDSTRING' : 'LB_ADDSTRING'}: ` +
                `hwnd=0x${child.handle.toString(16)} id=${child.controlId ?? '?'} index=${index} text="${text}"`);
            return index;
        }
        case CB_INSERTSTRING:
        case LB_INSERTSTRING: {
            const state = getOrCreateListState(child.handle);
            const text = readAnsiOrWideString(lParam);
            let index = wParam | 0;
            if (index < 0 || index > state.items.length) index = state.items.length;
            state.items.splice(index, 0, { text, data: 0 });
            if (state.items.length > 1 && index <= state.caretIndex) state.caretIndex++;
            Logger.log(LogCategory.USER32,
                `handleSysCtrlMsg ${msg === CB_INSERTSTRING ? 'CB_INSERTSTRING' : 'LB_INSERTSTRING'}: ` +
                `hwnd=0x${child.handle.toString(16)} id=${child.controlId ?? '?'} index=${index} text="${text}"`);
            return index;
        }
        case CB_DELETESTRING:
        case LB_DELETESTRING: {
            const state = getOrCreateListState(child.handle);
            const idx = wParam | 0;
            if (idx < 0 || idx >= state.items.length) return CB_ERR;
            state.items.splice(idx, 1);
            if (state.selectedIndex === idx) state.selectedIndex = -1;
            else if (state.selectedIndex > idx) state.selectedIndex--;
            if (state.items.length === 0) state.caretIndex = 0;
            else if (state.caretIndex > idx) state.caretIndex--;
            else if (state.caretIndex >= state.items.length) state.caretIndex = state.items.length - 1;
            return state.items.length;
        }
        case CB_RESETCONTENT:
        case LB_RESETCONTENT: {
            const state = getOrCreateListState(child.handle);
            state.items.length = 0;
            state.selectedIndex = -1;
            state.caretIndex = 0;
            state.topIndex = 0;
            return 0;
        }
        case CB_GETCOUNT:
        case LB_GETCOUNT: {
            const state = getOrCreateListState(child.handle);
            return state.items.length;
        }
        case CB_GETCURSEL:
        case LB_GETCURSEL: {
            const state = getOrCreateListState(child.handle);
            return state.selectedIndex < 0 ? CB_ERR : state.selectedIndex;
        }
        case CB_SETCURSEL:
        case LB_SETCURSEL: {
            const state = getOrCreateListState(child.handle);
            const idx = wParam | 0;
            if (idx < 0 || idx >= state.items.length) {
                state.selectedIndex = -1;
                Logger.log(LogCategory.USER32,
                    `handleSysCtrlMsg ${msg === CB_SETCURSEL ? 'CB_SETCURSEL' : 'LB_SETCURSEL'}: ` +
                    `hwnd=0x${child.handle.toString(16)} id=${child.controlId ?? '?'} idx=${idx} -> CB_ERR`);
                return CB_ERR;
            }
            state.selectedIndex = idx;
            state.caretIndex = idx;
            // A combobox's WM_GETTEXT/GetDlgItemText reads child.title, not the list
            // state — without this, a CB_SETCURSEL'd combo shows the right item visually
            // but GetDlgItemText returns "" (e.g. TLJ's Player-Name combo: renders
            // "Player" but the guest's own empty-name validation sees nothing).
            if ((child.systemControlClass ?? '').toLowerCase() === 'combobox') {
                child.title = state.items[idx].text;
            }
            Logger.log(LogCategory.USER32,
                `handleSysCtrlMsg ${msg === CB_SETCURSEL ? 'CB_SETCURSEL' : 'LB_SETCURSEL'}: ` +
                `hwnd=0x${child.handle.toString(16)} id=${child.controlId ?? '?'} idx=${idx} text="${state.items[idx].text}"`);
            return idx;
        }
        case CB_SHOWDROPDOWN: {
            if ((child.systemControlClass ?? '').toLowerCase() !== 'combobox') return 0;
            const state = getOrCreateListState(child.handle);
            const show = wParam !== 0;
            if (show) {
                const host = child.parent ?? child.handle;
                closeOpenComboboxes(host, child.handle);
                state.dropdownOpen = true;
                state.topIndex = comboDropTopIndex(state.items.length, state.selectedIndex);
            } else if (state.dropdownOpen) {
                state.dropdownOpen = false;
            }
            if (child.parent) repaintDialogAfterContentChange(child.parent);
            return 1; // TRUE
        }
        case CB_GETLBTEXT:
        case LB_GETTEXT: {
            const state = getOrCreateListState(child.handle);
            const idx = wParam | 0;
            if (idx < 0 || idx >= state.items.length) return CB_ERR;
            const text = state.items[idx].text;
            if (lParam) {
                const encoded = encodeAnsi(text);
                mem.set(encoded, lParam);
                mem[lParam + encoded.length] = 0;
            }
            return text.length;
        }
        case CB_GETLBTEXTLEN:
        case LB_GETTEXTLEN: {
            const state = getOrCreateListState(child.handle);
            const idx = wParam | 0;
            if (idx < 0 || idx >= state.items.length) return CB_ERR;
            return state.items[idx].text.length;
        }
        case CB_GETITEMDATA:
        case LB_GETITEMDATA: {
            const state = getOrCreateListState(child.handle);
            const idx = wParam | 0;
            if (idx < 0 || idx >= state.items.length) return CB_ERR;
            return state.items[idx].data;
        }
        case CB_SETITEMDATA:
        case LB_SETITEMDATA: {
            const state = getOrCreateListState(child.handle);
            const idx = wParam | 0;
            if (idx < 0 || idx >= state.items.length) return CB_ERR;
            state.items[idx].data = lParam >>> 0;
            return 0; // CB_OKAY
        }
        case CB_FINDSTRING:
        case CB_FINDSTRINGEXACT: {
            const state = getOrCreateListState(child.handle);
            const search = readAnsiOrWideString(lParam).toLowerCase();
            const startAfter = (wParam | 0) < 0 ? -1 : (wParam | 0);
            const exact = msg === CB_FINDSTRINGEXACT;
            const idx = findStringIndex(state, startAfter, search, exact);
            return idx < 0 ? CB_ERR : idx;
        }
        case CB_SELECTSTRING:
        case LB_SELECTSTRING: {
            const state = getOrCreateListState(child.handle);
            const search = readAnsiOrWideString(lParam);
            const startAfter = (wParam | 0) < 0 ? -1 : (wParam | 0);
            const idx = findStringIndex(state, startAfter, search, false);
            if (idx < 0) {
                Logger.log(LogCategory.USER32,
                    `handleSysCtrlMsg ${msg === CB_SELECTSTRING ? 'CB_SELECTSTRING' : 'LB_SELECTSTRING'}: ` +
                    `hwnd=0x${child.handle.toString(16)} id=${child.controlId ?? '?'} search="${search}" -> CB_ERR`);
                return CB_ERR;
            }
            state.selectedIndex = idx;
            state.caretIndex = idx;
            if ((child.systemControlClass ?? '').toLowerCase() === 'combobox') {
                child.title = state.items[idx].text;
            }
            Logger.log(LogCategory.USER32,
                `handleSysCtrlMsg ${msg === CB_SELECTSTRING ? 'CB_SELECTSTRING' : 'LB_SELECTSTRING'}: ` +
                `hwnd=0x${child.handle.toString(16)} id=${child.controlId ?? '?'} search="${search}" ` +
                `idx=${idx} text="${state.items[idx].text}"`);
            return idx;
        }

        default:
            return 0;
    }
}

/** Trackbar (msctls_trackbar32) TBM_* message handler. */
function handleTrackbarMessage(child: WindowInfo, msg: number, wParam: number, lParam: number): number {
    const TBM_GETPOS       = 0x0400;
    const TBM_GETRANGEMIN  = 0x0401;
    const TBM_GETRANGEMAX  = 0x0402;
    const TBM_SETPOS       = 0x0405;
    const TBM_SETRANGE     = 0x0406;
    const TBM_SETRANGEMIN  = 0x0407;
    const TBM_SETRANGEMAX  = 0x0408;
    const TBM_SETSEL       = 0x040A;
    const TBM_SETTICFREQ   = 0x0414;
    const TBM_SETPAGESIZE  = 0x0415;
    const TBM_GETPAGESIZE  = 0x0416;
    const TBM_SETLINESIZE  = 0x0417;
    const TBM_GETLINESIZE  = 0x0418;

    const state = getOrCreateTrackbarState(child.handle);
    const clampPos = () => {
        if (state.pos < state.min) state.pos = state.min;
        if (state.pos > state.max) state.pos = state.max;
    };

    switch (msg) {
        case TBM_GETPOS:
            return state.pos;
        case TBM_GETRANGEMIN:
            return state.min;
        case TBM_GETRANGEMAX:
            return state.max;
        case TBM_SETPOS:
            state.pos = lParam | 0;
            clampPos();
            return 0;
        case TBM_SETRANGE: {
            // lParam: LOWORD=min, HIWORD=max (16-bit signed each)
            state.min = (lParam << 16) >> 16;
            state.max = (lParam >> 16) | 0;
            clampPos();
            return 0;
        }
        case TBM_SETRANGEMIN:
            state.min = lParam | 0;
            clampPos();
            return 0;
        case TBM_SETRANGEMAX:
            state.max = lParam | 0;
            clampPos();
            return 0;
        case TBM_SETSEL:
            return 0;
        case TBM_SETTICFREQ:
            state.ticFreq = wParam | 0;
            return 0;
        case TBM_SETPAGESIZE: {
            const prev = state.pageSize;
            state.pageSize = lParam | 0;
            return prev;
        }
        case TBM_GETPAGESIZE:
            return state.pageSize;
        case TBM_SETLINESIZE: {
            const prev = state.lineSize;
            state.lineSize = lParam | 0;
            return prev;
        }
        case TBM_GETLINESIZE:
            return state.lineSize;
        default:
            return 0;
    }
}

/** ScrollBar-class control SBM_* handler (state keyed as SB_CTL on the control's hwnd). */
function handleScrollBarControlMessage(
    child: WindowInfo, msg: number, wParam: number, lParam: number, mem: Uint8Array,
): number {
    const SB_CTL = 2;
    const SBM_SETPOS = 0x00E0;
    const SBM_GETPOS = 0x00E1;
    const SBM_SETRANGE = 0x00E2;
    const SBM_GETRANGE = 0x00E3;
    const SBM_ENABLE_ARROWS = 0x00E4;
    const SBM_SETRANGEREDRAW = 0x00E6;
    const SBM_SETSCROLLINFO = 0x00E9;
    const SBM_GETSCROLLINFO = 0x00EA;

    const repaint = () => {
        if (child.parent) repaintDialogAfterContentChange(child.parent);
    };

    switch (msg) {
        case SBM_SETPOS: {
            const prev = setScrollPos(child.handle, SB_CTL, wParam | 0);
            if (lParam) repaint();
            return prev;
        }
        case SBM_GETPOS:
            return getScrollPos(child.handle, SB_CTL);
        case SBM_SETRANGE:
        case SBM_SETRANGEREDRAW:
            setScrollRange(child.handle, SB_CTL, wParam | 0, lParam | 0);
            if (msg === SBM_SETRANGEREDRAW) repaint();
            return 0;
        case SBM_GETRANGE:
            getScrollRange(mem, child.handle, SB_CTL, wParam, lParam);
            return 0;
        case SBM_ENABLE_ARROWS:
            return 1;
        case SBM_SETSCROLLINFO: {
            const prev = applyScrollInfo(mem, child.handle, SB_CTL, lParam);
            if (wParam) repaint();
            return prev;
        }
        case SBM_GETSCROLLINFO:
            return readScrollInfo(mem, child.handle, SB_CTL, lParam) ? 1 : 0;
        default:
            return 0;
    }
}

/** Progress bar (msctls_progress32) PBM_* message handler. */
function handleProgressMessage(child: WindowInfo, msg: number, wParam: number, lParam: number): number {
    const PBM_SETRANGE   = 0x0401;
    const PBM_SETPOS     = 0x0402;
    const PBM_DELTAPOS   = 0x0403;
    const PBM_SETSTEP    = 0x0404;
    const PBM_STEPIT     = 0x0405;
    const PBM_SETRANGE32 = 0x0406;
    const PBM_GETPOS     = 0x0408;

    const state = getOrCreateTrackbarState(child.handle);
    const clampPos = () => {
        if (state.pos < state.min) state.pos = state.min;
        if (state.pos > state.max) state.pos = state.max;
    };

    switch (msg) {
        case PBM_SETRANGE:
            state.min = (lParam << 16) >> 16;
            state.max = (lParam >> 16) | 0;
            clampPos();
            return 0;
        case PBM_SETRANGE32:
            state.min = wParam | 0;
            state.max = lParam | 0;
            clampPos();
            return 0;
        case PBM_SETPOS: {
            const prev = state.pos;
            state.pos = wParam | 0;
            clampPos();
            return prev;
        }
        case PBM_DELTAPOS: {
            const prev = state.pos;
            state.pos += wParam | 0;
            clampPos();
            return prev;
        }
        case PBM_SETSTEP: {
            const prev = state.lineSize;
            state.lineSize = wParam | 0;
            return prev;
        }
        case PBM_STEPIT: {
            const prev = state.pos;
            state.pos += state.lineSize;
            if (state.pos > state.max) state.pos = state.min; // PBM_STEPIT wraps
            return prev;
        }
        case PBM_GETPOS:
            return state.pos;
        default:
            return 0;
    }
}
