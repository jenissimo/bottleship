/**
 * The split D3D9 call-stream codec: arguments survive the trip unchanged, typed arrays are
 * COPIED at encode time (the guest may overwrite the source the moment the call returns), and
 * anything that must not cross — a class instance, a view over all of guest memory — throws at
 * the call that tried.
 */

import { describe, expect, it } from 'bun:test';
import { SplitDecoder, SplitEncoder, SPLIT_MAX_TYPED_BYTES, type SplitRefTable } from '../../src/worker/backends/webgpu/d3d9/split-codec';

const noRefs: SplitRefTable = { idOf: () => undefined, twinOf: () => undefined };

function roundTrip(values: unknown[], refs: SplitRefTable = noRefs): unknown[] {
    const enc = new SplitEncoder(refs);
    for (const v of values) enc.value(v);
    const bytes = enc.bytes.slice(0, enc.length);
    const dec = new SplitDecoder(bytes, 0, bytes.length, refs);
    const out: unknown[] = [];
    while (!dec.done) out.push(dec.value());
    return out;
}

describe('split codec', () => {
    it('round-trips scalars, strings and nested plain data', () => {
        const values = [undefined, null, true, false, 0, -1, 0xffffffff, 0x80000000, -0x80000000, 1.5, NaN,
            -0, 2 ** 40, '', 'SetRenderState', [1, [2, 'x']], { a: 1, b: { c: [true, null] } }];
        const out = roundTrip(values);
        expect(out.length).toBe(values.length);
        expect(out[6]).toBe(0xffffffff);
        expect(out[8]).toBe(-0x80000000);
        expect(Number.isNaN(out[10] as number)).toBe(true);
        expect(out[12]).toBe(2 ** 40);
        expect(out.slice(13)).toEqual(values.slice(13));
    });

    it('copies typed arrays at encode time, keeping their kind', () => {
        const guest = new Uint8Array(64);
        guest.set([1, 2, 3, 4, 5, 6, 7, 8], 16);
        const view = guest.subarray(16, 24);
        const f32 = new Float32Array([0.5, -2]);
        const enc = new SplitEncoder(noRefs);
        enc.value(view);
        enc.value(f32);
        guest.fill(0xee);                  // the guest reuses the buffer after the call
        f32[0] = 99;
        const bytes = enc.bytes.slice(0, enc.length);
        const dec = new SplitDecoder(bytes, 0, bytes.length, noRefs);
        const a = dec.value() as Uint8Array;
        const b = dec.value() as Float32Array;
        expect(a).toBeInstanceOf(Uint8Array);
        expect(Array.from(a)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(b).toBeInstanceOf(Float32Array);
        expect(Array.from(b)).toEqual([0.5, -2]);
    });

    it('refuses a class instance no recorded call created', () => {
        class Device { x = 1; }
        const enc = new SplitEncoder(noRefs);
        expect(() => enc.value(new Device(), 'setThing(arg 0)')).toThrow(/Device instance/);
    });

    it('refuses a view the size of guest memory', () => {
        const huge = { byteLength: SPLIT_MAX_TYPED_BYTES + 1 };
        const fake = Object.assign(new Uint8Array(1), {});
        Object.defineProperty(fake, 'byteLength', { get: () => huge.byteLength });
        const enc = new SplitEncoder(noRefs);
        expect(() => enc.value(fake, 'setViewport(arg 1)')).toThrow(/guest memory/);
    });

    it('carries an object both sides created as a reference to the twin', () => {
        const front = { id: 'front block' };
        const twin = { id: 'twin block' };
        const refs: SplitRefTable = {
            idOf: (o) => (o === front ? 7 : undefined),
            twinOf: (id) => (id === 7 ? twin : undefined),
        };
        expect(roundTrip([front], refs)[0]).toBe(twin);
    });

    it('refuses functions', () => {
        const enc = new SplitEncoder(noRefs);
        expect(() => enc.value(() => 0, 'cb')).toThrow(/function/);
    });
});
