import { expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { WindowManager } from "../../src/worker/runtime/windowing/window-manager";
import { windows } from "../../src/worker/modules/user32/shared-state";
import { registerWindowQueryExports } from "../../src/worker/modules/user32/window-query";
import { VIRTUAL_CURRENT_PROCESS_ID } from "../../src/worker/modules/kernel32/process/virtual-process-manager";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

test("a window of this process reports this process id, so VCL FindControl resolves it", () => {
    const system = System.getInstance();
    const oldManager = system.windowManager;
    system.windowManager = new WindowManager();
    try {
        const hwnd = system.windowManager.createWindow("TMessageForm", "", 0x80000000, 0, 352, 320, 320, 127, 0, 0, 0, 0);
        const api: Record<string, ThunkImplementation> = {};
        registerWindowQueryExports(api);
        const mem = new Uint8Array(0x100);
        const tid = api["GetWindowThreadProcessId"]!({} as never, mem, [hwnd, 0x40] as never) as number;
        expect(new DataView(mem.buffer).getUint32(0x40, true)).toBe(VIRTUAL_CURRENT_PROCESS_ID >>> 0);
        expect(tid).toBeGreaterThan(0);
        new DataView(mem.buffer).setUint32(0x40, 0, true);
        api["GetWindowThreadProcessId"]!({} as never, mem, [0x7ffff, 0x40] as never);
        expect(new DataView(mem.buffer).getUint32(0x40, true)).not.toBe(VIRTUAL_CURRENT_PROCESS_ID >>> 0);
        expect(windows.has(0x7ffff)).toBe(false);
    } finally {
        system.windowManager = oldManager;
    }
});
