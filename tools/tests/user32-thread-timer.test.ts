import { expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { createMessageExports } from "../../src/worker/modules/user32/message";
import { clearTimerHandler, getTimerHandler, replaceTimerHandler } from "../../src/worker/core/scheduler/timer-wheel";
import { TimerKind } from "../../src/worker/core/scheduler/types";
import { preserveMemBinding, preserveSavestateParticipants } from "./helpers/scoped-process-state";
import { preserveGlobals } from "./helpers/scoped-globals";
import { newCaptureRun } from "../../src/worker/savestate/session";
import { savestateParticipants } from "../../src/worker/savestate/participant";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

preserveMemBinding(); preserveSavestateParticipants(); preserveGlobals("__savestates");

const memory = new Uint8Array(0x1000);
let exports: ReturnType<typeof createMessageExports>;

function withStubs(threadId: number, run: (fire: () => void, posts: number[][], wakes: unknown[], setThread: (id: number) => void) => void) {
    const oldMem = Mem.memoryGetter;
    Mem.bind(() => memory);
    const oldHandler = getTimerHandler(TimerKind.USER32_TIMER);
    clearTimerHandler(TimerKind.USER32_TIMER);
    exports = createMessageExports();
    const system = System.getInstance();
    const wheel = system.scheduler.timerWheel;
    const origAdd = wheel.add, origPost = system.windowManager.postMessage;
    const origTid = system.scheduler.getCurrentThreadId, origWake = system.scheduler.wakeMessageWaiters;
    let cb: () => void = () => {};
    const posts: number[][] = [];
    const wakes: unknown[] = [];
    wheel.add = ((_ms: number, _rep: boolean, kind: TimerKind, owner: number, _now: number, arg = 0) => { cb = () => getTimerHandler(kind)!(owner, arg, 1); return 1; }) as any;
    system.windowManager.postMessage = ((...a: number[]) => { posts.push(a); }) as any;
    system.scheduler.getCurrentThreadId = (() => threadId) as any;
    system.scheduler.wakeMessageWaiters = ((t?: number) => { wakes.push(t); }) as any;
    try { run(() => cb(), posts, wakes, (id) => { threadId = id; }); } finally {
        Mem.bind(oldMem);
        if (oldHandler) replaceTimerHandler(TimerKind.USER32_TIMER, oldHandler); else clearTimerHandler(TimerKind.USER32_TIMER);
        wheel.add = origAdd; system.windowManager.postMessage = origPost;
        system.scheduler.getCurrentThreadId = origTid; system.scheduler.wakeMessageWaiters = origWake;
    }
}

test("SetTimer(NULL) posts WM_TIMER to the creating thread only", () => {
    withStubs(7, (fire, posts, wakes) => {
        const id = exports.SetTimer({} as any, memory, [0, 0, 10, 0x2000]);
        fire();
        expect(posts).toEqual([[0, 0x113, id, 0x2000, 0, 0, 7, undefined, 0, true, 1]]);
        expect(wakes).toEqual([7]);
        exports.KillTimer({} as any, memory, [0, id]);
    });
});

test("SetTimer(hwnd) leaves routing to the window's owner thread", () => {
    withStubs(7, (fire, posts, wakes) => {
        exports.SetTimer({} as any, memory, [0x10009, 3, 10, 0]);
        fire();
        expect(posts[0].slice(0, 4)).toEqual([0x10009, 0x113, 3, 0]);
        expect(posts[0][6]).toBe(0);
        expect(wakes).toEqual([undefined]);
        exports.KillTimer({} as any, memory, [0x10009, 3]);
    });
});

test("another thread cannot replace or kill a thread timer", () => {
    withStubs(7, (fire, posts, wakes, setThread) => {
        const first = exports.SetTimer({} as never, memory, [0, 0, 10, 0]) as number;
        setThread(8);
        expect(exports.KillTimer({} as never, memory, [0, first])).toBe(0);
        const second = exports.SetTimer({} as never, memory, [0, first, 10, 0]) as number;
        expect(second).not.toBe(first);
        fire();
        expect(posts[0]![6]).toBe(8);
        expect(wakes).toEqual([8]);
        exports.KillTimer({} as never, memory, [0, second]);
        setThread(7);
        expect(exports.SetTimer({} as never, memory, [0, first, 10, 0])).toBe(first);
        expect(exports.KillTimer({} as never, memory, [0, first])).toBe(1);
    });
});

test("restored thread timers keep their original owner", () => {
    const flags = globalThis as {__savestates?: unknown};
    const before = flags.__savestates;
    flags.__savestates = true;
    try {
        withStubs(7, (fire, posts, wakes, setThread) => {
            const id = exports.SetTimer({} as never, memory, [0, 0, 10, 0]) as number;
            const participant = savestateParticipants.all().find(p => p.id === "user32-timers")!;
            const saved = participant.capture(newCaptureRun());
            setThread(8);
            participant.restore(structuredClone(saved), {object: () => null});
            fire();
            expect(posts[0]![6]).toBe(7);
            expect(wakes).toEqual([7]);
            setThread(7);
            exports.KillTimer({} as never, memory, [0, id]);
        });
    } finally { flags.__savestates = before; }
});
