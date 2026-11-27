import { beforeAll, expect, test } from "bun:test";
import { BottleShipMachine } from "../../src/worker/wwt/machine";
import { WwtCompiler } from "../../src/worker/wwt/translator";
import { WwtCpu } from "../../src/worker/wwt/cpu";
import { WwtEmulator } from "../../src/worker/wwt/emulator";
import { installWwtHypercall } from "../../src/worker/wwt/hypercall";
import { System } from "../../src/worker/core/system";
import { registerCoreParticipants } from "../../src/worker/savestate/core-participants";
import { MemoryChunkStore } from "../../src/worker/savestate/chunk-store";
import { writeRamChunks } from "../../src/worker/savestate/ram";
import { ParticipantRegistry, savestateParticipants } from "../../src/worker/savestate/participant";
import { captureSession, checkSavestate, restoreSession } from "../../src/worker/savestate/session";
import { preserveSavestateParticipants } from "./helpers/scoped-process-state";

preserveSavestateParticipants();
import { packMappedPe } from "../../src/worker/wwt/pe-aot";
import { installFakeOpfs } from "./fixtures/fake-opfs";

let compilerBytes: ArrayBuffer;
let machine: BottleShipMachine;
let cpu: number;
let memory: Uint8Array;
let words: Uint32Array;
const pc = 0x20000;
const stack = 0x54000;

beforeAll(async () => {
    const compilerPath = process.env.BOTTLESHIP_TEST_WWT_COMPILER;
    compilerBytes = await Bun.file(compilerPath ??
        new URL("../../public/wwt-provider/wwt_wasm.wasm", import.meta.url)).arrayBuffer();
    machine = new BottleShipMachine(await WwtCompiler.fromBytes(compilerBytes), 4 << 20);
    await machine.init();
    memory = new Uint8Array(machine.memory.buffer);
    words = new Uint32Array(machine.memory.buffer);
    cpu = machine.newCpu();
});

function callAt(address: number): number {
    const A = machine.abi.cpu;
    words[(cpu + A.PREEMPT_AT) >>> 2] = 0x70000000;
    words[(cpu + A.GPR + 16) >>> 2] = stack;
    words[stack >>> 2] = machine.stopAddress;
    expect(machine.run(cpu, address)).toBe(machine.stopAddress);
    return words[(cpu + A.GPR) >>> 2];
}

test("invalidated code observes changed x86 instructions", () => {
    memory.set([0xb8, 42, 0, 0, 0, 0xc3], pc);
    expect(callAt(pc)).toBe(42);
    const compiled = machine.translationStats.compiled;
    memory[pc + 1] = 127;
    machine.setL1(pc >>> 12, machine.zeroL2);
    expect(callAt(pc)).toBe(127);
    expect(machine.translationStats.compiled).toBeGreaterThan(compiled);
});

test("flat RAM keeps both ordinary guest accesses and stack operations outside native memory", async () => {
    const flat = new BottleShipMachine(await WwtCompiler.fromBytes(compilerBytes, true), 4 << 20);
    await flat.init();
    const state = flat.newCpu();
    const view = new DataView(flat.memory.buffer);
    const code = new Uint8Array(flat.memory.buffer);
    const A = flat.abi.cpu;
    const address = flat.nativeAlloc(16);
    view.setUint32(address, 0x10203040, true);
    let fault = 0;
    flat.onFault = (_cpu, _code, eip) => { fault = eip; return flat.stopAddress; };
    code.set([0xa1, 0, 0, 0, 0, 0xc3], pc);
    view.setUint32(pc + 1, address, true);
    view.setUint32(state + A.PREEMPT_AT, 10000, true);
    expect(flat.run(state, pc)).toBe(flat.stopAddress);
    expect(fault).toBe(pc);

    code.set([0x50, 0xc3], pc + 0x2000);
    view.setUint32(state + A.GPR + 16, address + 4, true);
    expect(flat.run(state, pc + 0x2000)).toBe(flat.stopAddress);
    expect(fault).toBe(pc + 0x2000);
    expect(view.getUint32(address, true)).toBe(0x10203040);
});

