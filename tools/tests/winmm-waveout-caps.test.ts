import { expect, test } from "bun:test";
import { WinMM } from "../../src/worker/modules/winmm";

const WAVECAPS_VOLUME = 0x0004;
const WAVECAPS_SYNC = 0x0010;
const WAVECAPS_SAMPLEACCURATE = 0x0020;

for (const [suffix, size] of [["A", 52], ["W", 84]] as const) {
    test(`waveOutGetDevCaps${suffix} describes the asynchronous ring-buffer device`, () => {
        const module = new WinMM();
        module.initialize({} as never);
        const mem = new Uint8Array(256);
        const ptr = 32;
        mem.fill(0xa5);
        const result = module.exports[`waveOutGetDevCaps${suffix}`]({} as never, mem, [0xffffffff, ptr, size]);
        expect(result).toBe(0);
        const support = new DataView(mem.buffer).getUint32(ptr + size - 4, true);
        expect(support & WAVECAPS_SYNC).toBe(0);
        expect(support).toBe(WAVECAPS_VOLUME | WAVECAPS_SAMPLEACCURATE);
        expect(mem[ptr + size]).toBe(0xa5);
    });
}
