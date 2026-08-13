/**
 * comctl32 PropertySheet — the real sheet: a modal frame dialog carrying a
 * SysTabControl32 plus OK/Cancel/Apply/Help, pages created on demand as child
 * `#32770`s, and the PSN_ / PSM_ protocol between them.
 *
 * Shape follows comctl32's own (see Wine dlls/comctl32/propsheet.c): the frame
 * is an ordinary dialog whose DLGPROC is a real code address — here a comctl32
 * thunk stub — so everything the guest can do to a sheet (SendMessage of a PSM_*,
 * GetWindowLong(DWLP_DLGPROC), subclassing) works through the normal window
 * plumbing rather than a side channel.
 *
 * Deliberate boundaries, all logged when hit:
 *  - PSH_WIZARD / PSH_WIZARD97 run as an ordinary tabbed sheet. The wizard
 *    button strip, PSN_WIZ* and PSM_SETWIZBUTTONS are not implemented.
 *  - PSH_MODELESS runs modal.
 *  - PSCB_PRECREATE is not delivered: it must run before the frame exists, and
 *    the frame is built inside the very thunk that would have to suspend for it.
 *    PSCB_INITIALIZED is delivered.
 *  - PSPCB_CREATE's return value is ignored (as comctl32's own does); the page
 *    is created regardless.
 */

import { Logger, LogCategory } from '../core/logger';
import { Marshaler } from '../core/memory/marshaler';
import { Mem } from '../core/memory/mem-accessor';
import { System } from '../core/system';
import { ThunkResult } from '../core/thunking/thunk-dispatcher';
import { findResourceInPE } from './kernel32/resource';
import { encodeAnsi } from './codepage-utils';
import {
    WindowInfo, windows, reorderChildInParent,
    finalizeWindowDestroy, registerControlStatePurger, getVirtualScreenRect,
} from './user32/shared-state';
import {
    parseDlgTemplate, dluToPixelX, dluToPixelY, getDialogBaseUnits,
} from './user32/dialog-template';
import {
    createDialogChildren, createModelessDialogFromTemplate, endModalDialog,
    isSentinelWndProc, runModalDialogFromTemplate,
} from './user32/dialog';
import {
    repaintDialogAfterContentChange, repaintDialogOverlayIfVisible,
} from './user32/dialog-paint';
import { WH_CBT, HCBT_CREATEWND, getHooksOfType } from './user32/hooks';
import { handleSystemControlMessage } from './user32/dialog-control-messages';
import { adjustTabRect, TabRect } from './user32/tab-control';
import { resolveModuleWndProcStub } from './user32/system-classes';

// ---- Win32 constants ----
const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_SETFONT = 0x0030;
const WM_INITDIALOG = 0x0110;
const WM_COMMAND = 0x0111;
const WM_NOTIFY = 0x004e;
const WM_USER = 0x0400;

const IDOK = 1;
const IDCANCEL = 2;
const IDHELP = 9;

const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_DISABLED = 0x08000000;
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00c00000;
const WS_SYSMENU = 0x00080000;
const WS_THICKFRAME = 0x00040000;
const WS_TABSTOP = 0x00010000;
const WS_GROUP = 0x00020000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_EX_CONTROLPARENT = 0x00010000;

const DS_MODALFRAME = 0x0080;
const DS_3DLOOK = 0x0004;
const DS_SETFONT = 0x0040;
const DS_CENTER = 0x0800;
const DS_CONTROL = 0x0400;

const BS_PUSHBUTTON = 0x0000;
const BS_DEFPUSHBUTTON = 0x0001;

const TCM_FIRST = 0x1300;
const TCM_GETCURSEL = TCM_FIRST + 11;
const TCM_SETCURSEL = TCM_FIRST + 12;
const TCM_INSERTITEMA = TCM_FIRST + 7;
const TCM_DELETEITEM = TCM_FIRST + 8;
const TCM_DELETEALLITEMS = TCM_FIRST + 9;
const TCIF_TEXT = 0x0001;

const TCN_SELCHANGE = (0 - 551) >>> 0;
const TCN_SELCHANGING = (0 - 552) >>> 0;

// ---- Property sheet ----
export const IDC_TABCONTROL = 12320;
export const IDC_APPLY_BUTTON = 12321;

const PSH_PROPTITLE = 0x0001;
const PSH_PROPSHEETPAGE = 0x0008;
const PSH_WIZARD = 0x0020;
const PSH_USEPSTARTPAGE = 0x0040;
const PSH_NOAPPLYNOW = 0x0080;
const PSH_USECALLBACK = 0x0100;
const PSH_HASHELP = 0x0200;
const PSH_MODELESS = 0x0400;
const PSH_WIZARD97_OLD = 0x00002000;
const PSH_WIZARD97_NEW = 0x01000000;
const PSH_WIZARD_ANY = PSH_WIZARD | PSH_WIZARD97_OLD | PSH_WIZARD97_NEW;

const PSP_DLGINDIRECT = 0x0001;
const PSP_USETITLE = 0x0008;
const PSP_HASHELP = 0x0020;
const PSP_USECALLBACK = 0x0080;

const PSPCB_RELEASE = 1;
const PSPCB_CREATE = 2;

const PSCB_INITIALIZED = 1;

const PSN_FIRST = 0 - 200;
const PSN_SETACTIVE = (PSN_FIRST - 0) >>> 0;
const PSN_KILLACTIVE = (PSN_FIRST - 1) >>> 0;
const PSN_APPLY = (PSN_FIRST - 2) >>> 0;
const PSN_RESET = (PSN_FIRST - 3) >>> 0;
const PSN_HELP = (PSN_FIRST - 5) >>> 0;
const PSN_QUERYCANCEL = (PSN_FIRST - 9) >>> 0;

const PSNRET_NOERROR = 0;
const PSNRET_INVALID = 1;
const PSNRET_INVALID_NOCHANGEPAGE = 2;

const PSM_SETCURSEL = WM_USER + 101;
const PSM_REMOVEPAGE = WM_USER + 102;
const PSM_ADDPAGE = WM_USER + 103;
const PSM_CHANGED = WM_USER + 104;
const PSM_RESTARTWINDOWS = WM_USER + 105;
const PSM_REBOOTSYSTEM = WM_USER + 106;
const PSM_CANCELTOCLOSE = WM_USER + 107;
const PSM_QUERYSIBLINGS = WM_USER + 108;
const PSM_UNCHANGED = WM_USER + 109;
const PSM_APPLY = WM_USER + 110;
const PSM_SETTITLEA = WM_USER + 111;
const PSM_SETWIZBUTTONS = WM_USER + 112;
const PSM_PRESSBUTTON = WM_USER + 113;
const PSM_SETCURSELID = WM_USER + 114;
const PSM_GETTABCONTROL = WM_USER + 116;
const PSM_ISDIALOGMESSAGE = WM_USER + 117;
const PSM_GETCURRENTPAGEHWND = WM_USER + 118;
const PSM_SETTITLEW = WM_USER + 120;
const PSM_HWNDTOINDEX = WM_USER + 129;
const PSM_INDEXTOHWND = WM_USER + 130;
const PSM_PAGETOINDEX = WM_USER + 131;
const PSM_INDEXTOPAGE = WM_USER + 132;
const PSM_IDTOINDEX = WM_USER + 133;
const PSM_INDEXTOID = WM_USER + 134;
const PSM_GETRESULT = WM_USER + 135;
const PSM_RECALCPAGESIZES = WM_USER + 136;

const PSBTN_BACK = 0;
const PSBTN_NEXT = 1;
const PSBTN_FINISH = 2;
const PSBTN_OK = 3;
const PSBTN_APPLYNOW = 4;
const PSBTN_CANCEL = 5;
const PSBTN_HELP = 6;

const ID_PSRESTARTWINDOWS = 0x2;
const ID_PSREBOOTSYSTEM = 0x3;

/** PSHNOTIFY { NMHDR hdr; LPARAM lParam; } — 12 + 4. */
const PSHNOTIFY_SIZE = 16;

/** Frame layout in dialog units, matching comctl32's IDD_PROPSHEET. */
const FRAME_PAD_DLU = 4;
const BUTTON_W_DLU = 50;
const BUTTON_H_DLU = 14;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface SheetPage {
    /** HPROPSHEETPAGE, or 0 when the header carried inline PROPSHEETPAGEs. */
    hpage: number;
    /** Guest PROPSHEETPAGE — WM_INITDIALOG's lParam, per the Win32 contract. */
    pspPtr: number;
    dwFlags: number;
    hInstance: number;
    templatePtr: number;
    /** Resource id of the page template; PSN_SETACTIVE may name a page by it. */
    templateId: number;
    dlgProc: number;
    pfnCallback: number;
    title: string;
    hwndPage: number;
    isDirty: boolean;
    hasHelp: boolean;
    /** Template size in DLU, and the same size in PIXELS via the page's own font. */
    cx: number;
    cy: number;
    wpx: number;
    hpx: number;
}

