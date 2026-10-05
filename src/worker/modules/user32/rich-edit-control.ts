/**
 * RICHEDIT / RichEdit20A / RichEdit20W: the EM_* protocol Rich Edit adds on top of
 * EDIT, plus the styled text it displays.
 *
 * Rich Edit 1.0/2.0 is a superset of the EDIT class, so everything the two share
 * (selection, limit, read-only, modify flag, WM_SETTEXT/WM_CHAR editing) is handled
 * by edit-control.ts and reached through the fallthrough at the end of
 * handleRichEditMessage — one implementation, so the two classes cannot drift.
 * What lives here is what EDIT does not have: formatted content (a run list, either
 * streamed in as RTF or synthesized from the plain text and the default character
 * format), the event mask that gates EN_* notifications, the background colour and
 * the vertical scroll position.
 */

import { Mem } from '../../core/memory/mem-accessor';
import { isValidAddress } from '../../core/memory/address-guard';
import { getCodePageDecoder } from '../../core/emulator-config-manager';
import { asBufferSource } from '../../../dom-buffer';
import { encodeAnsi, getAnsiCodePage } from '../codepage-utils';
import { parseRtf, isRtf, type RtfRun } from '@bottleship/formats/rtf';
import { WindowInfo, registerControlStatePurger } from './shared-state';
import { gdiTextMetrics } from '../win32-text';
import { handleEditMessage, registerEditNotifyFilter, setEditControlText } from './edit-control';

// Rich-edit-only EM_* messages.
const EM_CANPASTE = 0x0432;
const EM_EXGETSEL = 0x0434;
const EM_EXLIMITTEXT = 0x0435;
const EM_EXSETSEL = 0x0437;
const EM_GETCHARFORMAT = 0x043A;
const EM_GETEVENTMASK = 0x043B;
const EM_HIDESELECTION = 0x043F;
const EM_SETBKGNDCOLOR = 0x0443;
const EM_SETCHARFORMAT = 0x0444;
const EM_SETEVENTMASK = 0x0445;
const EM_SETUNDOLIMIT = 0x0446;
const EM_SETPARAFORMAT = 0x0447;
const EM_SETTARGETDEVICE = 0x0448;
export const EM_STREAMIN = 0x0449;
export const EM_STREAMOUT = 0x044A;
const EM_GETTEXTRANGE = 0x044B;
const EM_SETOPTIONS = 0x044D;
const EM_GETOPTIONS = 0x044E;
const EM_AUTOURLDETECT = 0x045B;

// Messages Rich Edit shares with EDIT but answers differently.
const EM_LINESCROLL = 0x00B6;
const EM_SETSEL = 0x00B1;
const EM_REPLACESEL = 0x00C2;
const EM_LIMITTEXT = 0x00C5;
const EM_SETREADONLY = 0x00CF;

const WM_SETTEXT = 0x000C;
const WM_VSCROLL = 0x0115;

// SCROLLBAR notification codes (WM_VSCROLL wParam LOWORD).
const SB_LINEUP = 0;
const SB_LINEDOWN = 1;
const SB_PAGEUP = 2;
const SB_PAGEDOWN = 3;
const SB_THUMBPOSITION = 4;
const SB_THUMBTRACK = 5;
const SB_TOP = 6;
const SB_BOTTOM = 7;

// ENM_* event-mask bits, in EN_* notification order.
const ENM_CHANGE = 0x00000001;
const ENM_UPDATE = 0x00000002;
const EN_CHANGE = 0x0300;
const EN_UPDATE = 0x0400;

// CHARFORMAT dwMask / dwEffects bits.
const CFM_BOLD = 0x00000001;
const CFM_ITALIC = 0x00000002;
const CFM_UNDERLINE = 0x00000004;
const CFM_CHARSET = 0x08000000;
const CFM_FACE = 0x20000000;
const CFM_COLOR = 0x40000000;
const CFM_SIZE = 0x80000000;
const CFE_BOLD = 0x00000001;
const CFE_ITALIC = 0x00000002;
const CFE_UNDERLINE = 0x00000004;
const CFE_AUTOCOLOR = 0x40000000;
/** CHARFORMAT (the Rich Edit 1.0 A form) — cbSize through szFaceName[32]. */
const CHARFORMAT_SIZE = 60;

/** SF_* stream formats (EM_STREAMIN / EM_STREAMOUT wParam). */
export const SF_TEXT = 0x0001;
export const SF_RTF = 0x0002;

