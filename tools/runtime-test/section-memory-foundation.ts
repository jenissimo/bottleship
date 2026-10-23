import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { GuestDataRoutes } from "../../src/worker/core/memory/guest-data-routes";
import { PageTableManager } from "../../src/worker/core/memory/page-table-manager";
import { MEM_PAGETABLE_BASE } from "../../src/worker/core/cpu/emulator-config";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
interface Options { lib: string; wasm: string; libSha: string; wasmSha: string; out: string }
const USAGE = "bun run test:section-memory --lib-sha <64hex> --wasm-sha <64hex> --out <new-directory> [--lib <libv86.mjs>] [--wasm <v86.wasm>]";
let options: Options;
let cpuConstructionAttempts = 0;
let unretiredCpu = false;

function parseOptions(args: string[]): Options {
    const values = new Map<string, string>();
    const names = new Set(["--lib", "--wasm", "--lib-sha", "--wasm-sha", "--out"]);
    for (let i = 0; i < args.length; i += 2) {
        const name = args[i]!, value = args[i + 1];
        if (!names.has(name) || values.has(name) || !value || value.startsWith("--")) {
            throw new Error("Invalid or duplicate argument: " + name + "\n" + USAGE);
        }
        values.set(name, value);
    }
    const libSha = values.get("--lib-sha")?.toLowerCase(), wasmSha = values.get("--wasm-sha")?.toLowerCase();
    if (!libSha || !wasmSha || !/^[0-9a-f]{64}$/.test(libSha) || !/^[0-9a-f]{64}$/.test(wasmSha) || !values.get("--out")) {
        throw new Error("Explicit reviewed SHA256 values and a fresh output directory are required.\n" + USAGE);
    }
    return {
        lib: resolve(values.get("--lib") ?? resolve(ROOT, "vendor/v86/build/libv86.mjs")),
        wasm: resolve(values.get("--wasm") ?? resolve(ROOT, "vendor/v86/build/v86.wasm")),
        libSha, wasmSha, out: resolve(values.get("--out")!),
    };
}

function errorRecord(error: unknown) {
    const e = error as Error & { code?: string };
    return { name: e?.name ?? "Error", message: e?.message ?? String(error), stack: e?.stack ?? "", code: e?.code };
}

function assertBeforeCpuProfile() {
    const receipt: any = { status: "CHECKING", cpuConstructionAttempts,
        requested: { lib: options.lib, wasm: options.wasm, libSha256: options.libSha, wasmSha256: options.wasmSha } };
    try {
        const artifacts = [{ name: "libv86.mjs", path: options.lib, expected: options.libSha },
            { name: "v86.wasm", path: options.wasm, expected: options.wasmSha }];
        receipt.artifacts = artifacts.map(a => ({ ...a, actual: hash(readFileSync(a.path)) }));
        const sources = ["src/worker/core/memory/page-table-manager.ts", "src/worker/core/memory/mem-accessor.ts",
            "src/worker/core/memory/guest-data-routes.ts", "tools/runtime-test/section-memory-foundation.ts",
            "tools/jit-config/shipping.mjs", "package.json"];
        const inputs = resolve(options.out, "inputs"); mkdirSync(inputs);
        receipt.sources = sources.map(path => {
            const bytes = readFileSync(resolve(ROOT, path));
            writeFileSync(resolve(inputs, path.replaceAll("/", "__")), bytes);
            return { path, sha256: hash(bytes) };
        });
        for (const a of receipt.artifacts) assert.equal(a.actual, a.expected, a.name + " SHA256 mismatch before CPU initialization");
        for (const a of artifacts) copyFileSync(a.path, resolve(inputs, a.name));
        receipt.status = "PASS";
    } catch (error) {
        receipt.status = "FAIL"; receipt.error = errorRecord(error);
        throw error;
    } finally {
        receipt.cpuConstructionAttempts = cpuConstructionAttempts;
        writeFileSync(resolve(options.out, "preflight.json"), JSON.stringify(receipt, null, 2) + "\n");
    }
}
const PAGE = 0x1000, RAM = 640 << 20;
const A = 0x400000, B = 0x420000;
// Test-owned device aperture in this standalone CPU, not a shipping address assignment.
const APERTURE = 0x90000000, APERTURE_SIZE = 0x20000;
const BASE = 0x100000, IMAGE_SIZE = 0x20000, STACK = BASE + IMAGE_SIZE - 16;
const RES = BASE + 0x18000, PORT = 0x501;
const HLE_WORD = 0x11223344, OTHER_WORD = 0xa0b0c0d0;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pteOffset = (address: number) =>
    MEM_PAGETABLE_BASE + PAGE + (address >>> 22) * PAGE + ((address >>> 12) & 1023) * 4;

