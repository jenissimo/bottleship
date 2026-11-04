import { describe, expect, test } from "bun:test";
import { assessReadiness, type ReadinessProbe } from "../../src/worker/savestate/readiness";
import { isRestartable, markRestartable } from "../../src/worker/core/thunking/restartable";
import { System } from "../../src/worker/core/system";
import { createMessageExports } from "../../src/worker/modules/user32/message";

const idle: ReadinessProbe = {
    asyncParks: () => [], pendingAsyncRestores: () => 0, pendingCallbacks: () => 0, pendingModals: () => 0,
    writeBufferPendingBytes: () => 0, sehDispatchInFlight: () => 0, activeLeases: () => 0,
    pendingOverlayWrites: () => 0, liveChildProcesses: () => 0, videoSessions: () => 0,
};

describe("savestate readiness", () => {
    test("an idle session is ready", () => {
        expect(assessReadiness(idle)).toEqual({ ready: true, blockers: [], restartableParks: 0 });
    });

    test("a thread parked in a restartable call does not block; any other park does", () => {
        const r = assessReadiness({
            ...idle,
            asyncParks: () => [
                { name: 'user32:GetMessageA', threadId: 1, restartable: true },
                { name: 'kernel32:ReadFile', threadId: 2, restartable: false },
            ],
        });
        expect(r.ready).toBe(false);
        expect(r.restartableParks).toBe(1);
        expect(r.blockers).toEqual([{ kind: 'async-park', detail: 'thread 2 in kernel32:ReadFile' }]);
    });

    test("every safe-point condition is named when it blocks", () => {
        const r = assessReadiness({
            ...idle,
            pendingAsyncRestores: () => 1, pendingCallbacks: () => 2, pendingModals: () => 1, writeBufferPendingBytes: () => 64,
            sehDispatchInFlight: () => 1, activeLeases: () => 1, pendingOverlayWrites: () => 3, liveChildProcesses: () => 1, videoSessions: () => 1,
        });
        expect(r.blockers.map(b => b.kind)).toEqual([
            'async-restore', 'callback', 'modal', 'write-buffer', 'seh-dispatch', 'lock-lease', 'overlay-flush', 'child-process', 'video',
        ]);
    });
});

describe("restartable async thunks", () => {
    test("the marker is per Promise", () => {
        const a = markRestartable(Promise.resolve(1));
        expect(isRestartable(a)).toBe(true);
        expect(isRestartable(Promise.resolve(1))).toBe(false);
    });

    test("GetMessage that has to wait returns a restartable Promise", async () => {
        const system = System.getInstance();
        const mem = new Uint8Array(0x4000);
        const previous = { process: system.process, peek: system.windowManager.peekMessage, wait: system.windowManager.waitForMessage, poll: system.inputManager.poll };
        let release!: (m: unknown) => void;
        system.process = { dispatcher: { callbackManager: {} }, v86: { mem8: mem }, getCurrentMemory: () => mem } as any;
        system.windowManager.peekMessage = (() => null) as any;
        system.windowManager.waitForMessage = (() => new Promise(r => { release = r; })) as any;
        system.inputManager.poll = () => {};
        try {
            const pending = createMessageExports().GetMessageW({ esp: 0x1000 } as any, mem, [0x2000, 0, 0, 0]);
            expect(pending).toBeInstanceOf(Promise);
            expect(isRestartable(pending as Promise<unknown>)).toBe(true);
            release({ hwnd: 0, message: 0x12, wParam: 0, lParam: 0, time: 0, ptX: 0, ptY: 0 });
            await pending;
        } finally {
            system.process = previous.process;
            system.windowManager.peekMessage = previous.peek;
            system.windowManager.waitForMessage = previous.wait;
            system.inputManager.poll = previous.poll;
        }
    });
});