const ES_READONLY = 0x0800;

/** Cell an empty line falls back to when no run has been measured yet. */
const EMPTY_LINE_CELL = 13;

/** RTF default character size, in half-points (12pt). */
const DEFAULT_SIZE_HALF_POINTS = 24;

export interface RichCharFormat {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    sizeHalfPoints: number;
    /** 0xRRGGBB, or null for the system window-text colour. */
    color: number | null;
}

interface RichEditState {
    /** RTF content. Empty means the control shows child.title in `format`. */
    runs: RtfRun[];
    /** EM_SETEVENTMASK; ENM_NONE (0) is the class default, as on real Rich Edit. */
    eventMask: number;
    /** EM_SETBKGNDCOLOR, 0xBBGGRR COLORREF; null = system window colour. */
    bkColor: number | null;
    /** First visible laid-out line (EM_LINESCROLL / WM_VSCROLL). */
    scrollTop: number;
    /** Last painted layout: -1 until the painter has laid the content out once. */
    lineCount: number;
    visibleLines: number;
    format: RichCharFormat;
}

const richEditStates = new Map<number, RichEditState>();

// Registered lazily for the same reason edit-control's purger is: shared-state sits
// in an import cycle with the control modules.
let hooksRegistered = false;

function ensureHooks(): void {
    if (hooksRegistered) return;
    hooksRegistered = true;
    registerControlStatePurger((hwnd) => richEditStates.delete(hwnd));
    registerEditNotifyFilter(richEditNotifyAllowed);
}

function getState(child: WindowInfo): RichEditState {
    ensureHooks();
    let state = richEditStates.get(child.handle);
    if (!state) {
        state = {
            runs: [],
            eventMask: 0,
            bkColor: null,
            scrollTop: 0,
            lineCount: -1,
            visibleLines: 1,
            format: {
                bold: false, italic: false, underline: false,
                sizeHalfPoints: DEFAULT_SIZE_HALF_POINTS, color: null,
            },
        };
        richEditStates.set(child.handle, state);
    }
    return state;
}

/** True when `child` is one of the Rich Edit classes. */
export function isRichEditControl(child: WindowInfo | undefined): boolean {
    const cls = (child?.systemControlClass ?? '').trim().toLowerCase();
    return cls === 'richedit';
}

/**
 * Rich Edit sends EN_* only for the codes its event mask enables (ENM_NONE by
 * default) — unlike EDIT, which always notifies. Registered as edit-control's
 * notification filter so the shared code path stays single.
 */
function richEditNotifyAllowed(child: WindowInfo, code: number): boolean {
    if (!isRichEditControl(child)) return true;
    const mask = getState(child).eventMask;
    if (code === EN_CHANGE) return (mask & ENM_CHANGE) !== 0;
    if (code === EN_UPDATE) return (mask & ENM_UPDATE) !== 0;
    return true;
}

/** Painter view of the control's chrome (its content comes from richEditContentRuns). */
export function getRichEditVisualState(child: WindowInfo): {
    bkColor: number | null; scrollTop: number;
} {
    const state = getState(child);
    return { bkColor: state.bkColor, scrollTop: state.scrollTop };
}

/** Rich Edit's own runs, or a single run synthesized from the plain text. */
export function richEditContentRuns(child: WindowInfo): RtfRun[] {
    const state = getState(child);
    if (state.runs.length > 0) return state.runs;
    if (!child.title) return [];
    const f = state.format;
    return [{
        text: child.title,
        bold: f.bold, italic: f.italic, underline: f.underline,
        fontSizeHalfPoints: f.sizeHalfPoints, color: f.color,
    }];
}

export function setRichEditScrollTop(child: WindowInfo, line: number): void {
    getState(child).scrollTop = Math.max(0, line | 0);
}

/**
 * How many laid-out lines the control has and how many fit — published by the
 * painter, because word wrap is a function of the control's width and the fonts of
 * its runs, which only the layout pass knows. The scrollbar's thumb and its hit
 * test read it here rather than guessing at a line height.
 */
export function noteRichEditLayout(child: WindowInfo, lineCount: number, visibleLines: number): void {
    const state = getState(child);
    state.lineCount = lineCount;
    state.visibleLines = Math.max(1, visibleLines);
}

/** null until the control has been painted once — nothing to scroll before that. */
export function richEditScrollRange(child: WindowInfo): {
    top: number; visibleLines: number; lineCount: number;
} | null {
    const state = getState(child);
    if (state.lineCount < 0) return null;
    return { top: state.scrollTop, visibleLines: state.visibleLines, lineCount: state.lineCount };
}

