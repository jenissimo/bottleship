// Arm A runner: a freestanding MSVC (or clang) PE executed by the CURRENT v86 JIT, headless in Node.
//
//   node run-v86.mjs --exe out/flat/flat.exe --warm 3 --lo 2000 --hi 8000 --reps 3 [--seed 7]
//                    [--flags "4=1,12=0"] [--switches "jit_guard_groups=0"] [--relaxed 1]
//                    [--dispatch] [--census] [--no-jit] [--out file.json]
//
// The PE is laid out at its fixed ImageBase inside a multiboot (a.out kludge) blob, together with a
// 4 KiB-page identity map of 0..64 MiB and an 8-instruction stub that turns CR0.PG on (production
// runs paged; v86 compiles the fastmem path only with paging on), sets ESP and calls the entry.
// The guest talks through ports: IN 0x888A config words, OUT 0x8889 results, OUT 0x8888 marks.
//
// --dispatch  arms set_dispatch_stats BEFORE anything compiles (counters are compiled in).
// --census    sets tier-2 threshold (idx 15) to 2^31 so every compiled module credits its retired
//             instructions (jit_get_tier2_retired_total) without ever promoting: the compiled share
//             of retired instructions. It changes the emitted code, so it is never a timing run.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { SHIPPING_JIT, SHIPPING_CODEGEN_SWITCHES, parseFlags } from "../../jit-config/shipping.mjs";
import { applyShape } from "../../aot-oracle/lib/engine-unit.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));

export function engineDir() {
    if (process.env.V86_ENGINE_DIR) return path.resolve(process.env.V86_ENGINE_DIR);
    // The MAIN checkout's build (worktrees may carry an in-progress engine).
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: here, encoding: "utf8" }).trim();
    return path.join(path.dirname(common), "vendor/v86");
}

const DISPATCH_NAMES = [
    "blockExecution", "moduleReentry", "moduleExitChainable", "moduleExitDynamic",
    "moduleExitIndirect", "moduleChainedEdge", "moduleChainBudgetExit", "moduleChainMiss",
    "deadFlagCandidate", "deadFlagElided",
    "abseipDispatch", "retChainHit", "retChainMiss",
    "x87CacheHit", "x87CacheFill", "x87CacheInvalidate", "pushRunHit", "pushRunFill",
    "retMemoHit", "retMemoAlias", "retMemoCold", "retMetaHit", "retChainBudget",
    "readTlbCacheHit", "readTlbCacheFill",
];

const LOAD = 0x100000, PD = 0x101000, PT0 = 0x102000, NPT = 16, STACK_TOP = 0x3F0000;

export function buildImage(pe) {
    const dv = new DataView(pe.buffer, pe.byteOffset, pe.byteLength);
    const lfanew = dv.getUint32(0x3c, true);
    if (dv.getUint32(lfanew, true) !== 0x4550) throw Error("not a PE");
    const coff = lfanew + 4;
    const nsec = dv.getUint16(coff + 2, true), optSize = dv.getUint16(coff + 16, true);
    const opt = coff + 20;
    const entry = dv.getUint32(opt + 16, true), base = dv.getUint32(opt + 28, true), sizeOfImage = dv.getUint32(opt + 56, true);
    const importRva = dv.getUint32(opt + 96 + 8, true);
    if (importRva) throw Error("PE has imports: the v86 arm is freestanding");
    if (base < 0x400000) throw Error("ImageBase must be >= 0x400000");
    const end = base + sizeOfImage;
    const img = new Uint8Array(end - LOAD);
    const im = new DataView(img.buffer);
    const sections = [];
    for (let i = 0; i < nsec; i++) {
        const s = opt + optSize + i * 40;
        const name = String.fromCharCode(...pe.subarray(s, s + 8)).replace(/\0.*$/, "");
        const vsize = dv.getUint32(s + 8, true), va = dv.getUint32(s + 12, true);
        const rawSize = dv.getUint32(s + 16, true), rawPtr = dv.getUint32(s + 20, true);
        img.set(pe.subarray(rawPtr, rawPtr + Math.min(rawSize, vsize)), base + va - LOAD);
        sections.push({ name, va: base + va, vsize });
    }
    // multiboot header, a.out kludge
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    const hdr = [MAGIC, FLAGS, (-(MAGIC + FLAGS)) >>> 0, LOAD, LOAD, end, end, LOAD + 0x20];
    hdr.forEach((v, i) => im.setUint32(i * 4, v, true));
    // identity map 0..64 MiB, 4 KiB pages
    for (let t = 0; t < NPT; t++) {
        im.setUint32(PD - LOAD + t * 4, (PT0 + t * 0x1000) | 3, true);
        for (let e = 0; e < 1024; e++) im.setUint32(PT0 - LOAD + t * 0x1000 + e * 4, ((t * 1024 + e) * 0x1000) | 3, true);
    }
    const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    const stub = [
        0xDB, 0xE3,                          // fninit
        0xB8, ...u32(PD), 0x0F, 0x22, 0xD8,  // mov eax, PD; mov cr3, eax
        0x0F, 0x20, 0xC0, 0x0D, ...u32(0x80000000), 0x0F, 0x22, 0xC0, // cr0 |= PG
        0xBC, ...u32(STACK_TOP),             // mov esp, STACK_TOP
        0xB8, ...u32(base + entry), 0xFF, 0xD0, // call entry
        0xF4, 0xEB, 0xFD,                    // hlt; jmp $-1
    ];
    img.set(stub, 0x20);
    return { img, entry: base + entry, base, sizeOfImage, sections };
}