interface SheetInfo {
    id: number;
    hwndFrame: number;
    dwFlags: number;
    hInstance: number;
    hwndParent: number;
    caption: string;
    pfnCallback: number;
    unicode: boolean;
    pages: SheetPage[];
    activeIndex: number;
    activeValid: boolean;
    result: number;
    hasApply: boolean;
    hasHelp: boolean;
    startPage: number;
    /** Largest page: DLU for logging, PIXELS for layout. */
    pageW: number;
    pageH: number;
    pageWpx: number;
    pageHpx: number;
    /** Page rect inside the frame's client, pixels. */
    pageRect: TabRect;
    /** Guest scratch for PSHNOTIFY + the synthesized frame template. */
    notifyPtr: number;
    templatePtr: number;
    /** CBT_CREATEWND + its CREATESTRUCT, reused for every page creation. */
    cbtPtr: number;
    ptrBlock: number;
    /** Set once the sheet has torn down, so a late PSM_* cannot resurrect it. */
    ended: boolean;
    /** PSH_MODELESS: the app owns the message loop and the sheet's lifetime. */
    modeless: boolean;
    /**
     * TCN_SELCHANGING's verdict, waiting for the TCN_SELCHANGE that follows it.
     * The tab control posts the pair (it has no thunk context to read an LRESULT
     * back with), so the veto has to be enforced on arrival of the second one —
     * asking the page again there would send it two PSN_KILLACTIVEs per switch.
     */
    pendingSwitchVeto: boolean | null;
}

/**
 * Every notification the sheet delivers, with the page's verdict.
 *
 * The protocol is otherwise unobservable: each hop is a guest callback whose
 * result only this module sees, the worker log ring holds ~50 entries, and the
 * pixels look identical whether a page was asked or not. Module-level (not
 * per-sheet) so it survives the sheet's teardown, which is exactly when a
 * regression wants to read it.
 */
const notifyTrace: string[] = [];
const NOTIFY_TRACE_MAX = 200;

function noteSheetNotify(entry: string): void {
    notifyTrace.push(entry);
    if (notifyTrace.length > NOTIFY_TRACE_MAX) notifyTrace.shift();
}

/** The notifications delivered since the last reset, oldest first. */
export function getPropSheetNotifyTrace(): string[] {
    return notifyTrace.slice();
}

export function resetPropSheetNotifyTrace(): void {
    notifyTrace.length = 0;
}

const sheetsById = new Map<number, SheetInfo>();
const sheetsByFrame = new Map<number, SheetInfo>();
let nextSheetId = 1;

// The modal manager deliberately does NOT deliver WM_DESTROY to a dialog's own
// root DLGPROC, so the sheet's teardown hangs off window finalization instead.
let purgerRegistered = false;
function ensureSheetPurger(): void {
    if (purgerRegistered) return;
    purgerRegistered = true;
    registerControlStatePurger((hwnd) => {
        const sheet = sheetsByFrame.get(hwnd >>> 0);
        if (sheet) releaseSheet(sheet);
    });
}

export function getSheetByFrame(hwnd: number): SheetInfo | undefined {
    return sheetsByFrame.get(hwnd);
}

export function resetPropSheetState(): void {
    sheetsById.clear();
    sheetsByFrame.clear();
    nextSheetId = 1;
    cachedDlgProcAddr = 0;
    notifyTrace.length = 0;
}

// ---------------------------------------------------------------------------
// The frame's DLGPROC address
// ---------------------------------------------------------------------------

let cachedDlgProcAddr = 0;

/**
 * The address the sheet reports through DWLP_DLGPROC. comctl32's own frame proc
 * is a real function inside comctl32, so this is a comctl32 thunk stub — a guest
 * that reads it back, CallWindowProc's it or subclasses around it lands in real
 * default processing rather than on a synthetic handle.
 */
export function getPropSheetDlgProcAddress(): number {
    if (!cachedDlgProcAddr) {
        cachedDlgProcAddr = resolveModuleWndProcStub('comctl32', 'PropertySheetDlgProc');
    }
    return cachedDlgProcAddr;
}

// ---------------------------------------------------------------------------
// Guest-memory helpers
// ---------------------------------------------------------------------------

function guestMem(): Uint8Array | null {
    return System.getInstance().process?.getCurrentMemory?.() ?? null;
}

function readCaption(mem: Uint8Array, ptr: number, unicode: boolean): string {
    if (!ptr) return '';
    if (ptr < 0x10000) return ''; // MAKEINTRESOURCE caption — not resolved here
    return unicode ? Marshaler.readWideString(mem, ptr) : Marshaler.readString(mem, ptr);
}

function writeAnsiZ(mem: Uint8Array, ptr: number, text: string, maxBytes: number): number {
    const bytes = encodeAnsi(text);
    const n = Math.min(bytes.length, Math.max(0, maxBytes - 1));
    for (let i = 0; i < n; i++) mem[ptr + i] = bytes[i];
    mem[ptr + n] = 0;
    return n + 1;
}

// ---------------------------------------------------------------------------
// Frame DLGTEMPLATE synthesis
// ---------------------------------------------------------------------------

class TemplateWriter {
    private bytes: number[] = [];

    get length(): number { return this.bytes.length; }

    u16(v: number): void { this.bytes.push(v & 0xff, (v >>> 8) & 0xff); }
    u32(v: number): void { this.u16(v & 0xffff); this.u16((v >>> 16) & 0xffff); }
    i16(v: number): void { this.u16(v & 0xffff); }

    wide(text: string): void {
        for (let i = 0; i < text.length; i++) this.u16(text.charCodeAt(i));
        this.u16(0);
    }

    align4(): void { while (this.bytes.length & 3) this.bytes.push(0); }

    toUint8Array(): Uint8Array { return new Uint8Array(this.bytes); }
}

interface FrameItem {
    style: number;
    x: number; y: number; cx: number; cy: number;
    id: number;
    className: string;
    title: string;
}

/**
 * Build the sheet's frame template. Sizes here are a starting point only — the
 * true geometry is font dependent and is applied in pixels once the tab control
 * exists (layoutSheet), exactly as comctl32's PROPSHEET_AdjustSize does.
 */
function buildFrameTemplate(caption: string, pageW: number, pageH: number, sheet: SheetInfo): Uint8Array {
    const tabW = pageW + 2 * FRAME_PAD_DLU;
    const tabH = pageH + 2 * FRAME_PAD_DLU + BUTTON_H_DLU;
    const cx = tabW + 2 * FRAME_PAD_DLU;
    const cy = tabH + 3 * FRAME_PAD_DLU + BUTTON_H_DLU;

    const buttonY = cy - FRAME_PAD_DLU - BUTTON_H_DLU;
    let buttons = 2;
    if (sheet.hasApply) buttons++;
    if (sheet.hasHelp) buttons++;
    let bx = cx - (FRAME_PAD_DLU + BUTTON_W_DLU) * buttons;

    const mkButton = (id: number, text: string, def: boolean, disabled: boolean): FrameItem => {
        const item: FrameItem = {
            style: WS_CHILD | WS_VISIBLE | WS_TABSTOP | (def ? BS_DEFPUSHBUTTON : BS_PUSHBUTTON)
                | (disabled ? WS_DISABLED : 0),
            x: bx, y: buttonY, cx: BUTTON_W_DLU, cy: BUTTON_H_DLU,
            id, className: 'Button', title: text,
        };
        bx += FRAME_PAD_DLU + BUTTON_W_DLU;
        return item;
    };

    const items: FrameItem[] = [
        {
            style: WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_GROUP | WS_CLIPSIBLINGS | 0x0200 /* TCS_MULTILINE */,
            x: FRAME_PAD_DLU, y: FRAME_PAD_DLU, cx: tabW, cy: tabH,
            id: IDC_TABCONTROL, className: 'SysTabControl32', title: '',
        },
        mkButton(IDOK, 'OK', true, false),
        mkButton(IDCANCEL, 'Cancel', false, false),
    ];
    if (sheet.hasApply) items.push(mkButton(IDC_APPLY_BUTTON, '&Apply', false, true));
    if (sheet.hasHelp) items.push(mkButton(IDHELP, 'Help', false, false));

    const w = new TemplateWriter();
    w.u32(WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_VISIBLE | DS_MODALFRAME | DS_3DLOOK
        | DS_SETFONT | DS_CENTER);
    w.u32(0);                 // dwExtendedStyle
    w.u16(items.length);      // cdit
    w.i16(0); w.i16(0);       // x, y (DS_CENTER places it)
    w.i16(cx); w.i16(cy);
    w.u16(0);                 // no menu
    w.u16(0);                 // default class (#32770)
    w.wide(caption);
    w.u16(8);                 // DS_SETFONT point size
    w.wide('MS Sans Serif');

    for (const item of items) {
        w.align4();
        w.u32(item.style);
        w.u32(0);             // dwExtendedStyle
        w.i16(item.x); w.i16(item.y); w.i16(item.cx); w.i16(item.cy);
        w.u16(item.id);
        w.wide(item.className);
        w.wide(item.title);
        w.u16(0);             // creation data
    }

    return w.toUint8Array();
}

