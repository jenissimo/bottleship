import { describe, expect, test } from "bun:test";
import { assessReadiness, type ReadinessProbe } from "../../src/worker/savestate/readiness";
import { markRestartable, restartableCheck } from "../../src/worker/core/thunking/restartable";
import { registerSavestateCommands } from "../../src/worker/harness/cmds/savestate";
import { System } from "../../src/worker/core/system";
import { createMessageExports } from "../../src/worker/modules/user32/message";
import { resetDialogPumps } from "../../src/worker/modules/user32/modal-dialog-state";
import { stopChildProcesses } from "../../src/worker/core/child-process";

const idle: ReadinessProbe = {
    asyncParks: () => [], pendingAsyncRestores: () => 0, pendingCallbacks: () => 0,
    suspendedFrames: () => [], modalPumpArmed: () => false, pendingModals: () => 0,
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

    test("a thread inside a host-pumped modal dialog blocks even with nothing else in flight", () => {
        const r = assessReadiness({
            ...idle,
            suspendedFrames: () => [{ threadId: 1, source: 'DialogBoxParamA' }],
            modalPumpArmed: () => true,
        });
        expect(r.ready).toBe(false);
        expect(r.blockers).toEqual([
            { kind: 'suspended-frame', detail: 'thread 1 in DialogBoxParamA' },
            { kind: 'modal-pump', detail: 'a host-driven modal pump has its next step armed' },
        ]);
    });

    test("the registered verb reads every owner of a session without a process", async () => {
        // Module-scope owners outlive a test file in one `bun test` process: an earlier
        // file can leave an armed dialog pump or an unfinished child behind, and the verb
        // would rightly report them. Start from an empty session.
        resetDialogPumps();
        await stopChildProcesses();
        const handlers = new Map<string, (args: unknown[]) => unknown>();
        registerSavestateCommands({ register: (name: string, h: (args: unknown[]) => unknown) => handlers.set(name, h) } as never);
        const system = System.getInstance();
        const previous = system.process;
        system.process = null as never;
        try {
            expect(handlers.get("savestateReadiness")!([])).toEqual({ ready: true, blockers: [], restartableParks: 0 });
        } finally {
            system.process = previous;
        }
    });
});

describe("restartable async thunks", () => {
    test("the marker is per Promise and asks the body whether it still holds", () => {
        let holds = false;
        const a = markRestartable(Promise.resolve(1), () => !holds);
        expect(restartableCheck(a)?.()).toBe(true);
        holds = true;
        expect(restartableCheck(a)?.()).toBe(false);
        expect(restartableCheck(Promise.resolve(1))).toBeUndefined();
    });

    test("GetMessage that has to wait returns a restartable Promise", async () => {
        const system = System.getInstance();
        const mem = new Uint8Array(0x4000);
        const previous = { paused: system.isPaused, process: system.process, peek: system.windowManager.peekMessage, wait: system.windowManager.waitForMessage, poll: system.inputManager.poll };
        let release!: (m: unknown) => void;
        system.process = { dispatcher: { callbackManager: {} }, v86: { mem8: mem }, getCurrentMemory: () => mem } as any;
        system.windowManager.peekMessage = (() => null) as any;
        system.windowManager.waitForMessage = (() => new Promise(r => { release = r; })) as any;
        system.inputManager.poll = () => {};
        try {
            const pending = createMessageExports().GetMessageW({ esp: 0x1000 } as any, mem, [0x2000, 0, 0, 0]);
            expect(pending).toBeInstanceOf(Promise);
            expect(restartableCheck(pending as Promise<unknown>)?.()).toBe(true);
            system.isPaused = true;
            release({ hwnd: 0, message: 0x12, wParam: 0, lParam: 0, time: 0, ptX: 0, ptY: 0 });
            await new Promise(r => setTimeout(r, 0));
            expect(restartableCheck(pending as Promise<unknown>)?.()).toBe(false);
            system.isPaused = false;
            await pending;
        } finally {
            system.isPaused = previous.paused;
            system.process = previous.process;
            system.windowManager.peekMessage = previous.peek;
            system.windowManager.waitForMessage = previous.wait;
            system.inputManager.poll = previous.poll;
        }
    });
});
