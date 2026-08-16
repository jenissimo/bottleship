// Auto-generated index for d3d9 module
// This file aggregates all atomic implementations
// Generated from directory scan: src/worker/modules/d3d9

import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

import { createStateExports as state } from './state';
import { createResourcesExports as resources } from './resources';
import { registerFastPathD3D9Functions as registerFastPathfast_path } from './fast-path';
import { createFactoryExports as factory } from './factory';
import { createShaderValidatorExports as shader_validator } from './shader-validator';
import { createDeviceExports as device } from './device';
import { createQueryExports as query } from './query';
import { resetD3D9SharedState } from './shared-state';

export class D3D9 implements IModule {
    name = 'd3d9';
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // state functions
        Object.assign(this.exports, state());
        // resources functions
        Object.assign(this.exports, resources());
        // fast-path functions
        registerFastPathfast_path(process.dispatcher);
        // factory functions
        Object.assign(this.exports, factory());
        // shader-validator functions
        Object.assign(this.exports, shader_validator());
        // device functions
        Object.assign(this.exports, device());
        // query functions
        Object.assign(this.exports, query());
    }

    reset(): void {
        resetD3D9SharedState();
    }
}