// ---------------------------------------------------------------------------
// Header / page parsing
// ---------------------------------------------------------------------------

function resolvePageTemplate(
    mem: Uint8Array, hInstance: number, flags: number, pszTemplate: number,
): { ptr: number; id: number } {
    if (flags & PSP_DLGINDIRECT) return { ptr: pszTemplate, id: 0 };
    if (!pszTemplate) return { ptr: 0, id: 0 };
    const moduleBase = hInstance || 0x00400000;
    const resourceName: number | string = pszTemplate < 0x10000
        ? pszTemplate
        : Marshaler.readString(mem, pszTemplate);
    const entry = findResourceInPE(mem, moduleBase, 5 /* RT_DIALOG */, resourceName);
    if (!entry) return { ptr: 0, id: typeof resourceName === 'number' ? resourceName : 0 };
    return {
        ptr: entry.moduleBase + entry.dataRVA,
        id: typeof resourceName === 'number' ? resourceName : 0,
    };
}

function collectPage(
    mem: Uint8Array, pspPtr: number, hpage: number, unicode: boolean,
): SheetPage | null {
    if (!pspPtr) return null;
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const dwFlags = v.getUint32(pspPtr + 0x04, true) >>> 0;
    const hInstance = v.getUint32(pspPtr + 0x08, true) >>> 0;
    const pszTemplate = v.getUint32(pspPtr + 0x0c, true) >>> 0;
    const pszTitle = v.getUint32(pspPtr + 0x14, true) >>> 0;
    const dlgProc = v.getUint32(pspPtr + 0x18, true) >>> 0;
    const pfnCallback = v.getUint32(pspPtr + 0x20, true) >>> 0;

    const tmpl = resolvePageTemplate(mem, hInstance, dwFlags, pszTemplate);

    let title = '';
    let cx = 0;
    let cy = 0;
    let wpx = 0;
    let hpx = 0;
    if (tmpl.ptr) {
        try {
            const parsed = parseDlgTemplate(mem, tmpl.ptr);
            title = parsed.title || '';
            cx = parsed.cx;
            cy = parsed.cy;
            // Each page maps its own DLU with its own font. comctl32 sizes the sheet
            // in DLU because every template involved uses MS Shell Dlg; when a page
            // omits DS_SETFONT and the frame does not, the same DLU count is a
            // DIFFERENT number of pixels, and the page gets clipped.
            const pageBase = getDialogBaseUnits(parsed);
            wpx = dluToPixelX(parsed.cx, pageBase);
            hpx = dluToPixelY(parsed.cy, pageBase);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM,
                `PropertySheet: bad page DLGTEMPLATE at 0x${tmpl.ptr.toString(16)}: ${e}`);
        }
    }
    if ((dwFlags & PSP_USETITLE) && pszTitle) {
        const explicit = readCaption(mem, pszTitle, unicode);
        if (explicit) title = explicit;
    }

    return {
        hpage,
        pspPtr,
        dwFlags,
        hInstance,
        templatePtr: tmpl.ptr,
        templateId: tmpl.id,
        dlgProc,
        pfnCallback,
        title,
        hwndPage: 0,
        isDirty: false,
        hasHelp: (dwFlags & PSP_HASHELP) !== 0,
        cx,
        cy,
        wpx,
        hpx,
    };
}

// ---------------------------------------------------------------------------
// Async driver
//
// Every notification the sheet owes a page is a guest call whose LRESULT it
// needs, and a JS handler cannot block on one. A routine is a generator: it
// YIELDS the message to deliver and RECEIVES the LRESULT, so the protocol reads
// in the order the documentation states it while each hop is a real suspended
// callback anchored to the sheet's modal frame.
// ---------------------------------------------------------------------------

interface SheetSend {
    /** Guest code address; 0 means "nothing to call", the routine gets 0 back. */
    proc: number;
    /** stdcall arguments, in declaration order. */
    args: number[];
    tag: string;
    /** Target window, when this is a window message (a callback has no hwnd). */
    hwnd?: number;
    /**
     * A DLGPROC answers in DWLP_MSGRESULT, not EAX (DefDlgProc's rule). When set,
     * this window's DWLP_MSGRESULT is cleared before the call and read after.
     */
    dlgResultOf?: number;
}

/** A window message to a window whose wndProc is a real guest address. */
function msgTo(
    hwnd: number, msg: number, wParam: number, lParam: number, tag: string,
    dialogResult = false,
): SheetSend {
    const win = windows.get(hwnd);
    const proc = win?.wndProc ?? 0;
    return {
        proc: proc && !isSentinelWndProc(proc) ? proc : 0,
        args: [hwnd, msg, wParam >>> 0, lParam >>> 0],
        tag,
        hwnd,
        dlgResultOf: dialogResult ? hwnd : undefined,
    };
}

type SheetRoutine = Generator<SheetSend, number, number>;

/** DefDlgProc's answer rule for a message a DLGPROC does not answer in EAX. */
function dialogMessageResult(hwnd: number, dlgProcReturn: number): number {
    if (!dlgProcReturn) return 0;
    return (windows.get(hwnd)?.extraBytes?.[0] ?? 0) >>> 0;
}

/**
 * Drive a routine to completion and answer THIS window-procedure call with its
 * result.
 *
 * Every hop uses `directThunkReturn`, the same mechanism DefDlgProc's nested
 * DLGPROC call uses: it resumes exactly where this thunk's own `RET 16` would
 * have, and consumes no outer callback frame. Anchoring to the enclosing frame
 * instead would make the routine's final value complete whatever suspended thunk
 * happened to be underneath — for a sheet created from PropertySheetA that is
 * PropertySheetA itself, which returns from the API in the middle of its own
 * WM_INITDIALOG.
 */
function runSheetRoutine(
    ctx: any, mem: Uint8Array, routine: SheetRoutine, tag: string,
): number | ThunkResult {
    const callbackManager = System.getInstance().process?.dispatcher?.callbackManager;
    const WNDPROC_CLEANUP = 16;

    const drain = (): number => {
        let step = routine.next(0);
        while (!step.done) step = routine.next(0);
        return step.value >>> 0;
    };
    if (!callbackManager) return drain();

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const returnAddr = view.getUint32(ctx.esp, true) >>> 0;
    const postEsp = (ctx.esp + 4 + WNDPROC_CLEANUP) >>> 0;

    let firstCallbackId = 0;
    const advance = (lresult: number): number | null => {
        let input = lresult >>> 0;
        for (;;) {
            let step: IteratorResult<SheetSend, number>;
            try {
                step = routine.next(input);
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `${tag}: routine threw: ${e}`);
                return 0;
            }
            if (step.done) return step.value >>> 0;

            const send = step.value;
            if (!send.proc) {
                input = 0;
                continue;
            }
            // NT clears DWLP_MSGRESULT before the dialog procedure runs; a DLGPROC
            // that answers FALSE has not written one, and its LRESULT is 0.
            const dlgHwnd = send.dlgResultOf;
            if (dlgHwnd !== undefined) {
                const resultWin = windows.get(dlgHwnd);
                if (resultWin?.extraBytes) resultWin.extraBytes[0] = 0;
            }

            const invoked = callbackManager.invokeCallback(
                send.proc, send.args, 0, undefined, false, send.tag, undefined,
                {
                    directThunkReturn: {
                        returnAddr,
                        postEsp,
                        complete: (ret: number): number | null => {
                            const lresult = dlgHwnd !== undefined
                                ? dialogMessageResult(dlgHwnd, ret >>> 0)
                                : (ret >>> 0);
                            noteSheetNotify(send.hwnd !== undefined
                                ? `${send.tag} hwnd=0x${send.hwnd.toString(16)} -> ${lresult | 0}`
                                : `${send.tag} -> ${lresult | 0}`);
                            return advance(lresult);
                        },
                    },
                },
            );
            if (invoked.callbackId === 0) {
                input = 0;
                continue;
            }
            if (!firstCallbackId) firstCallbackId = invoked.callbackId;
            return null;
        }
    };

    const immediate = advance(0);
    if (immediate !== null) return immediate;

    return {
        value: 0,
        suspendedForCallback: true,
        callbackId: firstCallbackId,
        stackCleanup: WNDPROC_CLEANUP,
        skipStackCheck: true,
        preserveCallbackReturnAddress: true,
    };
}