function image() {
    const bytes = new Uint8Array(IMAGE_SIZE), dv = new DataView(bytes.buffer);
    [0x1badb002, 0x10000, (-0x1badb002 - 0x10000) >>> 0, BASE, BASE, BASE + IMAGE_SIZE,
        BASE + IMAGE_SIZE, BASE + 0x40].forEach((v, i) => dv.setUint32(i * 4, v, true));
    let p = 0x40;
    const emit = (...v: number[]) => { bytes.set(v, p); p += v.length; };
    const u32 = (v: number) => { dv.setUint32(p, v >>> 0, true); p += 4; };
    const read = (address: number) => { emit(0xa1); u32(address); };
    const store = (address: number) => { emit(0xa3); u32(address); };
    const mov = (address: number, value: number) => { emit(0xc7, 0x05); u32(address); u32(value); };
    const phase = (value: number) => { emit(0xb8); u32(value); emit(0xba); u32(PORT); emit(0xef); };
    emit(0xbc); u32(STACK);
    emit(0xb9); u32(100000);
    const firstLoop = BASE + p;
    emit(0x89, 0x0d); u32(A); // mov [A],ecx
    read(B); store(RES);
    mov(B + 4, OTHER_WORD); read(A + 4); store(RES + 4);
    emit(0x49, 0x0f, 0x85); u32(firstLoop - (BASE + p + 4));
    phase(1); // Actual CPU writes above precede HLE access in the host callback.
    read(B + 8); store(RES + 8);
    read(B + 16); store(RES + 12);
    phase(2);
    emit(0xb9); u32(100000);
    const secondLoop = BASE + p;
    emit(0x89, 0x0d); u32(A + 32);
    read(B + 32); store(RES + 16);
    emit(0x49, 0x0f, 0x85); u32(secondLoop - (BASE + p + 4));
    phase(3);
    emit(0xf4);
    return { bytes, firstLoop, secondLoop };
}

async function withoutWindow<T>(action: () => Promise<T>) {
    const g = globalThis as any, had = Object.hasOwn(g, "window"), previous = g.window;
    if (had) delete g.window;
    try { return await action(); }
    finally { if (had) g.window = previous; }
}

