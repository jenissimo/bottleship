// A state block recorded while the guest-side setter shadows are armed silently loses entries.
//
// The shadow trampoline RETs in guest code when the incoming value equals its shadow slot, so
// device.setRenderState — and therefore recordStateBlock — never runs. The shadow is kept in
// lock-step with the device's tracked value on purpose, so the calls that get elided are
// exactly the ones setting a state to the value the device already holds. Real D3D9 records
// those. Ours dropped them, and the damage only appears later, as an Apply that fails to
// restore a state, with nothing logged anywhere.
//
// `guestSetRenderState` below models the emitted trampoline's decision: the owner-gate compare
// and the slot compare, in that order, exactly as writeShadowTrampoline emits them (and as
// hypercall_eagl's WASM replica re-implements them). Delete the disarm in
// IDirect3DDevice9_BeginStateBlock and the first test fails.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { createStateExports } from '../../src/worker/modules/d3d9/state';
import { devices, resetD3D9SharedState } from '../../src/worker/modules/d3d9/shared-state';
import {
    d3d9StateBlockShadowStats,
    resetStateBlockShadowWindowForTests,
} from '../../src/worker/modules/d3d9/state-block-shadow-window';

const D3D_OK = 0;
const DEVICE = 0x9000;
const SHADOWED = 'd3d9:idirect3ddevice9_setrenderstate';

let originalProcess: unknown;
let mem: Uint8Array;
let nextPtr: number;

/** The guest-visible half of the shadow: the owner gate and one slot table. */
let ownerWord: number;
let shadow: Map<number, number>;
let skipCounter: number;

/** A device that journals while recording, exactly as the real one does. */
interface FakeBlockDevice {
    recording: boolean;
    journal: Array<{ state: number; value: number }>;
    tracked: Map<number, number>;
}
let device: FakeBlockDevice;

/**
 * The emitted trampoline's decision, modelled: skip iff the owner gate names this device AND
 * the slot already holds the value. Everything else falls through to the setter.
 */
function guestSetRenderState(state: number, value: number): void {
    if (ownerWord === DEVICE && shadow.get(state) === value) {
        skipCounter++;
        return;
    }
    shadow.set(state, value);
    if (device.recording) {
        device.journal.push({ state, value });
        // The real device resyncs the slot to the UNCHANGED tracked value after journaling.
        shadow.set(state, device.tracked.get(state) ?? 0);
    } else {
        device.tracked.set(state, value);
    }
}

beforeEach(() => {
    const system = System.getInstance();
    originalProcess = system.process;
    mem = new Uint8Array(0x40000);
    nextPtr = 0x100;
    ownerWord = DEVICE;
    shadow = new Map();
    skipCounter = 0;
    device = { recording: false, journal: [], tracked: new Map() };

    const alloc = (size: number): number => {
        const at = (nextPtr + 15) & ~15;
        nextPtr = at + Math.max(16, size);
        return at;
    };
    system.process = {
        memory: {
            alloc,
            allocSystemBlock: alloc,
            allocAt: () => { },
            freeSystemBlock: () => { },
        },
        getCurrentMemory: () => mem,
        // EndStateBlock builds a real IDirect3DStateBlock9 COM object, so the vtable machinery
        // has to answer. Stub bodies are irrelevant here — nothing dispatches through them.
        thunkGenerator: {
            generateStubDll: (_name: string, methods: Array<{ name: string }>) => {
                const baseAddress = alloc(methods.length * 16);
                return {
                    baseAddress,
                    stubCode: new Uint8Array(methods.length * 16),
                    exportTable: new Map(methods.map((m, i) => [m.name.toLowerCase(), baseAddress + i * 16])),
                };
            },
            allocateVTableMemory: (size: number) => alloc(size),
        },
        // Only the two calls the recording window makes; the skip counter is the guest word
        // the trampolines (and the EAGL WASM path) bump, read back the same way here.
        dispatcher: {
            setShadowOwner: (ptr: number) => { ownerWord = ptr >>> 0; },
            getShadowStats: () => ({ [SHADOWED]: skipCounter }),
            applyPendingRegistrations: () => { },
        },
    } as never;
    Mem.bind(() => mem, (address, size) => address >= 0 && address + size <= mem.length);
    // The released-COM trap installs its own vtable through machinery this fixture does not
    // build; it is not what these tests are about.
    (globalThis as { __noComTrap?: boolean }).__noComTrap = true;
    resetD3D9SharedState();
    resetStateBlockShadowWindowForTests();

    devices.set(DEVICE, {
        beginStateBlock: () => { device.recording = true; return D3D_OK; },
        endStateBlock: () => {
            device.recording = false;
            return { hr: D3D_OK, entries: device.journal.map(e => ({ op: 'renderState', ...e })) };
        },
    } as never);
});