const PSN_NAMES: Record<number, string> = {
    [PSN_SETACTIVE]: 'PSN_SETACTIVE',
    [PSN_KILLACTIVE]: 'PSN_KILLACTIVE',
    [PSN_APPLY]: 'PSN_APPLY',
    [PSN_RESET]: 'PSN_RESET',
    [PSN_HELP]: 'PSN_HELP',
    [PSN_QUERYCANCEL]: 'PSN_QUERYCANCEL',
};

/** WM_NOTIFY of a PSHNOTIFY to a page; the LRESULT is the page's veto/verdict. */
function psn(sheet: SheetInfo, hwndPage: number, code: number, lParam = 0): SheetSend {
    const mem = guestMem();
    if (mem && sheet.notifyPtr) {
        const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        v.setUint32(sheet.notifyPtr + 0, sheet.hwndFrame >>> 0, true);  // hdr.hwndFrom
        v.setUint32(sheet.notifyPtr + 4, 0, true);                      // hdr.idFrom
        v.setUint32(sheet.notifyPtr + 8, code >>> 0, true);             // hdr.code
        v.setUint32(sheet.notifyPtr + 12, lParam >>> 0, true);          // lParam
    }
    return msgTo(hwndPage, WM_NOTIFY, 0, sheet.notifyPtr,
        'PropSheet:' + (PSN_NAMES[code] ?? ('PSN_' + (code | 0))), true);
}

/**
 * PropSheetPageProc(hwnd, uMsg, LPPROPSHEETPAGE) — 3 stdcall args, sent only when
 * the page asked for it with PSP_USECALLBACK. comctl32 discards the result.
 */
function pspCallback(page: SheetPage, msg: number): SheetSend {
    const wanted = (page.dwFlags & PSP_USECALLBACK) !== 0 && page.pfnCallback !== 0;
    return {
        proc: wanted ? page.pfnCallback : 0,
        args: [0, msg >>> 0, page.pspPtr >>> 0],
        tag: msg === PSPCB_CREATE ? 'PropSheet:PSPCB_CREATE' : 'PropSheet:PSPCB_RELEASE',
    };
}

/** PropSheetProc(hwndDlg, uMsg, lParam) — 3 stdcall args. */
function pscbCallback(sheet: SheetInfo, msg: number, lParam = 0): SheetSend {
    const wanted = (sheet.dwFlags & PSH_USECALLBACK) !== 0 && sheet.pfnCallback !== 0;
    return {
        proc: wanted ? sheet.pfnCallback : 0,
        args: [sheet.hwndFrame >>> 0, msg >>> 0, lParam >>> 0],
        tag: 'PropSheet:PSCB_' + msg,
    };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Direct children only. findChildByControlId recurses, and a page is a child of
 * the frame that sits FIRST in Z-order — a page control with id 1 would otherwise
 * answer as the sheet's own OK button.
 */
function getFrameControl(sheet: SheetInfo, id: number): WindowInfo | undefined {
    const frame = windows.get(sheet.hwndFrame);
    if (!frame) return undefined;
    for (const childHwnd of frame.children) {
        const child = windows.get(childHwnd);
        if (child?.controlId === id) return child;
    }
    return undefined;
}

function moveWindowInfo(win: WindowInfo, x: number, y: number, w: number, h: number): void {
    win.x = x;
    win.y = y;
    win.width = w;
    win.height = h;
    const wmWin = System.getInstance().windowManager.getWindow(win.handle);
    if (wmWin) {
        wmWin.rect.x = x;
        wmWin.rect.y = y;
        wmWin.rect.w = w;
        wmWin.rect.h = h;
    }
}

/**
 * comctl32's PROPSHEET_AdjustSize + PROPSHEET_AdjustButtons: grow the tab to fit
 * the largest page, then the frame to fit the tab plus one button row, then put
 * the buttons on that row right-aligned.
 */
function layoutSheet(sheet: SheetInfo): void {
    const frame = windows.get(sheet.hwndFrame);
    const tab = getFrameControl(sheet, IDC_TABCONTROL);
    const ok = getFrameControl(sheet, IDOK);
    if (!frame || !tab || !ok) return;

    const base = { x: frame.dialogBaseUnitX ?? 8, y: frame.dialogBaseUnitY ?? 16 };
    const padX = tab.x;
    const padY = tab.y;
    const buttonW = ok.width;
    const buttonH = ok.height;

    const pageW = sheet.pageWpx || dluToPixelX(sheet.pageW, base);
    const pageH = sheet.pageHpx || dluToPixelY(sheet.pageH, base);

    // Tab window rect that yields a display area of pageW x pageH.
    const want = adjustTabRect(tab, true, { left: 0, top: 0, right: pageW, bottom: pageH });
    const tabW = Math.max(tab.width, want.right - want.left);
    const tabH = Math.max(tab.height, want.bottom - want.top);
    moveWindowInfo(tab, padX, padY, tabW, tabH);

    const clientW = tabW + 2 * padX;
    const clientH = tabH + buttonH + 3 * padY;
    moveWindowInfo(frame, frame.x, frame.y, clientW, clientH);

    // Re-centre: the template's DS_CENTER placement was made for the guessed size.
    const screen = getVirtualScreenRect();
    const sw = screen.right - screen.left;
    const sh = screen.bottom - screen.top;
    if (sw > 0 && sh > 0) {
        moveWindowInfo(frame,
            screen.left + Math.max(0, Math.floor((sw - clientW) / 2)),
            screen.top + Math.max(0, Math.floor((sh - clientH) / 2)),
            clientW, clientH);
    }

    let buttons = 2;
    if (sheet.hasApply) buttons++;
    if (sheet.hasHelp) buttons++;
    const by = clientH - (padY + buttonH);
    let bx = clientW - (padX + buttonW) * buttons;
    for (const id of [IDOK, IDCANCEL, IDC_APPLY_BUTTON, IDHELP]) {
        const btn = getFrameControl(sheet, id);
        if (!btn) continue;
        moveWindowInfo(btn, bx, by, buttonW, buttonH);
        bx += padX + buttonW;
    }

    // Page rect: the tab's display area, in frame-client coordinates.
    const display = adjustTabRect(tab, false, { left: 0, top: 0, right: tabW, bottom: tabH });
    sheet.pageRect = {
        left: display.left + padX,
        top: display.top + padY,
        right: display.right + padX,
        bottom: display.bottom + padY,
    };
    Logger.log(LogCategory.SYSTEM,
        `PropertySheet: frame ${clientW}x${clientH}, tab ${tabW}x${tabH}, page rect `
        + `(${sheet.pageRect.left},${sheet.pageRect.top})-(${sheet.pageRect.right},${sheet.pageRect.bottom})`);
}

// ---------------------------------------------------------------------------
// Tab control plumbing
// ---------------------------------------------------------------------------

function tabMessage(sheet: SheetInfo, msg: number, wParam: number, lParam: number): number {
    const tab = getFrameControl(sheet, IDC_TABCONTROL);
    const mem = guestMem();
    if (!tab || !mem) return 0;
    return handleSystemControlMessage(tab, msg, wParam, lParam, mem) | 0;
}

/** Rebuild the tab row from the page list. */
function fillTabControl(sheet: SheetInfo): void {
    const mem = guestMem();
    if (!mem || !sheet.notifyPtr) return;
    tabMessage(sheet, TCM_DELETEALLITEMS, 0, 0);
    const textPtr = sheet.notifyPtr + PSHNOTIFY_SIZE;
    const itemPtr = textPtr + 128;
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    for (let i = 0; i < sheet.pages.length; i++) {
        writeAnsiZ(mem, textPtr, sheet.pages[i].title, 128);
        v.setUint32(itemPtr + 0, TCIF_TEXT, true);
        v.setUint32(itemPtr + 4, 0, true);
        v.setUint32(itemPtr + 8, 0, true);
        v.setUint32(itemPtr + 12, textPtr >>> 0, true);
        v.setInt32(itemPtr + 16, 128, true);
        v.setInt32(itemPtr + 20, -1, true);
        v.setUint32(itemPtr + 24, 0, true);
        tabMessage(sheet, TCM_INSERTITEMA, i, itemPtr);
    }
}

// ---------------------------------------------------------------------------
// Page creation
// ---------------------------------------------------------------------------

const PAGE_STYLE_CLEAR = (DS_MODALFRAME | WS_CAPTION | WS_SYSMENU | WS_POPUP
    | WS_DISABLED | WS_VISIBLE | WS_THICKFRAME) >>> 0;

/** Create the page window and its controls. WM_INITDIALOG is the caller's step. */
function createPageWindow(sheet: SheetInfo, page: SheetPage): number {
    if (!page.templatePtr || !page.dlgProc) return 0;
    const mem = guestMem();
    if (!mem) return 0;

    let parsed;
    try {
        parsed = parseDlgTemplate(mem, page.templatePtr);
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `PropertySheet: page template parse failed: ${e}`);
        return 0;
    }

    const system = System.getInstance();
    const style = (((parsed.style & ~PAGE_STYLE_CLEAR) | WS_CHILD | WS_TABSTOP | DS_CONTROL) >>> 0);
    const exStyle = ((parsed.exStyle ?? 0) | WS_EX_CONTROLPARENT) >>> 0;
    const r = sheet.pageRect;
    const x = r.left;
    const y = r.top;
    const w = Math.max(1, r.right - r.left);
    const h = Math.max(1, r.bottom - r.top);

    const hwnd = system.windowManager.createWindow(
        '#32770', parsed.title || '', style, exStyle,
        x, y, w, h, sheet.hwndFrame, 0, page.hInstance || 0x400000, page.pspPtr,
    );
    if (!hwnd) return 0;

    const base = getDialogBaseUnits(parsed);
    const info: WindowInfo = {
        handle: hwnd,
        title: parsed.title || '',
        style,
        exStyle,
        x, y, width: w, height: h,
        parent: sheet.hwndFrame,
        children: [],
        visible: false,
        wndProc: page.dlgProc,
        userData: 0,
        cbWndExtra: 40,
        extraBytes: new Uint32Array(10),
        nativeClassName: '#32770',
        dialogBaseUnitX: base.x,
        dialogBaseUnitY: base.y,
    };
    info.extraBytes![1] = page.dlgProc >>> 0; // DWLP_DLGPROC
    windows.set(hwnd, info);

    const frame = windows.get(sheet.hwndFrame);
    if (frame && !frame.children.includes(hwnd)) frame.children.push(hwnd);
    // Windows puts a freshly shown page on top of the tab control it sits inside;
    // children[0] is topmost here, so hit-testing and paint order follow from this.
    reorderChildInParent(hwnd, 0 /* HWND_TOP */);

    if (parsed.controls.length > 0) {
        createDialogChildren(system, hwnd, info, parsed, page.hInstance || 0x400000);
    }

    page.hwndPage = hwnd;
    Logger.log(LogCategory.SYSTEM,
        `PropertySheet: created page "${page.title}" hwnd=0x${hwnd.toString(16)} `
        + `${w}x${h}@(${x},${y}) with ${info.children.length} controls`);
    return hwnd;
}

