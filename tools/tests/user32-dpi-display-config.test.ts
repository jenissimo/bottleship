/**
 * The Win7-Win10 user32/shcore surface games probe through GetProcAddress: DPI awareness,
 * the *ForDpi metrics, CCD display config, touch/pointer, UIPI filters, power
 * notifications — plus the formerly-silent MonitorFrom*, DestroyIcon, double-click and
 * clipboard-sequence contracts.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { user32Module } from "../../src/worker/api/user32.api";
import { shcoreModule } from "../../src/worker/api/shcore.api";
import { createSystemExports } from "../../src/worker/modules/user32/system";
import { createDpiExports, resetDpiAwareness } from "../../src/worker/modules/user32/dpi-awareness";
import {
    createDisplayConfigExports,
    DISPLAYCONFIG_MODE_INFO_SIZE,
    DISPLAYCONFIG_PATH_INFO_SIZE,
    MODE_OFFSETS,
    PATH_OFFSETS,
    SIGNAL_OFFSETS,
} from "../../src/worker/modules/user32/display-config";
import { createTouchPointerExports, resetTouchPointerState } from "../../src/worker/modules/user32/touch-pointer";
import { createMessageFilterExports } from "../../src/worker/modules/user32/message-filter";
import { createPowerNotifyExports, resetPowerNotifications } from "../../src/worker/modules/user32/power-notify";
import { windows, getVirtualScreenRect, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import { Shcore } from "../../src/worker/modules/shcore";
import { Shell32 } from "../../src/worker/modules/shell32";

const mem = new Uint8Array(0x20000);
const view = new DataView(mem.buffer);

const system = createSystemExports();
const user32: Record<string, any> = { ...system };
Object.assign(user32, createDpiExports(user32), createDisplayConfigExports(), createTouchPointerExports(),
    createMessageFilterExports(), createPowerNotifyExports());
const shcore = new Shcore();
shcore.initialize({} as never);

let lastError = 0;
let threadId = 1;
const sys = System.getInstance() as unknown as { scheduler: unknown };
const realScheduler = sys.scheduler;
sys.scheduler = {
    setLastError: (code: number) => { lastError = code; },
    getCurrentThreadId: () => threadId,
};
afterAll(() => { sys.scheduler = realScheduler; });

const call = (name: string, args: number[]): number => {
    Mem.bind(() => mem);
    const r = user32[name]!({} as never, mem, args);
    return (typeof r === "object" ? r.value : r) as number;
};
const callShcore = (name: string, args: number[]): number => {
    Mem.bind(() => mem);
    return shcore.exports[name]!({} as never, mem, args) as number;
};

const HWND = 0x7a0010;
const win = (): WindowInfo => ({
    handle: HWND, title: "t", style: 0x00cf0000, x: 10, y: 10, width: 320, height: 240,
    children: [], visible: true, wndProc: 0,
});

const S_OK = 0, E_INVALIDARG = 0x80070057, E_ACCESSDENIED = 0x80070005;
const ERROR_INVALID_PARAMETER = 87, ERROR_ACCESS_DENIED = 5, ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_WINDOW_HANDLE = 1400, ERROR_INSUFFICIENT_BUFFER = 122;
const CTX_UNAWARE = -1 >>> 0, CTX_SYSTEM = -2 >>> 0, CTX_PMA = -3 >>> 0, CTX_PMA_V2 = -4 >>> 0;

beforeEach(() => {
    resetDpiAwareness();
    resetTouchPointerState();
    resetPowerNotifications();
    windows.clear();
    windows.set(HWND, win());
    lastError = 0;
    threadId = 1;
    mem.fill(0);
});

describe("descriptors", () => {
    test("publish the native stdcall arities", () => {
        const arity = (name: string) => user32Module.functions.find(f => f.name === name)?.params.length;
        expect(arity("AdjustWindowRectExForDpi")).toBe(5);
        expect(arity("SystemParametersInfoForDpi")).toBe(5);
        expect(arity("QueryDisplayConfig")).toBe(6);
        expect(arity("GetThreadDpiAwarenessContext")).toBe(0);
        expect(arity("ChangeWindowMessageFilterEx")).toBe(4);
        const sh = (name: string) => shcoreModule.functions.find(f => f.name === name);
        expect(sh("GetDpiForMonitor")?.params.length).toBe(4);
        expect(sh("SetProcessDpiAwareness")?.onUnimplemented).toBe("hresult");
    });
});

describe("DPI awareness state machine", () => {
    test("an untouched process is unaware and reports the encoded context", () => {
        expect(call("IsProcessDPIAware", [])).toBe(0);
        expect(call("GetThreadDpiAwarenessContext", [])).toBe(0x6010);
        expect(call("AreDpiAwarenessContextsEqual", [call("GetThreadDpiAwarenessContext", []), CTX_UNAWARE])).toBe(1);
        expect(call("GetAwarenessFromDpiAwarenessContext", [CTX_PMA]) | 0).toBe(2);
        expect(call("GetAwarenessFromDpiAwarenessContext", [0x1234]) | 0).toBe(-1);
        expect(call("GetDpiForSystem", [])).toBe(96);
    });

    test("process awareness is set once; later setters are refused", () => {
        expect(call("SetProcessDpiAwarenessContext", [CTX_PMA_V2])).toBe(1);
        expect(call("GetThreadDpiAwarenessContext", [])).toBe(0x22);
        expect(call("SetProcessDpiAwarenessContext", [CTX_SYSTEM])).toBe(0);
        expect(lastError).toBe(ERROR_ACCESS_DENIED);
        // SetProcessDPIAware still answers TRUE but changes nothing.
        expect(call("SetProcessDPIAware", [])).toBe(1);
        expect(call("GetThreadDpiAwarenessContext", [])).toBe(0x22);
        expect(callShcore("SetProcessDpiAwareness", [1])).toBe(E_ACCESSDENIED);
        mem.fill(0, 0x100, 0x104);
        expect(callShcore("GetProcessDpiAwareness", [0, 0x100])).toBe(S_OK);
        expect(view.getUint32(0x100, true)).toBe(2);
    });

    test("SetProcessDPIAware and IsProcessDPIAware agree", () => {
        expect(call("SetProcessDPIAware", [])).toBe(1);
        expect(call("IsProcessDPIAware", [])).toBe(1);
        expect(call("GetThreadDpiAwarenessContext", [])).toBe(0x6011);
        expect(callShcore("GetProcessDpiAwareness", [0, 0x100])).toBe(S_OK);
        expect(view.getUint32(0x100, true)).toBe(1);
    });

    test("a thread override returns the inherited context flagged PROCESS, and giving it back drops it", () => {
        call("SetProcessDpiAwarenessContext", [CTX_PMA]);
        const prev = call("SetThreadDpiAwarenessContext", [CTX_UNAWARE]);
        expect(prev >>> 0).toBe(0x80000012);
        expect(call("GetThreadDpiAwarenessContext", [])).toBe(0x6010);
        expect(call("IsProcessDPIAware", [])).toBe(0);
        threadId = 2;
        expect(call("GetThreadDpiAwarenessContext", [])).toBe(0x12);
        threadId = 1;
        expect(call("SetThreadDpiAwarenessContext", [prev]) >>> 0).toBe(0x6010);
        expect(call("GetThreadDpiAwarenessContext", [])).toBe(0x12);
        expect(call("SetThreadDpiAwarenessContext", [0xdead])).toBe(0);
        expect(lastError).toBe(ERROR_INVALID_PARAMETER);
    });

    test("shcore validates its awareness level and its out-params", () => {
        expect(callShcore("SetProcessDpiAwareness", [3])).toBe(E_INVALIDARG);
        expect(callShcore("SetProcessDpiAwareness", [2])).toBe(S_OK);
        expect(call("GetThreadDpiAwarenessContext", [])).toBe(0x12);
        expect(callShcore("GetProcessDpiAwareness", [0, 0])).toBe(E_INVALIDARG);
    });

    test("every DPI query on the one monitor answers 96", () => {
        expect(callShcore("GetDpiForMonitor", [1, 0, 0x100, 0x104])).toBe(S_OK);
        expect([view.getUint32(0x100, true), view.getUint32(0x104, true)]).toEqual([96, 96]);
        expect(callShcore("GetDpiForMonitor", [1, 3, 0x100, 0x104])).toBe(E_INVALIDARG);
        expect(callShcore("GetDpiForMonitor", [0x55, 0, 0x100, 0x104])).toBe(E_INVALIDARG);
        expect(callShcore("GetDpiForMonitor", [1, 0, 0, 0x104])).toBe(E_INVALIDARG);
        expect(call("GetDpiForWindow", [HWND])).toBe(96);
        expect(call("GetDpiForWindow", [0x1234])).toBe(0);
        expect(lastError).toBe(ERROR_INVALID_WINDOW_HANDLE);
        expect(call("EnableNonClientDpiScaling", [HWND])).toBe(1);
        expect(call("EnableNonClientDpiScaling", [0x1234])).toBe(0);
    });
});

describe("the *ForDpi metrics", () => {
    const WS_OVERLAPPEDWINDOW = 0x00cf0000;
    const adjust = (name: string, args: number[]) => {
        view.setInt32(0x200, 0, true); view.setInt32(0x204, 0, true);
        view.setInt32(0x208, 640, true); view.setInt32(0x20c, 480, true);
        expect(call(name, [0x200, ...args])).toBe(1);
        return [0, 4, 8, 12].map(o => view.getInt32(0x200 + o, true));
    };

    test("AdjustWindowRectExForDpi at 96 DPI is AdjustWindowRectEx", async () => {
        const { registerWindowGeometryExports } = await import("../../src/worker/modules/user32/window-geometry");
        const geo: Record<string, any> = {};
        registerWindowGeometryExports(geo as never, {} as never);
        user32["AdjustWindowRectEx"] = geo["AdjustWindowRectEx"];
        for (const menu of [0, 1]) {
            expect(adjust("AdjustWindowRectExForDpi", [WS_OVERLAPPEDWINDOW, menu, 0x200, 96]))
                .toEqual(adjust("AdjustWindowRectEx", [WS_OVERLAPPEDWINDOW, menu, 0x200]));
        }
    });

    test("AdjustWindowRectExForDpi at 144 DPI scales frame, caption and menu only", () => {
        // frame 3 + MulDiv(1,144,96)=2 -> 5; caption grows by (MulDiv(18,144,96)+1) - 19 = 9.
        expect(adjust("AdjustWindowRectExForDpi", [WS_OVERLAPPEDWINDOW, 0, 0, 144])).toEqual([-5, -32, 645, 485]);
        // The menu bar grows by the same 9.
        expect(adjust("AdjustWindowRectExForDpi", [WS_OVERLAPPEDWINDOW, 1, 0, 144])).toEqual([-5, -60, 645, 485]);
        // WS_EX_CLIENTEDGE's 2px edge is not DPI-scaled.
        const edged = adjust("AdjustWindowRectExForDpi", [WS_OVERLAPPEDWINDOW, 0, 0x200, 144]);
        expect(edged).toEqual([-7, -34, 647, 487]);
    });

    test("GetSystemMetricsForDpi agrees with GetSystemMetrics at 96 and scales at 144", () => {
        for (const index of [2, 4, 11, 15, 30, 31, 32, 49, 51, 71]) {
            expect(call("GetSystemMetricsForDpi", [index, 96])).toBe(call("GetSystemMetrics", [index]));
        }
        expect(call("GetSystemMetricsForDpi", [4, 144])).toBe(28);  // SM_CYCAPTION
        expect(call("GetSystemMetricsForDpi", [11, 144])).toBe(48); // SM_CXICON
        expect(call("GetSystemMetricsForDpi", [13, 144])).toBe(48); // SM_CXCURSOR
        expect(call("GetSystemMetricsForDpi", [0, 144])).toBe(call("GetSystemMetrics", [0])); // SM_CXSCREEN
    });

    test("SystemParametersInfoForDpi rescales NONCLIENTMETRICSW and refuses other actions", () => {
        const p = 0x1000;
        view.setUint32(p, 504, true);
        expect(call("SystemParametersInfoForDpi", [0x29, 504, p, 0, 144])).toBe(1);
        expect(view.getInt32(p + 20, true)).toBe(27);   // iCaptionHeight 18 -> 27
        expect(view.getInt32(p + 24, true)).toBe(-17);  // lfCaptionFont.lfHeight -11 -> -17
        expect(view.getInt32(p + 4, true)).toBe(2);     // iBorderWidth 1 -> 2
        view.setUint32(p, 504, true);
        expect(call("SystemParametersInfoForDpi", [0x29, 504, p, 0, 96])).toBe(1);
        expect(view.getInt32(p + 20, true)).toBe(18);
        expect(call("SystemParametersInfoForDpi", [0x30 /* SPI_GETWORKAREA */, 0, p, 0, 96])).toBe(0);
        expect(lastError).toBe(ERROR_INVALID_PARAMETER);
    });
});

