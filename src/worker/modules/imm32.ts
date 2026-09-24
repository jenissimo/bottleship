/**
 * IMM32.dll — the Input Method Manager of a system with no IME installed.
 *
 * Contexts, window association and the INPUTCONTEXT block are real (imm32-context.ts):
 * open/conversion status live in the INPUTCONTEXT, so a caller that locks the context and
 * reads fOpen sees what ImmSetOpenStatus wrote. Composition and candidate data stay empty
 * because no IME ever produces any.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation, X86Context } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { windows, registerWindowDestroyObserver, finalizeWindowDestroy } from "./user32/shared-state";
import {
    ImmContextTable, ImmLocalMemory, ImmWindowHost, INPUTCONTEXT, LHND,
} from "./imm32-context";

const TRUE = 1;
const FALSE = 0;
const IMM_ERROR_NODATA = -1;

const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_DISABLED = 0x08000000;
const IME_CLASS = "IME";
const IME_WINDOW_TITLE = "Default IME";

type Kernel32Exports = Record<string, ThunkImplementation>;

/** LocalAlloc & co. through kernel32's own handlers, so IMCC handles ARE local handles. */
function kernel32LocalMemory(ctx: X86Context, mem: Uint8Array): ImmLocalMemory {
    const k32 = (System.getInstance().process?.getModule("kernel32") as { exports?: Kernel32Exports } | undefined)?.exports;
    const call = (name: string, args: number[]): number => {
        const fn = k32?.[name];
        if (!fn) return 0;
        const ret = fn(ctx, mem, args);
        return typeof ret === "number" ? ret >>> 0 : 0;
    };
    return {
        alloc: (bytes) => call("LocalAlloc", [LHND, bytes]),
        lock: (h) => call("LocalLock", [h]),
        unlock: (h) => call("LocalUnlock", [h]),
        free: (h) => call("LocalFree", [h]),
        // Local and Global share one handle table; kernel32 exports only the Global spelling.
        lockCount: (h) => {
            const flags = call("GlobalFlags", [h]);
            return flags === 0xffffffff ? 0 : flags & 0xff;
        },
        size: (h) => call("GlobalSize", [h]),
        realloc: (h, bytes) => call("LocalReAlloc", [h, bytes, LHND]),
    };
}

function isTopLevel(style: number): boolean {
    return (style & WS_CHILD) === 0;
}

const windowHost: ImmWindowHost = {
    currentThreadId: () => System.getInstance().scheduler.getCurrentThreadId(),
    windowThread: (hwnd) => {
        const h = hwnd >>> 0;
        const win = windows.get(h);
        if (!h || !win || win.pendingDestroy) return undefined;
        return System.getInstance().windowManager.getWindowOwnerThread(h);
    },
    descendants: (hwnd) => {
        const out: number[] = [];
        const walk = (h: number, depth: number): void => {
            if (depth > 64) return;
            for (const child of windows.get(h)?.children ?? []) {
                out.push(child >>> 0);
                walk(child >>> 0, depth + 1);
            }
        };
        walk(hwnd >>> 0, 0);
        return out;
    },
};

export class Imm32 implements IModule {
    name = "imm32";
    exports: Record<string, ThunkImplementation> = {};
    private readonly contexts = new ImmContextTable(windowHost);
    /** Thread id → its default IME window. */
    private imeWindows = new Map<number, number>();
    private destroyObserverRegistered = false;

    initialize(_process: Process): void {
        if (!this.destroyObserverRegistered) {
            registerWindowDestroyObserver((hwnd) => this.windowDestroyed(hwnd));
            this.destroyObserverRegistered = true;
        }
        const contexts = this.contexts;

        // BOOL ImmDisableIME(DWORD idThread)
        this.exports["ImmDisableIME"] = (ctx, mem, args) => {
            const idThread = args[0] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmDisableIME(idThread=${idThread}) -> TRUE`);
            return TRUE;
        };

        // BOOL ImmIsIME(HKL hKL)
        this.exports["ImmIsIME"] = (ctx, mem, args) => {
            const hKL = args[0] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmIsIME(hKL=0x${hKL.toString(16)}) -> FALSE`);
            return FALSE;
        };

