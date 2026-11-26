import type { PeAotCompileRequest, PeAotCompileMessage } from "./pe-aot-compiler";
import { WwtCompiler } from "./translator";
import type { PeAotWork } from "./pe-aot-progress";

const stages = ["discover", "lift", "optimize", "emit"] as const;

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<PeAotCompileRequest>) => void) | null;
    postMessage(message: PeAotCompileMessage, transfer?: Transferable[]): void;
};

scope.onmessage = (event: MessageEvent<PeAotCompileRequest>) => {
    try {
        const { module, cacheId, file, profile, guestLimit } = event.data;
        const startedAt = performance.timeOrigin + performance.now();
        let pending: PeAotWork | undefined;
        let lastUpdate = -Infinity;
        const publish = () => {
            if (!pending) return;
            scope.postMessage({ type: "compiling", startedAt, work: pending });
            lastUpdate = performance.now();
            pending = undefined;
        };
        let lastStage: PeAotWork["stage"] | undefined;
        const compiler = WwtCompiler.fromAbi11Module(module, cacheId, (phase, completed, total) => {
            const stage = stages[phase];
            if (!stage) return;
            const changed = stage !== lastStage;
            if (changed) publish();
            pending = { stage, completed, total: total || undefined };
            lastStage = stage;
            if (changed || performance.now() - lastUpdate >= 125) publish();
        });
        scope.postMessage({ type: "compiling", startedAt });
        const wasm = compiler.translatePe(file, profile, guestLimit, false, false);
        publish();
        scope.postMessage({ type: "done", wasm }, [wasm.buffer]);
    } catch (error) {
        scope.postMessage({ type: "error", error: String(error) });
    }
};