describe("CCD display configuration", () => {
    const QDC_ONLY_ACTIVE_PATHS = 2, QDC_DATABASE_CURRENT = 4, QDC_VIRTUAL_MODE_AWARE = 0x10;
    const NUM_PATHS = 0x100, NUM_MODES = 0x104, PATHS = 0x400, MODES = 0x800, TOPO = 0x108;

    test("structure sizes and field offsets are the SDK's", () => {
        expect(DISPLAYCONFIG_PATH_INFO_SIZE).toBe(72);
        expect(DISPLAYCONFIG_MODE_INFO_SIZE).toBe(64);
        expect(PATH_OFFSETS.targetAdapterId).toBe(20);
        expect(PATH_OFFSETS.refreshNumerator).toBe(48);
        expect(PATH_OFFSETS.flags).toBe(68);
        expect(MODE_OFFSETS.union).toBe(16);
        expect(SIGNAL_OFFSETS.activeCx).toBe(24);
        expect(SIGNAL_OFFSETS.scanLineOrdering).toBe(44);
    });

    test("one active path from source 0 to target 0 in the current mode", () => {
        expect(call("GetDisplayConfigBufferSizes", [QDC_ONLY_ACTIVE_PATHS, NUM_PATHS, NUM_MODES])).toBe(0);
        expect([view.getUint32(NUM_PATHS, true), view.getUint32(NUM_MODES, true)]).toEqual([1, 2]);
        expect(call("QueryDisplayConfig", [QDC_ONLY_ACTIVE_PATHS, NUM_PATHS, PATHS, NUM_MODES, MODES, 0])).toBe(0);
        const screen = getVirtualScreenRect();
        expect(view.getUint32(PATHS + PATH_OFFSETS.flags, true)).toBe(1);
        expect(view.getUint32(PATHS + PATH_OFFSETS.sourceModeInfoIdx, true)).toBe(0);
        expect(view.getUint32(PATHS + PATH_OFFSETS.targetModeInfoIdx, true)).toBe(1);
        expect(view.getInt32(PATHS + PATH_OFFSETS.sourceAdapterId + 4, true)).toBe(1);
        expect(view.getUint32(MODES + MODE_OFFSETS.infoType, true)).toBe(1);
        expect(view.getUint32(MODES + MODE_OFFSETS.union, true)).toBe(screen.right);
        expect(view.getUint32(MODES + MODE_OFFSETS.union + 4, true)).toBe(screen.bottom);
        const target = MODES + DISPLAYCONFIG_MODE_INFO_SIZE;
        expect(view.getUint32(target + MODE_OFFSETS.infoType, true)).toBe(2);
        expect(view.getUint32(target + MODE_OFFSETS.union + SIGNAL_OFFSETS.activeCx, true)).toBe(screen.right);
    });

    test("virtual-mode-aware callers get the desktop-image mode and packed indices", () => {
        expect(call("GetDisplayConfigBufferSizes", [QDC_ONLY_ACTIVE_PATHS | QDC_VIRTUAL_MODE_AWARE, NUM_PATHS, NUM_MODES])).toBe(0);
        expect(view.getUint32(NUM_MODES, true)).toBe(3);
        expect(call("QueryDisplayConfig", [QDC_ONLY_ACTIVE_PATHS | QDC_VIRTUAL_MODE_AWARE, NUM_PATHS, PATHS, NUM_MODES, MODES, 0])).toBe(0);
        expect(view.getUint32(PATHS + PATH_OFFSETS.targetModeInfoIdx, true)).toBe(2 | (1 << 16));
        expect(view.getUint32(MODES + 2 * DISPLAYCONFIG_MODE_INFO_SIZE, true)).toBe(3);
    });

    test("argument errors are the documented Win32 codes", () => {
        view.setUint32(NUM_PATHS, 1, true);
        view.setUint32(NUM_MODES, 1, true);
        expect(call("QueryDisplayConfig", [QDC_ONLY_ACTIVE_PATHS, NUM_PATHS, PATHS, NUM_MODES, MODES, 0])).toBe(ERROR_INSUFFICIENT_BUFFER);
        view.setUint32(NUM_MODES, 2, true);
        expect(call("QueryDisplayConfig", [QDC_DATABASE_CURRENT, NUM_PATHS, PATHS, NUM_MODES, MODES, 0])).toBe(ERROR_INVALID_PARAMETER);
        expect(call("QueryDisplayConfig", [QDC_ONLY_ACTIVE_PATHS, NUM_PATHS, PATHS, NUM_MODES, MODES, TOPO])).toBe(ERROR_INVALID_PARAMETER);
        expect(call("QueryDisplayConfig", [QDC_DATABASE_CURRENT, NUM_PATHS, PATHS, NUM_MODES, MODES, TOPO])).toBe(0);
        expect(view.getUint32(TOPO, true)).toBe(1); // DISPLAYCONFIG_TOPOLOGY_INTERNAL
        expect(call("GetDisplayConfigBufferSizes", [0x80, NUM_PATHS, NUM_MODES])).toBe(ERROR_INVALID_PARAMETER);
    });

    test("DisplayConfigGetDeviceInfo names the source the way EnumDisplayDevices does", () => {
        const p = 0x2000;
        const header = (type: number, size: number, luidHigh = 1, id = 0) => {
            view.setUint32(p, type, true); view.setUint32(p + 4, size, true);
            view.setUint32(p + 8, 0, true); view.setInt32(p + 12, luidHigh, true); view.setUint32(p + 16, id, true);
        };
        header(1, 84);
        expect(call("DisplayConfigGetDeviceInfo", [p])).toBe(0);
        const name = String.fromCharCode(...Array.from({ length: 12 }, (_, i) => view.getUint16(p + 20 + i * 2, true)));
        expect(name).toBe("\\\\.\\DISPLAY1");
        header(1, 83);
        expect(call("DisplayConfigGetDeviceInfo", [p])).toBe(ERROR_INVALID_PARAMETER);
        header(1, 84, 7);
        expect(call("DisplayConfigGetDeviceInfo", [p])).toBe(ERROR_INVALID_PARAMETER);
        header(2, 420);
        expect(call("DisplayConfigGetDeviceInfo", [p])).toBe(0);
        expect(view.getUint16(p + 164, true)).toBe("\\".charCodeAt(0)); // monitorDevicePath
        header(3, 80);
        expect(call("DisplayConfigGetDeviceInfo", [p])).toBe(0);
        expect(view.getUint32(p + 20, true)).toBeGreaterThan(0);
        expect(view.getUint32(p + 32 + SIGNAL_OFFSETS.activeCx, true)).toBe(view.getUint32(p + 20, true));
        header(0x7fff, 64);
        expect(call("DisplayConfigGetDeviceInfo", [p])).toBe(50); // ERROR_NOT_SUPPORTED
    });
});

