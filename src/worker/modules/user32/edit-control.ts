/**
 * EDIT control: EM_* protocol + WM_CHAR/WM_KEYDOWN text editing over the
 * JS-driven system-control machinery. Text lives in WindowInfo.title (the
 * WM_SETTEXT/WM_GETTEXT contract); this module owns selection/caret/limit
 * state and the EN_* parent notifications. Semantics follow classic user32
 * (Wine edit.c) for the single-line core; multiline is line-split basic.
 */

import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { WindowInfo, windows, registerControlStatePurger } from './shared-state';
import { getClipboardText, setClipboardText } from './clipboard-text';
import { readAnsiOrWideFromGuest, encodeAnsi } from '../codepage-utils';

// ES_* styles
const ES_MULTILINE = 0x0004;
const ES_UPPERCASE = 0x0008;
const ES_LOWERCASE = 0x0010;
const ES_PASSWORD = 0x0020;
const ES_READONLY = 0x0800;
const ES_WANTRETURN = 0x1000;
const ES_NUMBER = 0x2000;
const WS_DISABLED = 0x08000000;

// EM_* messages
const EM_GETSEL = 0x00B0;
const EM_SETSEL = 0x00B1;
const EM_UNDO = 0x00C7;
const EM_SCROLLCARET = 0x00B7;
const EM_GETMODIFY = 0x00B8;
const EM_SETMODIFY = 0x00B9;
const EM_GETLINECOUNT = 0x00BA;
const EM_LINEINDEX = 0x00BB;
const EM_LINELENGTH = 0x00C1;
const EM_REPLACESEL = 0x00C2;
const EM_GETLINE = 0x00C4;
const EM_LIMITTEXT = 0x00C5; // == EM_SETLIMITTEXT
const EM_CANUNDO = 0x00C6;
const EM_EMPTYUNDOBUFFER = 0x00CD;
const EM_GETFIRSTVISIBLELINE = 0x00CE;
const EM_SETREADONLY = 0x00CF;
const EM_SETPASSWORDCHAR = 0x00CC;
const EM_GETPASSWORDCHAR = 0x00D2;
const EM_GETLIMITTEXT = 0x00D5;

const WM_SETTEXT = 0x000C;
const WM_SETFOCUS = 0x0007;
const WM_KILLFOCUS = 0x0008;
const WM_CHAR = 0x0102;
const WM_KEYDOWN = 0x0100;
const WM_COMMAND = 0x0111;
const WM_CUT = 0x0300;
const WM_COPY = 0x0301;
const WM_PASTE = 0x0302;
const WM_CLEAR = 0x0303;
const WM_UNDO = 0x0304;

// Virtual keys handled in WM_KEYDOWN
const VK_SHIFT = 0x10;
const VK_END = 0x23;
const VK_HOME = 0x24;
const VK_LEFT = 0x25;
const VK_RIGHT = 0x27;
const VK_DELETE = 0x2E;

// EN_* notification codes
const EN_SETFOCUS = 0x0100;
const EN_KILLFOCUS = 0x0200;
const EN_CHANGE = 0x0300;
const EN_UPDATE = 0x0400;
const EN_MAXTEXT = 0x0501;

/** Default text limit when the app never calls EM_LIMITTEXT (classic user32). */
const DEFAULT_LIMIT = 0x7FFFFFFE;

interface EditState {
    /** Selection anchor. Caret is selEnd; selStart===selEnd means no selection. */
    selStart: number;
    selEnd: number;
    limit: number;
    modified: boolean;
    passwordChar: number;
    /** Single-line horizontal scroll, in pixels of text hidden left of the inset. */
    scrollX: number;
    /** Single-level undo (Wine edit.c model): the text deleted at undoPos plus the
     *  number of chars inserted there. Undo re-selects the insertion and puts the
     *  deletion back, which rebuilds the inverse record — so undo is its own redo. */
    undoText: string;
    undoPos: number;
    undoInsertCount: number;
}

const editStates = new Map<number, EditState>();

// Registered lazily: shared-state sits in an import cycle with this module
// (shared-state → owner-draw → controls → edit-control), so a top-level call
// would hit its consts in TDZ.
let purgerRegistered = false;

