/**
 * User32 Dialog functions
 *
 * Atomic implementation for dialog operations (MessageBox via host native alert/confirm).
 * DialogBoxParam uses callback chaining (same pattern as CreateWindowEx) to invoke dlgProc.
 */

import { ThunkImplementation, ThunkResult } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { Mem } from '../../core/memory/mem-accessor';
import { registerDialogItemExports } from './dialog-items';
import { registerMessageBoxExports } from './dialog-messagebox';
import { System } from '../../core/system';
import { WindowInfo, windows, controlImageHandles, getAbsoluteWindowPosition, getGroupSiblingRange, getVirtualScreenRect, killWindowTimers, finalizeWindowDestroy, buttonCheckStates, findChildByControlId, isEffectivelyVisible } from './shared-state';
import { validateWindow } from './paint-region';
import { WH_CBT, HCBT_CREATEWND, getHooksOfType } from './hooks';
import { parseDlgTemplate, dluToPixelX, dluToPixelY, getDialogBaseUnits, logDlgTemplateDump, ParsedDlgTemplate } from './dialog-template';
import { findResourceInPE } from '../../modules/kernel32/resource';
import { loadBitmapFromPeResource, parseResourceNameFromTitle } from '../kernel32/bitmap-extractor';
import { loadIconFromPeResource } from '../kernel32/icon-extractor';
import { isGroupBoxSystemControl, hitTestSystemControlAtClient, applyComboBoxClosedHeight } from './controls';
import { clickAutoButton, handleSystemControlMouseAtScreen, resetControlInteractionState, takePendingControlNotification } from './control-interaction';
import { noteDialogOverlayCandidate, resolveMouseTargetHwnd, eraseDialogOverlay, registerOverlayPaintRepair } from './dialog-overlay';
import { paintDialogToOverlay, finalizeDialogPaint, repaintDialogOverlayIfVisible, repaintDialogAfterContentChange } from './dialog-paint';
import { handleSystemControlMessage, applyStaticSetImageAutoSize, isContentChangingMessage } from './dialog-control-messages';
import { getDefWindowProcAddress } from './system-classes';
import { runDefaultWindowPaint } from './window';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { emitDialogShow } from '../../core/debug/dbg-commands';
import {
    buildPendingActivationSteps,
    markPendingActivation,
    markActivationDelivered,
    needsActivationDelivery,
    resolveActivationWndProc,
    isDialogInitInProgress,
    postInitialActivationMessages,
    activateTopLevelWindow,
    activateOwnedDialog,
    reactivateOwnerIfNeeded,
    isCreateInProgress,
} from './activation-messages';
import { getSystemColorRef, COLOR_BTNFACE_INDEX } from './system';
// Active-dialog registry + modal-pump lifetime binding.
import { activeDialogs, createPumpScheduler } from './modal-dialog-state';

const SS_TYPEMASK = 0x001F;
const SS_BITMAP = 0x000E;
const SS_ICON = 0x0003;
const SS_CENTERIMAGE = 0x0200;
const BS_BITMAP = 0x0080;
const IMAGE_BITMAP = 0;
const IMAGE_ICON = 1;

const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_NCDESTROY = 0x0082;
const WM_INITDIALOG = 0x0110;
const WM_COMMAND    = 0x0111;
const WM_KEYDOWN    = 0x0100;
const WM_NEXTDLGCTL = 0x0028;
const WM_MOUSEMOVE   = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP   = 0x0202;

const IDOK     = 1;
const IDCANCEL = 2;
const BN_CLICKED = 0;

// BST_* button states
const BST_UNCHECKED = 0;
const BST_CHECKED = 1;
const BST_INDETERMINATE = 2;
const BST_PUSHED = 4;

// BS_* button styles (low nibble)
const BS_TYPEMASK = 0x000F;
const BS_PUSHBUTTON = 0x0000;
const BS_DEFPUSHBUTTON = 0x0001;
const BS_OWNERDRAW = 0x000B;
const BS_RADIOBUTTON = 0x0004;
const BS_AUTOCHECKBOX = 0x0003;
const BS_AUTO3STATE = 0x0006;
const BS_AUTORADIOBUTTON = 0x0009;

const VK_TAB = 0x09;
const VK_RETURN = 0x0D;
const VK_ESCAPE = 0x1B;
const VK_CANCEL = 0x03;
const VK_SHIFT = 0x10;
const VK_LEFT = 0x25;
const VK_UP = 0x26;
const VK_RIGHT = 0x27;
const VK_DOWN = 0x28;

const WS_CHILD   = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_DISABLED = 0x08000000;
const WS_BORDER = 0x00800000;
const WS_POPUP = 0x80000000;
const WS_TABSTOP = 0x00010000;
const WS_EX_CLIENTEDGE = 0x00000200;
const WS_EX_NOPARENTNOTIFY = 0x00000004;

const DS_CENTER = 0x0800;
const DS_CENTERMOUSE = 0x1000;

/**
 * Wine dialog.c gates the "try to fit it into the desktop" nudge on
 * `!(style & WS_CHILD)` (DS_CENTER still applies to a child). A WS_CHILD dialog —
 * a wizard / property page created inside a placeholder control — keeps its template
 * position verbatim, relative to its parent's client area; clamping it to the screen
 * would slide the whole page, and every control on it, by the parent's screen offset.
 */
function isChildDialogStyle(style: number): boolean {
    return ((style >>> 0) & WS_CHILD) !== 0;
}

/**
 * Wine/NT dialog placement: DS_CENTER / DS_CENTERMOUSE, else template coords; then
 * for non-WS_CHILD, clamp into the work area (shift — never invent a re-center on overflow).
 */
function placeDialogWindow(
    style: number,
    templateX: number,
    templateY: number,
    width: number,
    height: number,
): { x: number; y: number } {
    const screen = getVirtualScreenRect();
    const workLeft = screen.left;
    const workTop = screen.top;
    const workRight = screen.right;
    const workBottom = screen.bottom;
    const workW = Math.max(1, workRight - workLeft);
    const workH = Math.max(1, workBottom - workTop);

    let x = templateX;
    let y = templateY;
    if ((style & DS_CENTER) !== 0) {
        x = workLeft + Math.max(0, Math.floor((workW - width) / 2));
        y = workTop + Math.max(0, Math.floor((workH - height) / 2));
    } else if ((style & DS_CENTERMOUSE) !== 0) {
        const mouse = System.getInstance().inputManager.getMouseState();
        x = (mouse.x | 0) - Math.floor(width / 2);
        y = (mouse.y | 0) - Math.floor(height / 2);
    }

    if (!isChildDialogStyle(style)) {
        // Wine dialog.c: pull back into the desktop work area (SM_CX/CYDLGFRAME ignored —
        // our virtual screen is the whole guest desktop).
        if (x + width > workRight) x = workRight - width;
        if (y + height > workBottom) y = workBottom - height;
        if (x < workLeft) x = workLeft;
        if (y < workTop) y = workTop;
    }
    return { x, y };
}

type DestroyAction = {
    hwnd: number;
    msg: number;
    finalizeAfter: boolean;
};

function collectSubtreePostOrder(rootHwnd: number): number[] {
    const order: number[] = [];
    const collect = (hwnd: number): void => {
        const wi = windows.get(hwnd);
        if (!wi) return;
        for (const childHwnd of [...wi.children]) collect(childHwnd);
        order.push(hwnd);
    };
    collect(rootHwnd);
    return order;
}

function markModalDialogSubtreePendingDestroy(rootHwnd: number): void {
    eraseDialogOverlay(rootHwnd);
    const mark = (hwnd: number): void => {
        const wi = windows.get(hwnd);
        if (!wi || wi.pendingDestroy) return;
        wi.pendingDestroy = true;
        wi.visible = false;
        killWindowTimers(hwnd);
        for (const childHwnd of [...wi.children]) mark(childHwnd);
    };
    mark(rootHwnd);
}

function hasGuestDestroyProc(wi: WindowInfo): boolean {
    const wndProc = wi.wndProc ?? 0;
    return !!wndProc
        && !isSentinelWndProc(wndProc)
        && (!wi.isSystemControl || !!wi.wndProcSubclassed);
}

/** Dialog face as COLORREF (0x00BBGGRR), from the live system palette. */
const dlgFaceColorRef = (): number => getSystemColorRef(COLOR_BTNFACE_INDEX);

// Auto check/radio state transitions live in control-interaction.ts (shared with
// DispatchMessage's hit-test path); re-exported here for existing importers.
export { applyAutoButtonState } from './control-interaction';

function createDialogTemplateFont(parsed: ParsedDlgTemplate | null): number {
    if (!parsed?.fontName || !parsed.fontSize || parsed.fontSize <= 0) return 0;
    const height = -Math.max(1, Math.round((parsed.fontSize * 96) / 72));
    return System.getInstance().gdiContext.createFont(height, 0, 400, false, parsed.fontName);
}

function isVisibleEnabledControl(win: WindowInfo | undefined): win is WindowInfo {
    return !!win?.visible && (win.style & WS_DISABLED) === 0;
}

function collectDialogControls(hwnd: number, out: WindowInfo[] = [], visited: Set<number> = new Set<number>()): WindowInfo[] {
    if (visited.has(hwnd)) return out;
    visited.add(hwnd);
    const parent = windows.get(hwnd);
    if (!parent) return out;
    for (const childHwnd of parent.children) {
        const child = windows.get(childHwnd);
        if (!child) continue;
        out.push(child);
        collectDialogControls(childHwnd, out, visited);
    }
    return out;
}

function getNextDialogControl(hDlg: number, hCtl: number, previous: boolean, requireTabStop: boolean): number {
    const controls = collectDialogControls(hDlg)
        .filter((c) => isVisibleEnabledControl(c)
            && !isGroupBoxSystemControl(c)
            && (!requireTabStop || (c.style & WS_TABSTOP) !== 0));
    if (controls.length === 0) return 0;

    if (!hCtl) return (previous ? controls[controls.length - 1] : controls[0])?.handle ?? 0;
    const idx = controls.findIndex((c) => c.handle === hCtl);
    if (idx < 0) return (previous ? controls[controls.length - 1] : controls[0])?.handle ?? 0;
    const nextIdx = previous
        ? (idx - 1 + controls.length) % controls.length
        : (idx + 1) % controls.length;
    return controls[nextIdx]?.handle ?? 0;
}

/**
 * GetNextDlgGroupItem — walk siblings within a WS_GROUP range (Wine/NT semantics
 * for the common flat-dialog case: children of hDlg are the sibling list).
 */
function getNextDialogGroupItem(hDlg: number, hCtl: number, previous: boolean): number {
    const parent = windows.get(hDlg);
    if (!parent) return 0;
    if (parent.children.length === 0) return 0;
    if (hCtl === hDlg) hCtl = 0;
    // Wine: previous of NULL fails
    if (!hCtl && previous) return 0;

    if (!hCtl) {
        // GW_CHILD is children[0]: the topmost sibling, which for a dialog is the first
        // control the template declared.
        for (const h of parent.children) {
            const c = windows.get(h);
            if (c && isVisibleEnabledControl(c) && !isGroupBoxSystemControl(c)) return c.handle;
        }
        return 0;
    }

    const group = getGroupSiblingRange(hDlg, hCtl)
        .filter((c) => isVisibleEnabledControl(c) && !isGroupBoxSystemControl(c));
    if (group.length === 0) return 0;

    const idx = group.findIndex((c) => c.handle === hCtl);
    if (idx < 0) return group[0]!.handle;
    const nextIdx = previous
        ? (idx - 1 + group.length) % group.length
        : (idx + 1) % group.length;
    return group[nextIdx]!.handle;
}

function getInitialDialogFocus(hDlg: number): number {
    return getNextDialogControl(hDlg, 0, false, true)
        || getNextDialogControl(hDlg, 0, false, false);
}

