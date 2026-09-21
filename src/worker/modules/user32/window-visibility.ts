/**
 * The dialog manager's show step.
 *
 * Win32 creates a dialog hidden, runs WM_INITDIALOG on it, and then shows it —
 * DialogBox* always, CreateDialog* when the template carries WS_VISIBLE. Showing is
 * SetWindowPos(SWP_SHOWWINDOW), so the hidden->visible transition owes the window
 * WM_SHOWWINDOW(TRUE); apps hang real work off it (HL's launcher loads the menu's
 * background DIB there). ShowWindow/SetWindowPos own the general case; this is the
 * one path USER runs on the dialog manager's behalf.
 */
import { System } from '../../core/system';
import { windows } from './shared-state';
import { noteDialogOverlayCandidate } from './dialog-overlay';

const WS_VISIBLE = 0x10000000;
const WS_CHILD = 0x40000000;
const WM_SHOWWINDOW = 0x0018;
const HWND_TOP = 0;

/**
 * Show `hwnd` and announce the transition. Returns false when it was already visible —
 * Windows sends WM_SHOWWINDOW only on a change, and a spurious one re-runs the app's
 * show-time work.
 */
export function showDialogWindow(hwnd: number): boolean {
    const win = windows.get(hwnd);
    if (!win || win.visible) return false;

    win.visible = true;
    win.style |= WS_VISIBLE;

    const wm = System.getInstance().windowManager;
    const wmWin = wm.getWindow(hwnd);
    if (wmWin) wmWin.visible = true;
    if ((win.style & WS_CHILD) === 0) wm.setWindowZOrder(hwnd, HWND_TOP);

    // A dialog reaching the screen while the game owns it is a live overlay.
    noteDialogOverlayCandidate(win);
    wm.postMessage(hwnd, WM_SHOWWINDOW, 1, 0);
    return true;
}
