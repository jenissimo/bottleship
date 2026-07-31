// Custom index for kernel32 module.
// Export aggregation matches the generated style, but reset orchestration is
// hand-maintained: process-scoped state lives across many atomic files and must
// clear on an in-worker game switch (Process object is reused).

import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

import { exports as atom, resetAtomTable } from './atom';
import { exports as command, resetCommandLineState } from './command/command';
import { exports as environment } from './environment';
import { exports as error } from './error';
import { exports as exception, resetPointerCookie } from './exception';
import { exports as file_io, resetFileIoState } from './file-io';
import { exports as fls, resetFlsState } from './fls';
import { exports as locale } from './locale';
import { exports as memory } from './memory';
import { exports as module } from './module/module';
import { exports as process_, resetProcessApiState } from './process/process';
import { exports as profile, resetIniCache } from './profile';
import { exports as resource, resetResourceCache } from './resource';
import { exports as sync, resetSyncState } from './sync';
import { exports as time } from './time/time';
import { exports as tls } from './tls';
import { exports as util } from './util';
import { exports as vista_runtime } from './vista-runtime';
import { resetActCtxState } from './process/actctx';
import { getVirtualProcessManager } from './process/virtual-process-manager';
import { resetAllSrwLocks } from './srw-lock';
import { consoleScreenBuffers } from './console-screen-buffer';
import { resetConsoleModeState } from './file-io-console';

export class Kernel32 implements IModule {
    name = 'kernel32';
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // atom functions
        Object.assign(this.exports, atom);
        // command functions
        Object.assign(this.exports, command);
        // environment functions
        Object.assign(this.exports, environment);
        // error functions
        Object.assign(this.exports, error);
        // exception functions
        Object.assign(this.exports, exception);
        // file-io functions
        Object.assign(this.exports, file_io);
        // fls functions
        Object.assign(this.exports, fls);
        // locale functions
        Object.assign(this.exports, locale);
        // memory functions
        Object.assign(this.exports, memory);
        // module functions
        Object.assign(this.exports, module);
        // process functions
        Object.assign(this.exports, process_);
        // profile functions
        Object.assign(this.exports, profile);
        // resource functions
        Object.assign(this.exports, resource);
        // sync functions
        Object.assign(this.exports, sync);
        // time functions
        Object.assign(this.exports, time);
        // tls functions
        Object.assign(this.exports, tls);
        // util functions
        Object.assign(this.exports, util);
        // vista-runtime functions
        Object.assign(this.exports, vista_runtime);
    }

    reset(): void {
        resetAtomTable();
        resetCommandLineState();
        resetPointerCookie();
        resetFileIoState();
        resetFlsState();
        resetProcessApiState();
        resetIniCache();
        resetResourceCache();
        resetSyncState();
        resetActCtxState();
        getVirtualProcessManager().reset();
        resetAllSrwLocks();
        consoleScreenBuffers.reset();
        resetConsoleModeState();
    }
}