function applyInitDialogFocus(hDlg: number, initResult: number, focusHwnd: number): void {
    if (!initResult || !focusHwnd || !windows.has(focusHwnd)) return;
    System.getInstance().windowManager.setFocus(focusHwnd);
}

/** Sync WS_DISABLED on WindowInfo + WindowManager (EnableWindow contract). */
function setWindowEnabled(hwnd: number, enable: boolean): boolean {
    const win = windows.get(hwnd);
    if (!win) return false;
    const wasDisabled = (win.style & WS_DISABLED) !== 0;
    if (enable) win.style &= ~WS_DISABLED;
    else win.style |= WS_DISABLED;
    const wmWin = System.getInstance().windowManager.getWindow(hwnd);
    if (wmWin) {
        if (enable) wmWin.style &= ~WS_DISABLED;
        else wmWin.style |= WS_DISABLED;
    }
    return wasDisabled;
}

/**
 * Wine DIALOG_CreateIndirect: modal owner is the top-level ancestor of the
 * passed owner (climb while style is WS_CHILD without WS_POPUP).
 */
function resolveModalOwner(owner: number): number {
    let cur = owner;
    while (cur) {
        const win = windows.get(cur);
        if (!win) break;
        if ((win.style & (WS_POPUP | WS_CHILD)) === WS_CHILD && win.parent) {
            cur = win.parent;
            continue;
        }
        break;
    }
    return cur;
}

/** Wine IsDialogMessage VK_RETURN / DM_GETDEFID path. */
let pendingDialogCommand: { hwnd: number; wParam: number; lParam: number } | null = null;

function queueDialogCommand(hwnd: number, wParam: number, lParam: number): void {
    pendingDialogCommand = { hwnd, wParam: wParam >>> 0, lParam: lParam >>> 0 };
}

function takePendingDialogCommand(): { hwnd: number; wParam: number; lParam: number } | null {
    const command = pendingDialogCommand;
    pendingDialogCommand = null;
    return command;
}

function queueDialogDefaultCommand(hDlg: number): void {
    const system = System.getInstance();
    const focus = system.windowManager.getFocusHwnd();
    const focusWin = focus ? windows.get(focus) : undefined;
    if (focusWin && isDescendantOfDialog(focus, hDlg) && focus !== hDlg) {
        const className = (focusWin.systemControlClass ?? focusWin.nativeClassName ?? '').toLowerCase();
        if (className === 'button' && (focusWin.style & BS_TYPEMASK) === BS_DEFPUSHBUTTON) {
            const id = focusWin.controlId ?? 0;
            queueDialogCommand(hDlg, (id & 0xFFFF) | (BN_CLICKED << 16), focus);
            return;
        }
    }

    const defId = windows.get(hDlg)?.dialogDefaultId ?? 0;
    if (defId) {
        const defChild = findChildByControlId(hDlg, defId);
        if (!defChild || isVisibleEnabledControl(defChild)) {
            queueDialogCommand(hDlg, (defId & 0xFFFF) | (BN_CLICKED << 16), defChild?.handle ?? 0);
            return;
        }
    }

    const ok = findChildByControlId(hDlg, IDOK);
    queueDialogCommand(hDlg, IDOK | (BN_CLICKED << 16), ok?.handle ?? 0);
}

const DLGC_WANTARROWS = 0x0001;

/** WM_GETDLGCODE & DLGC_WANTARROWS for a JS-managed control. */
function wantsArrowKeys(hwnd: number): boolean {
    const win = windows.get(hwnd);
    if (!win?.isSystemControl || win.wndProcSubclassed) return false;
    const mem = System.getInstance().process?.getCurrentMemory?.();
    if (!mem) return false;
    const code = handleSystemControlMessage(win, 0x0087 /* WM_GETDLGCODE */, 0, 0, mem);
    return (code & DLGC_WANTARROWS) !== 0;
}

/**
 * Shared keyboard handling for the modal pump and IsDialogMessage
 * (Tab / arrows / Enter-via-DEFID / Esc). Returns true if consumed.
 */
function handleDialogKeyMessage(hDlg: number, message: number, wParam: number): boolean {
    if (message !== WM_KEYDOWN) return false;
    const system = System.getInstance();

    if (wParam === VK_TAB) {
        const shiftDown = (system.inputManager.getKeyState(VK_SHIFT) & 0x8000) !== 0;
        const focus = system.windowManager.getFocusHwnd();
        const cur = (focus && focus !== hDlg && isDescendantOfDialog(focus, hDlg)) ? focus : 0;
        const next = getNextDialogControl(hDlg, cur, shiftDown, true);
        if (next) system.windowManager.setFocus(next);
        return true;
    }

    if (wParam === VK_ESCAPE || wParam === VK_CANCEL) {
        const cancel = findChildByControlId(hDlg, IDCANCEL);
        queueDialogCommand(hDlg, IDCANCEL | (BN_CLICKED << 16), cancel?.handle ?? 0);
        return true;
    }

    if (wParam === VK_RETURN) {
        queueDialogDefaultCommand(hDlg);
        return true;
    }

    if (wParam === VK_LEFT || wParam === VK_UP || wParam === VK_RIGHT || wParam === VK_DOWN) {
        const previous = wParam === VK_LEFT || wParam === VK_UP;
        const focus = system.windowManager.getFocusHwnd();
        // IsDialogMessage asks the focused control first: a control that answers
        // WM_GETDLGCODE with DLGC_WANTARROWS owns the arrow keys, and the dialog
        // manager must not steal them for group navigation (tab control, listbox,
        // listview, edit).
        if (focus && focus !== hDlg && isDescendantOfDialog(focus, hDlg)
            && wantsArrowKeys(focus)) {
            return false;
        }
        const cur = (focus && isDescendantOfDialog(focus, hDlg)) ? focus : 0;
        const next = getNextDialogGroupItem(hDlg, cur, previous);
        if (next) {
            system.windowManager.setFocus(next);
            const nextWin = windows.get(next);
            if (nextWin
                && (nextWin.systemControlClass ?? '').toLowerCase() === 'button'
                && (nextWin.style & BS_TYPEMASK) === BS_AUTORADIOBUTTON
                && (buttonCheckStates.get(next) ?? 0) !== BST_CHECKED) {
                // Wine: BM_CLICK on autoradio when arrowing into an unchecked one —
                // the button checks itself and clears its group, THEN the parent hears
                // BN_CLICKED.
                clickAutoButton(nextWin);
                queueDialogCommand(
                    hDlg,
                    ((nextWin.controlId ?? 0) & 0xFFFF) | (BN_CLICKED << 16),
                    next);
            }
        }
        return true;
    }

    return false;
}

/**
 * Create child window HWNDs from parsed DLGTEMPLATE controls.
 * Called synchronously before WM_INITDIALOG so GetDlgItem works inside the dialog proc.
 */
export function createDialogChildren(
    system: System, dialogHwnd: number, dialogInfo: WindowInfo,
    parsed: ParsedDlgTemplate, hInstance: number,
): void {
    const base = getDialogBaseUnits(parsed);
    for (const ctrl of parsed.controls) {
        let childStyle = (ctrl.style & ~WS_POPUP) | WS_CHILD;
        let childExStyle = ctrl.exStyle | WS_EX_NOPARENTNOTIFY;
        if ((childStyle & WS_BORDER) !== 0) {
            childStyle &= ~WS_BORDER;
            childExStyle |= WS_EX_CLIENTEDGE;
        }
        const childX = dluToPixelX(ctrl.x, base);
        const childY = dluToPixelY(ctrl.y, base);
        const childW = dluToPixelX(ctrl.cx, base);
        const childH = dluToPixelY(ctrl.cy, base);

        const childHwnd = system.windowManager.createWindow(
            ctrl.className,
            ctrl.title,
            childStyle,
            childExStyle,
            childX, childY, childW, childH,
            dialogHwnd, ctrl.id, hInstance, 0
        );

        const childInfo: WindowInfo = {
            handle: childHwnd,
            title: ctrl.title,
            style: childStyle,
            exStyle: childExStyle,
            x: childX,
            y: childY,
            width: childW,
            height: childH,
            parent: dialogHwnd,
            children: [],
            visible: (childStyle & WS_VISIBLE) !== 0,
            wndProc: getDefWindowProcAddress(),
            userData: 0,
            controlId: ctrl.id,
            isSystemControl: true,
            systemControlClass: ctrl.className,
            nativeClassName: ctrl.className,
            fontHandle: dialogInfo.fontHandle,
        };

        windows.set(childHwnd, childInfo);
        // A combobox template's cy covers the dropped list; USER sizes the window to
        // the closed box (see applyComboBoxClosedHeight) — same rule as CreateWindow.
        applyComboBoxClosedHeight(childInfo);
        dialogInfo.children.push(childHwnd);
        if (ctrl.className.toLowerCase() === 'button'
            && (childStyle & BS_TYPEMASK) === BS_DEFPUSHBUTTON) {
            dialogInfo.dialogDefaultId = ctrl.id;
        }

        // Win32 loads RT_BITMAP from the control's template title for SS_BITMAP
        // statics (and BS_BITMAP buttons) at creation time — before WM_INITDIALOG.
        const classLower = ctrl.className.toLowerCase();
        const needsBitmapFromTitle =
            (classLower === 'static' && (childStyle & SS_TYPEMASK) === SS_BITMAP)
            || (classLower === 'button' && (childStyle & BS_BITMAP) !== 0);
        const needsIconFromTitle =
            classLower === 'static' && (childStyle & SS_TYPEMASK) === SS_ICON;
        if (needsBitmapFromTitle) {
            const resourceName = parseResourceNameFromTitle(ctrl.title);
            if (resourceName != null) {
                const mem = system.process?.v86?.mem8 ?? system.process?.v86?.v86?.cpu?.mem8;
                if (mem) {
                    const hBitmap = loadBitmapFromPeResource(mem, hInstance || 0x00400000, resourceName);
                    if (hBitmap) {
                        controlImageHandles.set(childHwnd, hBitmap);
                        applyStaticSetImageAutoSize(childInfo, IMAGE_BITMAP, hBitmap);
                    }
                }
            }
        }
        if (needsIconFromTitle) {
            const resourceName = parseResourceNameFromTitle(ctrl.title);
            if (resourceName != null) {
                const mem = system.process?.v86?.mem8 ?? system.process?.v86?.v86?.cpu?.mem8;
                if (mem) {
                    const hIcon = loadIconFromPeResource(mem, hInstance || 0x00400000, resourceName);
                    if (hIcon) {
                        controlImageHandles.set(childHwnd, hIcon);
                        applyStaticSetImageAutoSize(childInfo, IMAGE_ICON, hIcon);
                    }
                }
            }
        }

        Logger.log(LogCategory.USER32,
            `  child: ${ctrl.className} id=${ctrl.id} "${ctrl.title}" ` +
            `hwnd=0x${childHwnd.toString(16)} pos=(${childX},${childY}) size=${childW}x${childH} ` +
            `style=0x${childStyle.toString(16)} exStyle=0x${childExStyle.toString(16)}`);
    }
}

/**
 * Dequeue the next message from the queue (like real GetMessage(NULL, 0, 0)).
 * Modal behavior comes from disabling the owner, not from message filtering.
 * WM_NULL (hwnd=0, message=0) idle messages are skipped automatically.
 */
function dequeueNextDialogMessage(system: System): { hwnd: number; message: number; wParam: number; lParam: number } | undefined {
    for (let i = 0; i < 32; i++) {
        const msg = system.windowManager.getMessage();
        if (!msg) return undefined;
        if (msg.hwnd === 0 && msg.message === 0) continue; // WM_NULL idle
        return msg;
    }
    return undefined;
}

