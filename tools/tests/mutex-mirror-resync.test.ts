import { expect, test } from 'bun:test';
import { HypercallDataManager } from '../../src/worker/core/cpu/hypercall-data';
import { MUX_VALID, packMutexMirrorWord } from '../../src/worker/core/cpu/hypercall-event-mirror';

/**
 * The mutex word is WASM-owned: the hypercall tier takes and drops ownership without JS
 * ever handling the call, so `mutexMirrorShadow` only holds the last CONTENDED op JS saw.
 * A WASM memory grow re-runs rewriteState(), and flushing the shadow there hands the guest
 * back an owner that released long ago — a mutex nobody holds that blocks every waiter for
 * the life of the process.
 */

const GUEST_BASE = 0x8000;
const MIRROR = 0x4000;
const HP_BASE = 0x1000;
const SLOT = 66;                       // handle 0x30108

function makeManager(buffer: ArrayBuffer) {
    const manager: any = new HypercallDataManager();
    manager.cpu = { wasm_memory: { buffer }, mem8: new Uint8Array(buffer, GUEST_BASE) };
    manager.wasmMemory = buffer;
    manager.view = new DataView(buffer);
    manager.hpBase = HP_BASE;
    manager.initialized = true;
    manager.mutexMirrorAddr = MIRROR;
    return manager;
}

function liveWord(buffer: ArrayBuffer): number {
    return new Uint32Array(buffer)[(GUEST_BASE + MIRROR) / 4 + SLOT]!;
}

test('a WASM memory grow does not resurrect a released mutex owner', () => {
    const buffer = new ArrayBuffer(0x20000);
    const manager = makeManager(buffer);

    // JS last handled a CONTENDED acquire: T1 took it, and that is all the shadow knows.
    const held = packMutexMirrorWord(1, 1, true, false);
    manager.mutexMirrorShadow[SLOT] = held;
    manager.writeMutexMirrorSlot(SLOT);
    expect(liveWord(buffer)).toBe(held);

    // The guest then released it through the WASM fast path — guest RAM only.
    const free = packMutexMirrorWord(0, 0, true, false);
    new Uint32Array(buffer)[(GUEST_BASE + MIRROR) / 4 + SLOT] = free;
    expect(manager.readMutexMirrorState(0x30108).owner).toBeNull();

    // WASM memory grows: same contents, new buffer object.
    const grown = new ArrayBuffer(0x40000);
    new Uint8Array(grown).set(new Uint8Array(buffer));
    manager.cpu.wasm_memory.buffer = grown;
    manager.cpu.mem8 = new Uint8Array(grown, GUEST_BASE);
    manager.refreshViews();

    expect(liveWord(grown)).toBe(free);
    expect(manager.readMutexMirrorState(0x30108).owner).toBeNull();
    // The shadow must have re-learned from the live table, not the other way round.
    expect(manager.mutexMirrorShadow[SLOT]).toBe(free);
});

test('a resync republishes a slot the live table lost (restart zeroes guest RAM)', () => {
    const buffer = new ArrayBuffer(0x20000);
    const manager = makeManager(buffer);

    const held = packMutexMirrorWord(2, 1, true, false);
    manager.mutexMirrorShadow[SLOT] = held;
    manager.writeMutexMirrorSlot(SLOT);

    // v86.restart(): guest RAM is zeroed, so the slot is no longer VALID.
    const fresh = new ArrayBuffer(0x20000);
    manager.cpu.wasm_memory.buffer = fresh;
    manager.cpu.mem8 = new Uint8Array(fresh, GUEST_BASE);
    manager.refreshViews();

    expect(liveWord(fresh) & MUX_VALID).not.toBe(0);
    expect(manager.readMutexMirrorState(0x30108).owner).toBe(2);
});
