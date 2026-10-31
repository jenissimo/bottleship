import { expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { createMessageExports } from "../../src/worker/modules/user32/message";
import { windows } from "../../src/worker/modules/user32/shared-state";
import { installHook, uninstallHook, WH_GETMESSAGE } from "../../src/worker/modules/user32/hooks";

for (const blocked of [false, true]) test(`mouse retrieval sends WM_SETCURSOR then WH_GETMESSAGE (${blocked ? "blocked" : "ready"})`, async () => {
    const system = System.getInstance();
    const mem = new Uint8Array(0x5000), view = new DataView(mem.buffer);
    const esp = 0x1000, out = 0x2000, hwnd = 0x777;
    const wndProc = 0x4000, hookProc = 0x4100;
    view.setUint32(esp, 0x1234, true);
    const msg = { hwnd, message: 0x200, wParam: 0, lParam: 0, time: 1,
        sentSetCursor: { wParam: hwnd, lParam: 0x02000001 } };
    const pending: Array<{ proc: number; args: number[]; finish: (ret: number) => number | null }> = [];
    const callbackManager = {
        getStubPoolRange: () => ({ base: 0x9000, end: 0xa000 }),
        getActiveSuspendedFrameId: () => 1,
        saveSuspendedThunkContext: () => 1,
        invokeCallback: (proc: number, args: number[], _zero: number, finish: (ret: number) => number | null) => {
            pending.push({ proc, args, finish });
            return { callbackId: pending.length };
        },
    };
    const previousProcess = system.process;
    const previousPeek = system.windowManager.peekMessage;
    const previousWait = system.windowManager.waitForMessage;
    const previousPoll = system.inputManager.poll;
    const hook = installHook(WH_GETMESSAGE, hookProc, 0, 0);
    windows.set(hwnd, { wndProc, isSystemControl: false } as any);
    system.process = { dispatcher: { callbackManager }, v86: { mem8: mem }, getCurrentMemory: () => mem } as any;
    system.windowManager.peekMessage = (() => blocked ? null : msg) as any;
    system.windowManager.waitForMessage = (async () => msg) as any;
    system.inputManager.poll = () => {};
    try {
        const result = await createMessageExports().GetMessageW({ esp } as any, mem, [out, 0, 0x200, 0x200]) as any;
        if (blocked) {
            expect(result.startCallbackChain).toBeFunction();
            expect(pending).toHaveLength(0);
            expect(result.startCallbackChain({ esp, returnAddr: 0x1234, mem })).toBe(true);
        } else expect(result.suspendedForCallback).toBe(true);
        expect(view.getUint32(out + 4, true)).toBe(0x200);
        expect(pending[0].proc).toBe(wndProc);
        expect(pending[0].args[1]).toBe(0x20);
        expect(pending[0].finish(1)).toBeNull();
        expect(pending[1].proc).toBe(hookProc);
        expect(pending[1].args[2]).toBe(out);
        expect(pending[1].finish(0)).toBe(1);
    } finally {
        uninstallHook(hook);
        windows.delete(hwnd);
        system.process = previousProcess;
        system.windowManager.peekMessage = previousPeek;
        system.windowManager.waitForMessage = previousWait;
        system.inputManager.poll = previousPoll;
    }
});