/** Check if hwnd is a descendant of (or equal to) dialogHwnd. */
function isDescendantOfDialog(hwnd: number, dialogHwnd: number): boolean {
    let cur = hwnd;
    const visited = new Set<number>();
    while (cur) {
        if (cur === dialogHwnd) return true;
        if (visited.has(cur)) return false;
        visited.add(cur);
        const win = windows.get(cur);
        if (!win || !win.parent) return false;
        cur = win.parent;
    }
    return false;
}

function hitTestSystemControlRecursive(
    hwnd: number,
    x: number,
    y: number,
    visited: Set<number> = new Set<number>(),
): WindowInfo | undefined {
    if (visited.has(hwnd)) return undefined;
    visited.add(hwnd);

    const win = windows.get(hwnd);
    if (!win || !win.visible || !win.children.length) return undefined;

    // Reverse order: last child is treated as topmost.
    for (let i = 0; i < win.children.length; i++) {
        const child = windows.get(win.children[i]);
        if (!child || !child.visible) continue;

        const { x: absX, y: absY } = getAbsoluteWindowPosition(child);
        if (x < absX || y < absY || x >= absX + child.width || y >= absY + child.height) {
            continue;
        }

        const deeper = hitTestSystemControlRecursive(child.handle, x, y, visited);
        if (deeper) return deeper;
        if (child.isSystemControl && !isGroupBoxSystemControl(child)) return child;
    }

    return undefined;
}

const WM_PAINT = 0x000F;

/** DefDlgProc epilogue messages (Wine defdlg.c) — see answersWithDlgProcResult. */
const WM_CTLCOLOR16 = 0x0019;
const WM_VKEYTOITEM = 0x002E;
const WM_CHARTOITEM = 0x002F;
const WM_QUERYDRAGICON = 0x0037;
const WM_COMPAREITEM = 0x0039;
const WM_CTLCOLORMSGBOX = 0x0132;
const WM_CTLCOLORSTATIC = 0x0138;

function clientLParamToScreen(hwnd: number, lParam: number): { x: number; y: number } {
    const clientX = lParam & 0xFFFF;
    const clientY = (lParam >>> 16) & 0xFFFF;
    const win = windows.get(hwnd);
    if (!win) return { x: clientX, y: clientY };
    const { x, y } = getAbsoluteWindowPosition(win);
    return { x: x + clientX, y: y + clientY };
}

function screenToDialogClient(dialogHwnd: number, screenX: number, screenY: number): { x: number; y: number } {
    const dlg = windows.get(dialogHwnd);
    if (!dlg) return { x: screenX, y: screenY };
    const { x, y } = getAbsoluteWindowPosition(dlg);
    return { x: screenX - x, y: screenY - y };
}

function screenToWindowClient(hwnd: number, screenX: number, screenY: number): { x: number; y: number } {
    const win = windows.get(hwnd);
    if (!win) return { x: screenX, y: screenY };
    const { x, y } = getAbsoluteWindowPosition(win);
    return { x: screenX - x, y: screenY - y };
}

function makeMouseLParam(clientX: number, clientY: number): number {
    return (((clientY | 0) & 0xFFFF) << 16) | ((clientX | 0) & 0xFFFF);
}

function isPointInClient(hwnd: number, clientX: number, clientY: number): boolean {
    const win = windows.get(hwnd);
    return !!win && clientX >= 0 && clientY >= 0 && clientX < win.width && clientY < win.height;
}

