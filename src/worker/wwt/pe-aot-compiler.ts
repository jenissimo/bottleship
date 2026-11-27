import type { PeAotWork } from "./pe-aot-progress";

export interface PeAotCompileRequest {
    module: WebAssembly.Module;
    cacheId: string;
    file: Uint8Array<ArrayBuffer>;
    profile: number[];
    guestLimit: number;
}

export interface PeAotCompileUpdate {
    type: "compiling";
    startedAt: number;
    work?: PeAotWork;
}

export type PeAotCompileMessage =
    | PeAotCompileUpdate
    | { type: "done"; wasm: Uint8Array<ArrayBuffer> }
    | { type: "error"; error: string };

// A cold linked translation is optional. Keep a pathological PE from delaying
// guest entry indefinitely; demand translation remains available on ABI 11.
const COLD_COMPILE_BUDGET_MS = 30_000;

export class PeAotCompileTimeoutError extends Error {
    constructor(readonly budgetMs: number) {
        super(`Cold PE translation exceeded ${budgetMs} ms; using demand translation`);
    }
}

const BACKGROUND_COMPILE_BUDGET_MS = 120_000;

interface CompileOptions {
    key?: string;
    publish?: (wasm: Uint8Array<ArrayBuffer>) => Promise<void>;
    budgetMs?: number;
    backgroundBudgetMs?: number;
    trackBackground?: (task: Promise<void>) => void;
}

interface CompileJob {
    result: Promise<Uint8Array<ArrayBuffer>>;
    stop: () => void;
    stopProgress: () => void;
}

function startCompile(request: PeAotCompileRequest, onProgress?: (update: PeAotCompileUpdate) => void): CompileJob {
    const worker = new Worker(new URL("./pe-aot-compiler.worker.ts", import.meta.url), { type: "module" });
    let cancel!: () => void;
    let stopped = false;
    const result = new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
        cancel = () => reject(new Error("PE translation cancelled"));
        worker.onmessage = (event: MessageEvent<PeAotCompileMessage>) => {
            const message = event.data;
            switch (message.type) {
                case "compiling": onProgress?.(message); break;
                case "done": resolve(message.wasm); break;
                case "error": reject(new Error(message.error)); break;
            }
        };
        worker.onerror = event => reject(new Error(event.message || "PE translation worker failed"));
        worker.onmessageerror = () => reject(new Error("Could not read PE translation worker result"));
        worker.postMessage(request);
    });
    const stop = () => {
        if (stopped) return;
        stopped = true;
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
        cancel();
    };
    void result.then(stop, stop);
    return { result, stop, stopProgress: () => { onProgress = undefined; } };
}

export class PeAotCompiler {
    private backgroundKey: string | undefined;
    private readonly active = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

    private keepInBackground(job: CompileJob, key: string, publish: NonNullable<CompileOptions["publish"]>,
        budgetMs: number): Promise<void> {
        this.backgroundKey = key;
        const timer = setTimeout(job.stop, budgetMs);
        return job.result.then(
            async wasm => { clearTimeout(timer); await publish(wasm); },
            () => { clearTimeout(timer); },
        ).finally(() => {
            this.active.delete(key);
            this.backgroundKey = undefined;
        });
    }

    compile(request: PeAotCompileRequest, onProgress?: (update: PeAotCompileUpdate) => void,
        options: CompileOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
        const { key, publish, budgetMs = COLD_COMPILE_BUDGET_MS, backgroundBudgetMs = BACKGROUND_COMPILE_BUDGET_MS } = options;
        const existing = key === undefined ? undefined : this.active.get(key);
        if (existing) return existing;
        const job = startCompile(request, onProgress);
        const foreground = new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
            const timer = setTimeout(() => {
                job.stopProgress();
                if (key !== undefined && publish && this.backgroundKey === undefined) {
                    const task = this.keepInBackground(job, key, publish, backgroundBudgetMs);
                    void task.catch(() => undefined);
                    options.trackBackground?.(task);
                } else {
                    if (key !== undefined) this.active.delete(key);
                    job.stop();
                }
                reject(new PeAotCompileTimeoutError(budgetMs));
            }, budgetMs);
            void job.result.then(async wasm => {
                clearTimeout(timer);
                if (key !== undefined && this.backgroundKey === key) return;
                resolve(wasm);
                try {
                    if (publish) await publish(wasm);
                } finally {
                    if (key !== undefined) this.active.delete(key);
                }
            }, error => {
                clearTimeout(timer);
                reject(error);
                if (key !== undefined && this.active.get(key) === foreground && this.backgroundKey !== key) this.active.delete(key);
            }).catch(() => undefined);
        });
        if (key !== undefined) this.active.set(key, foreground);
        return foreground;
    }

    refresh(request: PeAotCompileRequest, key: string,
        publish: NonNullable<CompileOptions["publish"]>, budgetMs = BACKGROUND_COMPILE_BUDGET_MS): Promise<void> | undefined {
        if (this.backgroundKey !== undefined || this.active.has(key)) return;
        const job = startCompile(request);
        const defer = Promise.reject<Uint8Array<ArrayBuffer>>(new PeAotCompileTimeoutError(COLD_COMPILE_BUDGET_MS));
        void defer.catch(() => undefined);
        this.active.set(key, defer);
        return this.keepInBackground(job, key, publish, budgetMs);
    }
}
