/**
 * aot-oracle ARM — the same experiment, in a stock browser.
 *
 * The plan accepts a performance result only from an uninstrumented fixed-work run in a browser;
 * Node runs are for correctness and diagnostic attribution. So this arm exists to be BORING: same
 * corpus image, same codegen shape, same publication transaction, same phase markers, same state
 * readback. Everything shared with the Node arm is imported rather than reimplemented — a second
 * loader would make a difference between the arms a difference between two loaders.
 *
 * BOTH arms run here, alternating, in ONE page. Measuring them in separate browsers made the
 * difference between them include the difference between two Chrome processes: the reference
 * spread was 21% and the ratio was withheld. A fresh emulator per round is still built — that is
 * what a warmup phase is for — but the process, its Wasm tiering and its power state are shared.
 *
 * What it deliberately does NOT do: faults, MMU scenarios, byte capture, one-call conformance.
 * Those are diagnostics and they belong where the diagnostics run.
 *
 * The result is left on `window.__ORACLE_RESULT__`; the driver reads it and prints it.
 */

import { buildImage } from "../corpus/image.mjs";
import * as L from "../corpus/layout.mjs";
import { getCase } from "../corpus/cases.mjs";
import { readV86State } from "../lib/state.mjs";
import { SHIPPING_JIT } from "../../jit-config/shipping.mjs";
import {
    WASM_TABLE_SIZE, PAGE_SIZE,
    aotIdentity, applyRelocations, applyShape, aotLiveness,
    manifestMatchesLiveIdentity, publishUnit,
} from "../lib/engine-unit.mjs";

const params = new URLSearchParams(location.search);
const CASE = params.get("case") ?? "k3";
const OUTER = Number(params.get("outer") ?? 1_000_000);
const WARMUP = Number(params.get("warmup") ?? 1_000_000);
const UNIT = params.get("unit");                 // URL of a manifest, or null for reference-only
const ROUNDS = Number(params.get("rounds") ?? 1);
const ENGINE_SHA = params.get("engineSha") ?? "";
const ENGINE_DIR = params.get("engineDir") ?? "/vendor/v86/build";

const report = (o) => { window.__ORACLE_RESULT__ = o; };
const fail = (status, extra = {}) => report({ impl: "v86-browser", case: CASE, status, ...extra });

/** SHA-256 of a byte range, as hex — the browser's own digest, awaited before publication. */
async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const c = getCase(CASE);
const n1 = OUTER;
let V86 = null;
let manifest = null;