function getOrCreateEditState(child: WindowInfo): EditState {
    if (!purgerRegistered) {
        purgerRegistered = true;
        registerControlStatePurger((hwnd) => editStates.delete(hwnd));
    }
    let state = editStates.get(child.handle);
    if (!state) {
        state = {
            selStart: 0,
            selEnd: 0,
            limit: DEFAULT_LIMIT,
            modified: false,
            // Sampled once, like the real control's es->password_char / ped->charPasswordChar:
            // only EM_SETPASSWORDCHAR changes it afterwards, a later style change does not.
            passwordChar: (child.style & ES_PASSWORD) !== 0 ? 0x2A /* '*' */ : 0,
            scrollX: 0,
            undoText: '',
            undoPos: 0,
            undoInsertCount: 0,
        };
        editStates.set(child.handle, state);
    }
    return state;
}

/** Caret/selection/password/scroll info for the painter (controls.ts). */
export function getEditVisualState(child: WindowInfo): {
    selStart: number; selEnd: number; focused: boolean; passwordChar: number; scrollX: number;
} {
    const state = getOrCreateEditState(child);
    const len = child.title.length;
    return {
        selStart: Math.min(state.selStart, len),
        selEnd: Math.min(state.selEnd, len),
        focused: System.getInstance().windowManager.getFocusHwnd() === child.handle,
        passwordChar: state.passwordChar,
        scrollX: state.scrollX,
    };
}

// Measurement context for caret-from-click hit testing (font mirrors the painter's
// getWindowFont fallback in controls.ts).
const DEFAULT_CONTROL_FONT = "11px 'Liberation Sans', sans-serif";
let measureCtx: OffscreenCanvasRenderingContext2D | null = null;

function getMeasureCtx(child: WindowInfo): OffscreenCanvasRenderingContext2D | null {
    // Text metrics are optional: without a canvas (non-DOM host) hit testing and
    // scrolling fall back to "no scroll", they never fail the message.
    if (!measureCtx && typeof OffscreenCanvas !== 'undefined') {
        measureCtx = new OffscreenCanvas(1, 1).getContext('2d');
    }
    if (measureCtx) {
        const parent = child.parent !== undefined ? windows.get(child.parent) : undefined;
        const hFont = child.fontHandle || parent?.fontHandle || 0;
        measureCtx.font = (hFont
            ? System.getInstance().gdiContext.getFontCss(hFont)
            : null) ?? DEFAULT_CONTROL_FONT;
    }
    return measureCtx;
}

/** Text inset paintEdit draws at, on both sides of the client rect. */
export const EDIT_TEXT_INSET = 4;

/** Text as PAINTED: password masking applies to hit testing and scrolling too. */
function displayText(child: WindowInfo, state: EditState): string {
    return state.passwordChar
        ? String.fromCharCode(state.passwordChar).repeat(child.title.length)
        : child.title;
}

/** Place the caret at the clicked pixel (x relative to the control); clears selection. */
export function setEditCaretFromPoint(child: WindowInfo, localX: number): void {
    const state = getOrCreateEditState(child);
    const text = displayText(child, state);
    const ctx = getMeasureCtx(child);
    let pos = text.length;
    if (ctx) {
        const target = localX - EDIT_TEXT_INSET + state.scrollX;
        pos = 0;
        while (pos < text.length) {
            const w = ctx.measureText(text.slice(0, pos + 1)).width;
            const wPrev = ctx.measureText(text.slice(0, pos)).width;
            if (target < (wPrev + w) / 2) break;
            pos++;
        }
    }
    state.selStart = pos;
    state.selEnd = pos;
    ensureCaretVisible(child, state);
}

/**
 * EM_SCROLLCARET for a single-line edit: scroll horizontally so the caret stays in
 * the client rect. Without it a caret past the right edge keeps typing into the clip
 * region and the user sees a frozen box.
 */
