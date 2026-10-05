/**
 * A child's `completion` settling is what makes the guest's process handle stop being
 * STILL_ACTIVE. Three independent layers could turn one stuck VFS operation into an
 * unbounded wait there, with nothing logged and nothing to look at:
 *
 *   1. the child VFS server's close(), waiting out in-flight dispatches;
 *   2. startChildExecution's teardown drain and its final flushAll;
 *   3. the child worker's own exit barrier, which reported a failed flush as `error`
 *      — a crash — instead of the exit that had already happened.
 *
 * Layers 1 and 2 bound the WAIT (never the work: nothing is cancelled, so no bytes are
 * abandoned) and name what they were waiting for. Layer 3 propagates: the process exited,
 * so the exit code must reach the parent whatever the barrier managed to drain.
 *
 * Each layer is driven at its own seam, with a test budget, so the assertion is
 * deterministic rather than timing-shaped.
 */
import { describe, expect, test, afterEach } from "bun:test";
import {
    startChildExecution, setChildDrainBudgetForTests, type ChildProcessRecord,
} from "../../src/worker/core/child-process";
import {
    createChildVfsServer, setChildVfsCloseBudgetForTests, CHILD_IO_BYTES,
} from "../../src/worker/core/child-vfs";
import type { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";

const TEST_BUDGET_MS = 60;

afterEach(() => {
    setChildDrainBudgetForTests(30_000);
    setChildVfsCloseBudgetForTests(30_000);
});

const never = () => new Promise<never>(() => {});

function fakeVfs(flushAll: () => Promise<void> = async () => {}): VirtualFileSystem {
    return { flushAll } as unknown as VirtualFileSystem;
}

const request = { imagePath: "C:\\game\\setup.exe", commandLine: "setup.exe", currentDirectory: "C:\\game\\" };

/** Bun's default timeout would report a hang as a suite failure, not as this assertion. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
    });
    try { return await Promise.race([work, guard]); } finally { clearTimeout(timer); }
}

describe("child teardown is bounded and attributable", () => {
    test("a cleanup that never settles does not hold the child's handle", async () => {
        setChildDrainBudgetForTests(TEST_BUDGET_MS);
        const task = startChildExecution(fakeVfs(), request, async context => {
            context.onStop(() => never());
            return 7;
        });
        expect(await within(task.completion, 2000)).toBe(7);
        expect(task.record.stalled).toContain("cleanup drain");
        expect(task.record.finished).toBeDefined();
    });

    test("a flushAll that never settles does not hold the child's handle", async () => {
        setChildDrainBudgetForTests(TEST_BUDGET_MS);
        const task = startChildExecution(fakeVfs(never), request, async () => 3);
        expect(await within(task.completion, 2000)).toBe(3);
        expect(task.record.stalled).toContain("vfs.flushAll");
    });

    test("a drain that DOES settle is still awaited, and its failure still propagates", async () => {
        setChildDrainBudgetForTests(TEST_BUDGET_MS);
        let cleanupDone = false;
        const task = startChildExecution(fakeVfs(), request, async context => {
            context.onStop(async () => { await new Promise(r => setTimeout(r, 5)); cleanupDone = true; });
            return 0;
        });
        expect(await within(task.completion, 2000)).toBe(0);
        expect(cleanupDone).toBe(true);
        expect(task.record.stalled).toBeUndefined();

        const failing = startChildExecution(fakeVfs(async () => { throw new Error("commit refused"); }),
            request, async () => 0);
        await expect(within(failing.completion, 2000)).rejects.toThrow("commit refused");
        expect(failing.record.stalled).toBeUndefined();
    });

    test("the VFS server's close() outlives a wedged dispatch and names it", async () => {
        setChildVfsCloseBudgetForTests(TEST_BUDGET_MS);
        const serve = createChildVfsServer(
            fakeVfs(never) as unknown as VirtualFileSystem,
            new SharedArrayBuffer(CHILD_IO_BYTES));
        void serve({ method: "flushAll", args: [] });
        await within(serve.close(), 2000);
        expect(serve.pendingOperations()).toContain("flushAll");
    });

    test("a dispatch that settles is waited out, not cut short", async () => {
        setChildVfsCloseBudgetForTests(5000);
        let served = false;
        const serve = createChildVfsServer(
            fakeVfs(async () => { await new Promise(r => setTimeout(r, 20)); served = true; }) as unknown as VirtualFileSystem,
            new SharedArrayBuffer(CHILD_IO_BYTES));
        void serve({ method: "flushAll", args: [] });
        await within(serve.close(), 2000);
        expect(served).toBe(true);
        expect(serve.pendingOperations()).toEqual([]);
    });
});

describe("a child's exit is an exit, not a crash", () => {
    /** The parent's message handler, exercised through startChildProcess's fake worker. */
    function fakeWorkerChild(post: (emit: (message: unknown) => void) => void) {
        const record: ChildProcessRecord = { ...request, started: 0 };
        let emit: ((message: unknown) => void) | undefined;
        const worker = {
            postMessage: (message: { type?: string }) => {
                if (message.type === "child_boot") queueMicrotask(() => post(emit!));
            },
            terminate: () => {},
            set onmessage(fn: ((event: { data: unknown }) => void) | null) {
                emit = fn ? (message: unknown) => fn({ data: message }) : undefined;
            },
            set onerror(_: unknown) {}, set onmessageerror(_: unknown) {},
        };
        return { worker: worker as unknown as Worker, record };
    }

    test("process_exit with a failed barrier keeps the exit code and records the failure", async () => {
        const { startChildProcess } = await import("../../src/worker/core/child-process");
        const image = { path: request.imagePath } as unknown as never;
        const vfs = {
            flushAll: async () => {},
            open: async () => image,
            getFileSize: () => 4,
            read: async () => new Uint8Array(4),
        } as unknown as VirtualFileSystem;
        const task = startChildProcess(vfs, request, () => fakeWorkerChild(emit => {
            emit({ type: "process_exit", exitCode: 0, flushError: "Child VFS flushAll timed out" });
        }).worker);
        expect(await within(task.completion, 2000)).toBe(0);
        expect(task.record.stalled).toContain("Child VFS flushAll timed out");
        expect(task.record.error).toBeUndefined();
    });
});
