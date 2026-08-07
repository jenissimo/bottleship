// Auto-generated index for d3d9 module
// This file aggregates all atomic implementations
// Generated from directory scan: src/worker/modules/d3d9

import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

import { createDeviceExports as device } from './device';
import { createFactoryExports as factory } from './factory';
import { registerFastPathD3D9Functions as registerFastPathfast_path } from './fast-path';
import { createQueryExports as query } from './query';
import { createResourcesExports as resources } from './resources';
import { createShaderValidatorExports as shader_validator } from './shader-validator';
import { createStateExports as state } from './state';
import { resetD3D9SharedState } from './shared-state';

export class D3D9 implements IModule {
    name = 'd3d9';
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // device functions
        Object.assign(this.exports, device());
        // factory functions
        Object.assign(this.exports, factory());
        // fast-path functions
        registerFastPathfast_path(process.dispatcher);
        // query functions
        Object.assign(this.exports, query());
        // resources functions
        Object.assign(this.exports, resources());
        // shader-validator functions
        Object.assign(this.exports, shader_validator());
        // state functions
        Object.assign(this.exports, state());
    }

    reset(): void {
        resetD3D9SharedState();
    }
}