test("guarded flat stack faults expose the preceding ESP and flags", async () => {
    const limit = 4 << 20;
    const flat = new BottleShipMachine(await WwtCompiler.fromBytes(compilerBytes, true), limit);
    await flat.init();
    const state = flat.newCpu();
    const view = new DataView(flat.memory.buffer);
    const ram = new Uint8Array(flat.memory.buffer);
    const A = flat.abi.cpu;
    // push eax; push ebx; push ecx; cmp eax,eax; mov esp,edx; push esi; ret
    ram.set([0x50, 0x53, 0x51, 0x39, 0xc0, 0x89, 0xd4, 0x56, 0xc3], pc);
    ram.fill(0x55, limit - 8, limit + 8);
    view.setUint32(state + A.PREEMPT_AT, 10000, true);
    view.setUint32(state + A.GPR + 2 * 4, limit + 2, true);
    view.setUint32(state + A.GPR + 4 * 4, stack, true);
    view.setUint32(state + A.GPR + 6 * 4, 0x11223344, true);
    let fault: number[] | undefined;
    flat.onFault = (faultCpu, code, eip, address) => {
        fault = [code, eip, address, view.getUint32(faultCpu + A.GPR + 4 * 4, true), flat.eflags(faultCpu) & 0x8d5];
        return flat.stopAddress;
    };
    expect(flat.run(state, pc)).toBe(flat.stopAddress);
    expect(fault).toEqual([flat.abi.fault.ACCESS_VIOLATION_WRITE, pc + 7, limit - 2, limit + 2, 0x44]);
    expect([...ram.subarray(limit - 8, limit + 8)]).toEqual(Array(16).fill(0x55));
});

test("interior loop yields at the requested retired count and resumes on the jump", () => {
    const address = pc + 0x10000;
    memory.set([0x83, 0xc0, 1, 0xeb, 0xfe], address);
    const A = machine.abi.cpu;
    const word = (key: number) => (cpu + key) >>> 2;
    words[word(A.RETIRED_INSNS)] = 0;
    words[word(A.PREEMPT_AT)] = 32;
    words[word(A.GPR)] = 0;
    let pausedAt = 0;
    machine.onPreempt = (_cpu, eip) => { pausedAt = eip; return true; };
    expect(machine.run(cpu, address)).toBe(machine.yieldAddress);
    expect(pausedAt).toBe(address + 3);
    expect(words[word(A.RETIRED_INSNS)]).toBe(32);
    expect(words[word(A.GPR)]).toBe(1);
});

