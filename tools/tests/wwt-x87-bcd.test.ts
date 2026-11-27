import { expect, test } from "bun:test";
import { BottleShipMachine } from "../../src/worker/wwt/machine";
import { WwtCompiler } from "../../src/worker/wwt/translator";

const pc = 0x20000;
const stack = 0x54000;
const src = 0x30000;
const dst = 0x31000;

function bcd(value: bigint): number[] {
    const out = Array(10).fill(0);
    let n = value < 0n ? -value : value;
    for (let k = 0; k < 9; k++) {
        const lo = Number(n % 10n); n /= 10n;
        const hi = Number(n % 10n); n /= 10n;
        out[k] = (hi << 4) | lo;
    }
    out[9] = value < 0n ? 0x80 : 0;
    return out;
}

const cases: Array<[string, number[], (view: DataView) => void, number[]]> = [
    ["fild m64; fbstp m80", [0xdf, 0x28, 0xdf, 0x32, 0xc3],
        view => view.setBigInt64(src, 123456789012345678n, true), bcd(123456789012345678n)],
    ["fild m64; fbstp m80 negative", [0xdf, 0x28, 0xdf, 0x32, 0xc3],
        view => view.setBigInt64(src, -42n, true), bcd(-42n)],
    ["fbld m80; fbstp m80", [0xdf, 0x20, 0xdf, 0x32, 0xc3],
        view => bcd(-123456789012345n).forEach((b, k) => view.setUint8(src + k, b)), bcd(-123456789012345n)],
    ["fbld m80; fbstp m80 with 18 digits", [0xdf, 0x20, 0xdf, 0x32, 0xc3],
        view => bcd(999999999999999999n).forEach((b, k) => view.setUint8(src + k, b)), bcd(999999999999999999n)],
    ["fild m64; fbstp m80 out of range stores the BCD indefinite", [0xdf, 0x28, 0xdf, 0x32, 0xc3],
        view => view.setBigInt64(src, 1000000000000000000n, true), [0, 0, 0, 0, 0, 0, 0, 0xc0, 0xff, 0xff]],
];

for (const [compilerFile, flat] of [["wwt_abi11.wasm", true], ["wwt_wasm.wasm", false]] as const) {
    for (const [name, code, setup, expected] of cases) {
        test(`${compilerFile}: ${name}`, async () => {
            const dir = process.env.WWT_PROVIDER_DIR;
            const bytes = await Bun.file(dir ? `${dir}/${compilerFile}` : new URL(`../../public/wwt-provider/${compilerFile}`, import.meta.url)).arrayBuffer();
            const machine = new BottleShipMachine(await WwtCompiler.fromBytes(bytes, flat), 4 << 20);
            await machine.init();
            const cpu = machine.newCpu();
            const memory = new Uint8Array(machine.memory.buffer);
            const view = new DataView(machine.memory.buffer);
            const words = new Uint32Array(machine.memory.buffer);
            const A = machine.abi.cpu;
            memory.fill(0, src, src + 16);
            memory.fill(0xee, dst, dst + 16);
            setup(view);
            memory.set(code, pc);
            words[(cpu + A.PREEMPT_AT) >>> 2] = 0x70000000;
            words[(cpu + A.GPR) >>> 2] = src;
            words[(cpu + A.GPR + 8) >>> 2] = dst;
            words[(cpu + A.GPR + 16) >>> 2] = stack;
            words[stack >>> 2] = machine.stopAddress;
            expect(machine.run(cpu, pc)).toBe(machine.stopAddress);
            expect([...memory.subarray(dst, dst + 10)]).toEqual(expected);
        });
    }
}
