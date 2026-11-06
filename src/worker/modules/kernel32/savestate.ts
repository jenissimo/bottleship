import { System } from '../../core/system';
import { savestateParticipants, stateKeys } from '../../savestate/participant';
import type { SaveValue } from '../../savestate/value-codec';
import { CaptureRefusal } from '../../savestate/object-codecs';
import { captureAtoms, restoreAtoms } from './atom';
import { captureFls, restoreFls } from './fls';
import { captureSrwLocks, restoreSrwLocks } from './srw-lock';
import { namedObjects } from './named-objects';
import { captureModuleRefs, restoreModuleRefs, type ModuleRefState } from './module/module';
import { captureResourceHandles, restoreResourceHandles } from './resource';
import { captureCommandLineState, restoreCommandLineState } from './command/command';
import { capturePointerCookie, restorePointerCookie } from './exception';
import { captureConsoleModes, restoreConsoleModes } from './file-io-console';
import { areFileApisAnsi, setFileApisAnsi } from './file-io-strings';
import { consoleScreenBuffers } from './console-screen-buffer';
import { captureProcessApiState, restoreProcessApiState } from './process/process';
import { captureVistaSystemState, restoreVistaSystemState, type VistaSystemState } from './process/vista-system';
import { captureActCtxState, restoreActCtxState, type ActCtxState } from './process/actctx';
import { captureVistaRuntimeState, restoreVistaRuntimeState } from './vista-runtime';
import { ioCompletionInUse } from './sync';
import { pendingReadExCount } from './file-io-ex';
import { pendingSocketFileIoCount } from './socket-file-io';
import { getVirtualProcessManager } from './process/virtual-process-manager';
import { captureAddressWaits, restoreAddressWaits } from '../kernelbase';
import { captureStartupSessionState, restoreStartupSessionState, type StartupSessionState } from '../../core/process-startup-info';

export interface Kernel32State {
    atoms: ReturnType<typeof captureAtoms>;
    fls: ReturnType<typeof captureFls>;
    srwLocks: ReturnType<typeof captureSrwLocks>;
    namedObjects: ReturnType<typeof namedObjects.captureState>;
    modules: ModuleRefState;
    resources: ReturnType<typeof captureResourceHandles>;
    commandLine: ReturnType<typeof captureCommandLineState>;
    pointerCookie: number;
    consoleModes: Array<[number, number]>;
    fileApisAnsi: boolean;
    console: ReturnType<typeof consoleScreenBuffers.captureState>;
    process: ReturnType<typeof captureProcessApiState>;
    vista: VistaSystemState;
    actCtx: ActCtxState;
    threadPool: ReturnType<typeof captureVistaRuntimeState>;
    startup: StartupSessionState;
    addressWaits: Array<[number, number]>;
}

export function captureKernel32State(): Kernel32State {
    const process = System.getInstance().process;
    if (ioCompletionInUse()) throw new Error('kernel32: I/O completion ports are not part of a v1 savestate');
    if (process && (pendingReadExCount(process) > 0 || pendingSocketFileIoCount(process) > 0)) {
        throw new Error('kernel32: an overlapped or socket read is pending');
    }
    if (getVirtualProcessManager().recordCount() > 0) throw new Error('kernel32: child process handles are not part of a v1 savestate');
    return {
        atoms: captureAtoms(),
        fls: captureFls(),
        srwLocks: captureSrwLocks(),
        namedObjects: namedObjects.captureState(),
        modules: captureModuleRefs(),
        resources: captureResourceHandles(),
        commandLine: captureCommandLineState(),
        pointerCookie: capturePointerCookie(),
        consoleModes: captureConsoleModes(),
        fileApisAnsi: areFileApisAnsi(),
        console: consoleScreenBuffers.captureState(),
        process: captureProcessApiState(),
        vista: captureVistaSystemState(),
        actCtx: captureActCtxState(),
        threadPool: captureVistaRuntimeState(),
        startup: captureStartupSessionState(),
        addressWaits: captureAddressWaits(),
    };
}

export function restoreKernel32State(state: Kernel32State): void {
    restoreAtoms(state.atoms);
    restoreFls(state.fls);
    restoreSrwLocks(state.srwLocks);
    namedObjects.restoreState(state.namedObjects);
    restoreModuleRefs(state.modules);
    restoreResourceHandles(state.resources);
    restoreCommandLineState(state.commandLine);
    restorePointerCookie(state.pointerCookie);
    restoreConsoleModes(state.consoleModes);
    setFileApisAnsi(state.fileApisAnsi);
    consoleScreenBuffers.restoreState(state.console);
    restoreProcessApiState(state.process);
    restoreVistaSystemState(state.vista);
    restoreActCtxState(state.actCtx);
    restoreVistaRuntimeState(state.threadPool);
    restoreStartupSessionState(state.startup);
    restoreAddressWaits(state.addressWaits);
}

export function registerKernel32Participant(): void {
    savestateParticipants.add({
        id: 'kernel32', version: 4, order: 6, covers: ['kernel32', 'kernelbase', 'ntdll'],
        schema: stateKeys<Kernel32State>({ atoms: true, fls: true, srwLocks: true, namedObjects: true, modules: true, resources: true, commandLine: true, pointerCookie: true, consoleModes: true, fileApisAnsi: true, console: true, process: true, vista: true, actCtx: true, threadPool: true, startup: true, addressWaits: true }),
        capture: () => {
            try {
                return captureKernel32State() as unknown as SaveValue;
            } catch (e) {
                throw new CaptureRefusal(e instanceof Error ? e.message : String(e));
            }
        },
        restore: (s) => restoreKernel32State(s as unknown as Kernel32State),
    });
}