        // HIMC ImmGetContext(HWND hWnd) — NULL for a NULL or foreign hWnd, and for a
        // window associated with no context.
        this.exports["ImmGetContext"] = (_ctx, _mem, args) => {
            const hWnd = args[0] >>> 0;
            if (!hWnd) return 0;
            return contexts.windowContext(hWnd) ?? 0;
        };

        this.exports["ImmCreateContext"] = () => contexts.create();

        // BOOL ImmDestroyContext(HIMC hIMC)
        this.exports["ImmDestroyContext"] = (ctx, mem, args) =>
            contexts.destroy(args[0] >>> 0, kernel32LocalMemory(ctx, mem)) ? TRUE : FALSE;

        // BOOL ImmReleaseContext(HWND hWnd, HIMC hIMC) — ImmGetContext takes no reference.
        this.exports["ImmReleaseContext"] = () => TRUE;

        // HIMC ImmAssociateContext(HWND hWnd, HIMC hIMC) — the previous context.
        this.exports["ImmAssociateContext"] = (_ctx, _mem, args) =>
            contexts.associate(args[0] >>> 0, args[1] >>> 0);

        // BOOL ImmAssociateContextEx(HWND hWnd, HIMC hIMC, DWORD dwFlags)
        this.exports["ImmAssociateContextEx"] = (_ctx, _mem, args) =>
            contexts.associateEx(args[0] >>> 0, args[1] >>> 0, args[2] >>> 0) ? TRUE : FALSE;

        // LPINPUTCONTEXT ImmLockIMC(HIMC hIMC)
        this.exports["ImmLockIMC"] = (ctx, mem, args) =>
            contexts.lock(args[0] >>> 0, kernel32LocalMemory(ctx, mem));

        // BOOL ImmUnlockIMC(HIMC hIMC)
        this.exports["ImmUnlockIMC"] = (ctx, mem, args) =>
            contexts.unlock(args[0] >>> 0, kernel32LocalMemory(ctx, mem)) ? TRUE : FALSE;

        // DWORD ImmGetIMCLockCount(HIMC hIMC)
        this.exports["ImmGetIMCLockCount"] = (ctx, mem, args) =>
            contexts.lockCount(args[0] >>> 0, kernel32LocalMemory(ctx, mem));

        // HIMCC ImmCreateIMCC(DWORD dwSize) — LocalAlloc(LHND), never smaller than a DWORD.
        this.exports["ImmCreateIMCC"] = (ctx, mem, args) =>
            kernel32LocalMemory(ctx, mem).alloc(Math.max(4, args[0] >>> 0));

        // HIMCC ImmDestroyIMCC(HIMCC hIMCC) — NULL on success, like LocalFree.
        this.exports["ImmDestroyIMCC"] = (ctx, mem, args) => {
            const h = args[0] >>> 0;
            return h ? kernel32LocalMemory(ctx, mem).free(h) : 0;
        };

        // LPVOID ImmLockIMCC(HIMCC hIMCC)
        this.exports["ImmLockIMCC"] = (ctx, mem, args) => {
            const h = args[0] >>> 0;
            return h ? kernel32LocalMemory(ctx, mem).lock(h) : 0;
        };

        // BOOL ImmUnlockIMCC(HIMCC hIMCC) — LocalUnlock: TRUE only while still locked.
        this.exports["ImmUnlockIMCC"] = (ctx, mem, args) => {
            const h = args[0] >>> 0;
            return h ? kernel32LocalMemory(ctx, mem).unlock(h) : FALSE;
        };

        // DWORD ImmGetIMCCLockCount(HIMCC hIMCC)
        this.exports["ImmGetIMCCLockCount"] = (ctx, mem, args) => {
            const h = args[0] >>> 0;
            return h ? kernel32LocalMemory(ctx, mem).lockCount(h) : 0;
        };

        // DWORD ImmGetIMCCSize(HIMCC hIMCC)
        this.exports["ImmGetIMCCSize"] = (ctx, mem, args) => {
            const h = args[0] >>> 0;
            return h ? kernel32LocalMemory(ctx, mem).size(h) : 0;
        };

