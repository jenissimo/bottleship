import { expect, test } from "bun:test";
import { BottleShipMachine } from "../../src/worker/wwt/machine";
import { WwtCompiler } from "../../src/worker/wwt/translator";

const pc = 0x20000;
const stack = 0x54000;
const dst = 0x31000;

const cases: Array<[string, number[], number, number]> = [
    ["maskmovdqu xmm0, xmm1", [0x66, 0x0f, 0xf7, 0xc1, 0xc3], 16, 0],
    ["maskmovq mm0, mm1", [0x0f, 0xf7, 0xc1, 0xc3], 8, 1],
];

const ramSize = 4 << 20;
const protectedBoundary = 0x32000;

for (const [compilerFile, flat] of [["wwt_abi11.wasm", true], ["wwt_wasm.wasm", false]] as const) {
    for (const [name, code, size, mmx] of cases) {
        async function fixture() {
            const bytes = await Bun.file(new URL(`../../public/wwt-provider/${compilerFile}`, import.meta.url)).arrayBuffer();
            const machine = new BottleShipMachine(await WwtCompiler.fromBytes(bytes, flat), ramSize);
            await machine.init();
            const cpu = machine.newCpu();
            const memory = new Uint8Array(machine.memory.buffer);
            const words = new Uint32Array(machine.memory.buffer);
            const A = machine.abi.cpu;
            const data = Array.from({ length: size }, (_, k) => 0x10 + k);
            const regs = mmx ? A.MMX : A.XMM;
            memory.set(data, cpu + regs);
            memory.set(code, pc);
            words[(cpu + A.PREEMPT_AT) >>> 2] = 0x70000000;
            const faults: number[] = [];
            machine.onFault = (_cpu, _code, _eip, address) => {
                faults.push(address);
                return machine.stopAddress;
            };
            function run(entry: number, address: number, mask: number[]) {
                memory.set(mask, cpu + regs + size);
                words[(cpu + A.GPR + 28) >>> 2] = address;
                words[(cpu + A.GPR + 16) >>> 2] = stack;
                words[stack >>> 2] = machine.stopAddress;
                expect(machine.run(cpu, entry)).toBe(machine.stopAddress);
            }
            return { machine, cpu, memory, words, A, data, faults, run };
        }

        test(`${compilerFile}: ${name} stores only the selected bytes at EDI`, async () => {
            const { memory, data, faults, run } = await fixture();
            const mask = data.map((_, k) => (k % 3 === 0 ? 0x80 : k % 3 === 1 ? 0x7f : 0xff));
            memory.fill(0xee, dst, dst + 32);
            run(pc, dst, mask);
            expect(faults).toEqual([]);
            expect([...memory.subarray(dst, dst + size)]).toEqual(data.map((d, k) => mask[k] & 0x80 ? d : 0xee));
            expect(memory[dst + size]).toBe(0xee);
        });

        test(`${compilerFile}: ${name} skips inaccessible bytes past a page boundary`, async () => {
            const { machine, cpu, memory, words, A, data, faults, run } = await fixture();
            const boundary = flat ? machine.abi.null_limit : protectedBoundary;
            if (!flat) {
                const directory = 0x100000;
                const table = directory + 0x1000;
                words[directory >>> 2] = table | 7;
                for (let page = 0; page < ramSize >>> 12; page++) words[(table >>> 2) + page] = (page << 12) | 7;
                words[(table >>> 2) + (boundary >>> 12)] = 0;
                words[(cpu + A.PAGE_DIRECTORY) >>> 2] = directory;
                words[(cpu + A.PAGE_RAM_SIZE) >>> 2] = ramSize;
                words[(cpu + A.PAGE_TLB) >>> 2] = machine.nativeAlloc(A.PAGE_TLB_SLOTS * 8, 8);
            }
            const address = boundary - 2;
            memory.fill(0xee, address, address + size);
            const mask = data.map((_, k) => (flat ? k >= 2 : k < 2) ? 0x80 : 0x7f);
            run(pc, address, mask);
            expect(faults).toEqual([]);
            expect([...memory.subarray(address, address + size)]).toEqual(data.map((d, k) => mask[k] & 0x80 ? d : 0xee));
            const denied = flat ? 0 : 2;
            mask[denied] = 0x80;
            run(pc, address, mask);
            expect(faults).toEqual([address + denied]);
        });

        test(`${compilerFile}: ${name} leaves translations on a masked-off page intact`, async () => {
            const { machine, memory, data, faults, run } = await fixture();
            const entry = dst + 0x100;
            const mask = data.map((_, k) => k < 2 ? 0x80 : 0x7f);
            memory[entry] = 0xc3;
            run(entry, 0, mask);
            const translation = machine.lookup(entry);
            expect(translation).not.toBe(0);
            run(pc, dst - 2, mask);
            expect(machine.lookup(entry)).toBe(translation);
            mask[2] = 0x80;
            run(pc, dst - 2, mask);
            expect(machine.lookup(entry)).toBe(0);
            expect(faults).toEqual([]);
        });
    }
}
