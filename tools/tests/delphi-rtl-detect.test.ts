// The delphi-rtl descriptor's resolver, against module views: the switch decides whether it
// answers at all, each module answers for its own copy of the helpers, and a module whose
// copy is incomplete or duplicated answers nothing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import type { LoadedPEModule, PESection } from '../../src/worker/core/module-registry';
import type { ResolverModuleView } from '../../src/worker/core/hle-lib/types';
import { BODIES, delphiRtlDescriptor } from '../../src/worker/core/hle-lib/libs/delphi-rtl/descriptor';

/** Offsets of each body inside its code section, keeping a linked runner's distances. */
const LAYOUT: Record<keyof typeof BODIES, number> = {
    LStrClr: 0x4fa8, InitializeRecord: 0x5988, InitializeArray: 0x59b8, FinalizeRecord: 0x5a58, FinalizeArray: 0x5aa4,
};
const TEXT_RVA = 0x1000, TEXT_SIZE = 0x8000;
const g = globalThis as { __delphiRtlHle?: boolean };
let saved: typeof Mem.memoryGetter;
let mem: Uint8Array;

function placeHelpers(textBase: number): void {
    for (const [name, body] of Object.entries(BODIES) as Array<[keyof typeof BODIES, (typeof BODIES)[keyof typeof BODIES]]>) {
        mem.set(body.bytes, textBase + LAYOUT[name] - 0x4000);
    }
}

function view(name: string, base: number, sectionName = '.text'): ResolverModuleView {
    const section = { name: sectionName, virtualAddress: TEXT_RVA, virtualSize: TEXT_SIZE, rawSize: TEXT_SIZE, characteristics: 0x60000020 } as PESection;
    const module = { name, baseAddress: base, size: 0x10000, sections: [section] } as unknown as LoadedPEModule;
    return { module, signatureHits: [], getSection: n => (n === sectionName ? section : undefined) };
}

const resolve = (v: ResolverModuleView) => delphiRtlDescriptor.resolveAdditionalFunctions!(v);

beforeEach(() => {
    saved = (Mem as unknown as { memoryGetter: typeof Mem.memoryGetter }).memoryGetter;
    mem = new Uint8Array(0x100000);
    Mem.bind(() => mem);
    g.__delphiRtlHle = true;
});
afterEach(() => {
    Mem.bind(saved as () => Uint8Array);
    delete g.__delphiRtlHle;
});

describe('delphi-rtl resolver', () => {
    test('two modules each resolve their own copy; a Delphi 7 CODE section is read like .text', () => {
        placeHelpers(0x10000 + TEXT_RVA);
        placeHelpers(0x40000 + TEXT_RVA);
        const a = resolve(view('runner.exe', 0x10000));
        const b = resolve(view('plugin.dll', 0x40000, 'CODE'));
        const at = (base: number, f: keyof typeof BODIES) => base + TEXT_RVA + LAYOUT[f] - 0x4000;
        expect(a).toEqual([
            { name: 'InitializeRecord', address: at(0x10000, 'InitializeRecord') },
            { name: 'FinalizeRecord', address: at(0x10000, 'FinalizeRecord') },
        ]);
        expect(b).toEqual([
            { name: 'InitializeRecord', address: at(0x40000, 'InitializeRecord') },
            { name: 'FinalizeRecord', address: at(0x40000, 'FinalizeRecord') },
        ]);
    });

    test('switched off, nothing resolves although the bodies are there', () => {
        placeHelpers(0x10000 + TEXT_RVA);
        delete g.__delphiRtlHle;
        expect(resolve(view('runner.exe', 0x10000))).toEqual([]);
        g.__delphiRtlHle = 'yes' as unknown as boolean;
        expect(resolve(view('runner.exe', 0x10000))).toEqual([]);
    });

    test('a changed body, a missing helper or a second copy in the same section resolves nothing', () => {
        const base = 0x10000, text = base + TEXT_RVA;
        placeHelpers(text);
        const changed = mem.slice();
        mem[text + LAYOUT.FinalizeArray - 0x4000 + 3] ^= 0x01;
        expect(resolve(view('runner.exe', base))).toEqual([]);

        mem.set(changed);
        mem.fill(0, text + LAYOUT.LStrClr - 0x4000, text + LAYOUT.LStrClr - 0x4000 + BODIES.LStrClr.bytes.length);
        expect(resolve(view('runner.exe', base))).toEqual([]);

        mem.set(changed);
        mem.set(BODIES.InitializeArray.bytes, text + 0x7000);
        expect(resolve(view('runner.exe', base))).toEqual([]);
    });
});
