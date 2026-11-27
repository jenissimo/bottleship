import { expect, test } from "bun:test";
import { peAotCacheKey, planPeAot, readPeAot, writePeAot, peAotCacheStats } from "../../src/worker/wwt/pe-aot-cache";
import { PeAotCompiler, PeAotCompileTimeoutError, type PeAotCompileRequest, type PeAotCompileMessage } from "../../src/worker/wwt/pe-aot-compiler";
import { FakeFileHandle, installFakeOpfs, type FakeDirHandle } from "./fixtures/fake-opfs";

async function withFakeOpfs(run: (root: FakeDirHandle) => Promise<void>): Promise<void> {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
        await run(installFakeOpfs());
    } finally {
        if (previous) Object.defineProperty(globalThis, "navigator", previous);
        else Reflect.deleteProperty(globalThis, "navigator");
    }
}

test("a cached translation is found whatever seeds the next run brings, and remembers its own seeds", async () => {
    await withFakeOpfs(async () => {
        const image = Uint8Array.of(7, 7, 7);
        const key = await peAotCacheKey(image, "mode");
        expect(await readPeAot(key)).toBeNull();
        await writePeAot(key, Uint8Array.of(1, 2, 3), [0x401000, 0x401200]);
        const hit = await readPeAot(key);
        expect(hit?.bytes).toEqual(Uint8Array.of(1, 2, 3));
        expect(hit?.seeds).toEqual([0x401000, 0x401200]);
        expect(await readPeAot(await peAotCacheKey(image, "other-mode"))).toBeNull();
        expect(await readPeAot(await peAotCacheKey(Uint8Array.of(8), "mode"))).toBeNull();
    });
});

test("new seeds keep the cached translation in use and refresh it in the background when they can", () => {
    expect(planPeAot(null, [1], true)).toBe("rebuild");
    expect(planPeAot([1, 2], [2], true)).toBe("use");
    expect(planPeAot([1, 2], [], false)).toBe("use");
    expect(planPeAot([1], [1, 3], true)).toBe("use-and-refresh");
    expect(planPeAot([1], [1, 3], false)).toBe("rebuild");
});

test("a late worker stops reporting progress and cannot overlap another background compile", async () => {
    const original = globalThis.Worker;
    const workers: CompileWorker[] = [];
    const compiler = new PeAotCompiler();
    class CompileWorker {
        onmessage: ((event: { data: PeAotCompileMessage }) => void) | null = null;
        terminated = false;
        constructor() { workers.push(this); }
        postMessage(): void {}
        terminate(): void { this.terminated = true; }
        emit(data: PeAotCompileMessage): void { this.onmessage?.({ data }); }
    }
    globalThis.Worker = CompileWorker as unknown as typeof Worker;
    try {
        await withFakeOpfs(async () => {
            const image = Uint8Array.of(5);
            const key = await peAotCacheKey(image, "mode");
            const before = peAotCacheStats().writes;
            const requests = { module: {} as WebAssembly.Module, cacheId: "c", file: image, profile: [], guestLimit: 0 } satisfies PeAotCompileRequest;
            const publish = (wasm: Uint8Array<ArrayBuffer>) => writePeAot(key, wasm);
            const progress: number[] = [];
            let late: Promise<void> | undefined;
            const options = { key, publish, budgetMs: 5, trackBackground: (task: Promise<void>) => { late = task; } };
            const pending = compiler.compile(requests, update => progress.push(update.startedAt), options);
            const worker = workers[0]!;
            worker.emit({ type: "compiling", startedAt: 1 });
            expect(compiler.compile(requests, undefined, options)).toBe(pending);
            await expect(pending).rejects.toBeInstanceOf(PeAotCompileTimeoutError);
            expect(worker.terminated).toBe(false);
            worker.emit({ type: "compiling", startedAt: 2 });
            expect(progress).toEqual([1]);
            expect(compiler.compile(requests, undefined, options)).toBe(pending);
            expect(compiler.refresh(requests, key, publish)).toBeUndefined();
            expect(compiler.refresh(requests, "other-key", publish)).toBeUndefined();
            expect(workers).toHaveLength(1);

            worker.emit({ type: "done", wasm: Uint8Array.of(9, 9) });
            await late;
            expect(worker.terminated).toBe(true);
            expect(peAotCacheStats().writes - before).toBe(1);
            expect((await readPeAot(key))?.bytes).toEqual(Uint8Array.of(9, 9));

            const refresh = compiler.refresh(requests, key, publish, 5);
            expect(refresh).toBeDefined();
            await refresh;
            expect(workers[1]?.terminated).toBe(true);
            expect(peAotCacheStats().writes - before).toBe(1);
        });
    } finally {
        globalThis.Worker = original;
    }
});

test("an interrupted replacement leaves Wasm and its original seed list together", async () => {
    await withFakeOpfs(async root => {
        const key = await peAotCacheKey(Uint8Array.of(5), "mode");
        await writePeAot(key, Uint8Array.of(1, 2), [0x401000]);
        const app = await root.getDirectoryHandle("bottleship");
        const cache = await app.getDirectoryHandle("wwt-pe-aot-v1");
        const file = await cache.getFileHandle(key);
        const open = FakeFileHandle.prototype.createWritable.bind(file);
        file.createWritable = async () => {
            const writer = await open();
            const write = writer.write.bind(writer);
            let calls = 0;
            writer.write = async chunk => {
                if (++calls === 2) throw new Error("interrupted write");
                await write(chunk);
            };
            return writer;
        };
        const before = peAotCacheStats().writeErrors;
        await writePeAot(key, Uint8Array.of(3, 4), [0x402000]);
        expect(peAotCacheStats().writeErrors).toBe(before + 1);
        expect(await readPeAot(key)).toEqual({ bytes: Uint8Array.of(1, 2), seeds: [0x401000] });
        expect([...cache.children.keys()]).toEqual([key]);
    });
});