async function run(jit: boolean) {
    // Artifacts are mandatory; read failure is infrastructure, never an eligible mechanism RED.
    const pins = {
        lib: hash(readFileSync(options.lib)), wasm: hash(readFileSync(options.wasm)),
        ptm: hash(readFileSync(resolve(ROOT, "src/worker/core/memory/page-table-manager.ts"))),
        mem: hash(readFileSync(resolve(ROOT, "src/worker/core/memory/mem-accessor.ts"))),
        routes: hash(readFileSync(resolve(ROOT, "src/worker/core/memory/guest-data-routes.ts"))),
        runner: hash(readFileSync(fileURLToPath(import.meta.url))),
    };
    assert.equal(pins.lib, options.libSha);
    assert.equal(pins.wasm, options.wasmSha);
    const out = options.out, arm = jit ? "jit" : "interpreter";
    const g = globalThis as any, oldPreemption = g.preemption, oldDump = g.__wasmDump;
    const program = image(), journal: unknown[] = [], result: any = { arm, pins, memoryBytes: RAM, journal };
    let em: any, timer: ReturnType<typeof setTimeout> | undefined;
    const leases: Array<{ release(): void }> = [];
    const begun = performance.now();
    try {
        const { V86 } = await import(options.lib);
        const { SHIPPING_JIT, applyCodegenSwitches } = await import("../jit-config/shipping.mjs");
        cpuConstructionAttempts++;
        em = new V86({ autostart: false, memory_size: RAM, wasm_path: options.wasm, log_level: 0,
            ...(jit ? {} : { disable_jit: 1 }) });
        await new Promise<void>((resolveLoaded, reject) => {
            const deadline = setTimeout(() => reject(new Error("INFRA: emulator load deadline")), 10000);
            em.add_listener("emulator-loaded", () => { clearTimeout(deadline); resolveLoaded(); });
        });
        const c = em.v86.cpu, w = c.wm.exports;
        c.reboot_internal(); c.reset_memory(); c.load_multiboot(program.bytes.buffer);
        if (jit) {
            for (const [index, value] of SHIPPING_JIT) w.set_jit_config(index, value);
            applyCodegenSwitches(w);
            // Exercise the normally optional fast-store path too. This changes no artifact.
            w.set_jit_config(19, 1);
            assert.equal(w.get_jit_config(19), 1);
        }
        w.set_dispatch_stats(1);
        assert.equal(w.get_dispatch_stats(), 1);
        g.__wasmDump = { out: [], maxPages: 8, keepLatestPerPage: true };
        g.preemption = { getWasmExports: () => w };
        const compiledMmio = { firstWrite: 0, firstRead: 0 };
        if (jit) {
            // Transparent observers of the real emitted module's Wasm imports: every
            // call invokes the original engine helper, with unchanged args/return.
            const write = c.jit_imports.safe_write32_slow_jit;
            const read = c.jit_imports.safe_read32s_slow_jit;
            c.jit_imports.safe_write32_slow_jit = (address: number, value: number, eip: number) => {
                const returned = write(address, value, eip);
                if ((address >>> 0) === A && eip === (program.firstLoop & 0xfff)) compiledMmio.firstWrite++;
                return returned;
            };
            c.jit_imports.safe_read32s_slow_jit = (address: number, eip: number) => {
                const returned = read(address, eip);
                if ((address >>> 0) === B && eip === ((program.firstLoop + 6) & 0xfff)) compiledMmio.firstRead++;
                return returned;
            };
        }
        const memory = () => new Uint8Array(c.mem8.buffer, c.mem8.byteOffset, c.mem8.length);
        const ptm = new PageTableManager(memory, () => w);
        ptm.initialize(RAM);
        ptm.enablePaging(c);
        const ram = memory(), dv = new DataView(ram.buffer, ram.byteOffset, ram.length);
        ram.fill(0x5a, A, A + PAGE); ram.fill(0xa5, B, B + PAGE);
        const shadowA = ram.slice(A, A + PAGE), shadowB = ram.slice(B, B + PAGE);
        const sab = new SharedArrayBuffer(PAGE), backing = new Uint8Array(sab), shared = new DataView(sab);
        const calls = { read8: 0, write8: 0, read32: 0, write32: 0 };
        c.io.mmap_register(APERTURE, APERTURE_SIZE,
            (address: number) => { calls.read8++; return backing[(address >>> 0) - APERTURE]; },
            (address: number, value: number) => { calls.write8++; backing[(address >>> 0) - APERTURE] = value; },
            (address: number) => { calls.read32++; return shared.getInt32((address >>> 0) - APERTURE, true); },
            (address: number, value: number) => { calls.write32++; shared.setInt32((address >>> 0) - APERTURE, value, true); });
        // Same semantic predicates as baseline-third; only the opt-in mapping
        // setup now uses the foundation rather than test-side direct PTE writes.
        const routes = new GuestDataRoutes(memory, (address, size, write) => ptm.isRangeAccessible(address, size, write));
        const pteA = ptm.mapExternalDataPages(A, APERTURE, PAGE);
        leases.push(pteA, ptm.mapExternalDataPages(B, APERTURE, PAGE));
        leases.push(routes.map(A, sab, 0, PAGE), routes.map(B, sab, 0, PAGE));
        Mem.bind(memory, (address, size, perms) => ptm.isRangeAccessible(address, size, perms.includes("w")), undefined, routes);
        let callbackFailure: unknown;
        c.io.register_write(PORT, {}, undefined, undefined, (phase: number) => {
            try {
                journal.push({ phase, compiledBlocks: w.profiler_dispatch_stat_get(0), compiledMmio: { ...compiledMmio }, calls: { ...calls } });
                if (phase === 1) {
                    result.cpuControl = [dv.getUint32(RES, true), dv.getUint32(RES + 4, true),
                        shared.getUint32(0, true), shared.getUint32(4, true)];
                    result.hleRead = Mem.readUint32(B);
                    result.hleWriteAccepted = Mem.writeUint32(A + 8, HLE_WORD);
                    result.bulkWriteAccepted = Mem.writeBytes(A + 16, new Uint8Array([8, 7, 6, 5]));
                    result.hleBulkRead = Array.from(Mem.readBytes(B + 16, 4) ?? []);
                    result.sharedAfterHle = [shared.getUint32(8, true), shared.getUint32(16, true)];
                } else if (phase === 2) {
                    result.cpuAfterHle = [dv.getUint32(RES + 8, true), dv.getUint32(RES + 12, true)];
                    ptm.setProtection(A, PAGE, 2);
                    result.readOnlyPhysical = (dv.getUint32(pteOffset(A), true) & 0xfffff000) >>> 0;
                    result.dataGuards = { readOnly: routes.isAccessible(A, 4, false) && !routes.isAccessible(A, 4, true) };
                    ptm.setProtection(A, PAGE, 1);
                    result.dataGuards.noAccess = !routes.isAccessible(A, 4, false);
                    ptm.setProtection(A, PAGE, 4);
                    ptm.rebuildWriteMap([{ base: A, size: PAGE }, { base: B, size: PAGE }]);
                    result.readWritePhysical = (dv.getUint32(pteOffset(A), true) & 0xfffff000) >>> 0;
                    result.fastWriteBit = w.fastmem_write_map_get(A >>> 12) & 1;
                } else if (phase === 3) {
                    result.cpuAfterProtect = dv.getUint32(RES + 16, true);
                    result.shadowUnchanged = [ram.subarray(A, A + PAGE).every((v, i) => v === shadowA[i]),
                        ram.subarray(B, B + PAGE).every((v, i) => v === shadowB[i])];
                } else throw new Error("Unexpected guest phase " + phase);
            } catch (error) { callbackFailure = error; }
        });
        await new Promise<void>((resolveHalt, reject) => {
            timer = setTimeout(() => { em.stop(); reject(new Error("Actual CPU did not halt within15s")); }, 15000);
            em.bus.register("cpu-event-halt", () => { clearTimeout(timer); em.stop(); resolveHalt(); });
            em.run();
        });
        if (callbackFailure) throw callbackFailure;
        const modules = (g.__wasmDump.out as any[]).map((entry, i) => {
            const bytes = entry.bytes as Uint8Array;
            const module = new WebAssembly.Module(bytes);
            const record = { start: entry.start, bytes: bytes.length, sha256: hash(bytes),
                imports: WebAssembly.Module.imports(module).map(x => x.name) };
            if (out) writeFileSync(resolve(out, arm + "-module-" + i + ".wasm"), bytes);
            return record;
        });
        result.dataGuards.liveLease = pteA.isCurrent();
        pteA.release();
        result.dataGuards.released = !pteA.isCurrent() && !ptm.isRangeAccessible(A, 4, false);
        ptm.setProtection(A, PAGE, 4);
        result.dataGuards.releaseThenProtectKeepsIdentity = ((dv.getUint32(pteOffset(A), true) & 0xfffff000) >>> 0) === A;
        ptm.commitPages(A, PAGE);
        const replacement = ptm.mapExternalDataPages(A, APERTURE, PAGE);
        leases.push(replacement);
        pteA.release();
        result.dataGuards.staleReleasePreservesReplacement = replacement.isCurrent() &&
            ((dv.getUint32(pteOffset(A), true) & 0xfffff000) >>> 0) === APERTURE;
        replacement.release();
        ptm.commitPages(A, PAGE);
        result.dataGuards.recommittedIdentity = ((dv.getUint32(pteOffset(A), true) & 0xfffff000) >>> 0) === A;
        result.execution = { halted: true, phases: journal.length,
            compiledBlocks: w.profiler_dispatch_stat_get(0), modules, calls };
        result.observed = {
            cpuControl: result.cpuControl, hleRead: result.hleRead, hleWriteAccepted: result.hleWriteAccepted,
            bulkWriteAccepted: result.bulkWriteAccepted, hleBulkRead: result.hleBulkRead,
            sharedAfterHle: result.sharedAfterHle, cpuAfterHle: result.cpuAfterHle,
            readOnlyPhysical: result.readOnlyPhysical, readWritePhysical: result.readWritePhysical,
            fastWriteBit: result.fastWriteBit, cpuAfterProtect: result.cpuAfterProtect,
            shadowUnchanged: result.shadowUnchanged,
        };
        result.expected = {
            cpuControl: [1, OTHER_WORD, 1, OTHER_WORD], hleRead: 1, hleWriteAccepted: true,
            bulkWriteAccepted: 4, hleBulkRead: [8, 7, 6, 5],
            sharedAfterHle: [HLE_WORD, 0x05060708], cpuAfterHle: [HLE_WORD, 0x05060708],
            readOnlyPhysical: APERTURE, readWritePhysical: APERTURE,
            fastWriteBit: 0, cpuAfterProtect: 1, shadowUnchanged: [true, true],
        };
    } catch (error) {
        result.error = { name: (error as Error).name, message: String((error as Error).message), stack: String((error as Error).stack) };
    } finally {
        if (timer) clearTimeout(timer);
        if (em) {
            const cleanupErrors: ReturnType<typeof errorRecord>[] = [];
            try { em.stop(); } catch (error) { cleanupErrors.push(errorRecord(error)); }
            for (const lease of leases) {
                try { lease.release(); } catch (error) { cleanupErrors.push(errorRecord(error)); }
            }
            let destroyDeadline: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([Promise.resolve().then(() => em.destroy()), new Promise<never>((_, reject) => {
                    destroyDeadline = setTimeout(() => reject(new Error("V86 destroy deadline5s")), 5000);
                })]);
                result.destroyed = true;
            } catch (error) {
                cleanupErrors.push(errorRecord(error)); result.destroyed = false; unretiredCpu = true;
            } finally { if (destroyDeadline) clearTimeout(destroyDeadline); }
            if (cleanupErrors.length) result.cleanupError = cleanupErrors;
        }
        Mem.bind(() => new Uint8Array());
        g.preemption = oldPreemption; g.__wasmDump = oldDump;
        result.elapsedMs = performance.now() - begun;
        if (out) writeFileSync(resolve(out, arm + ".json"), JSON.stringify(result, null, 2) + "\n");
        Bun.gc(true);
    }
    return result;
}

