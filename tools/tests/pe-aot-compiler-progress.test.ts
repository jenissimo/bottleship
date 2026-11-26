import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
    compileAbi11Pe, PeAotCompileTimeoutError, type PeAotCompileMessage, type PeAotCompileRequest, type PeAotCompileUpdate,
} from "../../src/worker/wwt/pe-aot-compiler";

class CompileWorker {
    static current: CompileWorker;
    onmessage: ((event: MessageEvent<PeAotCompileMessage>) => void) | null = null;
    terminated = false;

    constructor() { CompileWorker.current = this; }
    postMessage(_request: PeAotCompileRequest) {}
    terminate() { this.terminated = true; }

    emit(data: PeAotCompileMessage) {
        this.onmessage?.(new MessageEvent("message", { data }));
    }
}

const worker = globalThis.Worker;
const realSetTimeout = globalThis.setTimeout;
const request: PeAotCompileRequest = {
    module: new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)),
    cacheId: "test",
    file: new Uint8Array(0),
    profile: [],
    guestLimit: 0x8000000,
};

beforeEach(() => { globalThis.Worker = CompileWorker as unknown as typeof Worker; });
afterEach(() => { globalThis.Worker = worker; });

test("compiler progress reaches the parent without resolving the worker result", async () => {
    const updates: PeAotCompileUpdate[] = [];
    const pending = compileAbi11Pe(request, update => updates.push(update));
    const start = { type: "compiling", startedAt: 1234 } as const;
    const count = { ...start, work: { stage: "optimize", completed: 64, total: 200 } } as const;
    CompileWorker.current.emit(start);
    CompileWorker.current.emit(count);
    await Promise.resolve();
    expect(updates).toEqual([start, count]);
    expect(CompileWorker.current.terminated).toBe(false);

    const wasm = Uint8Array.of(1, 2, 3);
    CompileWorker.current.emit({ type: "done", wasm });
    expect(await pending).toBe(wasm);
    expect(CompileWorker.current.terminated).toBe(true);
});

test("a cold compile is bounded at 30 seconds even after progress", async () => {
    let expire: (() => void) | undefined;
    let delay: number | undefined;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation((callback, ms) => {
        expire = callback as () => void;
        delay = ms;
        return realSetTimeout(() => {}, 60_000);
    });
    try {
        const pending = compileAbi11Pe(request);
        CompileWorker.current.emit({ type: "compiling", startedAt: 1234, work: { stage: "lift", completed: 128 } });
        expect(delay).toBe(30_000);
        expect(CompileWorker.current.terminated).toBe(false);
        expire!();
        await expect(pending).rejects.toBeInstanceOf(PeAotCompileTimeoutError);
        await expect(pending).rejects.toMatchObject({ budgetMs: 30_000 });
        expect(CompileWorker.current.terminated).toBe(true);
    } finally {
        timer.mockRestore();
    }
});