test("WWT savestate restores executable RAM, live x87 and integer state, and resumes the same guest", async () => {
    const ramSize = 4 << 20;
    const host = new BottleShipMachine(await WwtCompiler.fromBytes(compilerBytes), ramSize);
    await host.init();
    const cpuStateBase = host.nativeAlloc(4096, 4096);
    const wasm = (file: string) => Bun.file(new URL("../../public/" + file, import.meta.url)).arrayBuffer();
    const hypercall = await installWwtHypercall(host, ramSize, cpuStateBase, {
        hypercall: await wasm("wwt-hypercall.wasm"),
        d3d9Arena: await wasm("wwt-d3d9-arena.wasm"),
    });
    const core = new WwtCpu(host, ramSize, hypercall, cpuStateBase);
    const engine = new WwtEmulator(core, error => { throw error; });
    const system = System.getInstance();
    const processBefore = system.process;
    const registry = new ParticipantRegistry();
    try {
        system.process = { v86: engine } as unknown as NonNullable<typeof system.process>;
        registerCoreParticipants();
        const participant = savestateParticipants.all().find(p => p.id === "cpu")!;
        expect(participant.version).toBe(2);
        registry.add(participant);
    } finally {
        system.process = processBefore;
    }

    const data = 0x31000;
    const marker = 0x12345678;
    const received: number[] = [];
    core.io.register_write(0x1234, null, undefined, undefined, value => {
        received.push(value);
        core.requestYield();
    });
    const bytes = new Uint8Array([
        0xd9, 0xe8,                         // fld1
        0xb8, 41, 0, 0, 0,                  // mov eax, 41
        0xef,                               // out dx, eax
        0x03, 0x05, 0, 0x10, 0x03, 0,       // add eax, [data]
        0xdb, 0x1d, 4, 0x10, 0x03, 0,       // fistp dword ptr [data + 4]
        0xef,                               // out dx, eax
    ]);
    core.mem8.set(bytes, pc);
    core.mem32s[data >>> 2] = marker;
    core.instruction_pointer[0] = pc;
    core.reg32[2] = 0x1234;
    core.reg32[4] = stack;
    core.main_loop();
    expect(received).toEqual([41]);
    expect(core.instruction_pointer[0]).toBe(pc + 8);
    expect(core.fpu_get_sti_f64(0)).toBe(1);
    const retiredAtCapture = core.instruction_counter[0];

    const target = {
        guestMemory: () => core.mem8,
        compatibilityKey: () => ({ buildSha: "test", contentHash: "test", configHash: "test", bootLayout: "test", participants: {} }),
        overlayState: () => "",
        gameId: () => "wwt-test",
        touchedModules: () => [],
    };
    const captured = await captureSession(target, new Set(), undefined, registry);
    const checked = checkSavestate(target, captured.bytes);
    expect(checked.ok).toBe(true);
    const store = new MemoryChunkStore();
    await writeRamChunks(captured.pending, store);

    core.mem8.set([0x83, 0xc0, 3, 0x90, 0x90, 0x90], pc + 8);
    core.mem32s[data >>> 2] = 5;
    core.wm.exports.jit_dirty_cache(pc, pc + bytes.length);
    core.main_loop();
    expect(received).toEqual([41, 44]);
    expect(core.mem32s[(data + 4) >>> 2]).toBe(1);
    expect(core.fpu_stack_empty[0]).toBe(0xff);
    const compiledBeforeRestore = core.getTranslationStats().compiled;
    const incompatible = { ...checked.state, sections: new Map(checked.state.sections) };
    incompatible.sections.set("cpu", { format: "wrong" });
    await expect(restoreSession(target, incompatible, store, registry)).rejects.toThrow("Incompatible WWT register snapshot");
    expect(core.mem32s[data >>> 2]).toBe(5);
    expect(core.instruction_pointer[0]).toBe(pc + bytes.length);
    await restoreSession(target, checked.state, store, registry);
    expect(core.mem32s[data >>> 2]).toBe(marker);
    expect(core.mem32s[(data + 4) >>> 2]).toBe(0);
    expect(core.instruction_counter[0]).toBe(retiredAtCapture);
    expect(core.instruction_pointer[0]).toBe(pc + 8);
    expect(core.fpu_get_sti_f64(0)).toBe(1);
    core.main_loop();
    expect(received).toEqual([41, 44, 41 + marker]);
    expect(core.mem32s[(data + 4) >>> 2]).toBe(1);
    expect(core.getTranslationStats().compiled).toBeGreaterThan(compiledBeforeRestore);

    const emptyChunk = 0x70000;
    core.mem8[emptyChunk] = 1;
    await restoreSession(target, checked.state, store, registry);
    expect(core.mem8[emptyChunk]).toBe(0);
    core.main_loop();
    expect(received).toEqual([41, 44, 41 + marker, 41 + marker]);
});

function minimalPe(entry: number): Uint8Array {
    const file = new Uint8Array(0x2200);
    const view = new DataView(file.buffer);
    const word = (at: number, value: number) => view.setUint16(at, value, true);
    const dword = (at: number, value: number) => view.setUint32(at, value, true);
    const opt = 0x58, text = 0x138;
    word(0, 0x5a4d);
    dword(0x3c, 0x40);
    dword(0x40, 0x4550);
    word(0x44, 0x14c);
    word(0x46, 1);
    word(0x54, 224);
    word(0x56, 0x010e);
    word(opt, 0x10b);
    dword(opt + 0x10, entry);
    dword(opt + 0x14, 0x1000);
    dword(opt + 0x1c, 0x400000); // deliberately different from the mapped base
    dword(opt + 0x20, 0x1000);
    dword(opt + 0x24, 0x200);
    dword(opt + 0x38, 0x3000);
    dword(opt + 0x3c, 0x200);
    word(opt + 0x44, 3);
    dword(opt + 0x5c, 16);
    file.set(new TextEncoder().encode(".text"), text);
    dword(text + 8, 0x2000);
    dword(text + 12, 0x1000);
    dword(text + 16, 0x2000);
    dword(text + 20, 0x200);
    dword(text + 36, 0x60000020);
    return file;
}