function validate(result: any, jit: boolean): void {
    assert.equal(result.error, undefined, "Actual engine run failed: " + (result.error?.message ?? ""));
    assert.equal(result.cleanupError, undefined, "Actual engine retirement failed");
    assert.equal(result.destroyed, true);
    assert.equal(result.execution.halted, true);
    assert.equal(result.execution.phases, 3);
    assert.deepEqual(result.cpuControl, [1, OTHER_WORD, 1, OTHER_WORD]);
    if (jit) {
        assert.ok(result.journal[0].compiledBlocks > 0, "No compiled blocks executed before phase1");
        assert.ok(result.execution.modules.some((m: any) => m.start === BASE &&
            m.imports.includes("safe_write32_slow_jit") && m.imports.includes("safe_read32s_slow_jit")),
            "No emitted MMIO module for guest code page");
        assert.ok(result.journal[0].compiledMmio.firstWrite > 0, "Exact compiled MMIO write did not execute");
        assert.ok(result.journal[0].compiledMmio.firstRead > 0, "Exact compiled MMIO read did not execute");
    } else assert.equal(result.execution.compiledBlocks, 0);
    assert.deepEqual(result.observed, result.expected);
    assert.deepEqual(result.dataGuards, { readOnly: true, noAccess: true, liveLease: true, released: true,
        releaseThenProtectKeepsIdentity: true, staleReleasePreservesReplacement: true, recommittedIdentity: true });
}

