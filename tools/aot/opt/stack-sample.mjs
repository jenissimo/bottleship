import { runV86Arm } from "../../aot-oracle/browser/fixed-work.mjs";

/** One sample per worker gives all arms the same engine-memory lifetime. */
export async function runSample({ name, outer, warmup, engineDir, engineSha, engineModule,
    unit, direct, directBytes, timeoutMs }) {
    if (name === "emscripten") {
        const adapter = await import(direct.adapterUrl);
        const reference = await adapter.createReference(direct.moduleUrl, { wasmBinary: directBytes });
        return reference.runOnce({ outer, warmup });
    }
    const { V86 } = await import(`${engineDir}/libv86.mjs`);
    return runV86Arm({ V86, caseId: "k8", outer, warmup, engineDir, engineSha,
        engineModule, unit, timeoutMs });
}

if (typeof process === "undefined" && typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
    self.onmessage = async ({ data }) => {
        let sample;
        try { sample = await runSample(data); }
        catch (e) { sample = { status: "ARM_ERROR", why: String(e?.stack ?? e) }; }
        self.postMessage({ type: "result", sample });
    };
}