test("packs a small mapped PE even when the original has a large file overlay", () => {
    const base = 0x90000;
    const file = minimalPe(0x1000);
    const originalWithOverlay = new Uint8Array((32 << 20) + 1);
    originalWithOverlay.set(file);
    originalWithOverlay[originalWithOverlay.length - 1] = 0xa5;
    const image = new Uint8Array(0x3000);
    image.set([0xb8, 42, 0, 0, 0, 0xc3], 0x1000); // mov eax,42; ret

    const expected = packMappedPe(image, file, base);
    const packed = packMappedPe(image, originalWithOverlay, base);
    expect(packed).toEqual(expected);
    expect(() => packMappedPe(originalWithOverlay, file, base)).toThrow("Unsupported AOT image size or address");
});

test.each(["default", "explicit auto", "off", "no OPFS", "fast default", "fast off"])("PE loading with %s policy preserves guest execution across resets", async (mode) => {
    const fast = mode.startsWith("fast ");
    const off = mode.endsWith("off");
    const globalOptions = globalThis as { __wwtPeAot?: boolean | string };
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const oldMode = globalOptions.__wwtPeAot;
    try {
        if (mode === "no OPFS") {
            Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
        } else {
            installFakeOpfs();
        }
        if (off) globalOptions.__wwtPeAot = false;
        else if (mode === "explicit auto") globalOptions.__wwtPeAot = "auto";
        else delete globalOptions.__wwtPeAot;
        const training = mode === "default" || mode === "explicit auto" || mode === "fast default";
        const ramSize = 4 << 20;
        const bytes = fast
            ? await Bun.file(new URL("../../public/wwt-provider/wwt_abi11.wasm", import.meta.url)).arrayBuffer()
            : compilerBytes;
        const host = new BottleShipMachine(await WwtCompiler.fromBytes(bytes, fast), ramSize);
        await host.init();
        const cpuState = host.nativeAlloc(4096, 4096);
        const wasm = (name: string) => Bun.file(new URL("../../public/" + name, import.meta.url)).arrayBuffer();
        const hooks = await installWwtHypercall(host, ramSize, cpuState, {
            hypercall: await wasm("wwt-hypercall.wasm"), d3d9Arena: await wasm("wwt-d3d9-arena.wasm"),
        });
        const core = new WwtCpu(host, ramSize, hooks, cpuState);
        if (fast) core.setCodePermissionReader(() => true);
        const base = 0x90000, entry = base + 0x1000, dynamicEntry = entry + 0x100;
        const file = minimalPe(0x1000);
        file.set([0xc3], 0x200);
        file.set([0xb8, 19, 0, 0, 0, 0xef], 0x300);
        core.io.register_write(0x1234, null, undefined, undefined, () => core.requestYield());
        const before = core.getTranslationStats().peAotCache;
        for (let run = 0; run < 3; run++) {
            core.reset();
            core.mem8.set(file.subarray(0x200), entry);
            core.registerCodeRange(entry, base + 0x3000, !fast);
            await core.registerPeImage("demo.exe", base, 0x3000, file);
            expect(host.lookup(entry) > 0).toBe((fast && !off) || (training && run > 0));
            expect(host.lookup(dynamicEntry) > 0).toBe(training && run > (fast ? 1 : 0));
            core.instruction_pointer[0] = dynamicEntry;
            core.reg32[2] = 0x1234;
            core.reg32[4] = stack;
            core.main_loop();
            expect(core.reg32[0]).toBe(19);
            const profileFlush = core.flushPeProfile();
            if (training) await profileFlush;
            else expect(profileFlush).toBeUndefined();
            await host.settlePeAotWrites();
        }
        const after = core.getTranslationStats().peAotCache;
        expect(after.writes - before.writes).toBe(training ? (fast ? 2 : 1) : 0);
        expect(after.hits - before.hits).toBe(training ? (fast ? 2 : 1) : 0);
        expect(after.misses - before.misses).toBe(training ? 1 : 0);
    } finally {
        if (oldMode === undefined) delete globalOptions.__wwtPeAot;
        else globalOptions.__wwtPeAot = oldMode;
        if (previous) Object.defineProperty(globalThis, "navigator", previous);
        else Reflect.deleteProperty(globalThis, "navigator");
    }
});