/**
 * HCBT_CREATEWND for a page window.
 *
 * Not optional decoration: MFC's page callback answers PSPCB_CREATE by arming
 * its CBT hook (AfxHookWindowCreate) so the very next window created is attached
 * to the CPropertyPage object. Skip the hook and the attach never happens, the
 * page's own OnInitDialog never runs, and every control on it stays empty while
 * looking perfectly well laid out.
 */
function* fireCbtCreateWnd(
    sheet: SheetInfo, hwnd: number, createParams: number,
): Generator<SheetSend, void, number> {
    const hooks = getHooksOfType(WH_CBT);
    if (hooks.length === 0) return;
    const process = System.getInstance().process;
    if (!process) return;
    if (!sheet.cbtPtr) {
        // CBT_CREATEWND { LPCREATESTRUCT lpcs; HWND hwndInsertAfter; } + CREATESTRUCT.
        sheet.cbtPtr = process.memory.alloc(8 + 48, 'THUNK_DATA', 'rw');
        if (!sheet.cbtPtr) return;
    }
    const csPtr = sheet.cbtPtr + 8;
    Mem.writeUint32(sheet.cbtPtr + 0, csPtr);
    Mem.writeUint32(sheet.cbtPtr + 4, 0);
    Mem.writeUint32(csPtr + 0, createParams >>> 0); // CREATESTRUCT.lpCreateParams
    for (const hook of hooks) {
        yield {
            proc: hook.lpfn >>> 0,
            args: [HCBT_CREATEWND, hwnd >>> 0, sheet.cbtPtr >>> 0],
            tag: `PropSheet:HCBT_CREATEWND(0x${(hwnd >>> 0).toString(16)})`,
        };
    }
}

function setPageVisible(sheet: SheetInfo, page: SheetPage, visible: boolean): void {
    if (!page.hwndPage) return;
    const info = windows.get(page.hwndPage);
    if (!info) return;
    info.visible = visible;
    info.style = visible ? (info.style | WS_VISIBLE) >>> 0 : (info.style & ~WS_VISIBLE) >>> 0;
    const wmWin = System.getInstance().windowManager.getWindow(page.hwndPage);
    if (wmWin) wmWin.visible = visible;
    if (visible) reorderChildInParent(page.hwndPage, 0 /* HWND_TOP */);
}

function firstTabStop(hwnd: number): number {
    const win = windows.get(hwnd);
    if (!win) return 0;
    for (const childHwnd of win.children) {
        const child = windows.get(childHwnd);
        if (!child) continue;
        if ((child.style & WS_TABSTOP) && (child.style & WS_DISABLED) === 0 && child.visible) {
            return childHwnd;
        }
    }
    return win.children[0] ?? 0;
}

// ---------------------------------------------------------------------------
// Protocol routines
// ---------------------------------------------------------------------------

function activePage(sheet: SheetInfo): SheetPage | undefined {
    return sheet.activeIndex >= 0 ? sheet.pages[sheet.activeIndex] : undefined;
}

function enableFrameControl(sheet: SheetInfo, id: number, enabled: boolean): void {
    const win = getFrameControl(sheet, id);
    if (!win) return;
    const next = enabled ? (win.style & ~WS_DISABLED) >>> 0 : (win.style | WS_DISABLED) >>> 0;
    if (next === win.style) return;
    win.style = next;
    const wmWin = System.getInstance().windowManager.getWindow(win.handle);
    if (wmWin) wmWin.style = next;
}

function repaintSheet(sheet: SheetInfo): void {
    if (!sheet.ended && windows.has(sheet.hwndFrame)) {
        repaintDialogAfterContentChange(sheet.hwndFrame);
    }
}

/** PROPSHEET_CanSetCurSel: PSN_KILLACTIVE on the active page; TRUE vetoes. */
function* canSetCurSel(sheet: SheetInfo): Generator<SheetSend, boolean, number> {
    const page = activePage(sheet);
    if (!page?.hwndPage) return true;
    const veto = yield psn(sheet, page.hwndPage, PSN_KILLACTIVE);
    return veto === 0;
}

/**
 * PROPSHEET_SetCurSel. Creates the page if needed, then PSN_SETACTIVE: 0 accepts,
 * -1 skips in `skipDir`, anything else names a page by its template resource id.
 */
