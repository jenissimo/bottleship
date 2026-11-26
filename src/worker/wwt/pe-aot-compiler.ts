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

export async function compileAbi11Pe(request: PeAotCompileRequest,
    onProgress?: (update: PeAotCompileUpdate) => void): Promise<Uint8Array<ArrayBuffer>> {
    const worker = new Worker(new URL("./pe-aot-compiler.worker.ts", import.meta.url), { type: "module" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
            timer = setTimeout(() => reject(new PeAotCompileTimeoutError(COLD_COMPILE_BUDGET_MS)), COLD_COMPILE_BUDGET_MS);
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
            // Keep the original bytes for the mapped-image verification before installation.
            worker.postMessage(request);
        });
    } finally {
        clearTimeout(timer);
        worker.terminate();
    }
}