test("linked PE AOT observes a guest code write before calling the old entry", async () => {
    const base = 0x90000;
    const entry = base + 0x1000;
    const target = entry + 0x80;
    const data = new DataView(memory.buffer);
    memory.set([0xc6, 0x05, 0, 0, 0, 0, 69, 0xe8, 0, 0, 0, 0, 0xc3], entry);
    data.setUint32(entry + 2, target + 1, true);
    data.setInt32(entry + 8, target - (entry + 12), true);
    memory.set([0xb8, 42, 0, 0, 0, 0xc3], target);
    const packed = packMappedPe(memory.subarray(base, base + 0x3000), minimalPe(0x1000), base);
    await machine.loadPeAot(packed, "mutation-probe.exe", addr => addr >= entry && addr < base + 0x3000, () => true);
    expect(machine.lookup(entry)).toBeGreaterThan(0);
    expect(machine.lookup(target)).toBeGreaterThan(0);
    const translated = machine.translationStats.compiled;
    expect(callAt(entry)).toBe(69);
    expect(machine.translationStats.compiled).toBeGreaterThan(translated);

    // Publish the updated caller and callee together before re-entering
    // demand translation, which can inline this tiny callee.
    memory[entry + 6] = 127;
    memory[target + 1] = 127;
    machine.setL1(entry >>> 12, machine.zeroL2);
    expect(callAt(entry)).toBe(127);
});

test("page-local PE AOT leaves a cross-page function for demand translation", async () => {
    const base = 0xb0000;
    const entry = base + 0x1ffd;
    memory.set([0xb8, 7, 0, 0, 0, 0xc3], entry);
    const packed = packMappedPe(memory.subarray(base, base + 0x3000), minimalPe(0x1ffd), base);
    await machine.loadPeAot(packed, "straddling-probe.exe", addr => addr >= base + 0x1000 && addr < base + 0x3000, () => true);
    expect(machine.lookup(entry)).toBe(0);
    expect(callAt(entry)).toBe(7);
});


