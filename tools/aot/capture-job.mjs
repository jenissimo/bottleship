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

const JIT_FLAGS = new Map([[5, 1], [10, 0], [11, 1], [12, 1], [13, 1], [19, 0], [21, 0], [15, 300000]]);
// The integrity gate supplies a disposable engine copy. Capture must use that same binary for
// both its executable bytes and its identity envelope; falling back to the workspace here would
// create a job whose measured state and claimed engine disagree.
const ENGINE_DIR = path.resolve(process.env.V86_ENGINE_DIR || path.join(REPO, "vendor/v86"));
const wasmPath = path.join(ENGINE_DIR, "build/v86.wasm");
const libPath = path.join(ENGINE_DIR, "build/libv86.mjs");
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
    const requiredIdentity = ["jit_config_abi_version", "jit_config_supported_mask", "jit_codegen_fingerprint_lo", "jit_codegen_fingerprint_hi"];
    const jitModuleForPage = (() => {
        const rec = (globalThis["__wasmDump"]?.out ?? []).find((r) => (r.start >>> 12) === codePage);
        return rec ? { bytes: rec.len, tableIndex: rec.table_index } : null;
    })();
    if (!requiredIdentity.every(name => typeof w[name] === "function")
        || !Number.isInteger(cpu.memory_size?.[0])
        || idx === 0xFFFF || idx === 0 || idx >= 900
        || !jitModuleForPage || !Number.isInteger(jitModuleForPage.tableIndex)
        || jitModuleForPage.tableIndex !== idx) {
        throw new Error("capture refused: missing authoritative JIT identity or exact live slot");
    }

    const job = {
        tool: "aot/capture-job", case: caseId, created_at: new Date().toISOString(),
        engine: {
            sha256: sha256(fs.readFileSync(wasmPath)),
            // A property of the linked binary, not of this run — see lib/tlb-base.mjs.
            tlbDataBase: tlb.base, tlbProbeSupport: tlb.support,
            mem8: cpu.mem8.byteOffset, memorySize: cpu.memory_size?.[0] >>> 0,
        },
        jit_identity: {
            aot_abi: 5,
            engine_sha256: sha256(fs.readFileSync(wasmPath)),
            ram_size: cpu.memory_size?.[0] >>> 0,
            abi: w.jit_config_abi_version() >>> 0,
            supported_mask: w.jit_config_supported_mask() >>> 0,
            fingerprint_lo: w.jit_codegen_fingerprint_lo() >>> 0,
            fingerprint_hi: w.jit_codegen_fingerprint_hi() >>> 0,
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
        jitModuleForPage,
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
    const supportedMask = typeof ex.jit_config_supported_mask === "function"
        ? ex.jit_config_supported_mask() >>> 0 : null;
    for (const [i, v] of JIT_FLAGS) {
    if (supportedMask !== null && (i >= 32 || !(supportedMask & (1 << i)))) {
            throw new Error(`JIT config index ${i} is unsupported by mask 0x${supportedMask.toString(16)}`);
        }
        const status = ex.set_jit_config(i, v);
        if (supportedMask !== null && status !== 0) {
            throw new Error(`set_jit_config(${i}, ${v}) failed with status ${status}`);
        }
    }
    ex.set_relaxed_fpu(1);
    if (cpu.jit_clear_cache) cpu.jit_clear_cache();
    globalThis["__wasmDump"] = { pages: new Set([c.codeAddr >>> 12]), out: [], keepLatestPerPage: true };
    cpu.io.register_write(L.PORT, { name: "aot-capture" }, () => {});
    emulator.run();
});
