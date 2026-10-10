import { describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { createMessageExports, registerFastPathMessageFunctions } from "../../src/worker/modules/user32/message";
import { isSentinelWndProc } from "../../src/worker/modules/user32/dialog";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { msvfw32Module } from "../../src/worker/api/msvfw32.api";

const system = System.getInstance();
const memory = new Uint8Array(0x20000);
const view = new DataView(memory.buffer);
const esp = 0x1000, out = 0x2000;
Mem.bind(() => memory);
const exports = createMessageExports();
const fastPaths = new Map<string, Function>();
registerFastPathMessageFunctions({ registerFastPath: (_module: string, name: string, impl: Function) => { fastPaths.set(name, impl); } } as any);

describe("PeekMessage removal flags on both tiers", () => {
    for (const flags of [0, 1, 2, 3, 0x10000, 0x10001]) {
        for (const fast of [false, true]) {
            test(`${fast ? "fast" : "slow"}, flags ${flags}`, () => {
                let pending = true;
                const manager = system.windowManager;
                const originalPeek = manager.peekMessage;
                const originalPoll = system.inputManager.poll;
                const msg = { hwnd: 0, message: 0x0400, wParam: 7, lParam: 9, time: 0 };
                manager.peekMessage = (remove: boolean) => {
                    if (!pending) return null;
                    if (remove) pending = false;
                    return msg;
                };
                system.inputManager.poll = () => {};
                try {
                    const args = [out, 0, 0, 0, flags];
                    for (let i = 0; i < args.length; i++) view.setUint32(esp + 4 + i * 4, args[i], true);
                    const result = fast
                        ? fastPaths.get("PeekMessageW")!(esp, view, memory)
                        : exports.PeekMessageW({ esp } as any, memory, args);
                    expect(result).toBe(1);
                    expect(view.getUint32(out + 4, true)).toBe(0x0400);
                    expect(pending).toBe((flags & 1) === 0);
                } finally {
                    manager.peekMessage = originalPeek;
                    system.inputManager.poll = originalPoll;
                }
            });
        }
    }
});

test("system WndProc sentinels compare as unsigned addresses", () => {
    expect(isSentinelWndProc(0xffff0000)).toBe(true);
    expect(isSentinelWndProc(0xffffffff)).toBe(true);
    expect(isSentinelWndProc(0xfffeffff)).toBe(false);
    expect(isSentinelWndProc(0x00401000)).toBe(false);
});

test("ICDecompress uses the VFWAPIV cdecl ABI", () => {
    expect(msvfw32Module.functions.find(f => f.name === "ICDecompress")?.callingConvention).toBe("cdecl");
});