/**
 * Install streamed content. `runs` empty means the stream was plain text, which the
 * control keeps exactly like EDIT does — in child.title, so WM_GETTEXT and
 * GetDlgItemText answer without a second source of truth.
 */
export function setRichEditContent(child: WindowInfo, text: string, runs: RtfRun[]): void {
    const state = getState(child);
    state.runs = runs;
    state.scrollTop = 0;
    setEditControlText(child, text);
}

/** Decode RTF bytes with the emulator's own code-page tables. */
export function parseRichEditRtf(bytes: Uint8Array): { text: string; runs: RtfRun[] } {
    const doc = parseRtf(bytes, {
        decode: (buf, codePage) => getCodePageDecoder(codePage).decode(asBufferSource(buf)),
    });
    return { text: doc.text, runs: doc.runs };
}

/** EM_STREAMIN body: interpret the accumulated bytes per the SF_* format. */
export function applyRichEditStream(child: WindowInfo, format: number, bytes: Uint8Array): void {
    if ((format & SF_RTF) !== 0 || isRtf(bytes)) {
        const { text, runs } = parseRichEditRtf(bytes);
        setRichEditContent(child, text, runs);
        return;
    }
    // SF_TEXT is ANSI in the process code page (SF_UNICODE is a separate flag).
    const text = getCodePageDecoder(getAnsiCodePage()).decode(asBufferSource(bytes));
    setRichEditContent(child, text.replace(/\r\n/g, '\n'), []);
}

/** EM_STREAMOUT body: the bytes the control hands to the guest callback. */
export function buildRichEditStreamBytes(child: WindowInfo, format: number): Uint8Array {
    const text = child.title ?? '';
    if ((format & SF_RTF) === 0) {
        return encodeAnsi(text.replace(/\n/g, '\r\n'));
    }
    // A minimal but VALID RTF document. Round-tripping the run list would need an
    // emitter for every attribute the parser accepts; a control asked for RTF it
    // never received as RTF has no formatting to preserve anyway.
    const escaped = text
        .replace(/[\\{}]/g, (m) => `\\${m}`)
        .replace(/\n/g, '\\par\n');
    let body = '';
    for (const ch of escaped) {
        const code = ch.codePointAt(0)!;
        body += code < 0x80 ? ch : `\\u${code}?`;
    }
    // The header is pure ASCII and `body` escaped every non-ASCII char to `\uN?`,
    // so the document is byte-identical under any ANSI code page.
    return encodeAnsi(`{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Arial;}}\n${body}\n}`);
}

/** COLORREF (0x00BBGGRR) → 0xRRGGBB. */
function colorRefToRgb(colorRef: number): number {
    return ((colorRef & 0xFF) << 16) | (colorRef & 0xFF00) | ((colorRef >> 16) & 0xFF);
}

