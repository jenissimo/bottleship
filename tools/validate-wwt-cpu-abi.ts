/** Validate the compiler, kernel and direct HLE crossing shipped by the default build. */
import assert from "node:assert/strict";
import { WwtCompiler } from "../src/worker/wwt/translator";
import { BottleShipMachine } from "../src/worker/wwt/machine";
import { WwtCpu } from "../src/worker/wwt/cpu";
import { installWwtHypercall } from "../src/worker/wwt/hypercall";
import { cpuViews } from "../src/worker/core/cpu/cpu-views";

const load = (file: string) => Bun.file(new URL("../public/" + file, import.meta.url)).arrayBuffer();
const [compilerBytes, hypercall, d3d9Arena] = await Promise.all([
    load("wwt-provider/wwt_wasm.wasm"), load("wwt-hypercall.wasm"), load("wwt-d3d9-arena.wasm"),
]);

const upstream = await WwtCompiler.fromBytes(await load("wwt-provider/wwt_abi11.wasm"), true);
assert.equal(upstream.cacheId, "95f8ad6ee983acd0f7f466f25ebe71be3965da796d47befbc44b1cf56e958f42",
    "The fast compiler must match the pinned upstream artifact");
assert.equal(upstream.abi.version, 11);
assert(WebAssembly.validate(upstream.kernel()), "Invalid upstream i386 kernel");
console.log("WWT fast compiler OK (original ABI 11)");

const cpuFields: Record<string, number> = {
    GPR: 32, EIP: 4, FS_BASE: 4, GS_BASE: 4, SEG_SEL: 12,
    FK: 4, FR: 4, DF: 4, EFLAGS_SYS: 4, PREEMPT_AT: 4, RETIRED_INSNS: 4,
    FPU_TOP: 4, FPU_CW: 2, FPU_SW: 2, FPU_TAG: 1, FPU_ST: 64,
    MXCSR: 4, XMM: 128, MMX: 64,
    PAGE_DIRECTORY: 4, PAGE_RAM_SIZE: 4,
};

for (const flatRam of [false, true]) {
    const mode = flatRam ? "flat" : "paged";
    const compiler = await WwtCompiler.fromBytes(compilerBytes, flatRam);
    const { cpu: abi } = compiler.abi;
    assert(Number.isInteger(abi.SIZE) && abi.SIZE > 0, "WWT CPU ABI omits the native state size");
    for (const [field, width] of Object.entries(cpuFields)) {
        const offset = abi[field];
        assert(Number.isInteger(offset) && offset >= 0 && offset + width <= abi.SIZE,
            `WWT CPU ABI omits or misplaces ${field}`);
    }
    const ranges = Object.entries(cpuFields).map(([name, width]) => ({ name, offset: abi[name], end: abi[name] + width }))
        .sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < ranges.length; i++) {
        assert(ranges[i - 1].end <= ranges[i].offset, `WWT CPU fields overlap: ${ranges[i - 1].name} and ${ranges[i].name}`);
    }

    const guestBytes = 4 << 20;
    const machine = new BottleShipMachine(compiler, guestBytes);
    await machine.init();
    const state = machine.nativeAlloc(4096, 4096);
    const native = await installWwtHypercall(machine, guestBytes, state, { hypercall, d3d9Arena });
    assert(native.directInteger, "The shipped compiler lacks the native integer hypercall ABI");
    machine.natives.hle_out32 = native.directInteger.dispatch;
    machine.natives.hle_out32_config = native.directInteger.configAddress;
    const cpu = new WwtCpu(machine, guestBytes, native, state);
    assert(cpu.mem8 instanceof Uint8Array && cpu.mem8.buffer === machine.memory.buffer &&
        cpu.mem8.byteOffset === 0 && cpu.mem8.byteLength === guestBytes, "WWT CPU must publish a fixed plain guest view");
    const views = cpuViews(cpu);
    const { pageAddress } = native;
    const raw = new DataView(machine.memory.buffer);
    const functionId = 0xf123;
    const lastError = 0x1234abcd;
    raw.setUint32(pageAddress + 0x008, 1, true);
    raw.setUint32(pageAddress + 0x024, lastError, true);
    raw.setUint8(pageAddress + 0x4000 + functionId - 4096, 5); // GetLastError

    const entry = 0x20000;
    cpu.mem8[0x40] = 0x5c;
    cpu.mem8.set([
        0xb8, 0x23, 0xf1, 0, 0,      // mov eax, functionId
        0xba, 0x77, 0xb0, 0, 0,      // mov edx, 0xb077
        0xef,                       // out dx, eax — native HLE
        0xba, 0x34, 0x12, 0, 0,      // mov edx, 0x1234
        0xef,                       // out dx, eax — host test boundary
    ], entry);
    let returned: number | undefined;
    cpu.io.register_write(0xb077, null, undefined, undefined, () => {
        throw new Error(`${mode}: expected the sidecar to handle the translated OUT`);
    });
    cpu.io.register_write(0x1234, null, undefined, undefined, value => {
        returned = value >>> 0;
        cpu.requestYield();
    });
    views.reg32[4] = 0x28000;
    views.instructionPointer[0] = entry;
    cpu.main_loop();
    assert.equal(returned, lastError, `${mode}: wrong native GetLastError result`);
    assert.equal(views.instructionPointer[0], entry + 17, `${mode}: wrong resume EIP`);
    assert.equal(views.instructionCounter[0], 5, `${mode}: OUT retirement mismatch`);
    assert.equal(raw.getUint32(pageAddress + 0x00c, true), 1, `${mode}: wrong total native hits`);
    assert.equal(raw.getUint32(pageAddress + 0x2000 + 4 * 5, true), 1, `${mode}: wrong handler hits`);
    assert.equal(cpu.mem8[0x40], 0x5c, `${mode}: native CPU state altered guest page zero`);
    console.log(`WWT CPU ABI OK (${mode}): translated guest OUT and native shared-page accounting`);
}