describe("touch and pointer input without a digitizer", () => {
    test("RegisterTouchWindow marks the window and IsTouchWindow reports it", () => {
        expect(call("IsTouchWindow", [HWND, 0x100])).toBe(0);
        expect(call("RegisterTouchWindow", [HWND, 1])).toBe(1);
        expect(call("IsTouchWindow", [HWND, 0x100])).toBe(1);
        expect(view.getUint32(0x100, true)).toBe(1);
        expect(call("UnregisterTouchWindow", [HWND])).toBe(1);
        expect(call("IsTouchWindow", [HWND, 0])).toBe(0);
        expect(call("RegisterTouchWindow", [0x1234, 0])).toBe(0);
        expect(lastError).toBe(ERROR_INVALID_WINDOW_HANDLE);
    });

    test("no HTOUCHINPUT ever exists", () => {
        expect(call("GetTouchInputInfo", [0x1000, 1, 0x100, 40])).toBe(0);
        expect(lastError).toBe(ERROR_INVALID_HANDLE);
        lastError = 0;
        expect(call("CloseTouchInputHandle", [0x1000])).toBe(0);
        expect(lastError).toBe(ERROR_INVALID_HANDLE);
    });

    test("the mouse is pointer 1 only once EnableMouseInPointer turned it on, and the setting latches", () => {
        expect(call("GetPointerType", [1, 0x100])).toBe(0);
        expect(lastError).toBe(ERROR_INVALID_PARAMETER);
        expect(call("EnableMouseInPointer", [1])).toBe(1);
        expect(call("GetPointerType", [1, 0x100])).toBe(1);
        expect(view.getUint32(0x100, true)).toBe(4); // PT_MOUSE
        expect(call("GetPointerType", [2, 0x100])).toBe(0);
        expect(call("EnableMouseInPointer", [1])).toBe(1);
        expect(call("EnableMouseInPointer", [0])).toBe(0);
        expect(lastError).toBe(ERROR_ACCESS_DENIED);
    });
});

