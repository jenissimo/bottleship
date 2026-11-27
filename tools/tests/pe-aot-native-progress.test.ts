import { expect, test } from "bun:test";
import { WwtCompiler } from "../../src/worker/wwt/translator";

/** A PE32 whose entry calls a fixed number of tiny functions. */
function peWithCalls(calls: number): Uint8Array<ArrayBuffer> {
    const pe = 0x80;
    const optional = pe + 24;
    const section = optional + 224;
    const raw = 0x200;
    const virtualAddress = 0x1000;
    const length = calls * 6 + 1;
    const padded = Math.ceil(length / 0x200) * 0x200;
    const bytes = new Uint8Array(raw + padded);
    const view = new DataView(bytes.buffer);
    const u16 = (offset: number, value: number) => view.setUint16(offset, value, true);
    const u32 = (offset: number, value: number) => view.setUint32(offset, value, true);
    u16(0, 0x5a4d);
    u32(0x3c, pe);
    u32(pe, 0x4550);
    u16(pe + 4, 0x14c);
    u16(pe + 6, 1);
    u16(pe + 20, 224);
    u16(pe + 22, 0x0102);
    u16(optional, 0x10b);
    u32(optional + 4, padded);
    u32(optional + 16, virtualAddress);
    u32(optional + 20, virtualAddress);
    u32(optional + 28, 0x400000);
    u32(optional + 32, 0x1000);
    u32(optional + 36, 0x200);
    u32(optional + 56, 0x2000);
    u32(optional + 60, raw);
    u16(optional + 68, 3);
    u32(optional + 92, 16);
    bytes.set(new TextEncoder().encode(".text"), section);
    u32(section + 8, length);
    u32(section + 12, virtualAddress);
    u32(section + 16, padded);
    u32(section + 20, raw);
    u32(section + 36, 0x60000020);
    const firstCallee = raw + calls * 5 + 1;
    for (let i = 0; i < calls; i++) {
        const call = raw + i * 5;
        bytes[call] = 0xe8;
        view.setInt32(call + 1, firstCallee + i - (call + 5), true);
    }
    bytes.fill(0xc3, firstCallee - 1, firstCallee + calls);
    return bytes;
}

test("ABI11 PE compiler reports work while preserving the translated Wasm", async () => {
    const bytes = await Bun.file(new URL("../../public/wwt-provider/wwt_abi11.wasm", import.meta.url)).arrayBuffer();
    const module = await WebAssembly.compile(bytes);
    const progress: Array<[number, number, number]> = [];
    const observed = WwtCompiler.fromAbi11Module(module, "test", (...update) => progress.push(update));
    const plain = WwtCompiler.fromAbi11Module(module, "test");
    const file = peWithCalls(140);
    const wasm = observed.translatePe(file, [], 0x8000000, false, false);
    expect(wasm).toEqual(plain.translatePe(file, [], 0x8000000, false, false));
    expect(WebAssembly.validate(wasm)).toBe(true);
    expect(progress).toContainEqual([0, 281, 0]);
    expect(progress).toContainEqual([1, 64, 0]);
    expect(progress).toContainEqual([1, 141, 0]);
    expect(progress).toContainEqual([2, 64, 141]);
    expect(progress).toContainEqual([2, 141, 141]);
    expect(progress).toContainEqual([3, 64, 141]);
    expect(progress.at(-1)).toEqual([3, 141, 141]);
});
