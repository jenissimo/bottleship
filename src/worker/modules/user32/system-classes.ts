/**
 * Built-in user32 window classes (Button, Static, Edit, ListBox, ComboBox,
 * ComboLBox, ScrollBar, MDIClient) — the classes real Windows pre-registers
 * before any app code runs. Class styles / cbWndExtra follow the classic
 * (pre-comctl32-v6) user32 layout.
 *
 * CreateWindowEx resolves these when no app-registered class shadows the name;
 * the resulting windows are JS-driven system controls (isSystemControl), same
 * machinery as dialog-template children.
 */

import { System } from '../../core/system';
import { writeGuestCode } from '../../core/memory/guest-code';
import { Logger, LogCategory } from '../../core/logger';
import { IDC_ARROW, IDC_IBEAM } from './system-cursors';

// Class styles (WNDCLASS.style)
const CS_VREDRAW = 0x0001;
const CS_HREDRAW = 0x0002;
const CS_DBLCLKS = 0x0008;
const CS_PARENTDC = 0x0080;
const CS_SAVEBITS = 0x0800;

export interface BuiltinSystemClass {
    /** Canonical mixed-case class name as real Windows reports it. */
    name: string;
    style: number;
    cbWndExtra: number;
    idcCursor: number;
    /** systemControlClass for the JS control machinery; undefined = plain window. */
    controlClass?: string;
}

const BUILTIN_SYSTEM_CLASSES: ReadonlyMap<string, BuiltinSystemClass> = new Map(
    ([
        { name: 'Button', style: CS_DBLCLKS | CS_VREDRAW | CS_HREDRAW | CS_PARENTDC, cbWndExtra: 12, idcCursor: IDC_ARROW, controlClass: 'Button' },
        { name: 'Static', style: CS_DBLCLKS | CS_PARENTDC, cbWndExtra: 8, idcCursor: IDC_ARROW, controlClass: 'Static' },
        { name: 'Edit', style: CS_DBLCLKS | CS_PARENTDC, cbWndExtra: 8, idcCursor: IDC_IBEAM, controlClass: 'Edit' },
        { name: 'ListBox', style: CS_DBLCLKS, cbWndExtra: 4, idcCursor: IDC_ARROW, controlClass: 'ListBox' },
        { name: 'ComboBox', style: CS_PARENTDC | CS_DBLCLKS | CS_HREDRAW | CS_VREDRAW, cbWndExtra: 4, idcCursor: IDC_ARROW, controlClass: 'ComboBox' },
        // The combo's drop-down list is a listbox under a different class name.
        { name: 'ComboLBox', style: CS_DBLCLKS | CS_SAVEBITS, cbWndExtra: 4, idcCursor: IDC_ARROW, controlClass: 'ListBox' },
        { name: 'ScrollBar', style: CS_DBLCLKS | CS_VREDRAW | CS_HREDRAW | CS_PARENTDC, cbWndExtra: 4, idcCursor: IDC_ARROW, controlClass: 'ScrollBar' },
        { name: 'MDIClient', style: 0, cbWndExtra: 8, idcCursor: IDC_ARROW },
    ] satisfies BuiltinSystemClass[]).map((d) => [d.name.toLowerCase(), d]),
);

/** Descriptor for a built-in user32 class, or undefined. Case-insensitive. */
export function getBuiltinSystemClass(className: string): BuiltinSystemClass | undefined {
    return BUILTIN_SYSTEM_CLASSES.get(className.toLowerCase());
}

/**
 * Cached DefWindowProcA thunk address, lazily resolved from the ThunkGenerator.
 * System controls use this as their wndProc: it's a real x86 thunk stub, so
 * GetWindowLong(GWL_WNDPROC), CallWindowProcA and a direct CALL all work.
 * When the thunk fires, the DefWindowProcA handler runs in JS.
 */
let cachedDefWindowProcAddr = 0;
let cachedDefDlgProcAddr = 0;

/** The thunk layout is rebuilt on bundle switch — the cached stub address dies with it. */
export function resetDefWindowProcCache(): void {
    cachedDefWindowProcAddr = 0;
    cachedDefDlgProcAddr = 0;
}

/**
 * Resolve (or allocate) the x86 thunk stub for an export used as a wndProc.
 *
 * A window procedure must be a real code address: the guest can read it back
 * through GWL_WNDPROC, CALL it, or subclass around it. Any HLE module that owns
 * a window class or a dialog procedure of its own (comctl32's property sheet)
 * gets its address from here rather than inventing a handle.
 */
export function resolveModuleWndProcStub(moduleName: string, exportName: string): number {
    const system = System.getInstance();
    const dispatcher = system.process?.dispatcher as any;
    const tg = dispatcher?.thunkGenerator;
    if (!tg) {
        Logger.warn(LogCategory.USER32, `Could not resolve ${exportName} thunk address`);
        return 0;
    }
    const key = exportName.toLowerCase();
    // Prefer the stub generated during PE import processing.
    let addr = tg.getExportAddress(`${moduleName}:${key}`) ?? tg.getExportAddress(key);
    if (!addr) {
        // App didn't import it — allocate a stub on demand
        // (stdcall, 4 args: hWnd, Msg, wParam, lParam).
        try {
            const { address, code } = tg.allocateOneStub(moduleName, exportName, 4, 'stdcall');
            const memArray = system.process?.getCurrentMemory();
            if (memArray && address + code.length <= memArray.length) {
                writeGuestCode(memArray, code, address);
                dispatcher.applyPendingRegistrations?.();
                addr = address;
                Logger.log(LogCategory.USER32,
                    `Allocated ${exportName} stub on demand at 0x${address.toString(16)}`);
            }
        } catch (e) {
            Logger.warn(LogCategory.USER32, `Failed to allocate ${exportName} stub: ${e}`);
        }
    }
    if (!addr) {
        Logger.warn(LogCategory.USER32, `Could not resolve ${exportName} thunk address`);
        return 0;
    }
    // The dispatcher's return-address check must let this stub be entered from the
    // callback stub pool: as a wndproc it IS a callback target.
    (System.getInstance().process?.dispatcher as any)?.markWndProcStub?.(addr);
    Logger.log(LogCategory.USER32, `Resolved ${exportName} thunk address: 0x${addr.toString(16)}`);
    return addr;
}

function resolveWndProcStub(exportName: string): number {
    return resolveModuleWndProcStub('user32', exportName);
}

export function getDefWindowProcAddress(): number {
    if (!cachedDefWindowProcAddr) cachedDefWindowProcAddr = resolveWndProcStub('DefWindowProcA');
    return cachedDefWindowProcAddr;
}

/**
 * The window procedure a `#32770` reports through GWL_WNDPROC. Win32 gives a dialog
 * USER's DefDlgProc and keeps the app's DlgProc in DWLP_DLGPROC; a subclasser stores
 * whatever GWL_WNDPROC returned and calls it for every message it does not handle, so
 * this address has to land in real default processing.
 */
export function getDefDlgProcAddress(): number {
    if (!cachedDefDlgProcAddr) cachedDefDlgProcAddr = resolveWndProcStub('DefDlgProcA');
    return cachedDefDlgProcAddr;
}