/** Mouse click on JS system controls — shared implementation (control-interaction.ts). */
function dispatchSystemControlClick(
    label: string,
    dialogHwnd: number,
    message: number,
    wParam: number,
    screenX: number,
    screenY: number,
): boolean {
    const consumed = handleSystemControlMouseAtScreen(dialogHwnd, message, wParam, screenX, screenY);
    if (consumed) {
        Logger.verbose(LogCategory.USER32,
            `${label}: system control consumed msg=0x${message.toString(16)} at (${screenX},${screenY})`);
    }
    return consumed;
}
function runModalDialog(
    ctx: any, mem: Uint8Array, hInstance: number, hWndParent: number,
    lpDialogFunc: number, dwInitParam: number, label: string,
    lpTemplate: number = 0,
    /** stdcall bytes the CALLING thunk pops; DialogBoxParam's five args by default. */
    callerStackCleanup: number = 5 * 4,
): any {
    if (!lpDialogFunc) {
        Logger.warn(LogCategory.USER32, `${label}: No dlgProc, returning IDOK`);
        return 1;
    }

    const system = System.getInstance();
    const callbackManager = system.process?.dispatcher?.callbackManager;
    if (!callbackManager) {
        Logger.warn(LogCategory.USER32, `${label}: No callback manager, returning IDOK`);
        return 1;
    }

    // Parse template and create dialog window + children
    let parsed: ParsedDlgTemplate | null = null;
    if (lpTemplate && mem) {
        try {
            parsed = parseDlgTemplate(mem, lpTemplate);
            Logger.log(LogCategory.USER32,
                `${label}: parsed template: "${parsed.title}" ${parsed.cx}x${parsed.cy} DLU, ` +
                `${parsed.controls.length} controls, style=0x${parsed.style.toString(16)}`);
            logDlgTemplateDump(parsed, label, lpTemplate);
        } catch (e) {
            Logger.warn(LogCategory.USER32, `${label}: Failed to parse DLGTEMPLATE at 0x${lpTemplate.toString(16)}: ${e}`);
        }
    }

    const base = getDialogBaseUnits(parsed);
    const dlgStyle  = parsed ? parsed.style : 0x90000000;
    const dlgTitle  = parsed?.title || '';
    const dlgWidth  = parsed ? dluToPixelX(parsed.cx, base) : 400;
    const dlgHeight = parsed ? dluToPixelY(parsed.cy, base) : 300;
    const dialogFont = createDialogTemplateFont(parsed);

    const screen = EmulatorConfig.getInstance().screenResolution;
    let dlgX: number, dlgY: number;
    if (parsed) {
        const placed = placeDialogWindow(
            dlgStyle,
            dluToPixelX(parsed.x, base),
            dluToPixelY(parsed.y, base),
            dlgWidth,
            dlgHeight,
        );
        dlgX = placed.x;
        dlgY = placed.y;
        if ((dlgStyle & (DS_CENTER | DS_CENTERMOUSE)) !== 0) {
            Logger.log(LogCategory.USER32,
                `${label}: dialog (${dlgWidth}x${dlgHeight}) placed at (${dlgX},${dlgY}) ` +
                `style=0x${(dlgStyle >>> 0).toString(16)}`);
        }
    } else {
        dlgX = 0;
        dlgY = 0;
    }

    // Ensure host canvas matches configured screen resolution for dialog-only flows
    // (no DDraw SetDisplayMode → canvas may still be at default/window size)
    const system2 = System.getInstance();
    system2.requestHostResize(screen.width, screen.height);

    const previousActiveHwnd = system.windowManager.getActiveHwnd() || hWndParent;

    // Wine/NT: disable the (top-level) owner BEFORE creating the modal dialog.
    let disabledOwner = 0;
    if (hWndParent) {
        const owner = resolveModalOwner(hWndParent);
        if (owner && windows.has(owner) && (windows.get(owner)!.style & WS_DISABLED) === 0) {
            setWindowEnabled(owner, false);
            disabledOwner = owner;
            Logger.log(LogCategory.USER32,
                `${label}: disabled modal owner 0x${owner.toString(16)}`);
        }
    }

    const dialogHwnd = system.windowManager.createWindow(
        '#32770',
        dlgTitle,
        dlgStyle | WS_VISIBLE,
        parsed?.exStyle ?? 0,
        dlgX, dlgY, dlgWidth, dlgHeight,
        hWndParent, 0, hInstance || 0x400000, dwInitParam
    );
    if (dialogHwnd) {
        activateTopLevelWindow(dialogHwnd);
    }

    const restoreOwnerActivation = (): void => {
        if (disabledOwner) {
            setWindowEnabled(disabledOwner, true);
            disabledOwner = 0;
        }
        if (previousActiveHwnd && system.windowManager.getWindow(previousActiveHwnd)) {
            reactivateOwnerIfNeeded(0, previousActiveHwnd);
        }
    };

    // DLGWINDOWEXTRA = 30 bytes on real Windows; round up to 10 DWORDs (40 bytes)
    const dialogInfo: WindowInfo = {
        handle: dialogHwnd,
        title: dlgTitle,
        style: dlgStyle | WS_VISIBLE,
        exStyle: parsed?.exStyle,
        x: dlgX, y: dlgY,
        width: dlgWidth, height: dlgHeight,
        parent: hWndParent || undefined,
        children: [],
        visible: true,
        wndProc: lpDialogFunc,
        userData: 0,
        cbWndExtra: 40,
        extraBytes: new Uint32Array(10),
        nativeClassName: '#32770',
        fontHandle: dialogFont || undefined,
        dialogBaseUnitX: base.x,
        dialogBaseUnitY: base.y,
    };
    // Seed DWLP_DLGPROC (extra-byte offset 4) with the initial proc, matching the
    // Win32 dialog manager; wndProc holds the same value for message dispatch.
    dialogInfo.extraBytes![1] = lpDialogFunc >>> 0; // DWLP_DLGPROC
    windows.set(dialogHwnd, dialogInfo);

    // Register dialog as child of parent window
    if (hWndParent) {
        const parentInfo = windows.get(hWndParent);
        if (parentInfo) parentInfo.children.push(dialogHwnd);
    }

    if (parsed && parsed.controls.length > 0) {
        createDialogChildren(system, dialogHwnd, dialogInfo, parsed, hInstance || 0x400000);
    }

    noteDialogOverlayCandidate(dialogInfo);

    Logger.log(LogCategory.USER32,
        `${label}: created modal dialog hwnd=0x${dialogHwnd.toString(16)} ` +
        `${dlgWidth}x${dlgHeight} with ${dialogInfo.children.length} children`);

    // WM_PAINT is posted after WM_INITDIALOG completes (see initCompleteThunk).

    activeDialogs.set(dialogHwnd, {
        hwnd: dialogHwnd,
        dlgProc: lpDialogFunc,
        result: 1,
        closed: false,
        disabledOwner: disabledOwner || undefined,
    });
    const initFocusHwnd = getInitialDialogFocus(dialogHwnd);

    // Gather CBT hooks and allocate CBT_CREATEWND if needed
    const cbtHooks = getHooksOfType(WH_CBT);
    let cbtCreateWndPtr = 0;
    if (cbtHooks.length > 0) {
        const createStruct = system.process!.memory.alloc(48, "HEAP", "rw");
        Mem.writeUint32(createStruct + 0, dwInitParam >>> 0);
        cbtCreateWndPtr = system.process!.memory.alloc(8, "HEAP", "rw");
        Mem.writeUint32(cbtCreateWndPtr + 0, createStruct);
        Mem.writeUint32(cbtCreateWndPtr + 4, 0);
        Logger.log(LogCategory.USER32, `${label}: firing ${cbtHooks.length} CBT hook(s)`);
    }

    // Suspend this thunk and keep its frame alive for the whole dialog lifetime.
    // Every x86 callback below is anchored to frame_esp via the frame mechanism,
    // so [frame_esp] = spinLoopAddress (written by _handleAsyncResult) is always
    // the callerRet the return-stub sees.
    const stackCleanup = callerStackCleanup;
    const frameId = callbackManager.saveSuspendedThunkContext(ctx, stackCleanup, label);
    if (!frameId) {
        Logger.error(LogCategory.USER32, `${label}: failed to save suspended thunk context`);
        activeDialogs.delete(dialogHwnd);
        restoreOwnerActivation();
        return IDCANCEL;
    }

    const completeClosedDialog = (reason: string): number | null => {
        const dialog = activeDialogs.get(dialogHwnd);
        const result = dialog?.result ?? IDOK;
        if (dialog?.teardownStarted) return null;
        if (dialog) dialog.teardownStarted = true;

        markModalDialogSubtreePendingDestroy(dialogHwnd);

        const actions: DestroyAction[] = [];
        let finalizeDialogRootAtFinish = false;
        for (const hwnd of collectSubtreePostOrder(dialogHwnd)) {
            const wi = windows.get(hwnd);
            if (!wi) continue;
            if (hwnd === dialogHwnd) {
                // EndDialog closes a modal dialog managed by our dialog manager. Some
                // legacy setup DLGPROCs corrupt their stack/SEH state when re-entered
                // with WM_DESTROY after EndDialog; skip root guest destroy delivery.
                finalizeDialogRootAtFinish = true;
                Logger.log(LogCategory.USER32,
                    `${label}: skipping root modal DLGPROC destroy for hwnd=0x${hwnd.toString(16)}`);
                continue;
            }
            if (hasGuestDestroyProc(wi)) {
                actions.push({ hwnd, msg: WM_DESTROY, finalizeAfter: false });
                actions.push({ hwnd, msg: WM_NCDESTROY, finalizeAfter: true });
            } else {
                finalizeWindowDestroy(hwnd);
            }
        }

        const finish = (): number => {
            if (finalizeDialogRootAtFinish && windows.has(dialogHwnd)) {
                finalizeWindowDestroy(dialogHwnd);
            }
            activeDialogs.delete(dialogHwnd);
            restoreOwnerActivation();
            if (previousActiveHwnd && windows.has(previousActiveHwnd)
                && !isDialogInitInProgress(previousActiveHwnd)
                && !isCreateInProgress(previousActiveHwnd)) {
                repaintDialogOverlayIfVisible(previousActiveHwnd);
            }
            Logger.log(LogCategory.USER32,
                `${label}: Dialog 0x${dialogHwnd.toString(16)} closed (${reason}), result=${result}`);
            return result;
        };

        if (actions.length === 0) return finish();

        let index = 0;
        const runNextDestroy = (): number | null => {
            while (index < actions.length) {
                const action = actions[index]!;
                const wi = windows.get(action.hwnd);
                const wndProc = wi?.wndProc ?? 0;
                if (!wi || !hasGuestDestroyProc(wi) || !wndProc) {
                    if (action.finalizeAfter) finalizeWindowDestroy(action.hwnd);
                    index++;
                    continue;
                }

                Logger.log(LogCategory.USER32,
                    `${label}: deferredDestroy hwnd=0x${action.hwnd.toString(16)} ` +
                    `msg=0x${action.msg.toString(16)} wndProc=0x${wndProc.toString(16)}`);
                const invoked = callbackManager.invokeCallback(
                    wndProc,
                    [action.hwnd, action.msg, 0, 0],
                    0,
                    completeDestroyAndAdvance,
                    false,
                    `${label}:deferred-destroy`,
                    frameId,
                );
                if (invoked.callbackId !== 0) return null;

                if (action.finalizeAfter) finalizeWindowDestroy(action.hwnd);
                index++;
            }
            return finish();
        };

        const completeDestroyAndAdvance = (_ret: number): number | null => {
            const finished = actions[index];
            if (finished?.finalizeAfter) finalizeWindowDestroy(finished.hwnd);
            index++;
            return runNextDestroy();
        };

        return runNextDestroy();
    };

    // -------------------------------------------------------------------------
    // Pump step - re-armed via schedulePump() between x86 callbacks.
    // Dequeues one dialog message and dispatches it (or yields for 8 ms if idle).
    //
    // The pump is bound to THIS process: its dispatches ride the suspended thunk
    // frame above, which dies with the process. schedulePump is the only way it
    // may re-arm, so a torn-down process cannot leave a pump firing into the next
    // guest (pumpScheduler epoch), and a dead process stops it on the next step.
    // -------------------------------------------------------------------------
    let pumpIterations = 0;
    let pumpCompleteThunk: (_ret: number) => number | null;

    const pumpScheduler = createPumpScheduler();
    const schedulePump = (delayMs: number): void => pumpScheduler.schedule(pumpStep, delayMs);
    /**
     * The pump can no longer deliver messages. DialogBoxParam's caller is suspended in
     * `frameId`, so this must still END the dialog rather than just stop: dropping the
     * registry entry first would leave completeClosedDialog with no dialog to close and
     * the guest thread parked at the spin loop for good. An abandoned modal answers
     * IDCANCEL, and its teardown chain is what completes the frame — a non-null return
     * means the chain finished without dispatching a guest callback, so nothing else
     * will, and the frame is released instead of staying pinned.
     */
    const abandonPump = (why: string): void => {
        if (!pumpScheduler.isLive()) return;
        pumpScheduler.abandon();
        Logger.error(LogCategory.USER32,
            `${label}: abandoning modal pump for hwnd=0x${dialogHwnd.toString(16)} - ${why}`);
        const dialog = activeDialogs.get(dialogHwnd);
        if (!dialog) {
            restoreOwnerActivation();
            callbackManager.abandonSuspendedFrame(frameId);
            return;
        }
        dialog.result = IDCANCEL;
        dialog.closed = true;
        if (completeClosedDialog('abandoned') !== null) {
            callbackManager.abandonSuspendedFrame(frameId);
        }
    };
    const MAX_PUMP_DISPATCH_FAILURES = 16;
    let pumpDispatchFailures = 0;

    const dispatchPendingControlNotification = (): boolean => {
        const control = takePendingControlNotification();
        const dialog = takePendingDialogCommand();
        const notification = control ?? (dialog ? {
            hwnd: dialog.hwnd,
            msg: WM_COMMAND,
            wParam: dialog.wParam,
            lParam: dialog.lParam,
        } : null);
        if (!notification) return false;
        const parent = windows.get(notification.hwnd);
        const wndProc = notification.hwnd === dialogHwnd
            ? lpDialogFunc
            : (parent?.wndProc ?? 0);
        if (!wndProc || isSentinelWndProc(wndProc)) return false;
        const result = callbackManager.invokeCallback(
            wndProc,
            [notification.hwnd, notification.msg, notification.wParam, notification.lParam],
            0,
            pumpCompleteThunk,
            false,
            `${label}:control-notify`,
            frameId,
        );
        return result.callbackId !== 0;
    };

    const pumpStep = (): void => {
        if (system.isExiting) {
            // The process this pump belongs to is gone; its suspended frame with it.
            pumpScheduler.abandon();
            Logger.log(LogCategory.USER32,
                `${label}: process exiting, stopping modal pump for hwnd=0x${dialogHwnd.toString(16)}`);
            return;
        }
        pumpIterations++;
        const dialog = activeDialogs.get(dialogHwnd);
        if (!dialog || dialog.closed) {
            // EndDialog while the pump was idle (no in-flight guest callback): still
            // run HWND teardown. Frame completion normally happens via pumpCompleteThunk
            // when the guest callback that called EndDialog returns; this is a safety net
            // so controls/state are not left dangling if that path was skipped.
            if (dialog?.closed && !dialog.teardownStarted) {
                completeClosedDialog('EndDialog-idle');
            } else {
                restoreOwnerActivation();
            }
            return;
        }

        system.inputManager.poll(true);

        const msg = dequeueNextDialogMessage(system);
        if (!msg) {
            if (pumpIterations <= 5 || pumpIterations % 100 === 0) {
                Logger.warn(LogCategory.USER32,
                    `${label}: pumpStep #${pumpIterations} - no message (queue empty)`);
            }
            schedulePump(8);
            return;
        }

        const { hwnd, message, wParam, lParam } = msg;
        const targetInfo = windows.get(hwnd);

        Logger.log(
            LogCategory.USER32,
            `${label}: pumpStep #${pumpIterations} - msg=0x${message.toString(16)} hwnd=0x${hwnd.toString(16)} ` +
            `isSysCtrl=${!!targetInfo?.isSystemControl} wndProc=0x${(targetInfo?.wndProc ?? 0).toString(16)}`,
        );

        if (message === WM_PAINT && targetInfo && !isEffectivelyVisible(targetInfo)) {
            validateWindow(hwnd, null);
            schedulePump(0);
            return;
        }

        // --- IsDialogMessage equivalent: Tab / Enter-via-DEFID / Esc / arrows ---
        if (handleDialogKeyMessage(dialogHwnd, message, wParam)) {
            if (dispatchPendingControlNotification()) return;
            schedulePump(0);
            return;
        }

        // --- Modal dialog mouse re-routing ---
        // Real modal dialogs are active owned top-level windows. If an already queued
        // mouse message still targets the owner, translate the screen point into the
        // dialog/control client space instead of dropping the message.
        const isMouseMsg = message === WM_MOUSEMOVE || message === WM_LBUTTONDOWN || message === WM_LBUTTONUP;
        if (isMouseMsg && hwnd !== dialogHwnd && !isDescendantOfDialog(hwnd, dialogHwnd)) {
            const { x: screenX, y: screenY } = clientLParamToScreen(hwnd, lParam);
            const { x: dlgClientX, y: dlgClientY } = screenToDialogClient(dialogHwnd, screenX, screenY);
            if (dispatchSystemControlClick(label, dialogHwnd, message, wParam, screenX, screenY)) {
                if (dispatchPendingControlNotification()) return;
                schedulePump(0);
                return;
            }
            if (message === WM_MOUSEMOVE) {
                const hitControl = hitTestSystemControlAtClient(dialogHwnd, dlgClientX, dlgClientY);
                if (hitControl) {
                    const mem8 = system.process?.v86?.mem8 ?? system.process?.v86?.v86?.cpu?.mem8;
                    if (mem8) {
                        const { x: ctrlX, y: ctrlY } = screenToWindowClient(hitControl.handle, screenX, screenY);
                        handleSystemControlMessage(hitControl, message, wParam, makeMouseLParam(ctrlX, ctrlY), mem8);
                    }
                    schedulePump(0);
                    return;
                }
            }

            if (isPointInClient(dialogHwnd, dlgClientX, dlgClientY)) {
                system.windowManager.postMessage(
                    dialogHwnd,
                    message,
                    wParam,
                    makeMouseLParam(dlgClientX, dlgClientY),
                    screenX,
                    screenY,
                );
            }
            schedulePump(0);
            return;
        }

        // If mouse message targets a non-system window within the dialog tree,
        // hit-test system controls recursively.
        if ((message === WM_LBUTTONDOWN || message === WM_LBUTTONUP) && !targetInfo?.isSystemControl) {
            const { x: screenX, y: screenY } = clientLParamToScreen(hwnd, lParam);
            if (dispatchSystemControlClick(label, dialogHwnd, message, wParam, screenX, screenY)) {
                if (dispatchPendingControlNotification()) return;
                schedulePump(0);
                return;
            }
        }

        // --- System control handling (JS-managed Button/Static/Edit/etc.) ---
        // A guest-subclassed control (SetWindowLong GWL_WNDPROC) is no longer JS-managed:
        // its window procedure IS the guest's, so fall through to the x86 dispatch below so
        // app-defined messages reach the guest message map (mirrors the SendMessage /
        // DispatchMessage `!wndProcSubclassed` guard). Without this, a subclassed control in
        // a MODAL dialog has its custom messages swallowed by handleSystemControlMessage.
        if (targetInfo?.isSystemControl && !targetInfo.wndProcSubclassed) {
            if (message === WM_LBUTTONDOWN || message === WM_LBUTTONUP) {
                const { x: screenX, y: screenY } = clientLParamToScreen(hwnd, lParam);
                dispatchSystemControlClick(label, dialogHwnd, message, wParam, screenX, screenY);
                if (dispatchPendingControlNotification()) return;
            } else {
                // Route other messages to the JS system control handler
                const mem8 = system.process?.v86?.mem8 ?? system.process?.v86?.v86?.cpu?.mem8;
                if (mem8) {
                    handleSystemControlMessage(targetInfo, message, wParam, lParam, mem8);
                    // Repaint after content-changing messages (WM_SETTEXT, LB_ADDSTRING, etc.)
                    if (isContentChangingMessage(targetInfo, message)) {
                        repaintDialogAfterContentChange(targetInfo.parent ?? dialogHwnd);
                    }
                }
            }
            schedulePump(0);
            return;
        }

        // --- Dispatch to x86 wndProc ---
        // Determine which wndProc to call for this message
        let targetWndProc = 0;
        if (hwnd === dialogHwnd) {
            // Message to the dialog itself -> call lpDialogFunc
            targetWndProc = lpDialogFunc;
        } else if (targetInfo?.wndProc && !isSentinelWndProc(targetInfo.wndProc)) {
            // Message to another window with a real x86 wndProc
            targetWndProc = targetInfo.wndProc;
        }

        if (targetWndProc) {
            Logger.log(LogCategory.USER32,
                `${label}: Dispatch msg=0x${message.toString(16)} hwnd=0x${hwnd.toString(16)} -> wndProc=0x${targetWndProc.toString(16)}`);
            try {
                const result = callbackManager.invokeCallback(
                    targetWndProc,
                    [hwnd, message, wParam, lParam],
                    0,
                    pumpCompleteThunk,
                    false,
                    `${label}:pump`,
                    frameId,
                );
                if (result.callbackId === 0) {
                    // The dispatch could not be SET UP. The callback-nesting limit is a
                    // transient one — the chain in flight unwinds and the next step gets
                    // through — so it rides the same bounded counter as a throwing dispatch
                    // rather than ending a dialog that is still perfectly alive.
                    if (++pumpDispatchFailures >= MAX_PUMP_DISPATCH_FAILURES) {
                        abandonPump(`${pumpDispatchFailures} consecutive dispatch set-up failures`);
                        return;
                    }
                    schedulePump(0);
                    return;
                }
                pumpDispatchFailures = 0;
            } catch (e) {
                Logger.warn(LogCategory.USER32, `${label}: dispatch msg=0x${message.toString(16)} failed: ${e}`);
                if (++pumpDispatchFailures >= MAX_PUMP_DISPATCH_FAILURES) {
                    abandonPump(`${pumpDispatchFailures} consecutive dispatch failures`);
                    return;
                }
                schedulePump(0);
            }
        } else {
            // Unknown target or no wndProc - continue pump
            Logger.verbose(LogCategory.USER32,
                `${label}: No wndProc for hwnd=0x${hwnd.toString(16)} msg=0x${message.toString(16)}, skipping`);
            schedulePump(0);
        }
    };

    // -------------------------------------------------------------------------
    // completeThunk for messages dispatched by pumpStep to x86 wndProcs.
    // Returns null -> keep frame alive, CPU parks at spin loop, pumpStep reschedules.
    // Returns number -> frame restoration fires, dialog returns to game caller.
    // -------------------------------------------------------------------------
    pumpCompleteThunk = (_ret: number): number | null => {
        const dialog = activeDialogs.get(dialogHwnd);
        if (!dialog || dialog.closed) {
            return completeClosedDialog(dialog ? 'EndDialog' : 'missing-dialog');
        }

        // Still open: schedule next poll iteration.
        Logger.log(LogCategory.USER32,
            `${label}: pumpCompleteThunk - callback returned 0x${_ret.toString(16)}, scheduling next pump`);
        schedulePump(0);
        return null;
    };

    // -------------------------------------------------------------------------
    // completeThunk for WM_INITDIALOG (and each CBT hook).
    // After the last CBT hook, fires WM_INITDIALOG.
    // After WM_INITDIALOG, either suppresses (dialog already closed) or starts pump.
    // -------------------------------------------------------------------------
    let cbtPhase = 0;
    const initCompleteThunk = (ret: number): number | null => {
        // Advance through any remaining CBT hooks first.
        if (cbtPhase < cbtHooks.length) {
            cbtPhase++;
            if (cbtPhase < cbtHooks.length) {
                try {
                    callbackManager.invokeCallback(
                        cbtHooks[cbtPhase].lpfn,
                        [HCBT_CREATEWND, dialogHwnd, cbtCreateWndPtr],
                        0,
                        initCompleteThunk,
                        false,
                        `${label}:CBT_${cbtPhase}`,
                        frameId,
                    );
                } catch (e) {
                    Logger.warn(LogCategory.USER32, `${label}: CBT hook ${cbtPhase} failed: ${e}`);
                    // Fall through to WM_INITDIALOG below on next completeThunk call.
                }
                return null;
            }
            // All CBT hooks done - fall through to WM_INITDIALOG.
        }
        if (cbtPhase === cbtHooks.length) {
            // Fire WM_INITDIALOG.
            cbtPhase = cbtHooks.length + 1;
            dialogInfo.dialogInitInProgress = true;
            try {
                callbackManager.invokeCallback(
                    lpDialogFunc,
                    [dialogHwnd, WM_INITDIALOG, initFocusHwnd, dwInitParam],
                    0,
                    initCompleteThunk,
                    false,
                    `${label}:WM_INITDIALOG`,
                    frameId,
                );
            } catch (e) {
                Logger.warn(LogCategory.USER32, `${label}: WM_INITDIALOG failed: ${e}`);
                dialogInfo.dialogInitInProgress = false;
                const dialog = activeDialogs.get(dialogHwnd);
                const result = dialog?.result ?? IDOK;
                activeDialogs.delete(dialogHwnd);
                restoreOwnerActivation();
                return result;
            }
            return null;
        }

        // WM_INITDIALOG has returned (cbtPhase > cbtHooks.length).
        const dialog = activeDialogs.get(dialogHwnd);
        if (!dialog || dialog.closed) {
            // Suppress case: dialog proc called EndDialog inside WM_INITDIALOG.
            return completeClosedDialog(dialog ? 'WM_INITDIALOG-EndDialog' : 'missing-dialog');
        }
        applyInitDialogFocus(dialogHwnd, ret, initFocusHwnd);

        dialogInfo.dialogInitInProgress = false;

        // Dialog is fully constructed and about to start its pump — surface it (and its
        // controls' global coords) to tooling so loops can drive launchers via
        // window.dbg.waitForEvent('dialogShow') + window.dbg.dlgClick(...).
        emitDialogShow(dialogHwnd);

        finalizeDialogPaint(dialogHwnd);
        system.windowManager.postMessage(dialogHwnd, 0x000f /* WM_PAINT */, 0, 0);

        // Start the async message pump (yields to JS event loop between callbacks).
        Logger.log(LogCategory.USER32,
            `${label}: WM_INITDIALOG complete, starting modal dialog pump for hwnd=0x${dialogHwnd.toString(16)}`);
        schedulePump(0);
        return null;  // Keep frame alive while pump runs
    };

    // -------------------------------------------------------------------------
    // Kick off: first CBT hook (if any) or straight to WM_INITDIALOG.
    // -------------------------------------------------------------------------
    let first: { callbackId: number };
    if (cbtHooks.length > 0) {
        first = callbackManager.invokeCallback(
            cbtHooks[0].lpfn,
            [HCBT_CREATEWND, dialogHwnd, cbtCreateWndPtr],
            0,
            initCompleteThunk,
            false,
            `${label}:CBT_0`,
            frameId,
        );
    } else {
        cbtPhase = cbtHooks.length; // = 0; trigger WM_INITDIALOG on first completeThunk call
        dialogInfo.dialogInitInProgress = true;
        first = callbackManager.invokeCallback(
            lpDialogFunc,
            [dialogHwnd, WM_INITDIALOG, initFocusHwnd, dwInitParam],
            0,
            initCompleteThunk,
            false,
            `${label}:WM_INITDIALOG`,
            frameId,
        );
        cbtPhase = cbtHooks.length + 1; // mark WM_INITDIALOG as in-flight
    }

    return { value: 1, suspendedForCallback: true, callbackId: first.callbackId, stackCleanup };
}

