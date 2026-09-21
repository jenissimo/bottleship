import { expect, test } from 'bun:test';
import { HypercallDataManager } from '../../src/worker/core/cpu/hypercall-data';

test('mutex mirror uses guest RAM origin for full writes, individual writes and live reads', () => {
    const buffer = new ArrayBuffer(0x20000);
    const guestBase = 0x8000, mirror = 0x4000;
    const raw = new Uint32Array(buffer);
    raw.fill(0xcccccccc);
    const manager: any = new HypercallDataManager();
    manager.cpu = { wasm_memory: { buffer }, mem8: new Uint8Array(buffer, guestBase) };
    manager.wasmMemory = buffer;
    manager.mutexMirrorAddr = mirror;
    manager.mutexMirrorShadow[3] = 0x80010001;
    manager.writeMutexMirrorState();
    expect(raw[(guestBase + mirror) / 4 + 3]).toBe(0x80010001);
    expect(raw.slice(mirror / 4, mirror / 4 + 2048).every(x => x === 0xcccccccc)).toBe(true);
    manager.mutexMirrorShadow[3] = 0x80020001;
    manager.writeMutexMirrorSlot(3);
    expect(raw[(guestBase + mirror) / 4 + 3]).toBe(0x80020001);
    // A WASM ReleaseMutex changes guest RAM directly; JS must observe that same word.
    raw[(guestBase + mirror) / 4 + 3] = 0x80000000;
    expect(manager.liveMutexWord(3)).toBe(0x80000000);
    expect(raw[mirror / 4 + 3]).toBe(0xcccccccc);
});