        // HIMCC ImmReSizeIMCC(HIMCC hIMCC, DWORD dwSize)
        this.exports["ImmReSizeIMCC"] = (ctx, mem, args) => {
            const h = args[0] >>> 0;
            return h ? kernel32LocalMemory(ctx, mem).realloc(h, args[1] >>> 0) : 0;
        };

        // HWND ImmGetDefaultIMEWnd(HWND hWnd)
        this.exports["ImmGetDefaultIMEWnd"] = (_ctx, _mem, args) => {
            const hWnd = args[0] >>> 0;
            const thread = hWnd ? windowHost.windowThread(hWnd) : windowHost.currentThreadId();
            return thread === undefined ? 0 : this.defaultImeWindow(thread);
        };

        // BOOL ImmGetOpenStatus(HIMC hIMC)
        this.exports["ImmGetOpenStatus"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            if (!hIMC) return FALSE;
            const open = contexts.withInputContext(hIMC, kernel32LocalMemory(ctx, mem),
                (ic) => Mem.readUint32(ic + INPUTCONTEXT.fOpen) ?? 0);
            return open ? TRUE : FALSE;
        };

        // BOOL ImmSetOpenStatus(HIMC hIMC, BOOL fOpen) — only from the owning thread.
        this.exports["ImmSetOpenStatus"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            if (contexts.ownerThread(hIMC) !== windowHost.currentThreadId()) return FALSE;
            const fOpen = (args[1] >>> 0) !== 0 ? TRUE : FALSE;
            const done = contexts.withInputContext(hIMC, kernel32LocalMemory(ctx, mem),
                (ic) => Mem.writeUint32(ic + INPUTCONTEXT.fOpen, fOpen));
            return done ? TRUE : FALSE;
        };

        // BOOL ImmGetConversionStatus(HIMC hIMC, LPDWORD lpfdwConversion, LPDWORD lpfdwSentence)
        this.exports["ImmGetConversionStatus"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const lpfdwConversion = args[1] >>> 0;
            const lpfdwSentence = args[2] >>> 0;
            const done = contexts.withInputContext(hIMC, kernel32LocalMemory(ctx, mem), (ic) => {
                if (lpfdwConversion) Mem.writeUint32(lpfdwConversion, Mem.readUint32(ic + INPUTCONTEXT.fdwConversion) ?? 0);
                if (lpfdwSentence) Mem.writeUint32(lpfdwSentence, Mem.readUint32(ic + INPUTCONTEXT.fdwSentence) ?? 0);
                return true;
            });
            return done ? TRUE : FALSE;
        };

        // BOOL ImmSetConversionStatus(HIMC hIMC, DWORD fdwConversion, DWORD fdwSentence)
        this.exports["ImmSetConversionStatus"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            if (contexts.ownerThread(hIMC) !== windowHost.currentThreadId()) return FALSE;
            const done = contexts.withInputContext(hIMC, kernel32LocalMemory(ctx, mem), (ic) => {
                Mem.writeUint32(ic + INPUTCONTEXT.fdwConversion, args[1] >>> 0);
                Mem.writeUint32(ic + INPUTCONTEXT.fdwSentence, args[2] >>> 0);
                return true;
            });
            return done ? TRUE : FALSE;
        };