/**
 * Create a modeless dialog: allocate HWND, invoke dlgProc(WM_INITDIALOG), return HWND.
 * Used by CreateDialogParamA/W and CreateDialogIndirectParamA.
 *
 * @param lpTemplate  Guest pointer to DLGTEMPLATE (0 = use defaults)
 */
function createModelessDialog(
    ctx: any, hInstance: number, title: string, hWndParent: number,
    lpDialogFunc: number, dwInitParam: number, label: string,
    lpTemplate: number = 0,
    /** stdcall bytes the CALLING thunk pops; CreateDialogParam*'s five args by default. */
    callerStackCleanup: number = 5 * 4,
): any {
    const system = System.getInstance();
    const mem = system.process?.v86?.mem8 ?? system.process?.v86?.v86?.cpu?.mem8;

    // Parse template if pointer provided
    let parsed: ParsedDlgTemplate | null = null;
    if (lpTemplate && mem) {
        try {
            parsed = parseDlgTemplate(mem, lpTemplate);
            Logger.log(LogCategory.USER32,
                `${label}: parsed template: "${parsed.title}" ${parsed.cx}x${parsed.cy} DLU, ` +
                `${parsed.controls.length} controls, style=0x${parsed.style.toString(16)}`);
            logDlgTemplateDump(parsed, label, lpTemplate);
        } catch (e) {
            Logger.warn(LogCategory.USER32, `${label}: Failed to parse DLGTEMPLATE at 0x${lpTemplate.toString(16)}: ${e}`);
        }
    }

    const base = getDialogBaseUnits(parsed);
    const dlgStyle = parsed ? parsed.style : 0x90000000; // WS_VISIBLE | WS_POPUP
    const dlgTitle = parsed?.title || title;
    const dlgWidth  = parsed ? dluToPixelX(parsed.cx, base) : 400;
    const dlgHeight = parsed ? dluToPixelY(parsed.cy, base) : 300;
    const dialogFont = createDialogTemplateFont(parsed);

    let dlgX: number, dlgY: number;
    if (parsed) {
        const placed = placeDialogWindow(
            dlgStyle,
            dluToPixelX(parsed.x, base),
            dluToPixelY(parsed.y, base),
            dlgWidth,
            dlgHeight,
        );
        dlgX = placed.x;
        dlgY = placed.y;
    } else {
        dlgX = 0;
        dlgY = 0;
    }

    // Real Windows: CreateDialogIndirectParam/CreateDialogParam (modeless) create the
    // dialog HIDDEN unless the template specifies WS_VISIBLE. The app then shows it via
    // ShowWindow, which is when WM_SHOWWINDOW fires — HL's launcher menu loads its
    // background DIB (gfx/shell/splash.bmp) + button strip in OnShowWindow(bShow=TRUE).
    // Forcing WS_VISIBLE here swallowed that hidden->visible transition so the menu's
    // OnShowWindow never ran and the background stayed black. (DialogBox/DialogBoxParam —
    // modal — always show; that path is runModalDialog, which still forces WS_VISIBLE.)
    const templateVisible = (dlgStyle & WS_VISIBLE) !== 0;
    const dialogCreateStyle = templateVisible ? (dlgStyle | WS_VISIBLE) : (dlgStyle & ~WS_VISIBLE);

    // Create a window via WindowManager
    const prevActiveBeforeCreate = system.windowManager.getActiveHwnd();
    const hwnd = system.windowManager.createWindow(
        '#32770',  // Default dialog window class
        dlgTitle,
        dialogCreateStyle,
        parsed?.exStyle ?? 0,
        dlgX, dlgY, dlgWidth, dlgHeight,
        hWndParent, 0, hInstance, 0
    );
    const windowInfo: WindowInfo = {
        handle: hwnd,
        title: dlgTitle,
        style: dialogCreateStyle,
        exStyle: parsed?.exStyle,
        x: dlgX, y: dlgY,
        width: dlgWidth, height: dlgHeight,
        parent: hWndParent || undefined,
        children: [],
        visible: templateVisible,
        wndProc: lpDialogFunc,
        userData: 0,
        cbWndExtra: 40,
        extraBytes: new Uint32Array(10),
        nativeClassName: '#32770',
        fontHandle: dialogFont || undefined,
        dialogBaseUnitX: base.x,
        dialogBaseUnitY: base.y,
    };
    // Seed DWLP_DLGPROC (extra-byte offset 4) with the initial proc, matching the
    // Win32 dialog manager; wndProc holds the same value for message dispatch.
    if (windowInfo.extraBytes) {
        windowInfo.extraBytes[1] = lpDialogFunc >>> 0; // DWLP_DLGPROC
    }
    windows.set(hwnd, windowInfo);

    if (hWndParent) {
        const parent = windows.get(hWndParent);
        if (parent) parent.children.push(hwnd);
    }

    // Create child controls from parsed template (before WM_INITDIALOG)
    if (parsed && parsed.controls.length > 0) {
        createDialogChildren(system, hwnd, windowInfo, parsed, hInstance);
    }
    const initFocusHwnd = getInitialDialogFocus(hwnd);

    noteDialogOverlayCandidate(windowInfo);

    Logger.log(LogCategory.USER32,
        `${label}: created dialog hwnd=0x${hwnd.toString(16)} ${dlgWidth}x${dlgHeight} ` +
        `with ${windowInfo.children.length} children`);

    // Invoke dlgProc(WM_INITDIALOG) via callback, with CBT hooks first
    const callbackManager = system.process?.dispatcher?.callbackManager;
    const needsActivation = !hWndParent && system.windowManager.getActiveHwnd() === hwnd;
    if (needsActivation) {
        markPendingActivation(hwnd);
    }
    const activationSteps = needsActivation
        ? buildPendingActivationSteps(hwnd, lpDialogFunc, prevActiveBeforeCreate)
        : [];

    if (callbackManager && lpDialogFunc) {
        const cbtHooks = getHooksOfType(WH_CBT);
        const totalCbtHooks = cbtHooks.length;
        const activationCount = activationSteps.length;

        // Allocate CBT_CREATEWND if hooks exist
        let cbtCreateWndPtr = 0;
        if (totalCbtHooks > 0) {
            const createStruct = system.process!.memory.alloc(48, "HEAP", "rw");
            Mem.writeUint32(createStruct + 0, dwInitParam >>> 0);  // lpCreateParams
            cbtCreateWndPtr = system.process!.memory.alloc(8, "HEAP", "rw");
            Mem.writeUint32(cbtCreateWndPtr + 0, createStruct);
            Mem.writeUint32(cbtCreateWndPtr + 4, 0);
            Logger.log(LogCategory.USER32, `${label}: firing ${totalCbtHooks} CBT hook(s) before WM_INITDIALOG`);
        }

        const stackCleanup = callerStackCleanup;
        callbackManager.saveSuspendedThunkContext(ctx, stackCleanup);

        // Phase: CBT -> WM_INITDIALOG -> activation (top-level) -> finalize.
        // Activation must follow WM_INITDIALOG; OnActivate before init re-enters GetMessage
        // and CreateDialog never completes (HL intro/MCI never starts).
        let phase = 0;
        let activationStep = 0;
        let activationMarked = false;
        let initFocusApplied = false;
        const completeThunk = (ret: number): number | null => {
            if (phase < totalCbtHooks) {
                phase++;
                if (phase < totalCbtHooks) {
                    try {
                        callbackManager.invokeCallback(
                            cbtHooks[phase].lpfn,
                            [HCBT_CREATEWND, hwnd, cbtCreateWndPtr],
                            0,
                            completeThunk,
                        );
                        return null;
                    } catch (e) {
                        Logger.warn(LogCategory.USER32, `${label}: CBT hook ${phase} failed: ${e}`);
                    }
                }
            }

            if (phase <= totalCbtHooks) {
                phase = totalCbtHooks + 1;
                windowInfo.dialogInitInProgress = true;
                try {
                    callbackManager.invokeCallback(
                        lpDialogFunc,
                        [hwnd, WM_INITDIALOG, initFocusHwnd, dwInitParam],
                        0,
                        completeThunk,
                    );
                    return null;
                } catch (e) {
                    windowInfo.dialogInitInProgress = false;
                    Logger.warn(LogCategory.USER32, `${label}: WM_INITDIALOG invoke failed: ${e}`);
                    finalizeDialogPaint(hwnd);
                    return hwnd;
                }
            }

            if (!initFocusApplied) {
                applyInitDialogFocus(hwnd, ret, initFocusHwnd);
                initFocusApplied = true;
            }

            if (needsActivation && activationStep < activationCount && needsActivationDelivery(hwnd)) {
                windowInfo.dialogInitInProgress = false;
                if (activationStep === 0) {
                    Logger.log(LogCategory.USER32,
                        `${label}: WM_INITDIALOG returned hwnd=0x${hwnd.toString(16)}, ` +
                        `delivering activation (${activationCount} steps)`);
                }
                const step = activationSteps[activationStep]!;
                activationStep++;
                const wndProc = resolveActivationWndProc(step.hwnd, step.wndProc);
                Logger.log(LogCategory.USER32,
                    `deliverActivation[post-init]: hwnd=0x${step.hwnd.toString(16)} msg=0x${step.msg.toString(16)} ` +
                    `wParam=0x${step.wParam.toString(16)} lParam=0x${step.lParam.toString(16)} ` +
                    `wndProc=0x${wndProc.toString(16)}`);
                try {
                    callbackManager.invokeCallback(
                        wndProc,
                        [step.hwnd, step.msg, step.wParam, step.lParam],
                        0,
                        completeThunk,
                    );
                    return null;
                } catch (e) {
                    Logger.warn(LogCategory.USER32, `${label}: activation step failed: ${e}`);
                }
            }

            if (!activationMarked && activationCount > 0 && activationStep >= activationCount) {
                markActivationDelivered(hwnd);
                activationMarked = true;
            }

            windowInfo.dialogInitInProgress = false;

            // Owned dialog created visible (e.g. TS "Select Campaign" over the DDraw
            // menu): make it the active window so keyboard input reaches it. Intra-app
            // transition only — no WM_ACTIVATEAPP(0) to the game's main window.
            if (templateVisible && hWndParent && windowInfo.visible && !windowInfo.pendingDestroy) {
                activateOwnedDialog(hwnd);
            }

            finalizeDialogPaint(hwnd);
            return hwnd;
        };

        if (totalCbtHooks > 0) {
            const first = callbackManager.invokeCallback(
                cbtHooks[0].lpfn,
                [HCBT_CREATEWND, hwnd, cbtCreateWndPtr],
                0,
                completeThunk,
            );
            return { value: hwnd, suspendedForCallback: true, callbackId: first.callbackId, stackCleanup };
        }

        phase = totalCbtHooks;
        windowInfo.dialogInitInProgress = true;
        const first = callbackManager.invokeCallback(
            lpDialogFunc,
            [hwnd, WM_INITDIALOG, initFocusHwnd, dwInitParam],
            0,
            completeThunk,
        );
        phase = totalCbtHooks + 1;
        return { value: hwnd, suspendedForCallback: true, callbackId: first.callbackId, stackCleanup };
    }

    if (needsActivation) {
        postInitialActivationMessages(hwnd);
    }
    return hwnd;
}

