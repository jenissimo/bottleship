import { describe, expect, it } from 'bun:test';
import { parseModule, walkBody } from '../aot/lib/wdis.mjs';
import { moduleStats } from '../aot/module-stats.mjs';

const uleb = (value: number): number[] => {
    const bytes: number[] = [];
    do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value) byte |= 0x80;
        bytes.push(byte);
    } while (value);
    return bytes;
};
const section = (id: number, bytes: number[]) => [id, ...uleb(bytes.length), ...bytes];
const name = (text: string) => [...uleb(text.length), ...Buffer.from(text)];

/** Native-valid void function with exported memory: SIMD results stay observable in memory. */
function moduleOf(body: number[]): Uint8Array {
    const fn = [0, ...body, 0x0b];
    return Uint8Array.from([
        0, 97, 115, 109, 1, 0, 0, 0,
        ...section(1, [1, 0x60, 0, 0]),
        ...section(3, [1, 0]),
        ...section(5, [1, 0, 1]),
        ...section(7, [2, ...name('run'), 0, 0, ...name('memory'), 2, 0]),
        ...section(10, [1, ...uleb(fn.length), ...fn]),
    ]);
}

// Standard SIMD sub-opcodes: 78=v128.and, 80=v128.or, 205=i64x2.shr_u.
// Each has no immediates. v128.load/store retain their ordinary memarg.
const load = [0xfd, 0, 4, 0], store = [0xfd, 11, 4, 0];
const marker = [0x41, 0x80, 0x01, 0x1a]; // i32.const 128; drop (multi-byte immediate)
const cases = [
    { label: 'v128.and', subop: 78, shift: false },
    { label: 'v128.or', subop: 80, shift: false },
    { label: 'i64x2.shr_u', subop: 205, shift: true },
];

describe('Wasm SIMD decoder boundaries', () => {
    for (const { label, subop, shift } of cases) {
        it(`decodes ${label} without eating the next immediate, and executes its lane result`, () => {
            const bytes = moduleOf([
                0x41, 32, 0x41, 0, ...load,
                ...(shift ? [0x41, 1] : [0x41, 16, ...load]),
                0xfd, ...uleb(subop), ...store, ...marker,
            ]);
            expect(WebAssembly.validate(bytes)).toBe(true);
            const native = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
            const memory = native.memory as WebAssembly.Memory;
            const input = new Uint8Array(memory.buffer);
            for (let i = 0; i < 16; i++) {
                input[i] = (i * 19 + 0x81) & 0xff;
                input[16 + i] = (i * 37 + 0x55) & 0xff;
            }
            const expected = shift
                ? Array.from(new BigUint64Array(memory.buffer, 0, 2), value => value >> 1n)
                : Array.from(input.subarray(0, 16), (value, i) => subop === 78 ? value & input[16 + i] : value | input[16 + i]);
            (native.run as () => void)();
            expect(shift ? Array.from(new BigUint64Array(memory.buffer, 32, 2)) : Array.from(input.subarray(32, 48))).toEqual(expected);

            const info = parseModule(bytes);
            const rows = [...walkBody(bytes, info.code.instrStart, info.code.instrEnd)];
            // Golden byte offsets are independent of the decoder's length computation.
            expect(rows.map(row => row.offset - info.code.instrStart)).toEqual(shift
                ? [0, 2, 4, 8, 10, 13, 17, 20, 21]
                : [0, 2, 4, 8, 10, 14, 16, 20, 23, 24]);
            const simd = rows.filter(row => row.op === 0xfd);
            expect(simd.map(row => row.imm.subop)).toEqual(shift ? [0, subop, 11] : [0, 0, subop, 11]);
            expect(simd.find(row => row.imm.subop === subop)!.imm).toEqual({ subop });
            expect(simd.filter(row => row.imm.subop === 0 || row.imm.subop === 11).every(row => row.imm.align === 4 && row.imm.offset === 0)).toBe(true);
            expect(rows.at(-3)).toMatchObject({ op: 0x41, imm: 128 });
            expect(rows.at(-2).op).toBe(0x1a);
            expect(rows.at(-1).op).toBe(0x0b);

            const stats = moduleStats(bytes, label);
            expect(stats.groups.alu).toBe(1);
            expect(stats.groups.mem).toBe(shift ? 2 : 3);
            expect(stats.top.find(([name]: [string, number]) => name === label)?.[1]).toBe(1);
        });
    }

    it('still refuses a native-valid SIMD opcode with unsupported immediate layout', () => {
        const bytes = moduleOf([0xfd, 12, ...Array(16).fill(0), 0x1a, ...marker]); // v128.const
        expect(WebAssembly.validate(bytes)).toBe(true);
        const info = parseModule(bytes);
        expect(() => [...walkBody(bytes, info.code.instrStart, info.code.instrEnd)]).toThrow('unsupported SIMD opcode 12');
    });
});
