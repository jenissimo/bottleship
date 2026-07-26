#!/usr/bin/env node
// Produce a COMPILE JOB for the AOT compiler from a live reference run (design §S1).
//
//   node capture-job.mjs --case k3 [--out jobs/k3.json] [--warmup N]
//
// A job is everything an offline compiler cannot invent: the page's FINAL in-guest bytes and
// their sha256, the entry offsets the engine's own dispatcher publishes for that page, the
// CachedStateFlags it dispatches under, the live jit config, and the two engine facts that are
// properties of the BINARY rather than of the run — its sha256 and the linker-assigned address
// of `tlb_data` (measured, see lib/tlb-base.mjs).
//
// "Input remains a runtime artifact" is a property of any AOT design here (design §11.6); this
// is where that dependency is made explicit instead of hidden.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { buildImage } from "../aot-oracle/corpus/image.mjs";
import * as L from "../aot-oracle/corpus/layout.mjs";
import { getCase } from "../aot-oracle/corpus/cases.mjs";
import { findTlbDataBase, ORACLE_PROBE_PAGES } from "./lib/tlb-base.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(__dirname, "../..");
const PAGE = 4096;

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith("--")) continue;
    const n = process.argv[i + 1];
    if (n !== undefined && !n.startsWith("--")) { args[a.slice(2)] = n; i++; } else args[a.slice(2)] = "1";
}

const caseId = args.case || "k3";
const c = getCase(caseId);
const warmup = Number(args.warmup || 20000);
const outPath = path.resolve(args.out || path.join(__dirname, "jobs", `${caseId}.json`));

const JIT_FLAGS = new Map([[5, 1], [9, 1], [10, 1], [11, 1], [12, 1], [13, 1], [18, 1], [19, 0], [21, 0], [15, 300000]]);
const wasmPath = path.join(REPO, "vendor/v86/build/v86.wasm");
const libPath = path.join(REPO, "vendor/v86/build/libv86.mjs");
const { V86 } = await import(url.pathToFileURL(libPath).href);

const image = buildImage(c, { warmup, n1: 200, n2: 400 });
const emulator = new V86({
    autostart: false, memory_size: L.MEM_SIZE, vga_memory_size: 1024 * 1024,
    wasm_path: wasmPath, log_level: 0,
});

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

emulator.bus.register("cpu-event-halt", () => {
    const cpu = emulator.v86.cpu;
    const w = cpu.wm.exports;
    const mem = cpu.wm.exports.memory ?? cpu.wm.memory;

    const codePage = c.codeAddr >>> 12;
    const pAddr = codePage * PAGE;
    const idx = w.jit_aot_page_table_index(pAddr) >>> 0;
    const entryOffsets = [];
    let stateFlags = null;
    if (idx !== 0xFFFF) {
        stateFlags = w.jit_aot_page_state_flags(pAddr) >>> 0;
        const n = w.jit_aot_page_entry_count(pAddr) >>> 0;
        for (let e = 0; e < n; e++) {
            const packed = w.jit_aot_page_entry_at(pAddr, e) >>> 0;
            if (packed !== 0xFFFFFFFF) entryOffsets.push(packed >>> 16);
        }
    }
    const tlb = findTlbDataBase(mem, cpu.mem8.byteOffset, ORACLE_PROBE_PAGES);
    const pageBytes = Buffer.from(cpu.mem8.subarray(pAddr, pAddr + PAGE));

    const job = {
        tool: "aot/capture-job", case: caseId, created_at: new Date().toISOString(),
        engine: {
            sha256: sha256(fs.readFileSync(wasmPath)),
            // A property of the linked binary, not of this run — see lib/tlb-base.mjs.
            tlbDataBase: tlb.base, tlbProbeSupport: tlb.support,
            mem8: cpu.mem8.byteOffset, memorySize: w.get_memory_size ? w.get_memory_size() : L.MEM_SIZE,
        },
        jitConfig: Object.fromEntries([...JIT_FLAGS]),
        relaxedFpu: w.get_relaxed_fpu ? w.get_relaxed_fpu() : 1,
        page: {
            physPage: codePage, pageBase: pAddr, sha256: sha256(pageBytes),
            bytesBase64: pageBytes.toString("base64"),
            stateFlags,
            // The engine's own published entry points for this page; the compiler must publish
            // a superset (design G3: every basic-block head).
            entryOffsets: entryOffsets.sort((a, b) => a - b),
        },
        jitModuleForPage: (() => {
            const rec = (globalThis["__wasmDump"]?.out ?? []).find((r) => (r.start >>> 12) === codePage);
            return rec ? { bytes: rec.len, tableIndex: rec.table_index } : null;
        })(),
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(job, null, 2));
    const dump = (globalThis["__wasmDump"]?.out ?? []).find((r) => (r.start >>> 12) === codePage);
    if (dump) fs.writeFileSync(outPath.replace(/\.json$/, ".jit.wasm"), Buffer.from(dump.bytes));
    console.log(JSON.stringify({
        job: outPath, case: caseId, physPage: "0x" + codePage.toString(16),
        stateFlags, entryOffsets: job.page.entryOffsets,
        tlbDataBase: "0x" + tlb.base.toString(16), tlbProbeSupport: tlb.support,
        jitModuleBytes: job.jitModuleForPage?.bytes ?? null,
    }, null, 2));
    try { emulator.stop(); } catch { /* already stopped */ }
    process.exit(0);
});

emulator.add_listener("emulator-loaded", () => {
    const cpu = emulator.v86.cpu;
    cpu.reboot_internal();
    cpu.reset_memory();
    cpu.load_multiboot(image.buf.buffer);
    const ex = cpu.wm.exports;
    for (const [i, v] of JIT_FLAGS) ex.set_jit_config(i, v);
    ex.set_relaxed_fpu(1);
    if (cpu.jit_clear_cache) cpu.jit_clear_cache();
    globalThis["__wasmDump"] = { pages: new Set([c.codeAddr >>> 12]), out: [], keepLatestPerPage: true };
    cpu.io.register_write(L.PORT, { name: "aot-capture" }, () => {});
    emulator.run();
});
