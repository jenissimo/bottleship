import { buildImage } from "../corpus/image.mjs";
import * as L from "../corpus/layout.mjs";
import { getCase } from "../corpus/cases.mjs";
import { readV86State } from "../lib/state.mjs";
import { SHIPPING_JIT } from "../../jit-config/shipping.mjs";
import {
    WASM_TABLE_SIZE, PAGE_SIZE, aotIdentity, applyRelocations, applyShape, aotLiveness,
    manifestMatchesLiveIdentity, publishUnit,
} from "../lib/engine-unit.mjs";

export async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function prepareUnit(manifestUrl) {
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error(`manifest ${manifestUrl}: ${response.status}`);
    const text = await response.text();
    const manifest = JSON.parse(text);
    const base = new URL(".", new URL(manifestUrl, globalThis.location.href));
    const units = [];
    for (const u of manifest.units ?? []) {
        const r = await fetch(new URL(u.file, base));
        if (!r.ok) throw new Error(`unit ${u.file}: ${r.status}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        units.push({ ...u, bytes, sha256: await sha256Hex(bytes) });
    }
    return { manifest, units, manifest_sha256: await sha256Hex(new TextEncoder().encode(text)) };
}

/** Fresh engine, shipping readback and the oracle's exact warm/N/2N workload. */
export async function runV86Arm({ V86, caseId, outer, warmup, engineDir, engineSha,
    engineModule = null, unit = null, timeoutMs = 300_000 }) {
    const c = getCase(caseId);
    const image = buildImage(c, { warmup, n1: outer, n2: outer * 2, oneCall: false, mmu: null });
    const imageSha = await sha256Hex(image.buf);
    const emulator = new V86({
        autostart: false, memory_size: L.MEM_SIZE, vga_memory_size: 1024 * 1024,
        wasm_path: `${engineDir}/v86.wasm`, log_level: 0,
        disable_keyboard: true, disable_mouse: true, disable_speaker: true,
        ...(engineModule ? { wasm_fn: async (env) => (await WebAssembly.instantiate(engineModule, env)).exports } : {}),
    });
    const marks = [], counters = [], aotUnits = [];
    let shape = null, timer;
    let result;
    try {
        result = await new Promise((resolve) => {
            let settled = false;
            const done = (o) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { emulator.stop(); } catch { /* stopped */ }
                resolve(o);
            };
            timer = setTimeout(() => done({ status: "TIMEOUT" }), timeoutMs);
            emulator.bus.register("cpu-event-halt", () => {
                try {
                    if (marks.length !== 3) return done({ status: `HALT_WITH_${marks.length}_MARKS` });
                    const cpu = emulator.v86.cpu;
                    const p1 = (marks[1] - marks[0]) * 1e6;
                    const p2 = (marks[2] - marks[1]) * 1e6;
                    done({
                        status: "ok", arm: unit ? "unit" : "reference", phase_ns: { p1, p2 },
                        ns_per_outer: (p2 - p1) / outer,
                        guest_ins_per_outer: image.insPerOuter,
                        ledger: {
                            source: "live-engine-instruction-counter-at-port-markers",
                            counters,
                            retired: { p1: (counters[1] - counters[0]) >>> 0,
                                p2: (counters[2] - counters[1]) >>> 0 },
                            expected: { p1: outer * image.insPerOuter + 4,
                                p2: outer * 2 * image.insPerOuter + 4 },
                            instruction_counter_wrap_risk: outer * 2 * image.insPerOuter + 4 >= 2 ** 32,
                        },
                        regions: c.regions.map((r) => {
                            const bytes = cpu.mem8.subarray(r.addr, r.addr + r.len);
                            return { name: r.name, addr: r.addr, len: r.len,
                                hex: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("") };
                        }),
                        state: readV86State(cpu), aot: aotLiveness(cpu, aotUnits), shape,
                        jit: {
                            tier2Promotions: cpu.wm.exports.jit_get_tier2_promotions?.() ?? null,
                            tier2Pages: cpu.wm.exports.jit_get_tier2_page_count?.() ?? null,
                        },
                    });
                } catch (e) { done({ status: "ARM_ERROR", why: String(e?.stack ?? e) }); }
            });
            emulator.add_listener("emulator-loaded", async () => {
                try {
                    const cpu = emulator.v86.cpu;
                    cpu.reboot_internal();
                    cpu.reset_memory();
                    cpu.load_multiboot(image.buf.buffer);
                    shape = applyShape(cpu.wm.exports, { flags: new Map(SHIPPING_JIT), relaxed: 1 });
                    if (cpu.jit_clear_cache) cpu.jit_clear_cache();
                    if (unit) {
                        const manifest = unit.manifest;
                        const live = aotIdentity(cpu, engineSha);
                        if (manifest.engine_sha256 !== live.engine_sha256
                            || !manifestMatchesLiveIdentity(manifest, live)) {
                            return done({ status: "IDENTITY_MISMATCH" });
                        }
                        if (!unit.units.length || !unit.units.every((u) => Number.isInteger(u.tableIndex)
                            && u.tableIndex > 0 && u.tableIndex < WASM_TABLE_SIZE)) {
                            return done({ status: "MANIFEST_LACKS_TABLE_SLOT" });
                        }
                        const hashes = new Map();
                        for (const u of unit.units) for (const p of u.pages) {
                            const at = p.physPage * PAGE_SIZE;
                            hashes.set(p.physPage, await sha256Hex(cpu.mem8.slice(at, at + PAGE_SIZE)));
                        }
                        for (const u of unit.units) {
                            const bytes = applyRelocations(u.bytes.slice(), u, manifest.relocations ?? {});
                            aotUnits.push(publishUnit(cpu, { ...u, bytes }, live,
                                { pageSha: (page) => hashes.get(page) ?? "", countExecutions: false }));
                        }
                        if (!aotUnits.every((u) => u.registered)) {
                            return done({ status: "PUBLICATION_REFUSED", units: aotUnits.map((u) => u.why) });
                        }
                    }
                    cpu.io.register_write(L.PORT, { name: "aot-oracle" }, () => {
                        marks.push(performance.now());
                        const memory = cpu.wm.exports.memory ?? cpu.wm.memory;
                        counters.push(new DataView(memory.buffer).getUint32(664, true));
                    });
                    emulator.run();
                } catch (e) { done({ status: "ARM_ERROR", why: String(e?.stack ?? e) }); }
            });
        });
    } finally {
        clearTimeout(timer);
        await emulator.destroy();
    }
    return { ...result, workload_sha256: imageSha, outer: { warmup, n1: outer, n2: outer * 2 } };
}