function ensureCaretVisible(child: WindowInfo, state: EditState): void {
    if ((child.style & ES_MULTILINE) !== 0) {
        state.scrollX = 0;
        return;
    }
    const ctx = getMeasureCtx(child);
    if (!ctx) return;
    const text = displayText(child, state);
    const caret = clamp(state.selEnd, 0, text.length);
    const avail = Math.max(1, child.width - EDIT_TEXT_INSET * 2);
    const caretX = ctx.measureText(text.slice(0, caret)).width;
    const totalX = ctx.measureText(text).width;

    if (caretX - state.scrollX > avail) state.scrollX = caretX - avail;
    else if (caretX < state.scrollX) state.scrollX = caretX;
    state.scrollX = clamp(state.scrollX, 0, Math.max(0, totalX - avail));
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

// Win32 SENDS EN_* from inside the control's own processing, so the parent's handler has
// run by the time SendMessage returns. We POST: entering a guest wndproc means suspending
// a thunk, which this synchronous LRESULT sink cannot do.
function postEditNotify(child: WindowInfo, code: number): void {
    if (!child.parent) return;
    const system = System.getInstance();
    const wParam = ((code << 16) | ((child.controlId ?? 0) & 0xFFFF)) >>> 0;
    system.windowManager.postMessage(child.parent, WM_COMMAND, wParam, child.handle);
    system.scheduler.wakeMessageWaiters();
}

function notifyTextChanged(child: WindowInfo): void {
    postEditNotify(child, EN_UPDATE);
    postEditNotify(child, EN_CHANGE);
}

function applyCaseStyle(child: WindowInfo, s: string): string {
    if ((child.style & ES_UPPERCASE) !== 0) return s.toUpperCase();
    if ((child.style & ES_LOWERCASE) !== 0) return s.toLowerCase();
    return s;
}

function filterInsertable(child: WindowInfo, s: string): string {
    let out = applyCaseStyle(child, s);
    if ((child.style & ES_NUMBER) !== 0) out = out.replace(/[^0-9]/g, '');
    if ((child.style & ES_MULTILINE) === 0) out = out.replace(/[\r\n]/g, '');
    return out;
}

function emptyUndoBuffer(state: EditState): void {
    state.undoText = '';
    state.undoInsertCount = 0;
}

/** Fold one replacement into the single undo record (Wine EDIT_EM_ReplaceSel). */
function recordUndo(state: EditState, start: number, deleted: string, inserted: number): void {
    if (deleted) {
        if (!state.undoInsertCount && state.undoText && start === state.undoPos) {
            state.undoText += deleted;               // deletion extends to the right
        } else if (!state.undoInsertCount && state.undoText && start + deleted.length === state.undoPos) {
            state.undoText = deleted + state.undoText; // …to the left
            state.undoPos = start;
        } else {
            state.undoText = deleted;
            state.undoPos = start;
        }
        state.undoInsertCount = 0; // any deletion invalidates the insertion record
    }
    if (inserted) {
        if (start === state.undoPos
            || (state.undoInsertCount && start === state.undoPos + state.undoInsertCount)) {
            state.undoInsertCount += inserted;
        } else {
            state.undoPos = start;
            state.undoInsertCount = inserted;
            state.undoText = '';
        }
    }
}

/**
 * Replace the current selection with `insert`, honoring the text limit.
 * Returns true if the text changed.
 */
function replaceSelection(
    child: WindowInfo, insert: string, notify: boolean, canUndo: boolean = true,
): boolean {
    const state = getOrCreateEditState(child);
    const text = child.title;
    const start = clamp(Math.min(state.selStart, state.selEnd), 0, text.length);
    const end = clamp(Math.max(state.selStart, state.selEnd), 0, text.length);

    let filtered = filterInsertable(child, insert);
    const room = state.limit - (text.length - (end - start));
    if (filtered.length > room) {
        filtered = filtered.slice(0, Math.max(0, room));
        postEditNotify(child, EN_MAXTEXT);
    }
    if (start === end && !filtered.length) return false;

    if (canUndo) recordUndo(state, start, text.slice(start, end), filtered.length);
    else emptyUndoBuffer(state);

    child.title = text.slice(0, start) + filtered + text.slice(end);
    const caret = start + filtered.length;
    state.selStart = caret;
    state.selEnd = caret;
    state.modified = true;
    ensureCaretVisible(child, state);
    if (notify) notifyTextChanged(child);
    return true;
}

function deleteRange(child: WindowInfo, from: number, to: number): boolean {
    const state = getOrCreateEditState(child);
    state.selStart = clamp(Math.min(from, to), 0, child.title.length);
    state.selEnd = clamp(Math.max(from, to), 0, child.title.length);
    return replaceSelection(child, '', true);
}

/** EM_UNDO / WM_UNDO: put the deleted text back over the inserted range. */
function undoEdit(child: WindowInfo, state: EditState): boolean {
    // MSDN/Wine: a read-only single-line edit still answers TRUE.
    if (isReadOnly(child)) return (child.style & ES_MULTILINE) === 0;
    const restore = state.undoText;
    const pos = state.undoPos;
    setSelection(child, state, pos, pos + state.undoInsertCount);
    emptyUndoBuffer(state);
    replaceSelection(child, restore, true);
    setSelection(child, state, pos, pos + state.undoInsertCount);
    return true;
}

/** EM_SETSEL: out-of-order endpoints swap and both clamp (NT5 EditSL_ChangeSelection);
 *  the caret then sits at the end of the selection. */
function setSelection(child: WindowInfo, state: EditState, start: number, end: number): void {
    const len = child.title.length;
    let lo = clamp(start, 0, len);
    let hi = clamp(end, 0, len);
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    state.selStart = lo;
    state.selEnd = hi;
    ensureCaretVisible(child, state);
}

function isReadOnly(child: WindowInfo): boolean {
    return (child.style & (ES_READONLY | WS_DISABLED)) !== 0;
}

function textLines(child: WindowInfo): string[] {
    return (child.style & ES_MULTILINE) !== 0
        ? child.title.split(/\r\n|\n|\r/g)
        : [child.title];
}

/** Per-line char offsets into child.title, honoring the ACTUAL separator widths
 *  (guest-set text may use lone \n or \r, not just \r\n). */
function lineStartOffsets(child: WindowInfo): number[] {
    if ((child.style & ES_MULTILINE) === 0) return [0];
    const offsets = [0];
    const re = /\r\n|\n|\r/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(child.title)) !== null) {
        offsets.push(m.index + m[0].length);
    }
    return offsets;
}

