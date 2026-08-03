// Custom index for user32 module.
// Export aggregation is generated-style, but reset orchestration is intentionally
// hand-maintained because User32 owns state spread across several atomic modules.

import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

import { createClassExports as class_ } from './class';
import { createDialogExports as dialog } from './dialog';
import { createInputExports as input, registerFastPathInputFunctions } from './input';
import { createMenuExports as menu } from './menu';
import { createMessageExports as message, registerFastPathMessageFunctions as registerFastPathmessage } from './message';
import { createSystemExports as system } from './system';
import { createWindowExports as window, registerFastPathWindowFunctions } from './window';
import { resetUser32SharedState } from './shared-state';
import { resetUser32Classes } from './class';
import { resetDeviceNotifications } from './device-notify';
import { resetHooks } from './hooks';
import { resetOwnerDrawScratch } from './owner-draw';
import { resetSystemCursorHandles } from './system-cursors';
import { resetMenuState } from './menu';
import { resetScrollState } from './scroll-state';
import { resetControlInteractionState } from './control-interaction';

export class User32 implements IModule {
    name = 'user32';
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // class functions
        Object.assign(this.exports, class_());
        // dialog functions
        Object.assign(this.exports, dialog());
        // input functions
        Object.assign(this.exports, input());
        registerFastPathInputFunctions(process.dispatcher);
        // menu functions
        Object.assign(this.exports, menu());
        // message functions
        Object.assign(this.exports, message());
        registerFastPathmessage(process.dispatcher);
        // system functions
        Object.assign(this.exports, system());
        // window functions
        Object.assign(this.exports, window());
        registerFastPathWindowFunctions(process.dispatcher);
    }

    reset(): void {
        resetUser32SharedState();
        resetSystemCursorHandles();
        resetUser32Classes();
        resetOwnerDrawScratch();
        resetHooks();
        resetDeviceNotifications();
        resetMenuState();
        resetScrollState();
        resetControlInteractionState();
    }
}