test("region JIT restarts x86 after writes to active translated code", async () => {
    const size = 4 << 20;
    const host = new BottleShipMachine(await WwtCompiler.fromBytes(compilerBytes), size);
    await host.init();
    const cpuStateBase = host.nativeAlloc(4096, 4096);
    const publicWasm = (name: string) => Bun.file(new URL("../../public/" + name + ".wasm", import.meta.url)).arrayBuffer();
    const hypercall = await installWwtHypercall(host, size, cpuStateBase, {
        hypercall: await publicWasm("wwt-hypercall"),
        d3d9Arena: await publicWasm("wwt-d3d9-arena"),
    });
    const core = new WwtCpu(host, size, hypercall, cpuStateBase);
    core.enterProtectedMode({ eip: 0, esp: 0x54000, gdtBase: 0, idtBase: 0 });
    const memory = core.mem8;
    let portValue = -1;
    core.io.register_write(0x1234, null, undefined, undefined, value => {
        portValue = value;
        core.requestYield();
    });
    const cases = ["mov", "cross-page", "stack", "atomic", "rep", "direct-caller"] as const;
    for (const [index, kind] of cases.entries()) {
        const start = 0x20000 + index * 0x8000;
        const target = kind === "cross-page" ? start + 0xffc : start + 0x1080;
        const imm = target + 1;
        const put = (bytes: number[], at = start) => memory.set(bytes, at);
        const imm32 = (n: number) => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24];
        const request = kind === "mov" ? [0xc6, 5, ...imm32(imm), 69]
            : kind === "cross-page" ? [0xc7, 5, ...imm32(imm), 69, 0, 0, 0]
            : kind === "stack" ? [0x89, 0xe7, 0xbc, ...imm32(imm + 4), 0x6a, 69, 0x89, 0xfc]
            : kind === "atomic" ? [0xb0, 27, 0xf0, 0x0f, 0xc0, 5, ...imm32(imm)]
            : [0xbf, ...imm32(imm), 0xbe, ...imm32(start + 0x3000), 0xb9, 4, 0, 0, 0, 0xfc, 0xf3, 0xa4];
        // All paths call a small leaf which, before the write, is translated in the same region.
        const suffix = start + request.length;
        if (kind === "direct-caller") {
            const helper = start + 0x200;
            put([0xe8, ...imm32(helper - (start + 5)), 0xe8, ...imm32(target - (start + 10)), 0xef]);
            // Keep the helper beyond the leaf inliner's instruction limit.
            const padding = new Array<number>(256).fill(0x40);
            put([...padding, 0xc6, 5, ...imm32(imm), 69, 0xc3], helper);
        } else {
            put([...request, 0xe8, ...imm32(target - (suffix + 5)), 0xef]);
        }
        put([69, 0, 0, 0], start + 0x3000);
        put([0xb8, 42, 0, 0, 0, 0xc3], target);
        core.registerCodeRange(start, start + 0x2000);
        core.instruction_pointer[0] = start;
        core.reg32[2] = 0x1234;
        core.reg32[4] = 0x54000;
        portValue = -1;
        core.main_loop();
        expect({ kind, result: portValue }).toEqual({ kind, result: 69 });
        if (kind === "rep") {
            expect(core.reg32[1]).toBe(0);
            expect(core.reg32[7]).toBe(imm + 4);
        }
    }
});
test("linked PE AOT invalidates every dependent direct entry and resumes fresh x86", async () => {
    const base = 0xc0000;
    const entry = base + 0x1000;
    const target = base + 0x2000;
    const data = new DataView(memory.buffer);
    const install = () => machine.loadPeAot(
        packMappedPe(memory.subarray(base, base + 0x3000), minimalPe(0x1000), base),
        "linked-mutation.exe", addr => addr >= entry && addr < base + 0x3000, () => true, [],
        { base, end: base + 0x3000 },
    );
    memory.set([0xc6, 0x05, 0, 0, 0, 0, 69, 0xe8, 0, 0, 0, 0, 0xc3], entry);
    data.setUint32(entry + 2, target + 1, true);
    data.setInt32(entry + 8, target - (entry + 12), true);
    memory.set([0xb8, 42, 0, 0, 0, 0xc3], target);

    await install();
    const oldEntry = machine.lookup(entry);
    const oldTarget = machine.lookup(target);
    expect(oldEntry).toBeGreaterThan(0);
    expect(oldTarget).toBeGreaterThan(0);
    expect(callAt(entry)).toBe(69);
    expect(machine.table.get(oldEntry)).toBeNull();
    expect(machine.table.get(oldTarget)).toBeNull();

    // A host publication of the target alone drops the freshly linked caller.
    await install();
    const newEntry = machine.lookup(entry);
    const newTarget = machine.lookup(target);
    memory[target + 1] = 127;
    expect(machine.invalidateTranslationPages(target >>> 12, (target >>> 12) + 1)).toBe(true);
    expect(machine.table.get(newEntry)).toBeNull();
    expect(machine.table.get(newTarget)).toBeNull();
    expect(callAt(target)).toBe(127);

    await install();
    const mmioEntry = machine.lookup(entry);
    expect(machine.enableMmio()).toBe(true);
    expect(machine.table.get(mmioEntry)).toBeNull();
    expect(machine.lookup(entry)).toBe(0);
});
test("region JIT detects a store crossing from data into translated code", () => {
    const target = 0xf3000;
    const writer = 0xfa000;
    const data = new DataView(memory.buffer);
    memory.set([0xb8, 42, 0, 0, 0, 0xc3], target);
    expect(callAt(target)).toBe(42);
    const precedingPage = (target >>> 12) - 1;
    expect(memory[machine.storeMap + precedingPage] & 1).toBe(0);
    memory.set([0xc7, 0x05, 0, 0, 0, 0, 0x90, 0xb8, 69, 0, 0xe9, 0, 0, 0, 0], writer);
    data.setUint32(writer + 2, target - 1, true);
    data.setInt32(writer + 11, target - writer - 15, true);
    expect(callAt(writer)).toBe(69);
});
test("partial REP fault publishes earlier code writes before dispatching SEH", async () => {
    const ram = 4 << 20;
    const host = new BottleShipMachine(await WwtCompiler.fromBytes(compilerBytes), ram);
    await host.init();
    const state = host.newCpu();
    const A = host.abi.cpu;
    const mem = new Uint8Array(host.memory.buffer);
    const data = new DataView(host.memory.buffer);
    const word = (at: number, value: number) => data.setUint32(at, value, true);
    const dword = (at: number) => data.getUint32(at, true);
    const dir = 0x10000, pageTable = 0x11000;
    const writer = 0x70000, target = 0xe4000, source = 0x90000;
    word(dir, pageTable | 3);
    for (const page of [writer, target, source, stack]) word(pageTable + (page >>> 12) * 4, page | 3);
    word(state + A.PAGE_DIRECTORY, dir);
    word(state + A.PAGE_RAM_SIZE, ram);
    word(state + A.PREEMPT_AT, 0x70000000);
    word(state + A.GPR + 16, stack);
    word(stack, host.stopAddress);
    mem.set([0xb8, 42, 0, 0, 0, 0xc3], target);
    expect(host.run(state, target)).toBe(host.stopAddress);
    expect(host.lookup(target)).toBeGreaterThan(0);

    mem.set([0xf3, 0xa4, 0xc3], writer);
    mem.set([0x90, 0x99], source);
    word(state + A.GPR + 4, 2); // ecx
    word(state + A.GPR + 16, stack);
    word(state + A.GPR + 24, source); // esi
    word(state + A.GPR + 28, target + 0xfff); // edi
    let received = 0;
    host.onFault = (_cpu, code, eip, address) => {
        expect(code).toBe(host.abi.fault.ACCESS_VIOLATION_WRITE);
        expect(address).toBe(target + 0x1000);
        expect(eip).toBe(writer);
        expect(host.lookup(target)).toBe(0);
        expect(mem[target + 0xfff]).toBe(0x90);
        expect(dword(state + A.GPR + 4)).toBe(1);
        received++;
        return host.stopAddress;
    };
    expect(host.run(state, writer)).toBe(host.stopAddress);
    expect(received).toBe(1);
});

