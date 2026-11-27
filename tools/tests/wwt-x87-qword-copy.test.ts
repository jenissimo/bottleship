import { expect, test } from "bun:test";
import { BottleShipMachine } from "../../src/worker/wwt/machine";
import { WwtCpu } from "../../src/worker/wwt/cpu";
import { installWwtHypercall } from "../../src/worker/wwt/hypercall";
import { WwtCompiler } from "../../src/worker/wwt/translator";

const pc = 0x20000;
const stack = 0x54000;
const src = 0x30000;
const dst = 0x31000;

const delphiMove = [
    0x39, 0xd0, 0x74, 0x31, 0x83, 0xf9, 0x20, 0x77, 0x7c, 0x83, 0xe9, 0x08, 0x7f, 0x07, 0xcc, 0xcc,
    0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xdf, 0x2c, 0x01, 0xdf, 0x28, 0x83, 0xf9, 0x08, 0x7e, 0x11, 0xdf,
    0x68, 0x08, 0x83, 0xf9, 0x10, 0x7e, 0x06, 0xdf, 0x68, 0x10, 0xdf, 0x7a, 0x10, 0xdf, 0x7a, 0x08,
    0xdf, 0x3a, 0xdf, 0x3c, 0x11, 0xc3,
];

const cases: Array<[string, number[]]> = [
    ["fild; fistp", [0xdf, 0x28, 0xdf, 0x3a, 0xc3]],
    ["fild; cmp; fistp", [0xdf, 0x28, 0x83, 0xf9, 0x08, 0xdf, 0x3a, 0xc3]],
    ["fild; jmp; fistp", [0xdf, 0x28, 0xeb, 0x00, 0xdf, 0x3a, 0xc3]],
    ["Delphi 7 FastCode Move, 11 bytes", delphiMove],
];

for (const [compilerFile, flat] of [["wwt_abi11.wasm", true], ["wwt_wasm.wasm", false]] as const) {
    for (const [name, code] of cases) {
        test(`${compilerFile}: ${name} copies a qword exactly`, async () => {
            const dir = process.env.WWT_PROVIDER_DIR;
            const bytes = await Bun.file(dir ? `${dir}/${compilerFile}` : new URL(`../../public/wwt-provider/${compilerFile}`, import.meta.url)).arrayBuffer();
            const machine = new BottleShipMachine(await WwtCompiler.fromBytes(bytes, flat), 4 << 20);
            await machine.init();
            const cpu = machine.newCpu();
            const memory = new Uint8Array(machine.memory.buffer);
            const words = new Uint32Array(machine.memory.buffer);
            const A = machine.abi.cpu;
            const text = new TextEncoder().encode("TRUNNERFORM");
            memory.fill(0, src, src + 32);
            memory.fill(0xee, dst, dst + 32);
            memory.set(text, src);
            memory.set(code, pc);
            words[(cpu + A.PREEMPT_AT) >>> 2] = 0x70000000;
            words[(cpu + A.GPR) >>> 2] = src;
            words[(cpu + A.GPR + 4) >>> 2] = 11;
            words[(cpu + A.GPR + 8) >>> 2] = dst;
            words[(cpu + A.GPR + 16) >>> 2] = stack;
            words[stack >>> 2] = machine.stopAddress;
            expect(machine.run(cpu, pc)).toBe(machine.stopAddress);
            const n = code === delphiMove ? 11 : 8;
            expect(new TextDecoder().decode(memory.subarray(dst, dst + n))).toBe("TRUNNERFORM".slice(0, n));
        });
    }
    test(`${compilerFile}: an equal binary64 register overwrite invalidates the old integer`, async () => {
        const { machine, cpu, view } = await hostFixture(compilerFile, flat);
        const A = machine.abi.cpu;
        const state = machine.newCpu();
        view.setBigInt64(src, 9007199254740993n, true);
        view.setFloat64(src + 8, 9007199254740992, true);
        cpu.mem8.set([0xdf, 0x28, 0xdd, 0x40, 8, 0xdd, 0xd9, 0xdf, 0x3a, 0xc3], pc);
        view.setUint32(state + A.PREEMPT_AT, 0x70000000, true);
        view.setUint32(state + A.GPR, src, true);
        view.setUint32(state + A.GPR + 8, dst, true);
        view.setUint32(state + A.GPR + 16, stack, true);
        view.setUint32(stack, machine.stopAddress, true);
        expect(machine.run(state, pc)).toBe(machine.stopAddress);
        expect(view.getBigInt64(dst, true)).toBe(9007199254740992n);
    });

    test(`${compilerFile}: WwtCpu preserves an exact integer across preemption`, async () => {
        const { machine, cpu, view } = await hostFixture(compilerFile, flat);
        const loop = 0x24000;
        const offset = loop - (pc + 7);
        const value = 9007199254740993n;
        view.setBigInt64(src, value, true);
        cpu.mem8.set([0xdf, 0x2e, 0xe9, offset & 255, (offset >>> 8) & 255, 0, 0], pc);
        cpu.mem8.set([0x49, 0x75, 0xfd, 0xdf, 0x3f, 0xef], loop);
        cpu.reg32[1] = 12;
        cpu.reg32[2] = 0x1234;
        cpu.reg32[4] = stack;
        cpu.reg32[6] = src;
        cpu.reg32[7] = dst;
        cpu.instruction_pointer[0] = pc;
        const onMiss = machine.onMiss;
        machine.onMiss = (state, address) => {
            if (flat && address === loop) view.setUint32(machine.tickAddr, 100, true);
            return onMiss(state, address);
        };
        const budgetAddress = cpu.wm.exports.get_cycle_budget_ptr();
        view.setUint32(budgetAddress, 8, true);
        let finished = false;
        cpu.io.register_write(0x1234, null, undefined, undefined, () => {
            finished = true;
            cpu.requestYield();
        });
        cpu.main_loop();
        expect(cpu.instruction_pointer[0]).toBeGreaterThanOrEqual(loop);
        expect(cpu.instruction_pointer[0]).toBeLessThan(loop + 3);
        expect(cpu.fpu_get_sti_f64(0)).toBe(Number(value));
        expect(finished).toBe(false);
        expect(view.getBigInt64(dst, true)).toBe(0n);

        view.setUint32(budgetAddress, 1000, true);
        machine.onMiss = onMiss;
        cpu.main_loop();
        expect(finished).toBe(true);
        expect(view.getBigInt64(dst, true)).toBe(value);
    });
}

async function hostFixture(compilerFile: string, flat: boolean) {
    const dir = process.env.WWT_PROVIDER_DIR;
    const load = (name: string) => Bun.file(new URL(`../../public/${name}`, import.meta.url)).arrayBuffer();
    const bytes = await (dir ? Bun.file(`${dir}/${compilerFile}`).arrayBuffer() : load(`wwt-provider/${compilerFile}`));
    const ramSize = 4 << 20;
    const machine = new BottleShipMachine(await WwtCompiler.fromBytes(bytes, flat), ramSize);
    await machine.init();
    const state = machine.nativeAlloc(4096, 4096);
    const hypercall = await installWwtHypercall(machine, ramSize, state, {
        hypercall: await load("wwt-hypercall.wasm"),
        d3d9Arena: await load("wwt-d3d9-arena.wasm"),
    });
    return { machine, cpu: new WwtCpu(machine, ramSize, hypercall, state), view: new DataView(machine.memory.buffer) };
}
