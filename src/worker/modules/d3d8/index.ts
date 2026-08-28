/**
 * D3D8 HLE Module — aggregates all D3D8 exports.
 */

import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

import { createFactoryExports } from './factory';
import { createDeviceExports } from './device';
import { createStateExports, createComTripleStubs } from './state';
import { createResourcesExports } from './resources';
import { assignStubsOnce } from '../../core/thunking/stub-merge';
import { registerFastPathD3D8Functions } from './fast-path';
import { resetD3D8SharedState } from './shared-state';

export class D3D8 implements IModule {
    name = 'd3d8';
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        Object.assign(this.exports, createFactoryExports());
        Object.assign(this.exports, createDeviceExports());
        Object.assign(this.exports, createStateExports());
        Object.assign(this.exports, createResourcesExports());
        assignStubsOnce(this.exports, createComTripleStubs(), 'd3d8 COM triple');

        // Move the hot device setters + draws off the OUT-trap slow path (see fast-path.ts).
        registerFastPathD3D8Functions(process.dispatcher);

        // D3DX8 inline helper D3DXDebugMute calls GetProcAddress("DebugSetMute")
        // on every D3DX API call. Without this stub, GetProcAddress returns 0,
        // preventing the game from caching the result → 294 repeated lookups.
        this.exports['DebugSetMute'] = () => 0;
    }

    reset(): void {
        resetD3D8SharedState();
    }
}