function* setCurSel(sheet: SheetInfo, index: number, skipDir: number): Generator<SheetSend, boolean, number> {
    if (index < 0 || index >= sheet.pages.length) return false;

    const previous = activePage(sheet);
    if (previous) setPageVisible(sheet, previous, false);
    sheet.activeIndex = -1;

    let guard = 0;
    for (;;) {
        if (guard++ > sheet.pages.length + 4) {
            Logger.warn(LogCategory.SYSTEM, 'PropertySheet: PSN_SETACTIVE kept redirecting; stopping');
            break;
        }
        const page = sheet.pages[index];
        if (!page) break;

        tabMessage(sheet, TCM_SETCURSEL, index, 0);

        if (!page.hwndPage) {
            // comctl32 discards PSPCB_CREATE's result and creates the page anyway.
            yield pspCallback(page, PSPCB_CREATE);
            if (!createPageWindow(sheet, page)) {
                Logger.warn(LogCategory.SYSTEM,
                    `PropertySheet: page ${index} "${page.title}" could not be created`);
                sheet.pages.splice(index, 1);
                tabMessage(sheet, TCM_DELETEITEM, index, 0);
                if (index >= sheet.pages.length) index = sheet.pages.length - 1;
                if (index < 0) return false;
                continue;
            }
            yield* fireCbtCreateWnd(sheet, page.hwndPage, page.pspPtr);
            const focus = firstTabStop(page.hwndPage);
            // WM_INITDIALOG's lParam on a property page is the PROPSHEETPAGE itself.
            const initRet = yield msgTo(page.hwndPage, WM_INITDIALOG, focus, page.pspPtr,
                'PropSheet:page WM_INITDIALOG');
            if (initRet && focus) System.getInstance().windowManager.setFocus(focus);
        }

        const result = yield psn(sheet, page.hwndPage, PSN_SETACTIVE);
        if (result === 0) break;
        if ((result | 0) === -1) {
            index += skipDir;
            if (index < 0) { index = 0; break; }
            if (index >= sheet.pages.length) { index = sheet.pages.length - 1; break; }
            continue;
        }
        const byId = sheet.pages.findIndex((p) => p.templateId === (result | 0));
        if (byId < 0) break;
        index = byId;
    }

    const page = sheet.pages[index];
    if (!page) return false;
    setPageVisible(sheet, page, true);
    sheet.activeIndex = index;
    sheet.activeValid = true;
    tabMessage(sheet, TCM_SETCURSEL, index, 0);
    enableFrameControl(sheet, IDHELP, page.hasHelp);
    repaintSheet(sheet);
    // ShowWindow on the page is what makes its controls appear on Windows; the
    // frame's own repaint only covers the frame's direct children, so the page
    // subtree needs its own paint cycle or the pane stays empty grey.
    repaintDialogOverlayIfVisible(page.hwndPage);
    return true;
}

/** PROPSHEET_Apply. lParam is 1 for OK, 0 for Apply, per comctl32. */
function* applySheet(sheet: SheetInfo, lParam: number): Generator<SheetSend, boolean, number> {
    const active = activePage(sheet);
    if (!active?.hwndPage) return false;

    if ((yield psn(sheet, active.hwndPage, PSN_KILLACTIVE)) !== 0) return false;

    for (let i = 0; i < sheet.pages.length; i++) {
        const page = sheet.pages[i];
        if (!page.hwndPage) continue;
        const verdict = yield psn(sheet, page.hwndPage, PSN_APPLY, lParam);
        if (verdict === PSNRET_INVALID) {
            yield* setCurSel(sheet, i, 1);
            return false;
        }
        if (verdict === PSNRET_INVALID_NOCHANGEPAGE) return false;
    }

    if (lParam) {
        sheet.activeValid = false;
    } else if (sheet.activeIndex >= 0) {
        const page = sheet.pages[sheet.activeIndex];
        if (page?.hwndPage) yield psn(sheet, page.hwndPage, PSN_SETACTIVE);
    }
    return true;
}

/** PROPSHEET_Cancel: PSN_QUERYCANCEL may veto, then PSN_RESET to every page. */
function* cancelSheet(sheet: SheetInfo, lParam: number): Generator<SheetSend, boolean, number> {
    const active = activePage(sheet);
    if (!active?.hwndPage) return false;
    if ((yield psn(sheet, active.hwndPage, PSN_QUERYCANCEL)) !== 0) return false;

    for (const page of sheet.pages) {
        if (page.hwndPage) yield psn(sheet, page.hwndPage, PSN_RESET, lParam);
    }
    return true;
}

function* querySiblings(sheet: SheetInfo, wParam: number, lParam: number): Generator<SheetSend, number, number> {
    for (const page of sheet.pages) {
        if (!page.hwndPage) continue;
        const answer = yield msgTo(page.hwndPage, PSM_QUERYSIBLINGS, wParam, lParam,
            'PropSheet:PSM_QUERYSIBLINGS', true);
        if (answer !== 0) return answer;
    }
    return 0;
}

/**
 * comctl32 ends a MODAL sheet by leaving its own loop; a MODELESS one it only
 * marks invalid (PSM_GETCURRENTPAGEHWND then answers NULL) and leaves standing —
 * the app owns the window and destroys it when its own loop exits.
 */
function endSheet(sheet: SheetInfo, result: number): void {
    if (sheet.ended) return;
    sheet.result = result;
    sheet.activeValid = false;
    if (sheet.modeless) return;
    sheet.ended = true;
    endModalDialog(sheet.hwndFrame, result);
}

/** PROPSHEET_DoCommand. Returns 1 when `id` is one of the sheet's own buttons. */
function* doCommand(sheet: SheetInfo, id: number): Generator<SheetSend, number, number> {
    switch (id) {
        case IDOK:
        case IDC_APPLY_BUTTON: {
            const ok = yield* applySheet(sheet, id === IDOK ? 1 : 0);
            if (!ok) return 1;
            if (id === IDOK) {
                // A page's PSM_RESTARTWINDOWS/REBOOTSYSTEM result outranks IDOK.
                if (sheet.result === 0) sheet.result = IDOK;
                endSheet(sheet, sheet.result);
            } else {
                enableFrameControl(sheet, IDC_APPLY_BUTTON, false);
                repaintSheet(sheet);
            }
            return 1;
        }
        case IDCANCEL: {
            const ok = yield* cancelSheet(sheet, 0);
            if (ok) endSheet(sheet, sheet.result || IDCANCEL);
            return 1;
        }
        case IDHELP: {
            const page = activePage(sheet);
            if (page?.hwndPage) yield psn(sheet, page.hwndPage, PSN_HELP);
            return 1;
        }
        default:
            return 0;
    }
}

// ---------------------------------------------------------------------------
// The frame DLGPROC
// ---------------------------------------------------------------------------

function* initSheet(sheet: SheetInfo): Generator<SheetSend, number, number> {
    fillTabControl(sheet);
    layoutSheet(sheet);
    yield pscbCallback(sheet, PSCB_INITIALIZED);
    let start = sheet.startPage;
    if (start < 0 || start >= sheet.pages.length) start = 0;
    yield* setCurSel(sheet, start, 1);
    // FALSE: comctl32 has already put the focus on the active page's first control,
    // and a TRUE would have USER move it to the frame's first tab stop instead.
    return 0;
}

/**
 * Answer a message the way a dialog procedure must: the real result goes in
 * DWLP_MSGRESULT, which is what DefDlgProc hands back to SendMessage. The same
 * value is also returned in EAX so a caller that reaches this procedure without
 * DefDlgProc in the path (an un-subclassed sheet) still reads the right answer;
 * a zero result is indistinguishable either way, because default processing of
 * a PSM_* is itself zero.
 */
function answer(hDlg: number, value: number): number {
    const win = windows.get(hDlg);
    if (win?.extraBytes) win.extraBytes[0] = value >>> 0;
    return value >>> 0;
}

/**
 * The sheet frame's dialog procedure. Registered as a comctl32 export purely so
 * it has a guest-visible code address (see getPropSheetDlgProcAddress).
 */
