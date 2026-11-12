import * as L from "../../aot-oracle/corpus/layout.mjs";
import { bytesHex, checkK8Payload, k8Source } from "./stack-oracle.mjs";

export async function createReference(moduleUrl, moduleOptions = {}) {
    // Absolute URLs keep Vite from attaching its transform query to raw compiler output.
    const importUrl = new URL(moduleUrl, import.meta.url).href;
    const { default: createModule } = await import(/* @vite-ignore */ importUrl);
    const module = await createModule(moduleOptions);
    const heap = () => module.HEAPU8;
    const reset = () => {
        module._reference_reset(L.K8_SRC_STRIDE, L.K8_BIAS);
        heap().set(k8Source(), module._reference_source());
    };
    const payload = () => {
        const at = module._reference_destination();
        const len = L.K8_ROWS * L.K8_ROW_DST_STRIDE;
        return [{ name: "K8_DST", addr: L.K8_DST, len, hex: bytesHex(heap().slice(at, at + len)) }];
    };
    return {
        async runOnce({ outer, warmup }) {
            reset();
            module._reference_run(warmup);
            const before = module._reference_calls() >>> 0;
            const warmupOracle = checkK8Payload(payload());
            const t0 = performance.now();
            module._reference_run(outer);
            const t1 = performance.now();
            const middle = module._reference_calls() >>> 0;
            const p1Oracle = checkK8Payload(payload());
            const t2Start = performance.now();
            module._reference_run(outer * 2);
            const t2 = performance.now();
            const after = module._reference_calls() >>> 0;
            const p1 = (t1 - t0) * 1e6;
            const p2 = (t2 - t2Start) * 1e6;
            if (before !== warmup || middle - before !== outer || after - middle !== outer * 2) {
                throw new Error("reference completed-call ledger differs from canonical workload");
            }
            const regions = payload();
            const oracle = checkK8Payload(regions);
            return {
                status: "ok", arm: "emscripten-reference",
                contract: "reconstructed-compute; no x86 architectural-state or scheduling contract",
                phase_ns: { p1, p2 }, ns_per_outer: (p2 - p1) / outer,
                regions, oracle, phaseOracles: { warmup: warmupOracle, p1: p1Oracle, p2: oracle },
                completedCalls: { warmup: before, p1: middle - before, p2: after - middle,
                    total: after },
            };
        },
    };
}