async function main(): Promise<void> {
    options = parseOptions(process.argv.slice(2));
    if (existsSync(options.out)) throw new Error("Refusing to overwrite an existing report directory: " + options.out);
    mkdirSync(dirname(options.out), { recursive: true });
    mkdirSync(options.out);
    const summary: any = { status: "RUNNING", cpuConstructionAttempts: 0, arms: [], source: fileURLToPath(import.meta.url) };
    try {
        assertBeforeCpuProfile();
        for (const jit of [false, true]) {
            const outcome: any = { arm: jit ? "jit" : "interpreter", status: "RUNNING" };
            try {
                assert.equal(unretiredCpu, false, "Previous CPU retirement is unverified; refusing another CPU");
                const result = await withoutWindow(() => run(jit));
                validate(result, jit);
                outcome.status = "PASS";
            } catch (error) { outcome.status = "FAIL"; outcome.error = errorRecord(error); }
            summary.arms.push(outcome);
            writeFileSync(resolve(options.out, outcome.arm + "-outcome.json"), JSON.stringify(outcome, null, 2) + "\n");
            console.log(JSON.stringify(outcome));
        }
        summary.status = summary.arms.every((arm: any) => arm.status === "PASS") ? "PASS" : "FAIL";
    } catch (error) {
        summary.status = "FAIL"; summary.error = errorRecord(error);
        console.error(JSON.stringify(summary.error));
    } finally {
        summary.cpuConstructionAttempts = cpuConstructionAttempts;
        summary.unretiredCpu = unretiredCpu;
        writeFileSync(resolve(options.out, "result.json"), JSON.stringify(summary, null, 2) + "\n");
    }
    console.log(JSON.stringify({ status: summary.status, cpuConstructionAttempts, unretiredCpu, report: resolve(options.out, "result.json") }));
    if (summary.status !== "PASS") process.exitCode = 1;
    // A failed destroy must not leave a standalone verification process hanging.
    // The durable report remains FAIL; this terminates only this CLI process.
    if (unretiredCpu) process.exit(1);
}

main().catch(error => {
    console.error(JSON.stringify(errorRecord(error)));
    process.exitCode = 1;
});