function rgbToColorRef(rgb: number): number {
    return (((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF)) >>> 0;
}

/** Apply a CHARFORMAT to the control's default format (see EM_SETCHARFORMAT). */
function readCharFormat(lParam: number, format: RichCharFormat): boolean {
    if (!lParam || !isValidAddress(lParam, CHARFORMAT_SIZE, 'r')) return false;
    const dwMask = Mem.readUint32(lParam + 4) ?? 0;
    const dwEffects = Mem.readUint32(lParam + 8) ?? 0;
    if (dwMask & CFM_BOLD) format.bold = (dwEffects & CFE_BOLD) !== 0;
    if (dwMask & CFM_ITALIC) format.italic = (dwEffects & CFE_ITALIC) !== 0;
    if (dwMask & CFM_UNDERLINE) format.underline = (dwEffects & CFE_UNDERLINE) !== 0;
    if (dwMask & CFM_SIZE) {
        // yHeight is twips; CHARFORMAT sizes and RTF \fs are both half-points ×10.
        const twips = Mem.readInt32(lParam + 12) ?? 0;
        if (twips > 0) format.sizeHalfPoints = Math.max(1, Math.round(twips / 10));
    }
    if (dwMask & CFM_COLOR) {
        format.color = (dwEffects & CFE_AUTOCOLOR) !== 0
            ? null
            : colorRefToRgb((Mem.readUint32(lParam + 20) ?? 0) >>> 0);
    }
    return true;
}

/** Report the control's default format; returns the dwMask actually filled in. */
function writeCharFormat(lParam: number, format: RichCharFormat): number {
    if (!lParam || !isValidAddress(lParam, CHARFORMAT_SIZE, 'rw')) return 0;
    const dwMask = CFM_BOLD | CFM_ITALIC | CFM_UNDERLINE | CFM_SIZE | CFM_COLOR
        | CFM_CHARSET | CFM_FACE;
    let dwEffects = 0;
    if (format.bold) dwEffects |= CFE_BOLD;
    if (format.italic) dwEffects |= CFE_ITALIC;
    if (format.underline) dwEffects |= CFE_UNDERLINE;
    if (format.color === null) dwEffects |= CFE_AUTOCOLOR;
    Mem.writeUint32(lParam + 4, dwMask >>> 0);
    Mem.writeUint32(lParam + 8, dwEffects >>> 0);
    Mem.writeUint32(lParam + 12, format.sizeHalfPoints * 10);
    Mem.writeUint32(lParam + 16, 0); // yOffset
    Mem.writeUint32(lParam + 20, format.color === null ? 0 : rgbToColorRef(format.color));
    Mem.writeUint8(lParam + 24, 0); // bCharSet = ANSI_CHARSET
    Mem.writeUint8(lParam + 25, 0); // bPitchAndFamily = DEFAULT_PITCH | FF_DONTCARE
    Mem.writeUint8(lParam + 26, 0); // szFaceName: empty, the face is the RTF's own
    return dwMask >>> 0;
}

/** CHARRANGE { LONG cpMin; LONG cpMax; } */
function readCharRange(lParam: number): { min: number; max: number } | null {
    if (!lParam || !isValidAddress(lParam, 8, 'r')) return null;
    return { min: Mem.readInt32(lParam) ?? 0, max: Mem.readInt32(lParam + 4) ?? 0 };
}

/**
 * Rich Edit message sink. Returns the LRESULT, or null when the message belongs to
 * neither Rich Edit nor EDIT (generic system-control handling applies).
 */
export function handleRichEditMessage(
    child: WindowInfo, msg: number, wParam: number, lParam: number, mem: Uint8Array,
    textWidth?: 'ansi' | 'wide',
): number | null {
    const state = getState(child);

    switch (msg) {
        case EM_SETEVENTMASK: {
            const prev = state.eventMask;
            state.eventMask = lParam >>> 0;
            return prev >>> 0;
        }
        case EM_GETEVENTMASK:
            return state.eventMask >>> 0;

        case EM_EXLIMITTEXT:
            // Same limit EDIT keeps, only carried in lParam so it can exceed 64K.
            return handleEditMessage(child, EM_LIMITTEXT, lParam >>> 0, 0, mem) ?? 0;

        case EM_SETBKGNDCOLOR: {
            const prev = state.bkColor === null ? 0 : rgbToColorRef(state.bkColor);
            // wParam != 0 means "use the system window colour", ignoring lParam.
            state.bkColor = wParam ? null : colorRefToRgb(lParam >>> 0);
            return prev >>> 0;
        }

        case EM_SETCHARFORMAT:
            // Character formatting is stored per control, not per selection: our runs
            // come from RTF, which carries its own. A SCF_SELECTION request therefore
            // changes the default the control uses for plain text, which is what a
            // caller that has not streamed RTF is asking for.
            return readCharFormat(lParam, state.format) ? 1 : 0;
        case EM_GETCHARFORMAT:
            return writeCharFormat(lParam, state.format);

        case EM_SETPARAFORMAT:
            // Alignment/indents are not modelled; Rich Edit answers TRUE regardless of
            // whether any attribute in dwMask was applicable.
            return 1;

        case EM_EXSETSEL: {
            const range = readCharRange(lParam);
            if (!range) return 0;
            handleEditMessage(child, EM_SETSEL, range.min, range.max, mem);
            return 0; // EM_EXSETSEL returns zero, unlike EM_SETSEL
        }
        case EM_EXGETSEL: {
            if (!lParam || !isValidAddress(lParam, 8, 'rw')) return 0;
            // EM_GETSEL writes both endpoints through its wParam/lParam out-pointers.
            handleEditMessage(child, 0x00B0 /* EM_GETSEL */, lParam, lParam + 4, mem);
            return 0;
        }

        case EM_GETTEXTRANGE: {
            // TEXTRANGE { CHARRANGE chrg; LPSTR lpstrText; }
            if (!lParam || !isValidAddress(lParam, 12, 'r')) return 0;
            const range = readCharRange(lParam);
            const buffer = (Mem.readUint32(lParam + 8) ?? 0) >>> 0;
            if (!range || !buffer) return 0;
            const text = child.title ?? '';
            const min = Math.max(0, range.min);
            const max = range.max < 0 ? text.length : Math.min(text.length, range.max);
            const slice = text.slice(min, Math.max(min, max));
            const bytes = encodeAnsi(slice);
            if (!isValidAddress(buffer, bytes.length + 1, 'rw')) return 0;
            if (bytes.length) Mem.writeBytes(buffer, bytes);
            Mem.writeUint8(buffer + bytes.length, 0);
            return slice.length;
        }

        case EM_LINESCROLL:
            state.scrollTop = Math.max(0, state.scrollTop + (lParam | 0));
            return 1;

        case WM_VSCROLL: {
            const code = wParam & 0xFFFF;
            const pos = (wParam >>> 16) & 0xFFFF;
            switch (code) {
                case SB_LINEUP: state.scrollTop = Math.max(0, state.scrollTop - 1); break;
                case SB_LINEDOWN: state.scrollTop += 1; break;
                case SB_PAGEUP: state.scrollTop = Math.max(0, state.scrollTop - richEditPageLines(child)); break;
                case SB_PAGEDOWN: state.scrollTop += richEditPageLines(child); break;
                case SB_THUMBPOSITION: case SB_THUMBTRACK: state.scrollTop = pos; break;
                case SB_TOP: state.scrollTop = 0; break;
                case SB_BOTTOM: state.scrollTop = Number.MAX_SAFE_INTEGER; break;
                default: break;
            }
            return 0;
        }

        case WM_SETTEXT:
            // Plain text replaces streamed RTF outright; the format survives, the runs
            // do not (they described text that is gone).
            state.runs = [];
            state.scrollTop = 0;
            break;

        case EM_REPLACESEL:
            // Editing plain text past a stream leaves the runs describing stale offsets.
            state.runs = [];
            break;

        case EM_STREAMIN:
        case EM_STREAMOUT:
            // Streaming re-enters the guest's EDITSTREAMCALLBACK, which needs a
            // suspended thunk; the entry points that can suspend intercept these before
            // this sink is reached (rich-edit-stream.ts). Reaching here means the
            // message arrived on a path with no guest return frame — report that no
            // bytes moved rather than claim a stream that never ran.
            return 0;

        // Answered the way real Rich Edit answers when the feature is inert.
        case EM_CANPASTE: return 0;
        case EM_HIDESELECTION: return 0;
        case EM_SETTARGETDEVICE: return 1;
        case EM_SETUNDOLIMIT: return wParam >>> 0;
        case EM_AUTOURLDETECT: return 0; // S_OK
        case EM_SETOPTIONS: case EM_GETOPTIONS: {
            const ECO_READONLY = 0x0800;
            if (msg === EM_GETOPTIONS) return (child.style & ES_READONLY) !== 0 ? ECO_READONLY : 0;
            const ECOOP_SET = 1, ECOOP_OR = 2, ECOOP_AND = 3;
            const wantReadOnly = (lParam & ECO_READONLY) !== 0;
            if (wParam === ECOOP_SET || (wParam === ECOOP_OR && wantReadOnly)
                || (wParam === ECOOP_AND && !wantReadOnly)) {
                handleEditMessage(child, EM_SETREADONLY, wantReadOnly ? 1 : 0, 0, mem);
            }
            return (child.style & ES_READONLY) !== 0 ? ECO_READONLY : 0;
        }

        default:
            break;
    }

    return handleEditMessage(child, msg, wParam, lParam, mem, textWidth);
}

/** Messages that change what a Rich Edit PAINTS (see isEditContentMessage). */
export function isRichEditContentMessage(msg: number): boolean {
    return msg === EM_SETBKGNDCOLOR || msg === EM_SETCHARFORMAT || msg === EM_SETPARAFORMAT
        || msg === EM_LINESCROLL || msg === WM_VSCROLL
        || msg === EM_STREAMIN || msg === EM_EXSETSEL;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * The face every run is drawn in. RTF names its own fonts, but the guest ships no
 * font files we could load — so size, weight, slant and colour are honoured and the
 * family stays the UI face the other system controls use.
 */
export const RICH_EDIT_FONT_FAMILY = "'Liberation Sans', sans-serif";

/** Text inset from the client rect, on all four sides. */
export const RICH_EDIT_INSET = 4;

/** Line cell at the default 12pt face; only used before the first paint measures one. */
const NOMINAL_LINE_HEIGHT = 16;

export interface RichEditSegment {
    text: string;
    run: RtfRun;
}

export interface RichEditLine {
    segments: RichEditSegment[];
    height: number;
    /**
     * Baseline offset from the line's top. Runs of different sizes on one line sit
     * on ONE baseline (a 14pt word does not float above an 8pt one), so the layout
     * — which is what knows every run on the line — owns it, not the painter.
     */
    baseline: number;
}

/** RTF half-points → CSS pixels (72pt per inch, 96px per inch). */
export function richEditRunPixelSize(run: RtfRun): number {
    return Math.max(6, Math.round((run.fontSizeHalfPoints / 2) * (96 / 72)));
}

export function richEditRunFont(run: RtfRun): string {
    const style = run.italic ? 'italic ' : '';
    const weight = run.bold ? 'bold ' : '';
    return `${style}${weight}${richEditRunPixelSize(run)}px ${RICH_EDIT_FONT_FAMILY}`;
}

/**
 * Break the run list into laid-out lines, wrapping at `maxWidth` px. Wrapping is
 * per WORD across run boundaries, so a bold word in mid-sentence does not force a
 * break the way a per-run layout would.
 */
export function layoutRichEdit(
    ctx: OffscreenCanvasRenderingContext2D,
    runs: RtfRun[],
    maxWidth: number,
): RichEditLine[] {
    const lines: RichEditLine[] = [];
    let segments: RichEditSegment[] = [];
    let lineWidth = 0;
    let lineHeight = 0;
    let lineAscent = 0;
    let lineDescent = 0;

    /**
     * Metrics of the run the layout context is currently set to. The line advances by
     * the TEXT CELL of its tallest run (tmHeight), as GDI does — a factor of the em
     * size instead made every line a pixel or two too tall, and the control then
     * reported, and scrolled by, fewer lines than it actually showed.
     */
    const noteRun = (): void => {
        const m = gdiTextMetrics(ctx);
        lineAscent = Math.max(lineAscent, m.ascent);
        lineDescent = Math.max(lineDescent, m.descent);
        lineHeight = Math.max(lineHeight, m.height);
    };

    const pushLine = (): void => {
        // An empty line still advances by one cell of whatever run ended it.
        const ascent = lineAscent || Math.round(EMPTY_LINE_CELL * 0.8);
        const height = Math.max(lineHeight, ascent + lineDescent, 1);
        lines.push({ segments, height, baseline: ascent });
        segments = [];
        lineWidth = 0;
        lineHeight = 0;
        lineAscent = 0;
        lineDescent = 0;
    };

    const appendWord = (word: string, run: RtfRun, width: number): void => {
        const last = segments[segments.length - 1];
        if (last && last.run === run) last.text += word;
        else segments.push({ text: word, run });
        lineWidth += width;
        noteRun();
    };

    for (const run of runs) {
        ctx.font = richEditRunFont(run);
        // Keep the separators: a wrapped line must still be able to end on the space
        // that caused the break, and \t is content.
        for (const piece of run.text.split(/(\n)/g)) {
            if (piece === '') continue;
            if (piece === '\n') {
                noteRun();
                pushLine();
                continue;
            }
            for (const word of piece.split(/(\s+)/g)) {
                if (word === '') continue;
                const width = ctx.measureText(word).width;
                if (lineWidth > 0 && lineWidth + width > maxWidth && word.trim() !== '') {
                    pushLine();
                    ctx.font = richEditRunFont(run);
                }
                if (lineWidth === 0 && word.trim() === '') continue; // no leading space after a wrap
                appendWord(word, run, width);
            }
        }
    }
    if (segments.length > 0 || lines.length === 0) pushLine();
    return lines;
}

/**
 * Page size for SB_PAGEUP/SB_PAGEDOWN: the visible line count the painter measured,
 * so a page moves by exactly what the control shows. The nominal line height only
 * covers the window before the first paint, when no layout exists yet.
 */
function richEditPageLines(child: WindowInfo): number {
    const state = getState(child);
    if (state.lineCount >= 0) return Math.max(1, state.visibleLines);
    return Math.max(1, Math.floor((child.height - RICH_EDIT_INSET * 2) / NOMINAL_LINE_HEIGHT));
}
