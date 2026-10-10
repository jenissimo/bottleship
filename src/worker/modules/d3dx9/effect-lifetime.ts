import { textureMeta } from '../d3d9/resource-registry';
import { volumeTextureResources } from '../d3d9/volume-resources';
import { unbindSharedParameters } from './effect-pool';
import { isTextureParameter, setObjectParam } from './effect-values';
import type { EffectInstance, EffectParameter } from './effect-state';

function walk(parameters: readonly EffectParameter[], visit: (param: EffectParameter) => void): void {
    for (const param of parameters) {
        visit(param);
        walk(param.elementsList ?? param.members, visit);
    }
}

export function effectLostDevice(inst: EffectInstance): void {
    walk(inst.model.parameters, param => {
        if (!isTextureParameter(param) || !param.objectPtr) return;
        const pool = textureMeta.get(param.objectPtr)?.pool ?? volumeTextureResources.get(param.objectPtr)?.pool;
        // D3DX releases DEFAULT textures before Reset; managed and system-memory values survive.
        if (pool === 0) setObjectParam(param, 0);
    });
    inst.activePass = -1;
}

export function disposeEffectParameters(inst: EffectInstance): void {
    // Departing shared parameters relinquish their alias before private references are freed.
    if (inst.poolPtr) unbindSharedParameters(inst.poolPtr, inst.model);
    walk(inst.model.parameters, param => {
        if (param.objectPtr) setObjectParam(param, 0);
    });
}
