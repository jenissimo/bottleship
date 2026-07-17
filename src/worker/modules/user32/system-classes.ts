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

/** The thunk layout is rebuilt on bundle switch — the cached stub address dies with it. */
export function resetDefWindowProcCache(): void {
    cachedDefWindowProcAddr = 0;
}

export function getDefWindowProcAddress(): number {
    if (cachedDefWindowProcAddr) return cachedDefWindowProcAddr;
    const system = System.getInstance();
    const dispatcher = system.process?.dispatcher as any;
    const tg = dispatcher?.thunkGenerator;
    if (tg) {
        // Prefer the stub generated during PE import processing.
        let addr = tg.getExportAddress('user32:defwindowproca') ?? tg.getExportAddress('defwindowproca');
        if (!addr) {
            // App didn't import DefWindowProcA — allocate a stub on demand
            // (stdcall, 4 args: hWnd, Msg, wParam, lParam).
            try {
                const { address, code } = tg.allocateOneStub('user32', 'DefWindowProcA', 4, 'stdcall');
                const memArray = system.process?.getCurrentMemory();
                if (memArray && address + code.length <= memArray.length) {
                    memArray.set(code, address);
                    dispatcher.applyPendingRegistrations?.();
                    addr = address;
                    Logger.log(LogCategory.USER32,
                        `Allocated DefWindowProcA stub on demand at 0x${address.toString(16)}`);
                }
            } catch (e) {
                Logger.warn(LogCategory.USER32, `Failed to allocate DefWindowProcA stub: ${e}`);
            }
        }
        if (addr) {
            cachedDefWindowProcAddr = addr;
            Logger.log(LogCategory.USER32,
                `Resolved DefWindowProcA thunk address: 0x${addr.toString(16)}`);
            return addr;
        }
    }
    Logger.warn(LogCategory.USER32, 'Could not resolve DefWindowProcA thunk address');
    return 0;
}