test("guest page-table writes revoke cached permissions before the next access", async () => {
    const ramSize = 4 << 20;
    const host = new BottleShipMachine(await WwtCompiler.fromBytes(compilerBytes), ramSize);
    await host.init();
    const state = host.newCpu();
    const A = host.abi.cpu;
    const bytes = new Uint8Array(host.memory.buffer);
    const view = new DataView(bytes.buffer);
    const setWord = (address: number, value: number) => view.setUint32(address, value, true);
    const directory = 0x100000;
    const table = directory + 0x1000;
    const data = 0x5a000;
    setWord(directory, table | 7);
    for (let page = 0; page < ramSize >>> 12; page++) setWord(table + page * 4, page * 4096 + 7);
    setWord(state + A.PAGE_DIRECTORY, directory);
    setWord(state + A.PAGE_RAM_SIZE, ramSize);
    setWord(state + A.PAGE_TLB, host.nativeAlloc(A.PAGE_TLB_SLOTS * 8, 8));
    setWord(state + A.PREEMPT_AT, 10000);
    bytes.set([0x89, 0x11, 0xc3], pc); // mov [ecx], edx; ret
    bytes.set([0x8b, 0x01, 0xc3], pc + 32); // mov eax, [ecx]; ret
    let fault: number[] | undefined;
    host.onFault = (_cpu, code, eip, address) => {
        fault = [code, eip, address];
        return host.stopAddress;
    };
    function run(entry: number, address: number, value = 0): void {
        fault = undefined;
        setWord(state + A.GPR + 4, address);
        setWord(state + A.GPR + 8, value);
        setWord(state + A.GPR + 16, stack);
        setWord(stack, host.stopAddress);
        expect(host.run(state, entry)).toBe(host.stopAddress);
    }
    run(pc, data, 0x11223344);
    expect(fault).toBeUndefined();
    run(pc, table + (data >>> 12) * 4, data | 5);
    expect(fault).toBeUndefined();
    run(pc + 32, data);
    expect(fault).toBeUndefined();
    expect(view.getUint32(state + A.GPR, true)).toBe(0x11223344);
    run(pc, data, 0xfeedbeef);
    expect(fault).toEqual([host.abi.fault.ACCESS_VIOLATION_WRITE, pc, data]);
    expect(view.getUint32(data, true)).toBe(0x11223344);
});