export function propSheetDlgProc(
    ctx: any, mem: Uint8Array, args: number[],
): number | ThunkResult {
    const hDlg = args[0] >>> 0;
    const msg = args[1] >>> 0;
    const wParam = args[2] >>> 0;
    const lParam = args[3] >>> 0;

    if (msg === WM_INITDIALOG) {
        const sheet = sheetsById.get(lParam >>> 0);
        if (!sheet) {
            Logger.warn(LogCategory.SYSTEM,
                `PropertySheetDlgProc: WM_INITDIALOG with unknown sheet id ${lParam}`);
            return 0;
        }
        sheet.hwndFrame = hDlg;
        sheetsByFrame.set(hDlg, sheet);
        return runSheetRoutine(ctx, mem, initSheet(sheet), 'PropSheet:init');
    }

    const sheet = sheetsByFrame.get(hDlg);
    if (!sheet) return 0;

    switch (msg) {
        case WM_COMMAND: {
            const id = wParam & 0xffff;
            return runSheetRoutine(ctx, mem, (function* () {
                const handled = yield* doCommand(sheet, id);
                if (!handled && sheet.activeValid) {
                    // comctl32 forwards a command it has no button for to the page.
                    const page = activePage(sheet);
                    if (page?.hwndPage) {
                        yield msgTo(page.hwndPage, WM_COMMAND, wParam, lParam,
                            'PropSheet:forward WM_COMMAND');
                    }
                }
                return 1;
            })(), 'PropSheet:command');
        }

        case WM_CLOSE:
            // comctl32 cancels and then returns FALSE so DefDlgProc still posts
            // WM_COMMAND/IDCANCEL, which is what an app's own handler watches for.
            return runSheetRoutine(ctx, mem, (function* () {
                yield* cancelSheet(sheet, 1);
                return 0;
            })(), 'PropSheet:close');

        case WM_DESTROY:
            releaseSheet(sheet);
            return 1;

        case WM_NOTIFY: {
            const code = (Mem.readUint32(lParam + 8) ?? 0) >>> 0;
            if (code === TCN_SELCHANGE) {
                const index = tabMessage(sheet, TCM_GETCURSEL, 0, 0);
                const verdict = sheet.pendingSwitchVeto;
                sheet.pendingSwitchVeto = null;
                return runSheetRoutine(ctx, mem, (function* () {
                    // The tab control answered the click itself, so a page that
                    // refuses to leave has to be put back — comctl32 does the same.
                    const before = sheet.activeIndex;
                    const may = verdict !== null ? !verdict : yield* canSetCurSel(sheet);
                    if (!may) {
                        tabMessage(sheet, TCM_SETCURSEL, before, 0);
                        repaintSheet(sheet);
                        return 0;
                    }
                    yield* setCurSel(sheet, index, 1);
                    return 0;
                })(), 'PropSheet:TCN_SELCHANGE');
            }
            if (code === TCN_SELCHANGING) {
                return runSheetRoutine(ctx, mem, (function* () {
                    const may = yield* canSetCurSel(sheet);
                    sheet.pendingSwitchVeto = !may;
                    return answer(hDlg, may ? 0 : 1);
                })(), 'PropSheet:TCN_SELCHANGING');
            }
            return 0;
        }

        case PSM_SETCURSEL: {
            const index = lParam
                ? sheet.pages.findIndex((p) => p.hpage === (lParam >>> 0))
                : (wParam | 0);
            return runSheetRoutine(ctx, mem, (function* () {
                const may = yield* canSetCurSel(sheet);
                if (!may) return answer(hDlg, 0);
                const ok = yield* setCurSel(sheet, index, 1);
                return answer(hDlg, ok ? 1 : 0);
            })(), 'PropSheet:PSM_SETCURSEL');
        }

        case PSM_SETCURSELID: {
            const index = sheet.pages.findIndex((p) => p.templateId === (lParam | 0));
            if (index < 0) return 1;
            return runSheetRoutine(ctx, mem, (function* () {
                const may = yield* canSetCurSel(sheet);
                if (may) yield* setCurSel(sheet, index, 1);
                return 1;
            })(), 'PropSheet:PSM_SETCURSELID');
        }

        case PSM_CHANGED: {
            const page = sheet.pages.find((p) => p.hwndPage === (wParam >>> 0));
            if (page) page.isDirty = true;
            if (sheet.hasApply) {
                enableFrameControl(sheet, IDC_APPLY_BUTTON, true);
                repaintSheet(sheet);
            }
            return 1;
        }

        case PSM_UNCHANGED: {
            const page = sheet.pages.find((p) => p.hwndPage === (wParam >>> 0));
            if (page) page.isDirty = false;
            if (!sheet.pages.some((p) => p.isDirty)) {
                enableFrameControl(sheet, IDC_APPLY_BUTTON, false);
                repaintSheet(sheet);
            }
            return 1;
        }

        case PSM_APPLY:
            return runSheetRoutine(ctx, mem, (function* () {
                const ok = yield* applySheet(sheet, 0);
                if (ok) {
                    enableFrameControl(sheet, IDC_APPLY_BUTTON, false);
                    repaintSheet(sheet);
                }
                return answer(hDlg, ok ? 1 : 0);
            })(), 'PropSheet:PSM_APPLY');

        case PSM_PRESSBUTTON: {
            const id = pressButtonToCommand(wParam | 0);
            if (id === 0) return 1;
            return runSheetRoutine(ctx, mem, (function* () {
                yield* doCommand(sheet, id);
                return 1;
            })(), 'PropSheet:PSM_PRESSBUTTON');
        }

        case PSM_QUERYSIBLINGS:
            return runSheetRoutine(ctx, mem, (function* () {
                const found = yield* querySiblings(sheet, wParam, lParam);
                return answer(hDlg, found);
            })(), 'PropSheet:PSM_QUERYSIBLINGS');

        case PSM_CANCELTOCLOSE: {
            const ok = getFrameControl(sheet, IDOK);
            if (ok) {
                ok.title = 'Close';
                const wmWin = System.getInstance().windowManager.getWindow(ok.handle);
                if (wmWin) wmWin.title = 'Close';
            }
            enableFrameControl(sheet, IDCANCEL, false);
            repaintSheet(sheet);
            return 0;
        }

        case PSM_RESTARTWINDOWS:
            if (!sheet.hasApply) return 0;
            sheet.result = ID_PSRESTARTWINDOWS;
            return 1;

        case PSM_REBOOTSYSTEM:
            if (!sheet.hasApply) return 0;
            sheet.result = ID_PSREBOOTSYSTEM;
            return 1;

        case PSM_GETTABCONTROL:
            return answer(hDlg, getFrameControl(sheet, IDC_TABCONTROL)?.handle ?? 0);

        case PSM_GETCURRENTPAGEHWND:
            return answer(hDlg,
                sheet.activeValid ? (activePage(sheet)?.hwndPage ?? 0) : 0);

        case PSM_GETRESULT:
            return answer(hDlg, sheet.result);

        case PSM_HWNDTOINDEX:
            return answer(hDlg, sheet.pages.findIndex((p) => p.hwndPage === (wParam >>> 0)));

        case PSM_INDEXTOHWND:
            return answer(hDlg, sheet.pages[wParam | 0]?.hwndPage ?? 0);

        case PSM_PAGETOINDEX:
            return answer(hDlg, sheet.pages.findIndex((p) => p.hpage === (lParam >>> 0)));

        case PSM_INDEXTOPAGE:
            return answer(hDlg, sheet.pages[wParam | 0]?.hpage ?? 0);

        case PSM_IDTOINDEX:
            return answer(hDlg, sheet.pages.findIndex((p) => p.templateId === (lParam | 0)));

        case PSM_INDEXTOID:
            return answer(hDlg, sheet.pages[wParam | 0]?.templateId ?? 0);

        case PSM_SETTITLEA:
        case PSM_SETTITLEW: {
            const frame = windows.get(sheet.hwndFrame);
            if (!frame) return 1;
            let title = lParam ? readCaption(mem, lParam, msg === PSM_SETTITLEW) : '';
            if ((wParam & PSH_PROPTITLE) && title) title = `${title} Properties`;
            frame.title = title;
            const wmWin = System.getInstance().windowManager.getWindow(sheet.hwndFrame);
            if (wmWin) wmWin.title = title;
            repaintSheet(sheet);
            return 1;
        }

        case PSM_RECALCPAGESIZES:
            layoutSheet(sheet);
            repaintSheet(sheet);
            return answer(hDlg, 1);

        case PSM_ISDIALOGMESSAGE:
            // The app's own loop calls IsDialogMessage for us; answering TRUE here
            // would make it swallow every message it just asked us about.
            return answer(hDlg, 0);

        case PSM_ADDPAGE:
        case PSM_REMOVEPAGE:
        case PSM_SETWIZBUTTONS:
            Logger.warn(LogCategory.SYSTEM,
                `PropertySheet: msg WM_USER+${msg - WM_USER} is not implemented`);
            return 1;

        default:
            return 0;
    }
}

function pressButtonToCommand(button: number): number {
    switch (button) {
        case PSBTN_OK: return IDOK;
        case PSBTN_APPLYNOW: return IDC_APPLY_BUTTON;
        case PSBTN_CANCEL: return IDCANCEL;
        case PSBTN_HELP: return IDHELP;
        case PSBTN_BACK:
        case PSBTN_NEXT:
        case PSBTN_FINISH:
            Logger.warn(LogCategory.SYSTEM,
                `PropertySheet: PSM_PRESSBUTTON(${button}) is a wizard button (not implemented)`);
            return 0;
        default: return 0;
    }
}

function releaseSheet(sheet: SheetInfo): void {
    const process = System.getInstance().process;
    for (const page of sheet.pages) {
        if (page.hwndPage && windows.has(page.hwndPage)) {
            const info = windows.get(page.hwndPage);
            for (const child of [...(info?.children ?? [])]) finalizeWindowDestroy(child);
            finalizeWindowDestroy(page.hwndPage);
        }
        page.hwndPage = 0;
    }
    if (sheet.cbtPtr) process?.memory.free(sheet.cbtPtr);
    if (sheet.notifyPtr) process?.memory.free(sheet.notifyPtr);
    if (sheet.templatePtr) process?.memory.free(sheet.templatePtr);
    if (sheet.ptrBlock) process?.memory.free(sheet.ptrBlock);
    sheet.notifyPtr = 0;
    sheet.templatePtr = 0;
    sheet.cbtPtr = 0;
    sheet.ptrBlock = 0;
    sheetsById.delete(sheet.id);
    sheetsByFrame.delete(sheet.hwndFrame);
}

