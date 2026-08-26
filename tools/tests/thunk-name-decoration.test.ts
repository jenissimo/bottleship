// A stdcall decoration is the argument list, not spelling. findStubsByName's
// normalized fallback must therefore never reach across two decorations of one base
// name: binding `_AIL_pause_stream@4` (MSS 3.x — one argument, always pauses) into the
// stub the guest imported as `@8` (HSTREAM + onoff) drops the second argument, and the
// per-frame `AIL_pause_stream(stream, 0)` GTA III uses to keep a cutscene line playing
// then pauses it instead — the cutscene waits forever on audio that never advances.
//
// The undecorated spelling still has to reach a decorated stub: a module that exports
// "AIL_pause_stream" is naming the same function the guest imported as `_AIL_pause_stream@8`.

import { describe, it, expect } from 'bun:test';
import { ThunkGenerator } from '../../src/worker/core/thunking/thunk-generator';

function generatorWithStub(dll: string, name: string, argCount: number): ThunkGenerator {
    const gen = new ThunkGenerator();
    gen.generateStubDll(dll, [{ name, argCount }]);
    return gen;
}

describe('findStubsByName decoration matching', () => {
    it('matches a stub by its exact decorated name', () => {
        const gen = generatorWithStub('mss32', '_AIL_pause_stream@8', 2);
        const found = gen.findStubsByName('mss32', '_AIL_pause_stream@8');
        expect(found.map((s) => s.functionName)).toEqual(['_AIL_pause_stream@8']);
    });

    it('refuses to bind a different decoration of the same base name', () => {
        const gen = generatorWithStub('mss32', '_AIL_pause_stream@8', 2);
        expect(gen.findStubsByName('mss32', '_AIL_pause_stream@4')).toEqual([]);
    });

    it('still lets an undecorated export reach a decorated stub', () => {
        const gen = generatorWithStub('mss32', '_AIL_pause_stream@8', 2);
        const found = gen.findStubsByName('mss32', 'AIL_pause_stream');
        expect(found.map((s) => s.functionName)).toEqual(['_AIL_pause_stream@8']);
    });

    it('lets a decorated export reach an undecorated stub', () => {
        const gen = generatorWithStub('mss32', 'AIL_pause_stream', 2);
        const found = gen.findStubsByName('mss32', '_AIL_pause_stream@8');
        expect(found.map((s) => s.functionName)).toEqual(['AIL_pause_stream']);
    });

    it('keeps both decorations apart when the guest imported both', () => {
        const gen = new ThunkGenerator();
        gen.generateStubDll('mss32', [
            { name: '_AIL_pause_stream@4', argCount: 1 },
            { name: '_AIL_pause_stream@8', argCount: 2 },
        ]);
        expect(gen.findStubsByName('mss32', '_AIL_pause_stream@4').map((s) => s.argCount)).toEqual([1]);
        expect(gen.findStubsByName('mss32', '_AIL_pause_stream@8').map((s) => s.argCount)).toEqual([2]);
    });
});