function lineStartIndex(child: WindowInfo, line: number): number {
    const offsets = lineStartOffsets(child);
    if (line >= offsets.length) return -1;
    return offsets[line];
}

function lineFromCharIndex(child: WindowInfo, charIndex: number): number {
    const offsets = lineStartOffsets(child);
    for (let i = offsets.length - 1; i >= 0; i--) {
        if (charIndex >= offsets[i]) return i;
    }
    return 0;
}

/**
 * WM_SETTEXT body, taking the text already decoded: SetDlgItemText/SetWindowText are
 * SendMessage(WM_SETTEXT) on Win32 and must not bypass the style filtering, limit,
 * caret reset and EN_* notifications by assigning WindowInfo.title.
 */
export function setEditControlText(child: WindowInfo, text: string): void {
    const state = getOrCreateEditState(child);
    // Case styles apply (Wine EDIT_EM_ReplaceSel); the text LIMIT does not — it bounds
    // what the USER may type, never what WM_SETTEXT puts in (EM_SETLIMITTEXT docs).
    let next = applyCaseStyle(child, text);
    if ((child.style & ES_MULTILINE) === 0) {
        const brk = next.search(/[\r\n]/);
        if (brk >= 0) next = next.slice(0, brk);
    }
    child.title = next;
    state.selStart = 0;
    state.selEnd = 0;
    state.scrollX = 0;
    state.modified = false;
    emptyUndoBuffer(state);
    // Wine EDIT_WM_SetText: a multiline (or combobox-owned) edit stays silent.
    if ((child.style & ES_MULTILINE) === 0) notifyTextChanged(child);
}

/**
 * EM_* / editing-key sink for EDIT system controls. Returns the LRESULT, or
 * null when the message is not edit-specific (generic handling applies).
 */