afterEach(() => {
    delete (globalThis as { __noComTrap?: boolean }).__noComTrap;
    devices.delete(DEVICE);
    resetD3D9SharedState();
    resetStateBlockShadowWindowForTests();
    (System.getInstance() as { process: unknown }).process = originalProcess;
});

describe('a recording state block must capture setters the shadow would elide', () => {
    test('a Set* at the value the device already holds still reaches the block', () => {
        const exports = createStateExports();
        device.tracked.set(7, 42);
        shadow.set(7, 42);          // shadow in lock-step with the device, as the device keeps it

        // Outside a recording window this call is elided, which is the whole point of the
        // shadow and is correct there: the device already holds the value.
        guestSetRenderState(7, 42);
        expect(skipCounter).toBe(1);
        expect(device.journal).toEqual([]);

        expect(exports['IDirect3DDevice9_BeginStateBlock']!({} as never, mem, [DEVICE] as never)).toBe(D3D_OK);
        // Inside one, the same call MUST be recorded — real D3D9 journals every Set*.
        guestSetRenderState(7, 42);
        expect(device.journal).toEqual([{ state: 7, value: 42 }]);
        expect(skipCounter).toBe(1);
    });

    test('the gate is disarmed for the window and re-armed for the recording device', () => {
        const exports = createStateExports();
        expect(ownerWord).toBe(DEVICE);
        exports['IDirect3DDevice9_BeginStateBlock']!({} as never, mem, [DEVICE] as never);
        expect(ownerWord).toBe(0);

        const ppSB = 0x2000;
        exports['IDirect3DDevice9_EndStateBlock']!({} as never, mem, [DEVICE, ppSB] as never);
        expect(ownerWord).toBe(DEVICE);
        // …and skipping works again once the block is closed.
        device.tracked.set(7, 42);
        shadow.set(7, 42);
        guestSetRenderState(7, 42);
        expect(skipCounter).toBe(1);
    });

    test('a failed BeginStateBlock leaves the gate armed', () => {
        const exports = createStateExports();
        devices.set(DEVICE, { beginStateBlock: () => 0x8876086c } as never);
        exports['IDirect3DDevice9_BeginStateBlock']!({} as never, mem, [DEVICE] as never);
        expect(ownerWord).toBe(DEVICE);
    });

    test('an unbalanced Begin leaves skipping OFF, not on', () => {
        // The safe failure direction: correct and slower, never a lost entry.
        const exports = createStateExports();
        exports['IDirect3DDevice9_BeginStateBlock']!({} as never, mem, [DEVICE] as never);
        expect(ownerWord).toBe(0);
        expect(d3d9StateBlockShadowStats().openWindows).toBe(1);
    });
});

describe('the instrument can read non-zero — it is not a constant 0', () => {
    test('it counts setters elided while a block was recording', () => {
        // Exactly what the bug looked like: the gate stayed armed across the window, so the
        // trampoline elided a recorded setter. Simulated by re-arming behind the fix's back.
        const exports = createStateExports();
        exports['IDirect3DDevice9_BeginStateBlock']!({} as never, mem, [DEVICE] as never);
        ownerWord = DEVICE;                       // the pre-fix state of the world
        device.tracked.set(7, 42);
        shadow.set(7, 42);
        guestSetRenderState(7, 42);               // elided, and the block loses the entry
        expect(device.journal).toEqual([]);

        exports['IDirect3DDevice9_EndStateBlock']!({} as never, mem, [DEVICE, 0x2000] as never);
        const stats = d3d9StateBlockShadowStats();
        expect(stats.windows).toBe(1);
        expect(stats.elided).toBe(1);
        expect(stats.elidedBySetter[SHADOWED]).toBe(1);
        expect(stats.verdict).toBe('LEAK: a recorded block is missing setters the guest issued');
    });

    test('and reads 0 for a window the fix actually protected', () => {
        const exports = createStateExports();
        exports['IDirect3DDevice9_BeginStateBlock']!({} as never, mem, [DEVICE] as never);
        device.tracked.set(7, 42);
        shadow.set(7, 42);
        guestSetRenderState(7, 42);               // reaches the device: the gate is disarmed
        exports['IDirect3DDevice9_EndStateBlock']!({} as never, mem, [DEVICE, 0x2000] as never);

        const stats = d3d9StateBlockShadowStats();
        expect(stats.windows).toBe(1);
        expect(stats.elided).toBe(0);
        expect(stats.verdict).toBe('clean: nothing elided while recording');
    });

    test('no block recorded reports that, rather than a pass', () => {
        expect(d3d9StateBlockShadowStats().verdict).toBe('no state block recorded in this window');
    });
});