/**
 * Resolve a resource template name to a guest memory pointer.
 * Returns 0 if the resource is not found.
 */
function resolveDialogTemplate(
    mem: Uint8Array, hInstance: number, lpTemplateName: number, isWide: boolean,
): number {
    if (!hInstance) hInstance = 0x00400000;

    const resourceName: number | string = lpTemplateName < 0x10000
        ? lpTemplateName
        : (isWide ? Marshaler.readWideString(mem, lpTemplateName) : Marshaler.readString(mem, lpTemplateName));

    const entry = findResourceInPE(mem, hInstance, 5 /* RT_DIALOG */, resourceName);
    if (!entry) return 0;

    return entry.moduleBase + entry.dataRVA;
}

export function createDialogExports(): Record<string, ThunkImplementation> {
    registerOverlayPaintRepair();
    const exports: Record<string, ThunkImplementation> = {};

    exports['GetDialogBaseUnits'] = () => {
        // Default system font dialog units for US English (8x16 pixels per 4 DLUs).
        return 8 | (16 << 16);
    };

    exports['MapDialogRect'] = (ctx, mem, args) => {
        const hDlg = args[0];
        const lpRect = args[1] >>> 0;
        if (!lpRect || lpRect + 16 > mem.length) {
            return 0;
        }

        // Wine/NT: use the dialog's own xBaseUnit/yBaseUnit; X÷4, Y÷8.
        const win = windows.get(hDlg);
        const base = {
            x: win?.dialogBaseUnitX ?? 8,
            y: win?.dialogBaseUnitY ?? 16,
        };
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        const left = dluToPixelX(view.getInt32(lpRect, true), base);
        const top = dluToPixelY(view.getInt32(lpRect + 4, true), base);
        const right = dluToPixelX(view.getInt32(lpRect + 8, true), base);
        const bottom = dluToPixelY(view.getInt32(lpRect + 12, true), base);

        view.setInt32(lpRect, left, true);
        view.setInt32(lpRect + 4, top, true);
        view.setInt32(lpRect + 8, right, true);
        view.setInt32(lpRect + 12, bottom, true);

        Logger.verbose(LogCategory.USER32,
            `MapDialogRect(0x${hDlg.toString(16)}, rect -> ${left},${top},${right},${bottom}) base=(${base.x},${base.y})`);
        return 1;
    };

    // Point-based mouse routing while live native dialogs sit over a DDraw flip
    // chain (TS "Select Campaign"): InputManager asks the WindowManager for the
    // window under the cursor; this resolver implements the dialog preference.
    System.getInstance().windowManager.registerMouseTargetResolver(resolveMouseTargetHwnd);

    registerMessageBoxExports(exports);

    /**
     * DialogBoxParamA - Creates a modal dialog box from a dialog box template resource.
     * HLE: invoke dlgProc(WM_INITDIALOG) Р В Р’В Р В РІР‚В Р В Р вЂ Р В РІР‚С™Р вЂ™Р’В Р В Р вЂ Р В РІР‚С™Р Р†РІР‚С›РЎС› dlgProc(WM_COMMAND/IDOK) Р В Р’В Р В РІР‚В Р В Р вЂ Р В РІР‚С™Р вЂ™Р’В Р В Р вЂ Р В РІР‚С™Р Р†РІР‚С›РЎС› return EndDialog result.
     */
    exports['DialogBoxParamA'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpTemplateName = args[1];
        const hWndParent = args[2];
        const lpDialogFunc = args[3];
        const dwInitParam = args[4];

        const templateId = lpTemplateName < 0x10000
            ? `#${lpTemplateName}`
            : Marshaler.readString(mem, lpTemplateName);

        Logger.log(LogCategory.USER32,
            `DialogBoxParamA(hInstance=0x${hInstance.toString(16)}, template=${templateId}, ` +
            `parent=0x${hWndParent.toString(16)}, dlgProc=0x${lpDialogFunc.toString(16)}, initParam=0x${dwInitParam.toString(16)})`);

        const templatePtr = resolveDialogTemplate(mem, hInstance, lpTemplateName, false);
        return runModalDialog(ctx, mem, hInstance, hWndParent, lpDialogFunc, dwInitParam, 'DialogBoxParamA', templatePtr);
    };

    exports['DialogBoxParamW'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpTemplateName = args[1];
        const hWndParent = args[2];
        const lpDialogFunc = args[3];
        const dwInitParam = args[4];

        const templateId = lpTemplateName < 0x10000
            ? `#${lpTemplateName}`
            : Marshaler.readWideString(mem, lpTemplateName);

        Logger.log(LogCategory.USER32,
            `DialogBoxParamW(hInstance=0x${hInstance.toString(16)}, template=${templateId}, ` +
            `dlgProc=0x${lpDialogFunc.toString(16)}, initParam=0x${dwInitParam.toString(16)})`);

        const templatePtr = resolveDialogTemplate(mem, hInstance, lpTemplateName, true);
        return runModalDialog(ctx, mem, hInstance, hWndParent, lpDialogFunc, dwInitParam, 'DialogBoxParamW', templatePtr);
    };

    /** DialogBoxIndirectParamA - same as DialogBoxParamA but with in-memory DLGTEMPLATE */
    exports['DialogBoxIndirectParamA'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpTemplate = args[1];
        const hWndParent = args[2];
        const lpDialogFunc = args[3];
        const dwInitParam = args[4];

        Logger.log(LogCategory.USER32,
            `DialogBoxIndirectParamA(hInst=0x${hInstance.toString(16)}, tmpl=0x${lpTemplate.toString(16)}, ` +
            `dlgProc=0x${lpDialogFunc.toString(16)}, initParam=0x${dwInitParam.toString(16)})`);

        return runModalDialog(ctx, mem, hInstance, hWndParent, lpDialogFunc, dwInitParam, 'DialogBoxIndirectParamA', lpTemplate);
    };

    /** DialogBoxIndirectParamW */
    exports['DialogBoxIndirectParamW'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpTemplate = args[1];
        const hWndParent = args[2];
        const lpDialogFunc = args[3];
        const dwInitParam = args[4];

        Logger.log(LogCategory.USER32,
            `DialogBoxIndirectParamW(hInst=0x${hInstance.toString(16)}, tmpl=0x${lpTemplate.toString(16)}, ` +
            `dlgProc=0x${lpDialogFunc.toString(16)}, initParam=0x${dwInitParam.toString(16)})`);

        return runModalDialog(ctx, mem, hInstance, hWndParent, lpDialogFunc, dwInitParam, 'DialogBoxIndirectParamW', lpTemplate);
    };

    /**
     * EndDialog - Destroys a modal dialog box, returns control to owner
     */
    exports['EndDialog'] = (_ctx, _mem, args) => endModalDialog(args[0], args[1]);

    /**
     * GetDlgItem - Retrieves a handle to a control in the dialog box
     */
    registerDialogItemExports(exports);

    exports['CreateDialogParamA'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpTemplateName = args[1];
        const hWndParent = args[2];
        const lpDialogFunc = args[3];
        const dwInitParam = args[4];
        const templateId = lpTemplateName < 0x10000
            ? `#${lpTemplateName}`
            : Marshaler.readString(mem, lpTemplateName);
        Logger.log(LogCategory.USER32, `CreateDialogParamA(hInst=0x${hInstance.toString(16)}, template=${templateId}, parent=0x${hWndParent.toString(16)}, dlgProc=0x${lpDialogFunc.toString(16)})`);

        // Resolve resource template to a guest memory pointer
        const templatePtr = resolveDialogTemplate(mem, hInstance, lpTemplateName, false);

        return createModelessDialog(ctx, hInstance, templateId ?? '', hWndParent, lpDialogFunc, dwInitParam, 'CreateDialogParamA', templatePtr);
    };

    exports['CreateDialogParamW'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpTemplateName = args[1];
        const hWndParent = args[2];
        const lpDialogFunc = args[3];
        const dwInitParam = args[4];
        const templateId = lpTemplateName < 0x10000
            ? `#${lpTemplateName}`
            : Marshaler.readWideString(mem, lpTemplateName);
        Logger.log(LogCategory.USER32, `CreateDialogParamW(hInst=0x${hInstance.toString(16)}, template=${templateId}, parent=0x${hWndParent.toString(16)}, dlgProc=0x${lpDialogFunc.toString(16)})`);

        const templatePtr = resolveDialogTemplate(mem, hInstance, lpTemplateName, true);

        return createModelessDialog(ctx, hInstance, templateId ?? '', hWndParent, lpDialogFunc, dwInitParam, 'CreateDialogParamW', templatePtr);
    };

    exports['CreateDialogIndirectParamA'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpTemplate = args[1];
        const hWndParent = args[2];
        const lpDialogFunc = args[3];
        const dwInitParam = args[4];
        Logger.log(LogCategory.USER32, `CreateDialogIndirectParamA(hInst=0x${hInstance.toString(16)}, tmpl=0x${lpTemplate.toString(16)}, parent=0x${hWndParent.toString(16)}, dlgProc=0x${lpDialogFunc.toString(16)})`);
        return createModelessDialog(ctx, hInstance, '#dialog', hWndParent, lpDialogFunc, dwInitParam, 'CreateDialogIndirectParamA', lpTemplate);
    };

    exports['CreateDialogIndirectParamW'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpTemplate = args[1];
        const hWndParent = args[2];
        const lpDialogFunc = args[3];
        const dwInitParam = args[4];
        Logger.log(LogCategory.USER32, `CreateDialogIndirectParamW(hInst=0x${hInstance.toString(16)}, tmpl=0x${lpTemplate.toString(16)}, parent=0x${hWndParent.toString(16)}, dlgProc=0x${lpDialogFunc.toString(16)})`);
        // DLGTEMPLATE is always UTF-16 in-memory; A/W differ only in the API entry.
        return createModelessDialog(ctx, hInstance, '#dialog', hWndParent, lpDialogFunc, dwInitParam, 'CreateDialogIndirectParamW', lpTemplate);
    };

    exports['IsDialogMessageA'] = exports['IsDialogMessageW'] = (ctx, mem, args) => {
        const hDlg = args[0];
        const lpMsg = args[1] >>> 0;
        if (!hDlg || !lpMsg || lpMsg + 16 > mem.length || !windows.has(hDlg)) {
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const hwnd = view.getUint32(lpMsg, true);
        const message = view.getUint32(lpMsg + 4, true);
        const wParam = view.getUint32(lpMsg + 8, true);

        // Wine: message must target the dialog or a child.
        if (hwnd !== hDlg && !isDescendantOfDialog(hwnd, hDlg)) {
            return 0;
        }

        Logger.verbose(LogCategory.USER32,
            `IsDialogMessage(0x${hDlg.toString(16)}, msg=0x${message.toString(16)} hwnd=0x${hwnd.toString(16)} vk=0x${wParam.toString(16)})`);

        // Keyboard navigation / default / cancel — consume (caller must not Dispatch).
        if (handleDialogKeyMessage(hDlg, message, wParam)) {
            const command = takePendingDialogCommand();
            const wndProc = windows.get(hDlg)?.wndProc ?? 0;
            const callbackManager = System.getInstance().process?.dispatcher?.callbackManager;
            if (command && wndProc && !isSentinelWndProc(wndProc) && callbackManager) {
                const thunkReturnAddr = Mem.readUint32(ctx.esp) ?? 0;
                const frameId = callbackManager.saveSuspendedThunkContext(
                    { ...ctx, returnAddr: thunkReturnAddr }, 8, 'IsDialogMessage');
                if (frameId) {
                    const invoked = callbackManager.invokeCallback(
                        wndProc,
                        [command.hwnd, WM_COMMAND, command.wParam, command.lParam],
                        0,
                        () => 1,
                        false,
                        'IsDialogMessage:WM_COMMAND',
                        frameId,
                    );
                    if (invoked.callbackId) {
                        return {
                            value: 1,
                            suspendedForCallback: true,
                            callbackId: invoked.callbackId,
                            stackCleanup: 8,
                            skipStackCheck: true,
                        };
                    }
                }
            }
            return 1;
        }

        // Other messages: return FALSE so the app's TranslateMessage/DispatchMessage
        // delivers them (equivalent end-state to Wine's internal dispatch + TRUE).
        return 0;
    };

    exports['GetDlgCtrlID'] = (ctx, mem, args) => {
        const hWnd = args[0];
        Logger.verbose(LogCategory.USER32, `GetDlgCtrlID(0x${hWnd.toString(16)})`);
        const win = windows.get(hWnd);
        return win?.controlId ?? 0;
    };

    exports['GetNextDlgTabItem'] = (ctx, mem, args) => {
        const hDlg = args[0];
        const hCtl = args[1];
        const bPrevious = !!args[2];
        Logger.verbose(LogCategory.USER32, `GetNextDlgTabItem(0x${hDlg.toString(16)}, 0x${hCtl.toString(16)}, ${bPrevious})`);
        return getNextDialogControl(hDlg, hCtl, bPrevious, true);
    };

    exports['GetNextDlgGroupItem'] = (ctx, mem, args) => {
        const hDlg = args[0];
        const hCtl = args[1];
        const bPrevious = !!args[2];
        Logger.verbose(LogCategory.USER32, `GetNextDlgGroupItem(0x${hDlg.toString(16)}, 0x${hCtl.toString(16)}, ${bPrevious})`);
        return getNextDialogGroupItem(hDlg, hCtl, bPrevious);
    };

    /**
     * The half of DefDlgProc that runs when the dialog procedure declined the message —
     * Wine's DEFDLG_Proc plus the DefWindowProc fallback it ends in.
     */
    const defDlgDefaultProcessing = (ctx: any, mem: Uint8Array, args: number[]): number | ThunkResult => {
        const hDlg = args[0];
        const Msg = args[1];
        const wParam = args[2];
        const lParam = args[3];

        if (Msg === WM_PAINT) {
            Logger.log(LogCategory.USER32, `DefDlgProc(0x${hDlg.toString(16)}, WM_PAINT)`);
        } else {
            Logger.verbose(LogCategory.USER32,
                `DefDlgProc(0x${hDlg.toString(16)}, 0x${Msg.toString(16)}, 0x${wParam.toString(16)}, 0x${lParam.toString(16)})`);
        }

        const WM_ERASEBKGND = 0x0014;
        const WM_SETFONT = 0x0030;
        const WM_GETFONT = 0x0031;
        const DM_GETDEFID = 0x0400;
        const DM_SETDEFID = 0x0401;
        if (Msg === WM_PAINT) {
            // Real DefDlgProc bottoms out in DefWindowProc: BeginPaint (which sends
            // WM_ERASEBKGND back to the dialog's own proc) then EndPaint. Only when the
            // guest has no proc left to answer that do we fall back to drawing the
            // dialog's chrome ourselves.
            // Once only: runDefaultWindowPaint calls this itself when the window's own
            // paint reached the overlay with nothing, and returns null on the paths that
            // never got that far — so both callers have to be able to ask for it.
            let chromeDrawn = false;
            const paintDialogChrome = (): void => {
                if (chromeDrawn) return;
                chromeDrawn = true;
                const w = windows.get(hDlg);
                if (w && !w.guestCustomPaint) paintDialogToOverlay(hDlg, 'full');
            };
            const paint = runDefaultWindowPaint(ctx, mem, hDlg, 'DefDlgProc', 16, paintDialogChrome);
            if (paint) return paint;
            paintDialogChrome();
            return 0;
        }
        if (Msg === WM_NEXTDLGCTL) {
            // Wine DEFDLG_Proc: lParam=0 → GetNextDlgTabItem(focus, wParam=fPrevious);
            // lParam≠0 → wParam is destination HWND.
            const system = System.getInstance();
            let dest = wParam >>> 0;
            if (!lParam) {
                const focus = system.windowManager.getFocusHwnd();
                const cur = (focus && focus !== hDlg && isDescendantOfDialog(focus, hDlg)) ? focus : 0;
                dest = getNextDialogControl(hDlg, cur, !!wParam, true);
            }
            if (dest && windows.has(dest)) {
                system.windowManager.setFocus(dest);
                const destWin = windows.get(dest);
                if (destWin?.controlId !== undefined) {
                    const dlg = windows.get(hDlg);
                    if (dlg
                        && (destWin.systemControlClass ?? '').toLowerCase() === 'button'
                        && ((destWin.style & BS_TYPEMASK) === BS_PUSHBUTTON
                            || (destWin.style & BS_TYPEMASK) === BS_DEFPUSHBUTTON)) {
                        dlg.dialogDefaultId = destWin.controlId;
                    }
                }
            }
            return 0;
        }
        if (Msg === WM_CLOSE) {
            // Wine: PostMessage(WM_COMMAND, IDCANCEL, GetDlgItem(IDCANCEL))
            const cancel = findChildByControlId(hDlg, IDCANCEL);
            System.getInstance().windowManager.postMessage(
                hDlg, WM_COMMAND, IDCANCEL | (BN_CLICKED << 16), cancel?.handle ?? 0);
            System.getInstance().scheduler.wakeMessageWaiters();
            return 0;
        }
        if (Msg === WM_SETFONT) {
            const win = windows.get(hDlg);
            if (win) {
                win.fontHandle = wParam >>> 0;
                for (const childHwnd of win.children) {
                    const child = windows.get(childHwnd);
                    if (child?.isSystemControl) child.fontHandle = win.fontHandle;
                }
                if (lParam) repaintDialogAfterContentChange(hDlg);
            }
            return 0;
        }
        if (Msg === WM_GETFONT) {
            return windows.get(hDlg)?.fontHandle ?? 0;
        }
        if (Msg === DM_SETDEFID) {
            const win = windows.get(hDlg);
            if (win) win.dialogDefaultId = wParam | 0;
            return 1;
        }
        if (Msg === DM_GETDEFID) {
            const id = windows.get(hDlg)?.dialogDefaultId ?? 0;
            return id ? ((0x534b << 16) | (id & 0xFFFF)) >>> 0 : 0;
        }
        if (Msg === WM_ERASEBKGND && wParam) {
            // Fill the dialog background with the system button face.
            const win = windows.get(hDlg);
            if (win) {
                const gdi = System.getInstance().gdiContext;
                const hBrush = gdi.createSolidBrush(dlgFaceColorRef());
                const prevBrush = gdi.selectObject(wParam, hBrush);
                gdi.fillRect(wParam, 0, 0, win.width, win.height);
                gdi.selectObject(wParam, prevBrush);
                gdi.deleteObject(hBrush);
            }
            return 1;
        }

        return 0; // Default processing
    };

    /**
     * Messages whose answer is the dialog procedure's own BOOL rather than DWLP_MSGRESULT
     * (Wine defdlg.c, USER_DefDlgProc epilogue).
     */
    const answersWithDlgProcResult = (Msg: number): boolean =>
        (Msg >= WM_CTLCOLORMSGBOX && Msg <= WM_CTLCOLORSTATIC)
        || Msg === WM_CTLCOLOR16 || Msg === WM_COMPAREITEM || Msg === WM_VKEYTOITEM
        || Msg === WM_CHARTOITEM || Msg === WM_QUERYDRAGICON || Msg === WM_INITDIALOG;

    /** Messages the dialog manager must NOT default-process when the DlgProc declines. */
    const NO_DEFAULT_PROCESSING = new Set(
        [WM_INITDIALOG, WM_VKEYTOITEM, WM_COMPAREITEM, WM_CHARTOITEM]);

    /** hwnd:msg:wParam:lParam of a DlgProc call in flight — a DlgProc that itself calls
     *  DefDlgProc would otherwise recurse until the callback pool is exhausted. */
    const dlgProcInFlight = new Set<string>();

    /**
     * DefDlgProc — the window procedure of the `#32770` class, and the ONLY route to a
     * subclassed dialog's DlgProc. Win32 keeps the app's procedure in DWLP_DLGPROC and
     * calls it from here; when it answers FALSE, the dialog manager's own default
     * processing runs (Wine defdlg.c USER_DefDlgProcA). A subclasser (MFC's AfxWndProc,
     * a skinning library, a raw SetWindowLong) saves the address GWL_WNDPROC reported and
     * CallWindowProc's it for everything it does not consume — so without this call the
     * app's DlgProc never sees WM_COMMAND at all, and a dialog whose Cancel/OK handler
     * lives there can never be dismissed.
     */
    const defDlgProc = (ctx: any, mem: Uint8Array, args: number[]): number | ThunkResult => {
        const hDlg = args[0] >>> 0;
        const Msg = args[1] >>> 0;
        const wParam = args[2] >>> 0;
        const lParam = args[3] >>> 0;

        const win = windows.get(hDlg);
        const dlgProc = (win?.extraBytes?.[1] ?? 0) >>> 0;
        // NT clears DWLP_MSGRESULT before the dialog procedure runs; the epilogue reads
        // back whatever the procedure stored there.
        if (win?.extraBytes) win.extraBytes[0] = 0;

        const finish = (dlgResult: number): number | ThunkResult => {
            if (!dlgResult && windows.has(hDlg)) {
                if (!NO_DEFAULT_PROCESSING.has(Msg)) return defDlgDefaultProcessing(ctx, mem, args);
            }
            if (answersWithDlgProcResult(Msg)) return dlgResult >>> 0;
            return (windows.get(hDlg)?.extraBytes?.[0] ?? 0) >>> 0;
        };

        // WM_PAINT's default processing is itself a multi-step guest sequence (erase +
        // owner-draw chain) that has to own THIS thunk's return path, so it cannot run
        // from another callback's completion — the dialog then composites empty. The
        // dialog procedure still receives WM_PAINT through normal dispatch; only the
        // DefDlgProc → DWLP_DLGPROC hop for it is ours to skip.
        if (Msg === WM_PAINT) return defDlgDefaultProcessing(ctx, mem, args);

        // Our dispatch calls a dialog's DlgProc directly while it is still the window
        // proc, so only the subclassed case — where DWLP_DLGPROC is the sole remaining
        // route to it — is called from here; otherwise every message would arrive twice.
        const callbackManager = System.getInstance().process?.dispatcher?.callbackManager;
        const key = `${hDlg}:${Msg}:${wParam}:${lParam}`;
        if (dlgProc && dlgProc !== ((win?.wndProc ?? 0) >>> 0)
            && !isSentinelWndProc(dlgProc) && callbackManager && !dlgProcInFlight.has(key)) {
            const stackCleanup = 16;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const returnAddr = view.getUint32(ctx.esp, true) >>> 0;
            dlgProcInFlight.add(key);
            const invoked = callbackManager.invokeCallback(
                dlgProc, [hDlg, Msg, wParam, lParam], 0, undefined, false, 'DefDlgProc:DlgProc',
                undefined,
                {
                    // A nested guest call, like CallWindowProc: resume where this thunk's
                    // own RET N would have, without consuming an outer callback frame.
                    directThunkReturn: {
                        returnAddr,
                        postEsp: (ctx.esp + 4 + stackCleanup) >>> 0,
                        complete: (ret: number): number | null => {
                            dlgProcInFlight.delete(key);
                            const out = finish(ret >>> 0);
                            // Default processing that suspended for guest callbacks of
                            // its own owns the resume from here.
                            return typeof out === 'number' ? out >>> 0 : null;
                        },
                    },
                },
            );
            if (invoked.callbackId) {
                return {
                    value: 0,
                    suspendedForCallback: true,
                    callbackId: invoked.callbackId,
                    stackCleanup,
                    skipStackCheck: true,
                    preserveCallbackReturnAddress: true,
                };
            }
            dlgProcInFlight.delete(key);
        }

        return finish(0);
    };

    exports['DefDlgProcA'] = defDlgProc;
    exports['DefDlgProcW'] = defDlgProc;

    return exports;
}

/**
 * Check if a WndProc value is a sentinel (system control, not a real x86 address).
 * Legacy check Р В Р’В Р В РІР‚В Р В Р’В Р Р†Р вЂљРЎв„ўР В Р вЂ Р В РІР‚С™Р РЋРЎС™ system controls now use DefWindowProcA thunk addresses instead.
 * Kept for safety: any wndProc in 0xFFFF0000-0xFFFFFFFF is definitely not valid x86 code.
 */
/**
 * EndDialog's whole effect, callable from HLE code that owns a modal dialog of
 * its own (comctl32's property sheet). One definition so the sheet's OK/Cancel
 * and the guest's EndDialog cannot diverge.
 */
export function endModalDialog(hDlg: number, nResult: number): number {
    Logger.log(LogCategory.USER32, `EndDialog(0x${hDlg.toString(16)}, result=${nResult})`);

    const dialog = activeDialogs.get(hDlg);
    if (dialog) {
        dialog.result = nResult;
        dialog.closed = true;
        // Wine/NT: re-enable owner immediately in EndDialog.
        if (dialog.disabledOwner) {
            setWindowEnabled(dialog.disabledOwner, true);
            dialog.disabledOwner = undefined;
        }
    }

    const dialogInfo = windows.get(hDlg);
    if (dialogInfo) {
        resetControlInteractionState();
        const ownerHwnd = dialogInfo.parent ?? 0;
        if (ownerHwnd) {
            markPendingActivation(ownerHwnd);
        }

        // NT EndDialog: SWP_HIDEWINDOW before the modal loop tears down.
        dialogInfo.visible = false;
        const wmWin = System.getInstance().windowManager.getWindow(hDlg);
        if (wmWin) wmWin.visible = false;
        eraseDialogOverlay(hDlg);

        // Do not destroy HWND yet. Win32 lets the current DLGPROC keep
        // using its controls after EndDialog; teardown starts after it returns.
        Logger.log(LogCategory.USER32,
            `EndDialog: modal teardown deferred for 0x${hDlg.toString(16)}`);
    }
    return 1; // TRUE
}

/** True while `hDlg` is a modal dialog this manager is pumping. */
export function isModalDialogActive(hDlg: number): boolean {
    const dialog = activeDialogs.get(hDlg);
    return !!dialog && !dialog.closed;
}

/**
 * Create a MODELESS dialog straight from a DLGTEMPLATE, for an HLE module that
 * builds its own frame. Returns the HWND to the calling thunk once WM_INITDIALOG
 * and the activation chain have run — the app's own message loop drives it from
 * there (comctl32's PSH_MODELESS sheet, which is how MFC always creates one).
 */
export function createModelessDialogFromTemplate(
    ctx: any,
    hInstance: number,
    hWndParent: number,
    lpDialogFunc: number,
    dwInitParam: number,
    label: string,
    lpTemplate: number,
    callerStackCleanup: number,
): any {
    return createModelessDialog(
        ctx, hInstance, '', hWndParent, lpDialogFunc, dwInitParam,
        label, lpTemplate, callerStackCleanup,
    );
}

/**
 * Run a modal dialog straight from a DLGTEMPLATE in guest memory, for an HLE
 * module that builds its own frame (comctl32's PropertySheet). Same engine as
 * DialogBoxIndirectParam — there is deliberately no second modal pump.
 */
export function runModalDialogFromTemplate(
    ctx: any,
    mem: Uint8Array,
    hInstance: number,
    hWndParent: number,
    lpDialogFunc: number,
    dwInitParam: number,
    label: string,
    lpTemplate: number,
    callerStackCleanup: number,
): any {
    return runModalDialog(
        ctx, mem, hInstance, hWndParent, lpDialogFunc, dwInitParam,
        label, lpTemplate, callerStackCleanup,
    );
}

export function isSentinelWndProc(wndProc: number): boolean {
    return (wndProc & 0xFFFF0000) === 0xFFFF0000;
}