export function handleEditMessage(
    child: WindowInfo, msg: number, wParam: number, lParam: number, mem: Uint8Array,
    /** Text width of the ENTRY POINT the message arrived through, when it is known.
     *  `"5 A   "` and `L"5A"` are the same bytes, so a probe can never separate
     *  them — only the A/W entry can. Undefined keeps the heuristic. */
    textWidth?: 'ansi' | 'wide',
): number | null {
    const state = getOrCreateEditState(child);
    const len = () => child.title.length;

    switch (msg) {
        case EM_GETSEL: {
            // Clamp on READ as well: the text can shrink under a stored selection
            // (WM_SETTEXT from another path, EM_LIMITTEXT truncation).
            const start = clamp(Math.min(state.selStart, state.selEnd), 0, len());
            const end = clamp(Math.max(state.selStart, state.selEnd), 0, len());
            if (wParam) Mem.writeUint32(wParam, start);
            if (lParam) Mem.writeUint32(lParam, end);
            return (((end & 0xFFFF) << 16) | (start & 0xFFFF)) >>> 0;
        }
        case EM_SETSEL: {
            const start = wParam | 0;
            const end = lParam | 0;
            if (start === -1) {
                // Deselect; caret stays at current end.
                setSelection(child, state, state.selEnd, state.selEnd);
            } else {
                setSelection(child, state, start, end === -1 ? len() : end);
            }
            return 1;
        }
        case EM_SCROLLCARET:
            ensureCaretVisible(child, state);
            return 1;
        case EM_GETMODIFY:
            return state.modified ? 1 : 0;
        case EM_SETMODIFY:
            state.modified = !!wParam;
            return 0;
        case EM_GETLINECOUNT:
            return Math.max(1, textLines(child).length);
        case EM_LINEINDEX: {
            const line = (wParam | 0) === -1 ? lineFromCharIndex(child, state.selEnd) : (wParam | 0);
            return lineStartIndex(child, line);
        }
        case EM_LINELENGTH: {
            const charIndex = (wParam | 0) === -1 ? state.selEnd : (wParam | 0);
            const lines = textLines(child);
            return lines[lineFromCharIndex(child, clamp(charIndex, 0, len()))]?.length ?? 0;
        }
        case EM_GETLINE: {
            if (!lParam) return 0;
            const lines = textLines(child);
            const line = wParam | 0;
            if (line < 0 || line >= lines.length) return 0;
            // First WORD of the buffer holds its capacity in chars (Win32 contract).
            const cap = Mem.readUint16(lParam) ?? 0;
            const encoded = encodeAnsi(lines[line]).subarray(0, cap);
            if (encoded.length > 0) Mem.writeBytes(lParam, encoded);
            return encoded.length;
        }
        case EM_REPLACESEL: {
            if (isReadOnly(child)) return 0;
            const insert = lParam ? readAnsiOrWideFromGuest(mem, lParam, textWidth) : '';
            replaceSelection(child, insert, true, wParam !== 0); // wParam = fCanUndo
            return 1;
        }
        case EM_LIMITTEXT:
            state.limit = (wParam >>> 0) || DEFAULT_LIMIT;
            return 0;
        case EM_GETLIMITTEXT:
            return state.limit;
        case EM_SETREADONLY:
            if (wParam) child.style |= ES_READONLY;
            else child.style &= ~ES_READONLY;
            return 1;
        case EM_SETPASSWORDCHAR:
            state.passwordChar = wParam >>> 0;
            return 0;
        case EM_GETPASSWORDCHAR:
            return state.passwordChar;
        case EM_CANUNDO:
            return (state.undoInsertCount || state.undoText.length) ? 1 : 0;
        case EM_EMPTYUNDOBUFFER:
            emptyUndoBuffer(state);
            return 0;
        case EM_UNDO:
        case WM_UNDO:
            return undoEdit(child, state) ? 1 : 0;
        case EM_GETFIRSTVISIBLELINE:
            return 0;

        case WM_COPY: {
            const lo = Math.min(state.selStart, state.selEnd);
            const hi = Math.max(state.selStart, state.selEnd);
            if (lo === hi) return 0;
            setClipboardText(mem, child.handle, child.title.slice(lo, hi));
            return 0;
        }
        case WM_CUT:
            handleEditMessage(child, WM_COPY, 0, 0, mem);
            handleEditMessage(child, WM_CLEAR, 0, 0, mem);
            return 0;
        case WM_CLEAR:
            if (!isReadOnly(child)) replaceSelection(child, '', true);
            return 0;
        case WM_PASTE: {
            if (isReadOnly(child)) return 0;
            const text = getClipboardText(mem);
            if (text !== null) replaceSelection(child, text, true);
            return 0;
        }

        case WM_SETFOCUS:
            postEditNotify(child, EN_SETFOCUS);
            return 0;
        case WM_KILLFOCUS:
            postEditNotify(child, EN_KILLFOCUS);
            return 0;

        case WM_SETTEXT:
            setEditControlText(child, lParam ? readAnsiOrWideFromGuest(mem, lParam, textWidth) : '');
            return 1;

        case WM_CHAR: {
            const ch = wParam & 0xFFFF;
            if (ch === 0x08) { // backspace
                if (isReadOnly(child)) return 0;
                if (state.selStart !== state.selEnd) {
                    deleteRange(child, state.selStart, state.selEnd);
                } else if (state.selEnd > 0) {
                    deleteRange(child, state.selEnd - 1, state.selEnd);
                }
                return 0;
            }
            if (ch === 0x0D) { // Enter
                if ((child.style & ES_MULTILINE) !== 0 && (child.style & ES_WANTRETURN) !== 0
                    && !isReadOnly(child)) {
                    replaceSelection(child, '\r\n', true);
                }
                return 0;
            }
            // TranslateMessage folds Ctrl+key into a control character; the class turns
            // those back into the clipboard messages (Wine EDIT_WM_Char). A password
            // edit refuses to hand its content out, so ^C/^X do nothing there.
            const noPassword = (child.style & ES_PASSWORD) === 0;
            if (ch === 0x03) { // ^C
                if (noPassword) handleEditMessage(child, WM_COPY, 0, 0, mem);
                return 0;
            }
            if (ch === 0x16) { // ^V
                if (!isReadOnly(child)) handleEditMessage(child, WM_PASTE, 0, 0, mem);
                return 0;
            }
            if (ch === 0x18) { // ^X
                if (noPassword && !isReadOnly(child)) handleEditMessage(child, WM_CUT, 0, 0, mem);
                return 0;
            }
            if (ch === 0x1A) { // ^Z
                if (!isReadOnly(child)) handleEditMessage(child, WM_UNDO, 0, 0, mem);
                return 0;
            }
            if (ch < 0x20 || ch === 0x7F) return 0;
            if (isReadOnly(child)) return 0;
            replaceSelection(child, String.fromCharCode(ch), true);
            return 0;
        }

        case WM_KEYDOWN: {
            const shiftDown =
                (System.getInstance().inputManager.getKeyState(VK_SHIFT) & 0x8000) !== 0;
            const moveCaret = (pos: number): number => {
                const p = clamp(pos, 0, len());
                state.selEnd = p;
                if (!shiftDown) state.selStart = p;
                ensureCaretVisible(child, state);
                return 0;
            };
            switch (wParam & 0xFF) {
                case VK_LEFT:
                    return moveCaret((state.selStart !== state.selEnd && !shiftDown)
                        ? Math.min(state.selStart, state.selEnd)
                        : state.selEnd - 1);
                case VK_RIGHT:
                    return moveCaret((state.selStart !== state.selEnd && !shiftDown)
                        ? Math.max(state.selStart, state.selEnd)
                        : state.selEnd + 1);
                case VK_HOME:
                    return moveCaret(0);
                case VK_END:
                    return moveCaret(len());
                case VK_DELETE:
                    if (isReadOnly(child)) return 0;
                    if (state.selStart !== state.selEnd) {
                        deleteRange(child, state.selStart, state.selEnd);
                    } else if (state.selEnd < len()) {
                        deleteRange(child, state.selEnd, state.selEnd + 1);
                    }
                    return 0;
                default:
                    return null; // navigation keys (tab/enter/esc) belong to the dialog layer
            }
        }

        default:
            return null;
    }
}

/**
 * Messages that change what an EDIT PAINTS (text, selection, caret, mask) and so
 * need the parent's control repaint. WM_KEYDOWN is in only because the editing keys
 * (arrows/Home/End/Delete) move the caret; focus changes are not — the caret blink
 * is not worth a restore-and-restamp of the whole control set.
 */
export function isEditContentMessage(msg: number): boolean {
    return msg === WM_CHAR || msg === WM_KEYDOWN || msg === EM_REPLACESEL
        || msg === EM_SETSEL || msg === EM_SETREADONLY || msg === EM_SETPASSWORDCHAR
        || msg === EM_SCROLLCARET || msg === EM_UNDO
        || msg === WM_CUT || msg === WM_PASTE || msg === WM_CLEAR || msg === WM_UNDO;
}

/** True when `child` is an EDIT — the only class the messages above belong to. */
export function isEditControl(child: WindowInfo): boolean {
    return (child.systemControlClass ?? '').trim().toLowerCase() === 'edit';
}