describe("UIPI filters and power notifications", () => {
    test("ChangeWindowMessageFilterEx validates and reports MSGFLTINFO_NONE", () => {
        view.setUint32(0x100, 8, true);
        view.setUint32(0x104, 0xffffffff, true);
        expect(call("ChangeWindowMessageFilterEx", [HWND, 0x4a, 1, 0x100])).toBe(1);
        expect(view.getUint32(0x104, true)).toBe(0);
        expect(call("ChangeWindowMessageFilterEx", [HWND, 0x4a, 3, 0])).toBe(0);
        expect(lastError).toBe(ERROR_INVALID_PARAMETER);
        view.setUint32(0x100, 12, true);
        expect(call("ChangeWindowMessageFilterEx", [HWND, 0x4a, 1, 0x100])).toBe(0);
        expect(call("ChangeWindowMessageFilterEx", [0x1234, 0x4a, 1, 0])).toBe(0);
        expect(lastError).toBe(ERROR_INVALID_WINDOW_HANDLE);
        expect(call("ChangeWindowMessageFilter", [0x4a, 1])).toBe(1);
        expect(call("ChangeWindowMessageFilter", [0x4a, 3])).toBe(0);
    });

    test("power-setting handles register, unregister once, and are validated", () => {
        const h = call("RegisterPowerSettingNotification", [HWND, 0x300, 0]);
        expect(h).not.toBe(0);
        expect(call("UnregisterPowerSettingNotification", [h])).toBe(1);
        expect(call("UnregisterPowerSettingNotification", [h])).toBe(0);
        expect(lastError).toBe(ERROR_INVALID_HANDLE);
        expect(call("RegisterPowerSettingNotification", [HWND, 0, 0])).toBe(0);
        expect(call("RegisterPowerSettingNotification", [HWND, 0x300, 4])).toBe(0);
        expect(call("RegisterPowerSettingNotification", [0x1234, 0x300, 0])).toBe(0);
        expect(lastError).toBe(ERROR_INVALID_WINDOW_HANDLE);
    });
});

