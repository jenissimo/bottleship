import { describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { createMessageExports } from "../../src/worker/modules/user32/message";

describe("USER timer cancellation", () => {
    test("KillTimer removes an unobserved expiration but preserves an observed one", () => {
        const system = System.getInstance(), api = createMessageExports();
        const wheel = system.scheduler.timerWheel;
        const add = wheel.add, cancel = wheel.cancel;
        let fire: (() => void) | undefined;
        wheel.add = (_delay, _periodic, _kind, callback) => { fire = callback; return 12345; };
        wheel.cancel = () => true;
        const ctx = {} as any, mem = new Uint8Array(0x1000), hwnd = 0x7abcde01, id = 0x123456;
        try {
            expect(api.SetTimer(ctx, mem, [hwnd, id, 10, 0])).toBe(id);
            fire!();
            expect(api.KillTimer(ctx, mem, [hwnd, id])).toBe(1);
            expect(system.windowManager.peekMessage(true, 0x113, 0x113)).toBeUndefined();

            expect(api.SetTimer(ctx, mem, [hwnd, id, 10, 0])).toBe(id);
            fire!();
            expect(system.windowManager.peekMessage(false, 0x113, 0x113)?.wParam).toBe(id);
            expect(api.KillTimer(ctx, mem, [hwnd, id])).toBe(1);
            expect(system.windowManager.peekMessage(true, 0x113, 0x113)?.wParam).toBe(id);
        } finally {
            api.KillTimer(ctx, mem, [hwnd, id]);
            wheel.add = add;
            wheel.cancel = cancel;
        }
    });
});
