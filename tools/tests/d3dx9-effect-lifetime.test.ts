import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createEffectExports } from '../../src/worker/modules/d3dx9/effects';
import { disposeEffectParameters } from '../../src/worker/modules/d3dx9/effect-lifetime';
import { bindSharedParameters, createEffectPool, resetEffectPools } from '../../src/worker/modules/d3dx9/effect-pool';
import { EffectParamClass, EffectParamType, registerEffectInstance, resetEffectInstances, type EffectInstance, type EffectParameter } from '../../src/worker/modules/d3dx9/effect-state';
import { setObjectParam } from '../../src/worker/modules/d3dx9/effect-values';
import { getComRefCount, releaseComRef, trackComObject, forgetComObject } from '../../src/worker/modules/d3d9/com-refs';
import { textureMeta } from '../../src/worker/modules/d3d9/resource-registry';
import { volumeTextureResources } from '../../src/worker/modules/d3d9/volume-resources';

const DEFAULT = 0x0da000, MANAGED = 0x0da100, VOLUME = 0x0da200;
const flags = globalThis as { __d3d9MirrorRefcount?: boolean };
let before: boolean | undefined;
function param(name: string, shared = false, type = EffectParamType.Texture2D): EffectParameter {
    return { name, semantic: '', type, flags: shared ? 1 : 0, paramClass: EffectParamClass.Object,
        rows: 1, columns: 1, elements: 0, annotations: [], members: [], value: new Uint8Array(0), objectPtr: 0, objectIndex: -1 };
}
function instance(parameters: EffectParameter[], poolPtr = 0): EffectInstance {
    return { model: { creator: '', parameters, techniques: [], objects: [] }, devicePtr: 0, annotations: [], currentTechnique: 0, activePass: 0, poolPtr };
}
beforeEach(() => {
    before = flags.__d3d9MirrorRefcount;
    flags.__d3d9MirrorRefcount = true;
    for (const p of [DEFAULT, MANAGED, VOLUME]) trackComObject(p);
    textureMeta.set(DEFAULT, { width: 4, height: 4, levels: 1, usage: 1, pool: 0, format: 21 });
    textureMeta.set(MANAGED, { width: 4, height: 4, levels: 1, usage: 0, pool: 1, format: 21 });
    volumeTextureResources.set(VOLUME, { pool: 0 } as any);
});
afterEach(() => {
    for (const p of [DEFAULT, MANAGED, VOLUME]) {
        forgetComObject(p); textureMeta.delete(p); volumeTextureResources.delete(p);
    }
    resetEffectPools(); resetEffectInstances(); flags.__d3d9MirrorRefcount = before;
});

test('OnLostDevice releases DEFAULT texture and nested volume, preserves managed texture', () => {
    const a = param('target'), b = param('managed'), c = param('volume', false, EffectParamType.Texture3D);
    setObjectParam(a, DEFAULT); setObjectParam(b, MANAGED); setObjectParam(c, VOLUME);
    const nested = param('nested'); nested.paramClass = EffectParamClass.Struct; nested.members = [c];
    const inst = instance([a, b, nested]); registerEffectInstance(123, inst);
    const exports = createEffectExports({} as any);
    expect(exports.ID3DXEffect_OnLostDevice!({} as any, new Uint8Array(0), [123])).toBe(0);
    expect([a.objectPtr, b.objectPtr, c.objectPtr]).toEqual([0, MANAGED, 0]);
    expect([getComRefCount(DEFAULT), getComRefCount(MANAGED), getComRefCount(VOLUME)]).toEqual([1, 2, 1]);
    expect(inst.activePass).toBe(-1);
    exports.ID3DXEffect_OnLostDevice!({} as any, new Uint8Array(0), [123]);
    expect(getComRefCount(DEFAULT)).toBe(1);
    disposeEffectParameters(inst); expect(getComRefCount(MANAGED)).toBe(1);
});

test('effect teardown releases each owned reference, including two parameters naming one texture', () => {
    const a = param('a'), b = param('b');
    setObjectParam(a, DEFAULT); setObjectParam(b, DEFAULT);
    releaseComRef(DEFAULT); expect(getComRefCount(DEFAULT)).toBe(2);
    const inst = instance([a, b]); disposeEffectParameters(inst);
    expect(getComRefCount(DEFAULT)).toBeUndefined();
    disposeEffectParameters(inst); expect([a.objectPtr, b.objectPtr]).toEqual([0, 0]);
});

test('shared texture has one reference until its last effect departs, and late joins inherit it', () => {
    createEffectPool(456);
    const a = param('shared', true), b = param('shared', true);
    const first = instance([a], 456), second = instance([b], 456);
    bindSharedParameters(456, first.model); setObjectParam(a, DEFAULT);
    bindSharedParameters(456, second.model);
    expect(b.objectPtr).toBe(DEFAULT); expect(getComRefCount(DEFAULT)).toBe(2);
    disposeEffectParameters(first);
    expect(b.objectPtr).toBe(DEFAULT); expect(getComRefCount(DEFAULT)).toBe(2);
    disposeEffectParameters(second); expect(getComRefCount(DEFAULT)).toBe(1);
    const next = instance([param('shared', true)], 456); bindSharedParameters(456, next.model);
    expect(next.model.parameters[0]!.objectPtr).toBe(0);
});

test('OnLostDevice clears a shared texture across surviving effects exactly once', () => {
    createEffectPool(456);
    const a = param('shared', true), b = param('shared', true);
    const first = instance([a], 456), second = instance([b], 456);
    bindSharedParameters(456, first.model); bindSharedParameters(456, second.model);
    setObjectParam(a, DEFAULT); registerEffectInstance(123, first); registerEffectInstance(124, second);
    const exports = createEffectExports({} as any);
    for (const id of [123, 124]) exports.ID3DXEffect_OnLostDevice!({} as any, new Uint8Array(0), [id]);
    expect([a.objectPtr, b.objectPtr]).toEqual([0, 0]); expect(getComRefCount(DEFAULT)).toBe(1);
});
