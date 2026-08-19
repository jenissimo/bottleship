// Auto-generated index for gdi32 module
// This file aggregates all atomic implementations
// Generated from directory scan: src/worker/modules/gdi32

import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

import { createContextExports as context } from './context';
import { createPaintingExports as painting, registerFastPathGdiFunctions as registerFastPathpainting } from './painting';

export class GDI32 implements IModule {
    name = 'gdi32';
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // context functions
        Object.assign(this.exports, context());
        // painting functions
        Object.assign(this.exports, painting());
        registerFastPathpainting(process.dispatcher);
    }
}