// ---------------------------------------------------------------------------
// PropertySheetA / PropertySheetW
// ---------------------------------------------------------------------------

/**
 * Build the sheet and run its frame dialog modally. Returns through the modal
 * dialog's own frame restoration, so the guest sees IDOK/IDCANCEL (or the
 * ID_PSRESTARTWINDOWS/ID_PSREBOOTSYSTEM a page asked for) in EAX.
 */
export function propertySheet(
    ctx: any, mem: Uint8Array, args: number[], unicode: boolean,
    resolveHandle: (hpage: number) => number,
): number | ThunkResult {
    const headerPtr = args[0] >>> 0;
    const label = unicode ? 'PropertySheetW' : 'PropertySheetA';
    const STACK_CLEANUP = 4;
    if (!headerPtr) {
        Logger.warn(LogCategory.SYSTEM, `${label}: NULL header`);
        return -1;
    }

    const system = System.getInstance();
    const process = system.process;
    if (!process) return -1;

    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const dwFlags = v.getUint32(headerPtr + 0x04, true) >>> 0;
    const hwndParent = v.getUint32(headerPtr + 0x08, true) >>> 0;
    const hInstance = v.getUint32(headerPtr + 0x0c, true) >>> 0;
    const pszCaption = v.getUint32(headerPtr + 0x14, true) >>> 0;
    const nPages = v.getUint32(headerPtr + 0x18, true) >>> 0;
    const nStartPage = v.getUint32(headerPtr + 0x1c, true) >>> 0;
    const ppsp = v.getUint32(headerPtr + 0x20, true) >>> 0;
    const pfnCallback = v.getUint32(headerPtr + 0x24, true) >>> 0;

    Logger.log(LogCategory.SYSTEM,
        `${label}: flags=0x${dwFlags.toString(16)} nPages=${nPages} ppsp=0x${ppsp.toString(16)} `
        + `parent=0x${hwndParent.toString(16)} start=${nStartPage}`);

    if (nPages === 0 || !ppsp) {
        Logger.warn(LogCategory.SYSTEM, `${label}: no pages`);
        return -1;
    }
    if (dwFlags & PSH_WIZARD_ANY) {
        Logger.warn(LogCategory.SYSTEM,
            `${label}: wizard flags 0x${(dwFlags & PSH_WIZARD_ANY).toString(16)} are not implemented; `
            + 'running as a tabbed sheet');
    }

    let caption = readCaption(mem, pszCaption, unicode);
    if (dwFlags & PSH_PROPTITLE) caption = `${caption} Properties`;

    const sheet: SheetInfo = {
        id: nextSheetId++,
        hwndFrame: 0,
        dwFlags,
        hInstance,
        hwndParent,
        caption,
        pfnCallback,
        unicode,
        pages: [],
        activeIndex: -1,
        activeValid: false,
        result: 0,
        hasApply: (dwFlags & PSH_NOAPPLYNOW) === 0,
        hasHelp: (dwFlags & PSH_HASHELP) !== 0,
        startPage: (dwFlags & PSH_USEPSTARTPAGE) ? 0 : (nStartPage | 0),
        pageW: 0,
        pageH: 0,
        pageWpx: 0,
        pageHpx: 0,
        pageRect: { left: 0, top: 0, right: 0, bottom: 0 },
        notifyPtr: 0,
        templatePtr: 0,
        cbtPtr: 0,
        ptrBlock: 0,
        ended: false,
        modeless: (dwFlags & PSH_MODELESS) !== 0,
        pendingSwitchVeto: null,
    };

    // PSH_PROPSHEETPAGE clear ⇒ the array holds HPROPSHEETPAGE handles.
    const inlinePages = (dwFlags & PSH_PROPSHEETPAGE) !== 0;
    const firstSize = inlinePages ? (v.getUint32(ppsp, true) >>> 0) : 0;
    const stride = firstSize >= 0x28 ? firstSize : 0x28;

    for (let i = 0; i < nPages; i++) {
        const pspPtr = inlinePages
            ? ppsp + i * stride
            : resolveHandle(v.getUint32(ppsp + i * 4, true) >>> 0);
        const hpage = inlinePages ? 0 : (v.getUint32(ppsp + i * 4, true) >>> 0);
        const page = collectPage(mem, pspPtr, hpage, unicode);
        if (!page) {
            Logger.warn(LogCategory.SYSTEM, `${label}: page[${i}] could not be resolved`);
            continue;
        }
        if (!page.dlgProc || !page.templatePtr) {
            Logger.warn(LogCategory.SYSTEM,
                `${label}: page[${i}] "${page.title}" has no `
                + `${page.dlgProc ? 'template' : 'dlgProc'}; skipped`);
            continue;
        }
        sheet.pages.push(page);
        sheet.pageW = Math.max(sheet.pageW, page.cx);
        sheet.pageH = Math.max(sheet.pageH, page.cy);
        sheet.pageWpx = Math.max(sheet.pageWpx, page.wpx);
        sheet.pageHpx = Math.max(sheet.pageHpx, page.hpx);
        Logger.log(LogCategory.SYSTEM,
            `${label}:   page[${i}] "${page.title}" ${page.cx}x${page.cy} DLU `
            + `dlgProc=0x${page.dlgProc.toString(16)} tmpl=0x${page.templatePtr.toString(16)}`);
    }

    if (sheet.pages.length === 0) {
        Logger.warn(LogCategory.SYSTEM, `${label}: no usable pages`);
        return -1;
    }
    if (!caption) caption = sheet.pages[0].title;

    const dlgProcAddr = getPropSheetDlgProcAddress();
    if (!dlgProcAddr) {
        Logger.error(LogCategory.SYSTEM, `${label}: no thunk stub for the frame dialog procedure`);
        return -1;
    }

    // PSHNOTIFY + a scratch tail for the tab item text / TCITEM.
    sheet.notifyPtr = process.memory.alloc(PSHNOTIFY_SIZE + 128 + 32, 'THUNK_DATA', 'rw');
    const templateBytes = buildFrameTemplate(caption, sheet.pageW, sheet.pageH, sheet);
    sheet.templatePtr = process.memory.alloc(templateBytes.length, 'THUNK_DATA', 'rw');
    if (!sheet.notifyPtr || !sheet.templatePtr) {
        Logger.error(LogCategory.SYSTEM, `${label}: could not allocate sheet scratch`);
        return -1;
    }
    mem.set(templateBytes, sheet.templatePtr);

    ensureSheetPurger();
    sheetsById.set(sheet.id, sheet);

    Logger.log(LogCategory.SYSTEM,
        `${label}: running sheet #${sheet.id} with ${sheet.pages.length} page(s), `
        + `largest ${sheet.pageW}x${sheet.pageH} DLU, dlgProc=0x${dlgProcAddr.toString(16)}`);

    // PSH_MODELESS returns the sheet's HWND and lets the app pump it — which is
    // how MFC ALWAYS creates one (CPropertySheet::DoModal sets the flag and then
    // runs its own modal loop). Returning IDOK there hands MFC a bogus HWND.
    if (sheet.modeless) {
        return createModelessDialogFromTemplate(
            ctx, hInstance || 0x400000, hwndParent, dlgProcAddr,
            sheet.id, label, sheet.templatePtr, STACK_CLEANUP,
        );
    }
    return runModalDialogFromTemplate(
        ctx, mem, hInstance || 0x400000, hwndParent, dlgProcAddr,
        sheet.id, label, sheet.templatePtr, STACK_CLEANUP,
    );
}

/** Harness/diagnostic view of a live sheet. */
export function formatPropSheetDiagnostic(): string {
    if (sheetsByFrame.size === 0) {
        return notifyTrace.length
            ? `no property sheet (${notifyTrace.length} notification(s) traced)`
            : 'no property sheet';
    }
    const out: string[] = [];
    for (const sheet of sheetsByFrame.values()) {
        out.push(`sheet#${sheet.id} frame=0x${sheet.hwndFrame.toString(16)} `
            + `active=${sheet.activeIndex} result=${sheet.result} pages=[`
            + sheet.pages.map((p, i) =>
                `${i === sheet.activeIndex ? '*' : ''}${p.title}:0x${p.hwndPage.toString(16)}`
                + `${p.isDirty ? '+dirty' : ''}`).join(' ')
            + ']');
    }
    return out.join('\n');
}

/** True when the page subtree of a live sheet contains `hwnd`. */
export function isPropSheetPage(hwnd: number): boolean {
    for (const sheet of sheetsByFrame.values()) {
        if (sheet.pages.some((p) => p.hwndPage === hwnd)) return true;
    }
    return false;
}

