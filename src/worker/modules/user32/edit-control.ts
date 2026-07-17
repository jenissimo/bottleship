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
            passwordChar: (child.style & ES_PASSWORD) !== 0 ? 0x2A /* '*' */ : 0,
        };
        editStates.set(child.handle, state);
    }
    return state;
}

/** Caret/selection/password info for the painter (controls.ts). */
export function getEditVisualState(child: WindowInfo): {
    selStart: number; selEnd: number; focused: boolean; passwordChar: number;
} {
    const state = getOrCreateEditState(child);
    const len = child.title.length;
    return {
        selStart: Math.min(state.selStart, len),
        selEnd: Math.min(state.selEnd, len),
        focused: System.getInstance().windowManager.getFocusHwnd() === child.handle,
        passwordChar: state.passwordChar,
    };
}

// Measurement context for caret-from-click hit testing (font mirrors the painter's
// getWindowFont fallback in controls.ts).
const DEFAULT_CONTROL_FONT = "11px 'Liberation Sans', sans-serif";
let measureCtx: OffscreenCanvasRenderingContext2D | null = null;

function getMeasureCtx(child: WindowInfo): OffscreenCanvasRenderingContext2D | null {
    if (!measureCtx) {
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

/** Place the caret at the clicked pixel (x relative to the control); clears selection. */
export function setEditCaretFromPoint(child: WindowInfo, localX: number): void {
    const state = getOrCreateEditState(child);
    const text = state.passwordChar
        ? String.fromCharCode(state.passwordChar).repeat(child.title.length)
        : child.title;
    const ctx = getMeasureCtx(child);
    let pos = text.length;
    if (ctx) {
        const target = localX - 4; // text inset used by paintEdit
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
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

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

/**
 * Replace the current selection with `insert`, honoring the text limit.
 * Returns true if the text changed.
 */
function replaceSelection(child: WindowInfo, insert: string, notify: boolean): boolean {
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

    child.title = text.slice(0, start) + filtered + text.slice(end);
    const caret = start + filtered.length;
    state.selStart = caret;
    state.selEnd = caret;
    state.modified = true;
    if (notify) notifyTextChanged(child);
    return true;
}

function deleteRange(child: WindowInfo, from: number, to: number): boolean {
    const state = getOrCreateEditState(child);
    const text = child.title;
    const start = clamp(Math.min(from, to), 0, text.length);
    const end = clamp(Math.max(from, to), 0, text.length);
    if (start === end) return false;
    child.title = text.slice(0, start) + text.slice(end);
    state.selStart = start;
    state.selEnd = start;
    state.modified = true;
    notifyTextChanged(child);
    return true;
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
 * EM_* / editing-key sink for EDIT system controls. Returns the LRESULT, or
 * null when the message is not edit-specific (generic handling applies).
 */
export function handleEditMessage(
    child: WindowInfo, msg: number, wParam: number, lParam: number, mem: Uint8Array,
): number | null {
    const state = getOrCreateEditState(child);
    const len = () => child.title.length;

    switch (msg) {
        case EM_GETSEL: {
            const start = Math.min(state.selStart, state.selEnd);
            const end = Math.max(state.selStart, state.selEnd);
            if (wParam) Mem.writeUint32(wParam, start);
            if (lParam) Mem.writeUint32(lParam, end);
            return (((end & 0xFFFF) << 16) | (start & 0xFFFF)) >>> 0;
        }
        case EM_SETSEL: {
            const start = wParam | 0;
            const end = lParam | 0;
            if (start === -1) {
                // Deselect; caret stays at current end.
                state.selStart = state.selEnd;
            } else {
                state.selStart = clamp(start, 0, len());
                state.selEnd = end === -1 ? len() : clamp(end, 0, len());
            }
            return 1;
        }
        case EM_SCROLLCARET:
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
            if (line >= lines.length) return 0;
            // First WORD of the buffer holds its capacity in chars (Win32 contract).
            const cap = Mem.readUint16(lParam) ?? 0;
            const encoded = encodeAnsi(lines[line]).subarray(0, cap);
            if (encoded.length > 0) Mem.writeBytes(lParam, encoded);
            return encoded.length;
        }
        case EM_REPLACESEL: {
            if (isReadOnly(child)) return 0;
            const insert = lParam ? readAnsiOrWideFromGuest(mem, lParam) : '';
            replaceSelection(child, insert, true);
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
            return 0;
        case EM_EMPTYUNDOBUFFER:
            return 0;
        case EM_GETFIRSTVISIBLELINE:
            return 0;

        case WM_SETFOCUS:
            postEditNotify(child, EN_SETFOCUS);
            return 0;
        case WM_KILLFOCUS:
            postEditNotify(child, EN_KILLFOCUS);
            return 0;

        case WM_SETTEXT: {
            // Text swap resets caret/selection and the modify flag, then notifies.
            const text = lParam ? readAnsiOrWideFromGuest(mem, lParam) : '';
            child.title = applyCaseStyle(child, text);
            state.selStart = 0;
            state.selEnd = 0;
            state.modified = false;
            notifyTextChanged(child);
            return 1;
        }

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
            if (ch < 0x20) return 0; // other control chars (tab, ^C...) not handled
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

/** True for messages this module owns (used by dispatch gating/repaint decisions). */
export function isEditContentMessage(msg: number): boolean {
    return msg === WM_CHAR || msg === WM_KEYDOWN || msg === EM_REPLACESEL
        || msg === EM_SETSEL || msg === EM_SETREADONLY || msg === EM_SETPASSWORDCHAR
        || msg === WM_SETTEXT || msg === WM_SETFOCUS || msg === WM_KILLFOCUS;
}