export async function runV86(opts) {
    const dir = engineDir();
    const libv86 = path.join(dir, "build/libv86.mjs"), wasmPath = path.join(dir, "build/v86.wasm");
    const { V86 } = await import(url.pathToFileURL(libv86).href);
    const pe = fs.readFileSync(opts.exe);
    const image = buildImage(new Uint8Array(pe));
    const flags = new Map(SHIPPING_JIT);
    for (const [i, v] of parseFlags(opts.flags || "")) flags.set(i, v);
    if (opts.census) flags.set(15, 0x80000000);
    const switches = new Map(SHIPPING_CODEGEN_SWITCHES);
    for (const kv of String(opts.switches || "").split(",").filter(Boolean)) {
        const [k, v] = kv.split("="); switches.set(k, Number(v));
    }
    const input = [0xF1A7, opts.warm, opts.lo, opts.hi, opts.reps, opts.seed ?? 7];

    return await new Promise((resolve, reject) => {
        const emulator = new V86({ autostart: false, memory_size: 64 * 1024 * 1024, vga_memory_size: 1024 * 1024, wasm_path: wasmPath, log_level: 0 });
        let cpu, w, shape;
        const marks = [], outs = [];
        let inPos = 0;
        const timer = setTimeout(() => done("TIMEOUT"), opts.timeoutMs ?? 900000);
        // cpu.js counts every module compile and its emitted Wasm bytes into this global.
        const cs = globalThis.__jitCompileStats = { count: 0, bytes: 0 };
        const snap = () => ({
            ic: cpu.instruction_counter[0] >>> 0,
            cc: cs.count, cb: cs.bytes,
            d: opts.dispatch ? DISPATCH_NAMES.map((_, i) => Number(w.profiler_dispatch_stat_get(i))) : null,
            jr: opts.census ? Number(w.jit_get_tier2_retired_total()) : null,
        });
        function done(status) {
            clearTimeout(timer);
            const facts = {
                pages: w.jit_debug_page_count(), modules: w.jit_debug_module_count(),
                compiles: cs.count, emittedWasmBytes: cs.bytes,
                tier2Promotions: w.jit_get_tier2_promotions ? w.jit_get_tier2_promotions() : null,
                pagingOn: ((cpu.cr[0] >>> 0) & 0x80000000) !== 0,
            };
            try { emulator.stop(); } catch { /* over */ }
            resolve({
                arm: opts.label || "v86", status, exe: opts.exe, exeSha256: crypto.createHash("sha256").update(pe).digest("hex"),
                engine: { dir, wasmSha256: crypto.createHash("sha256").update(fs.readFileSync(wasmPath)).digest("hex") },
                input, shape, jit: facts, marks, outs, dispatchNames: opts.dispatch ? DISPATCH_NAMES : null,
                sections: image.sections,
            });
        }
        emulator.bus.register("cpu-event-halt", () => done(marks.length && marks[marks.length - 1].id === 99 ? "ok" : "HALT_EARLY"));
        emulator.add_listener("emulator-loaded", () => {
            try {
                cpu = emulator.v86.cpu; w = cpu.wm.exports;
                cpu.reboot_internal(); cpu.reset_memory();
                cpu.load_multiboot(image.img.buffer);
                const got = applyShape(w, { flags, relaxed: opts.relaxed ?? 1, switches });
                shape = { flags: got.flags, switches: got.switches, relaxed: got.relaxed, jitDisabled: !!opts.noJit };
                if (opts.noJit) { w.set_jit_config(0, 1); }
                if (cpu.jit_clear_cache) cpu.jit_clear_cache();
                w.set_dispatch_stats(opts.dispatch ? 1 : 0);
                if (opts.dispatch) w.profiler_init();
                const dev = { name: "flat-pair" };
                cpu.io.register_read(0x888A, dev, () => 0, () => 0, () => (input[inPos++] ?? 0) >>> 0);
                cpu.io.register_write(0x8889, dev, () => {}, () => {}, (v) => outs.push(v >>> 0));
                cpu.io.register_write(0x8888, dev, () => {}, () => {}, (id) => {
                    // A phase START is timestamped after the snapshot, an END before it, so the
                    // snapshot cost stays outside the timed window.
                    const start = id === 10 || id === 12;
                    if (start) { const s = snap(); marks.push({ id, t: Number(process.hrtime.bigint()), ...s }); }
                    else { const t = Number(process.hrtime.bigint()); marks.push({ id, t, ...snap() }); }
                });
                emulator.run();
            } catch (e) { clearTimeout(timer); reject(e); }
        });
    });
}

function parseCli(argv) {
    const o = { warm: 2, lo: 1000, hi: 4000, reps: 3, seed: 7 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === "--exe") o.exe = next();
        else if (["--warm", "--lo", "--hi", "--reps", "--seed", "--relaxed"].includes(a)) o[a.slice(2)] = Number(next());
        else if (a === "--flags") o.flags = next();
        else if (a === "--switches") o.switches = next();
        else if (a === "--dispatch") o.dispatch = true;
        else if (a === "--census") o.census = true;
        else if (a === "--no-jit") o.noJit = true;
        else if (a === "--out") o.out = next();
        else if (a === "--label") o.label = next();
        else { console.error(`unknown option ${a}`); process.exit(2); }
    }
    if (!o.exe) { console.error("--exe required"); process.exit(2); }
    return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
    const o = parseCli(process.argv.slice(2));
    const r = await runV86(o);
    const s = JSON.stringify(r);
    if (o.out) fs.writeFileSync(o.out, s);
    console.log(s);
    process.exit(r.status === "ok" ? 0 : 3);
}
