/**
 * SHCORE.DLL — the Win8.1 DPI entry points. They are HRESULT wrappers over the user32
 * awareness state (user32/dpi-awareness.ts), so shcore and user32 can never disagree
 * about the process's awareness or a monitor's DPI.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { isValidAddress } from "../core/memory/address-guard";
import {
    contextForAwarenessLevel,
    getAwarenessFromContext,
    getDpiForMonitorAsSeen,
    getProcessDpiContext,
    setProcessDpiContext,
} from "./user32/dpi-awareness";

const S_OK = 0;
const E_INVALIDARG = 0x80070057;
const hresultFromWin32 = (code: number): number => (code ? ((code & 0xffff) | 0x80070000) >>> 0 : S_OK);

/** MONITOR_DPI_TYPE: MDT_EFFECTIVE_DPI, MDT_ANGULAR_DPI, MDT_RAW_DPI. */
const MDT_RAW_DPI = 2;

export class Shcore implements IModule {
    name = "shcore";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        const exports = this.exports;

        // HRESULT SetProcessDpiAwareness(PROCESS_DPI_AWARENESS) — set-once, like the
        // user32 context API it forwards to: a second call is E_ACCESSDENIED.
        exports["SetProcessDpiAwareness"] = (_ctx, _mem, args) => {
            const ctx = contextForAwarenessLevel(args[0] | 0);
            if (ctx === null) return E_INVALIDARG;
            return hresultFromWin32(setProcessDpiContext(ctx));
        };

        // HRESULT GetProcessDpiAwareness(HANDLE hprocess, PROCESS_DPI_AWARENESS *value) —
        // NULL is the calling process, and there is no other process to ask about.
        exports["GetProcessDpiAwareness"] = (_ctx, mem, args) => {
            const pValue = args[1] >>> 0;
            if (!pValue || !isValidAddress(mem, pValue, 4, "rw")) return E_INVALIDARG;
            Mem.writeUint32(pValue, getAwarenessFromContext(getProcessDpiContext()));
            return S_OK;
        };

        // HRESULT GetDpiForMonitor(HMONITOR, MONITOR_DPI_TYPE, UINT *dpiX, UINT *dpiY)
        exports["GetDpiForMonitor"] = (_ctx, mem, args) => {
            const type = args[1] >>> 0;
            const pX = args[2] >>> 0;
            const pY = args[3] >>> 0;
            if (type > MDT_RAW_DPI) return E_INVALIDARG;
            if (!pX || !pY || !isValidAddress(mem, pX, 4, "rw") || !isValidAddress(mem, pY, 4, "rw")) {
                return E_INVALIDARG;
            }
            const dpi = getDpiForMonitorAsSeen(args[0] >>> 0);
            if (dpi === null) return E_INVALIDARG;
            Mem.writeUint32(pX, dpi);
            Mem.writeUint32(pY, dpi);
            return S_OK;
        };
    }
}