/** One measured run: a fresh emulator, optionally a published unit, three phase markers. */
function runOnce(unitManifest) {
    return new Promise((resolve) => {
        const image = buildImage(c, { warmup: WARMUP, n1, n2: n1 * 2, oneCall: false, mmu: null });
        const emulator = new V86({
            autostart: false, memory_size: L.MEM_SIZE, vga_memory_size: 1024 * 1024,
            wasm_path: `${ENGINE_DIR}/v86.wasm`, log_level: 0,
        });
        const marks = [];
        const aotUnits = [];
        let shape = null;
        let settled = false;
        const done = (o) => { if (!settled) { settled = true; try { emulator.stop(); } catch { /* stopped */ } resolve(o); } };
        const timer = setTimeout(() => done({ status: "TIMEOUT" }), 300_000);

        emulator.bus.register("cpu-event-halt", () => {
            clearTimeout(timer);
            if (marks.length !== 3) return done({ status: `HALT_WITH_${marks.length}_MARKS` });
            const cpu = emulator.v86.cpu;
            const ns = (i, j) => (marks[j] - marks[i]) * 1e6;   // performance.now() is milliseconds
            const p1 = ns(0, 1), p2 = ns(1, 2);
            done({
                status: "ok",
                arm: unitManifest ? "unit" : "reference",
                phase_ns: { p1, p2 },
                // The SLOPE between the two phases, exactly as the Node arm defines it:
                // `(t2 - t1) / (n2 - n1)`. Dividing phase 1 by its own count instead measures the
                // fixed cost of a phase and whatever compilation was still finishing inside it —
                // a different quantity, and the noisier one.
                ns_per_outer: (p2 - p1) / (n1 * 2 - n1),
                guest_ins_per_outer: image.insPerOuter,
                regions: c.regions.map((r) => {
                    const bytes = cpu.mem8.subarray(r.addr, r.addr + r.len);
                    return {
                        name: r.name, addr: r.addr, len: r.len,
                        hex: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""),
                    };
                }),
                state: readV86State(cpu),
                aot: aotLiveness(cpu, aotUnits),
                shape,
            });
        });

        emulator.add_listener("emulator-loaded", async () => {
            try {
                const cpu = emulator.v86.cpu;
                cpu.reboot_internal();
                cpu.reset_memory();
                cpu.load_multiboot(image.buf.buffer);

                shape = applyShape(cpu.wm.exports, { flags: new Map(SHIPPING_JIT), relaxed: 1 });
                if (cpu.jit_clear_cache) cpu.jit_clear_cache();

                if (unitManifest) {
                    const base = UNIT.slice(0, UNIT.lastIndexOf("/") + 1);
                    const liveIdentity = aotIdentity(cpu, ENGINE_SHA);
                    if (unitManifest.engine_sha256 !== liveIdentity.engine_sha256
                        || !manifestMatchesLiveIdentity(unitManifest, liveIdentity)) {
                        return done({ status: "IDENTITY_MISMATCH" });
                    }
                    if (!Array.isArray(unitManifest.units) || !unitManifest.units.length
                        || !unitManifest.units.every((u) => Number.isInteger(u.tableIndex)
                            && u.tableIndex > 0 && u.tableIndex < WASM_TABLE_SIZE)) {
                        return done({ status: "MANIFEST_LACKS_TABLE_SLOT" });
                    }
                    // Page hashes are taken BEFORE publication and looked up synchronously inside
                    // it: the transaction cannot await, and a digest here is asynchronous.
                    const hashes = new Map();
                    for (const u of unitManifest.units) {
                        for (const p of u.pages) {
                            const at = p.physPage * PAGE_SIZE;
                            hashes.set(p.physPage, await sha256Hex(cpu.mem8.slice(at, at + PAGE_SIZE)));
                        }
                    }
                    for (const u of unitManifest.units) {
                        const bytes = applyRelocations(
                            new Uint8Array(await (await fetch(base + u.file)).arrayBuffer()),
                            u, unitManifest.relocations ?? {});
                        // NOT counted here. The wrapper that counts entries is a JS call on every
                        // exit, and only the candidate arm would pay it — an arm that carries work
                        // the other does not is not the comparison this run reports. Entry is
                        // established instead from the engine's own per-slot counter, which the
                        // report reads per round together with the unit's aliveness.
                        aotUnits.push(publishUnit(cpu, { ...u, bytes }, liveIdentity,
                            { pageSha: (page) => hashes.get(page) ?? "", countExecutions: false }));
                    }
                    if (!aotUnits.every((u) => u.registered)) {
                        return done({ status: "PUBLICATION_REFUSED", units: aotUnits.map((u) => u.why) });
                    }
                }

                cpu.io.register_write(L.PORT, { name: "aot-oracle" }, () => { marks.push(performance.now()); });
                emulator.run();
            } catch (e) {
                done({ status: "ARM_ERROR", why: String(e?.stack ?? e) });
            }
        });
    });
}

async function main() {
    ({ V86 } = await import(`${ENGINE_DIR}/libv86.mjs`));
    if (UNIT) manifest = await (await fetch(UNIT)).json();

    const rounds = [];
    for (let round = 0; round < ROUNDS; round++) {
        // Alternate WITHIN the round, so drift lands on both arms equally.
        const reference = await runOnce(null);
        if (reference.status !== "ok") return fail(reference.status, reference);
        const unit = manifest ? await runOnce(manifest) : null;
        if (unit && unit.status !== "ok") return fail(unit.status, unit);
        rounds.push({ reference, unit });
        window.__ORACLE_PROGRESS__ = round + 1;
    }
    report({ impl: "v86-browser", case: CASE, status: "ok", rounds });
}

main().catch((e) => fail("ARM_ERROR", { why: String(e?.stack ?? e) }));
