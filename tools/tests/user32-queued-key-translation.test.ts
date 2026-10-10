import { describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { InputManager } from "../../src/worker/runtime/input/input-manager";
import { WindowManager } from "../../src/worker/runtime/windowing/window-manager";
import { createMessageExports } from "../../src/worker/modules/user32/message";

function rig() {
    let tid = 1;
    const wm = new WindowManager();
    const input = new InputManager(wm, () => tid);
    wm.setKeyStateCallback((packed, threadId) => input.applyMessageKeyState(packed, threadId || tid));
    const packed = (shift = false, caps = false) => {
        const table = new Uint8Array(256);
        table[0x10] = shift ? 0x80 : 0;
        table[0x14] = caps ? 1 : 0;
        return table;
    };
    const queue = (vk: number, table: Uint8Array, threadId = tid) => {
        wm.postMessage(0, 0x100, vk, 1, 0, 0, threadId, table);
    };
    function translate(vk: number, sysKey = false): number {
        const system = System.getInstance();
        const oldInput = system.inputManager, oldWm = system.windowManager;
        const mem = new Uint8Array(0x4000);
        const view = new DataView(mem.buffer);
        view.setUint32(0x1004, sysKey ? 0x104 : 0x100, true);
        view.setUint32(0x1008, vk, true);
        view.setUint32(0x100c, 1, true);
        Mem.bind(() => mem);
        system.inputManager = input;
        system.windowManager = wm;
        try {
            expect(createMessageExports().TranslateMessage({} as any, mem, [0x1000])).toBe(1);
            return wm.peekMessage(true, sysKey ? 0x106 : 0x102, sysKey ? 0x106 : 0x102, tid)!.wParam;
        } finally {
            system.inputManager = oldInput;
            system.windowManager = oldWm;
        }
    }
    return { wm, input, packed, queue, translate, thread: (id: number) => { tid = id; } };
}

describe("queued keyboard state used by TranslateMessage", () => {
    test("a released hardware modifier still translates the earlier shifted message", () => {
        const r = rig();
        r.queue(0xbd, r.packed(true));
        expect(r.input.keyStates[0x10]).toBe(0);
        r.wm.peekMessage(true, 0x100, 0x100, 1);
        expect(r.input.getKeyState(0x10) & 0x8000).toBe(0x8000);
        expect(r.translate(0xbd)).toBe("_".charCodeAt(0));
    });

    test("PM_NOREMOVE does not advance the thread's keyboard table", () => {
        const r = rig();
        r.input.applyMessageKeyState(r.packed(), 1);
        r.queue(0x41, r.packed(true));
        r.wm.peekMessage(false, 0x100, 0x100, 1);
        expect(r.input.getKeyState(0x10)).toBe(0);
        r.wm.peekMessage(true, 0x100, 0x100, 1);
        expect(r.translate(0x41)).toBe("A".charCodeAt(0));
    });

    test("keyboard tables follow the consuming thread", () => {
        const r = rig();
        r.queue(0x41, r.packed(true), 1);
        r.queue(0x41, r.packed(), 2);
        r.wm.peekMessage(true, 0x100, 0x100, 1);
        r.wm.peekMessage(true, 0x100, 0x100, 2);
        expect(r.translate(0x41)).toBe("A".charCodeAt(0));
        r.thread(2);
        expect(r.translate(0x41, true)).toBe("a".charCodeAt(0));
    });

    test("Caps Lock uses its toggle bit and Shift reverses it", () => {
        const r = rig();
        r.queue(0x41, r.packed(false, true));
        r.wm.peekMessage(true, 0x100, 0x100, 1);
        expect(r.translate(0x41)).toBe("A".charCodeAt(0));
        r.queue(0x41, r.packed(true, true));
        r.wm.peekMessage(true, 0x100, 0x100, 1);
        expect(r.translate(0x41)).toBe("a".charCodeAt(0));
    });

    test("asynchronous GetMessage delivery publishes the removed snapshot", async () => {
        const r = rig();
        const pending = r.wm.waitForMessage(1);
        r.queue(0x39, r.packed(true));
        expect((await pending).wParam).toBe(0x39);
        expect(r.translate(0x39)).toBe("(".charCodeAt(0));
    });

    test("a complete queued transcript survives all modifiers being released", () => {
        const r = rig();
        for (const [vk, shift] of [[0x39, true], [0x41, true], [0xbd, true], [0x5a, true], [0x30, true], [0x0d, false]] as const) {
            r.queue(vk, r.packed(shift));
        }
        let text = "";
        while (true) {
            const msg = r.wm.peekMessage(true, 0x100, 0x100, 1);
            if (!msg) break;
            text += String.fromCharCode(r.translate(msg.wParam));
        }
        expect(text).toBe("(A_Z)\r");
    });
});
