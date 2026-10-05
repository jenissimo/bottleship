
import { ThunkImplementation } from './thunking/thunk-dispatcher';
import { Process } from './process';

export interface IModule {
    name: string;
    exports: Record<string, ThunkImplementation>;
    initialize(process: Process): void;
    reset?(): void;
    recreateVTables?(): void;
    reregisterExports?(process: Process): void;
    /**
     * Settle anything that depends on WHICH build of this DLL the bundle ships, before a
     * single stub for it exists. Awaited once per game load, after the VFS is mounted and
     * before the synthetic HLE images are published — a stub's RET N is emitted into guest
     * code there, so an answer that arrives later cannot reach a stub the guest holds.
     * Vendors have shipped a changed argument list under an unchanged decorated name
     * (Bink's `_BinkSetVolume@8`), which is what makes this a per-bundle question.
     */
    prepareForBundle?(): Promise<void>;
}
