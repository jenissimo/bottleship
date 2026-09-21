/**
 * D3DX9 HLE — single implementation for all versioned d3dx9_XX.dll names.
 */

import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { d3dx9Module } from '../../api/d3dx9.api';
import { createMathExports } from './math';
import { createSurfaceExports } from './surfaces';
import { createTextureExports } from './textures';
import { createEffectExports, resetEffectState } from './effects';
import { createBufferExports, resetD3DXBuffers } from './buffer';
import { createEffectPoolExports, resetEffectPools, resetEffectPoolVtable } from './effect-pool';
import { createShaderExports, resetShaderAsmState } from './shaders';
import { createConstantTableExports, resetD3DXConstantTables } from './constant-table';
import { createTextureRequirementExports } from './texture-requirements';
import { resetEffectInstances } from './effect-state';
import { resetEffectApplyWarnings, resetEffectZeroConstantCensus } from './effect-apply';
import { resetEffectParamWriteCensus } from './effect-values';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;

const warnedStubs = new Set<string>();

function warnOnce(name: string, detail: string): void {
    if (warnedStubs.has(name)) return;
    warnedStubs.add(name);
    Logger.warn(LogCategory.SYSTEM, `d3dx9:${name} stub — ${detail}`);
}

function invalidCall(name: string): number {
    warnOnce(name, 'returning D3DERR_INVALIDCALL');
    return D3DERR_INVALIDCALL;
}

export class D3dx9 implements IModule {
    name = 'd3dx9';
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        const debugMute = () => 0;
        this.exports['DebugSetMute'] = debugMute;
        this.exports['D3DXDebugMute'] = debugMute;
        this.exports['D3DXCheckVersion'] = () => 1;

        Object.assign(this.exports, createMathExports());
        Object.assign(this.exports, createSurfaceExports());
        Object.assign(this.exports, createTextureExports());
        Object.assign(this.exports, createEffectExports(process));
        Object.assign(this.exports, createBufferExports(process));
        Object.assign(this.exports, createEffectPoolExports(process));
        Object.assign(this.exports, createShaderExports(process));
        Object.assign(this.exports, createConstantTableExports());
        Object.assign(this.exports, createTextureRequirementExports());

        this.exports['D3DXTessellateNPatches'] = () => D3DERR_INVALIDCALL;
        this.exports['D3DXSavePRTCompBufferToFileW'] = () => D3DERR_INVALIDCALL;

        const fontSpriteStubs = [
            'D3DXCreateFontA',
            'D3DXCreateFontW',
            'D3DXCreateFontIndirectA',
            'D3DXCreateFontIndirectW',
            'D3DXCreateSprite',
        ];
        for (const name of fontSpriteStubs) {
            this.exports[name] = () => invalidCall(name);
        }

        for (const func of d3dx9Module.functions) {
            if (!this.exports[func.name]) {
                this.exports[func.name] = () => invalidCall(func.name);
            }
        }
    }

    reset(): void {
        warnedStubs.clear();
        resetEffectState();
        resetD3DXBuffers();
        resetEffectPools();
        resetEffectPoolVtable();
        resetShaderAsmState();
        resetD3DXConstantTables();
        // The effect registry is keyed by GUEST pointer: leaving it populated lets a new
        // effect that lands on a recycled address inherit the previous process's model.
        resetEffectInstances();
        resetEffectApplyWarnings();
        resetEffectZeroConstantCensus();
        resetEffectParamWriteCensus();
    }
}