        // LONG ImmGetCompositionStringA(HIMC hIMC, DWORD dwIndex, LPVOID lpBuf, DWORD dwBufLen)
        this.exports["ImmGetCompositionStringA"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const dwIndex = args[1] >>> 0;
            const lpBuf = args[2] >>> 0;
            const dwBufLen = args[3] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmGetCompositionStringA(hIMC=0x${hIMC.toString(16)}, index=0x${dwIndex.toString(16)}, buf=0x${lpBuf.toString(16)}, len=${dwBufLen}) -> IMM_ERROR_NODATA`);
            return IMM_ERROR_NODATA;
        };

        // DWORD ImmGetCandidateListA(HIMC hIMC, DWORD deIndex, LPCANDIDATELIST lpCandList, DWORD dwBufLen)
        this.exports["ImmGetCandidateListA"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const deIndex = args[1] >>> 0;
            const lpCandList = args[2] >>> 0;
            const dwBufLen = args[3] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmGetCandidateListA(hIMC=0x${hIMC.toString(16)}, index=${deIndex}, list=0x${lpCandList.toString(16)}, len=${dwBufLen}) -> 0`);
            return 0;
        };

        // DWORD ImmGetCandidateListCountA(HIMC hIMC, LPDWORD lpdwListCount)
        this.exports["ImmGetCandidateListCountA"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const lpdwListCount = args[1] >>> 0;
            if (lpdwListCount) {
                Mem.writeUint32(lpdwListCount, 0);
            }
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmGetCandidateListCountA(hIMC=0x${hIMC.toString(16)}, out=0x${lpdwListCount.toString(16)}) -> 0`);
            return 0;
        };

        // BOOL ImmSetCompositionStringA(HIMC hIMC, DWORD dwIndex, LPVOID lpComp, DWORD dwCompLen, LPVOID lpRead, DWORD dwReadLen)
        this.exports["ImmSetCompositionStringA"] = () => FALSE;

        // BOOL ImmSimulateHotKey(HWND hWnd, DWORD dwHotKeyID)
        this.exports["ImmSimulateHotKey"] = (ctx, mem, args) => {
            const hWnd = args[0] >>> 0;
            const dwHotKeyID = args[1] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmSimulateHotKey(hWnd=0x${hWnd.toString(16)}, hotKey=${dwHotKeyID}) -> FALSE`);
            return FALSE;
        };

        // LONG ImmGetCompositionStringW(HIMC hIMC, DWORD dwIndex, LPVOID lpBuf, DWORD dwBufLen)
        // dwBufLen is in bytes even for W; no IME means IMM_ERROR_NODATA.
        this.exports["ImmGetCompositionStringW"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const dwIndex = args[1] >>> 0;
            const lpBuf = args[2] >>> 0;
            const dwBufLen = args[3] >>> 0;
            Logger.verbose(
                LogCategory.SYSTEM,
                `imm32:ImmGetCompositionStringW(hIMC=0x${hIMC.toString(16)}, index=0x${dwIndex.toString(16)}, buf=0x${lpBuf.toString(16)}, len=${dwBufLen}) -> IMM_ERROR_NODATA`
            );
            return IMM_ERROR_NODATA;
        };

        // DWORD ImmGetCandidateListW(HIMC hIMC, DWORD deIndex, LPCANDIDATELIST lpCandList, DWORD dwBufLen)
        this.exports["ImmGetCandidateListW"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const deIndex = args[1] >>> 0;
            const lpCandList = args[2] >>> 0;
            const dwBufLen = args[3] >>> 0;
            Logger.verbose(
                LogCategory.SYSTEM,
                `imm32:ImmGetCandidateListW(hIMC=0x${hIMC.toString(16)}, index=${deIndex}, list=0x${lpCandList.toString(16)}, len=${dwBufLen}) -> 0`
            );
            return 0;
        };

        // UINT ImmGetIMEFileNameA(HKL hKL, LPSTR lpszFileName, UINT uBufLen) — no IME, no file.
        this.exports["ImmGetIMEFileNameA"] = (ctx, mem, args) => {
            const hKL = args[0] >>> 0;
            const lpszFileName = args[1] >>> 0;
            const uBufLen = args[2] >>> 0;
            Logger.verbose(
                LogCategory.SYSTEM,
                `imm32:ImmGetIMEFileNameA(hKL=0x${hKL.toString(16)}, file=0x${lpszFileName.toString(16)}, len=${uBufLen}) -> 0`
            );
            return 0;
        };

        // BOOL ImmNotifyIME(HIMC hIMC, DWORD dwAction, DWORD dwIndex, DWORD dwValue)
        this.exports["ImmNotifyIME"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const dwAction = args[1] >>> 0;
            const dwIndex = args[2] >>> 0;
            const dwValue = args[3] >>> 0;
            Logger.verbose(
                LogCategory.SYSTEM,
                `imm32:ImmNotifyIME(hIMC=0x${hIMC.toString(16)}, action=0x${dwAction.toString(16)}, index=0x${dwIndex.toString(16)}, value=0x${dwValue.toString(16)}) -> TRUE`
            );
            return TRUE;
        };

        // BOOL ImmSetCandidateWindow(HIMC hIMC, LPCANDIDATEFORM lpCandidate)
        this.exports["ImmSetCandidateWindow"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const lpCandidate = args[1] >>> 0;
            Logger.verbose(
                LogCategory.SYSTEM,
                `imm32:ImmSetCandidateWindow(hIMC=0x${hIMC.toString(16)}, candidate=0x${lpCandidate.toString(16)}) -> TRUE`
            );
            return TRUE;
        };

        // BOOL ImmSetCompositionStringW(HIMC hIMC, DWORD dwIndex, LPVOID lpComp, DWORD dwCompLen, LPVOID lpRead, DWORD dwReadLen)
        this.exports["ImmSetCompositionStringW"] = () => FALSE;

        // BOOL ImmSetCompositionWindow(HIMC hIMC, LPCOMPOSITIONFORM lpCompForm)
        this.exports["ImmSetCompositionWindow"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const lpCompForm = args[1] >>> 0;
            Logger.verbose(
                LogCategory.SYSTEM,
                `imm32:ImmSetCompositionWindow(hIMC=0x${hIMC.toString(16)}, compForm=0x${lpCompForm.toString(16)}) -> TRUE`
            );
            return TRUE;
        };
    }

    /**
     * USER gives every GUI thread one hidden "IME" window, created with its first top-level
     * window. Created here on first query instead, so a title that never asks sees exactly
     * the window list it saw before; a thread with no top-level window has none.
     */
    private defaultImeWindow(threadId: number): number {
        const existing = this.imeWindows.get(threadId);
        if (existing && windows.has(existing)) return existing;
        this.imeWindows.delete(threadId);
        if (this.topLevelWindowsOf(threadId, 0).length === 0) return 0;

        const wm = System.getInstance().windowManager;
        const style = (WS_POPUP | WS_DISABLED) >>> 0;
        const hwnd = wm.createWindow(IME_CLASS, IME_WINDOW_TITLE, style, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        if (!hwnd) return 0;
        const wobj = wm.getWindow(hwnd);
        if (wobj) wobj.creatorThreadId = threadId;
        windows.set(hwnd, {
            handle: hwnd,
            title: IME_WINDOW_TITLE,
            style,
            exStyle: 0,
            x: 0, y: 0, width: 0, height: 0,
            parent: 0,
            children: [],
            visible: false,
            wndProc: 0,
            nativeClassName: IME_CLASS,
        });
        this.imeWindows.set(threadId, hwnd);
        return hwnd;
    }

    private topLevelWindowsOf(threadId: number, excluding: number): number[] {
        const wm = System.getInstance().windowManager;
        const imeHwnd = this.imeWindows.get(threadId) ?? 0;
        const out: number[] = [];
        for (const win of windows.values()) {
            const h = win.handle >>> 0;
            if (h === excluding || h === imeHwnd || win.pendingDestroy) continue;
            if (!isTopLevel(win.style)) continue;
            if (wm.getWindowOwnerThread(h) === threadId) out.push(h);
        }
        return out;
    }

    /** The default IME window goes with its thread's last top-level window. */
    private windowDestroyed(hwnd: number): void {
        this.contexts.windowDestroyed(hwnd);
        for (const [thread, imeHwnd] of this.imeWindows) {
            if (imeHwnd === hwnd) {
                this.imeWindows.delete(thread);
                return;
            }
        }
        const thread = System.getInstance().windowManager.getWindowOwnerThread(hwnd);
        const imeHwnd = this.imeWindows.get(thread);
        if (imeHwnd && this.topLevelWindowsOf(thread, hwnd).length === 0) {
            this.imeWindows.delete(thread);
            finalizeWindowDestroy(imeHwnd);
        }
    }

    reset(): void {
        this.contexts.reset();
        this.imeWindows.clear();
    }
}