describe("formerly silent stubs", () => {
    test("MonitorFrom* honour their flags", () => {
        const far = -100000 >>> 0;
        expect(call("MonitorFromPoint", [far, far, 0])).toBe(0);
        expect(call("MonitorFromPoint", [far, far, 1])).toBe(1);
        expect(call("MonitorFromPoint", [5, 5, 0])).toBe(1);
        expect(call("MonitorFromWindow", [HWND, 0])).toBe(1);
        expect(call("MonitorFromWindow", [0x1234, 0])).toBe(0);
        expect(call("MonitorFromWindow", [0x1234, 2])).toBe(1);
        windows.get(HWND)!.x = -50000;
        expect(call("MonitorFromWindow", [HWND, 0])).toBe(0);
        view.setInt32(0x100, 0, true); view.setInt32(0x104, 0, true);
        view.setInt32(0x108, 10, true); view.setInt32(0x10c, 10, true);
        expect(call("MonitorFromRect", [0x100, 0])).toBe(1);
    });

    test("DestroyIcon frees an owned icon once and refuses a non-icon handle", () => {
        const provider = System.getInstance().resourceProvider;
        const owned = provider.registerUserObject({ type: "ICON", width: 1, height: 1, pixels: new Uint8Array(4), loading: false });
        expect(call("DestroyIcon", [owned])).toBe(1);
        expect(provider.getUserObject(owned)).toBeFalsy();
        expect(call("DestroyIcon", [owned])).toBe(0);
        expect(lastError).toBe(1402); // ERROR_INVALID_CURSOR_HANDLE
        const shared = provider.registerUserObject({ type: "ICON", width: 1, height: 1, pixels: new Uint8Array(4), loading: false, shared: true });
        expect(call("DestroyIcon", [shared])).toBe(1);
        expect(provider.getUserObject(shared)).toBeTruthy();
        const bitmap = provider.registerUserObject({ type: "BITMAP", width: 1, height: 1, loading: false });
        expect(call("DestroyIcon", [bitmap])).toBe(0);
        const loaded = call("LoadIconA", [0, 32512]);
        expect(call("DestroyIcon", [loaded])).toBe(1);
    });

    test("CopyImage hands out an independent icon, so DestroyIcon on one keeps the other", async () => {
        const { registerWindowDrawingExports } = await import("../../src/worker/modules/user32/window-drawing");
        const drawing: Record<string, any> = {};
        registerWindowDrawingExports(drawing as never);
        user32["CopyImage"] = drawing["CopyImage"];
        const provider = System.getInstance().resourceProvider;
        const icon = provider.registerUserObject({ type: "ICON", width: 1, height: 1, pixels: new Uint8Array(4), loading: false });
        const copy = call("CopyImage", [icon, 1, 0, 0, 0]);
        expect(copy).not.toBe(icon);
        expect(call("DestroyIcon", [icon])).toBe(1);
        expect(provider.getUserObject(copy)?.type).toBe("ICON");
        expect(call("CopyImage", [copy, 1, 0, 0, 4 /* LR_COPYRETURNORG */])).toBe(copy);
        const moved = call("CopyImage", [copy, 1, 0, 0, 8 /* LR_COPYDELETEORG */]);
        expect(provider.getUserObject(copy)).toBeFalsy();
        expect(call("DestroyIcon", [moved])).toBe(1);
    });

    test("the double-click time is one setting behind both setters", () => {
        expect(call("SetDoubleClickTime", [0])).toBe(1);
        expect(call("GetDoubleClickTime", [])).toBe(500);
        expect(call("SetDoubleClickTime", [9000])).toBe(1);
        expect(call("GetDoubleClickTime", [])).toBe(5000);
        expect(call("SystemParametersInfoW", [32 /* SPI_SETDOUBLECLICKTIME */, 700, 0, 0])).toBe(1);
        expect(call("GetDoubleClickTime", [])).toBe(700);
    });

    test("the clipboard sequence number moves with every content change", () => {
        const before = call("GetClipboardSequenceNumber", []);
        expect(call("OpenClipboard", [HWND])).toBe(1);
        expect(call("EmptyClipboard", [])).toBe(1);
        const afterEmpty = call("GetClipboardSequenceNumber", []);
        expect(afterEmpty).not.toBe(before);
        call("SetClipboardData", [1, 0x5000]);
        expect(call("GetClipboardSequenceNumber", [])).not.toBe(afterEmpty);
        expect(call("CloseClipboard", [])).toBe(1);
    });

    test("DragAcceptFiles toggles WS_EX_ACCEPTFILES", () => {
        const shell32 = new Shell32();
        shell32.initialize({} as never);
        const drag = (accept: number) => shell32.exports["DragAcceptFiles"]!({} as never, mem, [HWND, accept]);
        drag(1);
        expect((windows.get(HWND)!.exStyle ?? 0) & 0x10).toBe(0x10);
        drag(0);
        expect((windows.get(HWND)!.exStyle ?? 0) & 0x10).toBe(0);
    });
});
