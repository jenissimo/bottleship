/**
 * COMBASE.DLL — the Windows Runtime surface of a system that hosts no runtime classes.
 *
 * RoInitialize/RoUninitialize are the COM apartment calls under another name (they share
 * ole32's per-thread state), HSTRING is implemented for real (combase-hstring.ts), and
 * activation fails exactly as it does on Windows when a class is not registered: no
 * ActivatableClassId key exists, so every class id is REGDB_E_CLASSNOTREG.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { System } from "../core/system";
import { Mem } from "../core/memory/mem-accessor";
import { isValidAddress } from "../core/memory/address-guard";
import { comApartments } from "../core/com/apartment";
import { HStrings, E_INVALIDARG } from "./combase-hstring";

const REGDB_E_CLASSNOTREG = 0x80040154;
const CO_E_NOTINITIALIZED = 0x800401f0;
const RO_INIT_SINGLETHREADED = 0;
const RO_INIT_MULTITHREADED = 1;

/** RoGetActivationFactory's apartment rule: an uninitialized thread may use the MTA only if one exists. */
export function activationApartmentError(threadId: number): number {
    if (comApartments.model(threadId) || comApartments.hasMta()) return 0;
    return CO_E_NOTINITIALIZED;
}

export class Combase implements IModule {
    name = "combase";
    exports: Record<string, ThunkImplementation> = {};
    private strings: HStrings | null = null;

    initialize(process: Process): void {
        const strings = new HStrings({
            alloc: (bytes) => {
                try {
                    return process.memory.alloc(bytes);
                } catch {
                    return 0;
                }
            },
            free: (ptr) => process.memory.free(ptr),
        });
        this.strings = strings;
        const currentThread = () => System.getInstance().scheduler.getCurrentThreadId();

        // HRESULT RoInitialize(RO_INIT_TYPE initType)
        this.exports["RoInitialize"] = (_ctx, _mem, args) => {
            const type = args[0] >>> 0;
            if (type === RO_INIT_SINGLETHREADED) return comApartments.enter(currentThread(), "sta");
            if (type === RO_INIT_MULTITHREADED) return comApartments.enter(currentThread(), "mta");
            return E_INVALIDARG;
        };

        // void RoUninitialize(void)
        this.exports["RoUninitialize"] = () => {
            comApartments.leave(currentThread());
            return 0;
        };

        // HRESULT RoGetActivationFactory(HSTRING activatableClassId, REFIID iid, void **factory)
        this.exports["RoGetActivationFactory"] = (_ctx, _mem, args) => {
            const iid = args[1] >>> 0;
            const ppFactory = args[2] >>> 0;
            if (!iid || !ppFactory || !isValidAddress(ppFactory, 4, "rw")) return E_INVALIDARG;
            Mem.writeUint32(ppFactory, 0);
            return activationApartmentError(currentThread()) || REGDB_E_CLASSNOTREG;
        };

        // HRESULT RoActivateInstance(HSTRING activatableClassId, IInspectable **instance)
        // — RoGetActivationFactory(IID_IActivationFactory) and then the factory, so it
        // fails the same way before *instance is ever written.
        this.exports["RoActivateInstance"] = (_ctx, _mem, args) => {
            const ppInstance = args[1] >>> 0;
            if (!ppInstance || !isValidAddress(ppInstance, 4, "rw")) return E_INVALIDARG;
            return activationApartmentError(currentThread()) || REGDB_E_CLASSNOTREG;
        };

        this.exports["WindowsCreateString"] = (_ctx, _mem, args) =>
            strings.create(args[0] >>> 0, args[1] >>> 0, args[2] >>> 0);
        this.exports["WindowsCreateStringReference"] = (_ctx, _mem, args) =>
            strings.createReference(args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, args[3] >>> 0);
        this.exports["WindowsDeleteString"] = (_ctx, _mem, args) => strings.delete(args[0] >>> 0);
        this.exports["WindowsDuplicateString"] = (_ctx, _mem, args) =>
            strings.duplicate(args[0] >>> 0, args[1] >>> 0);
        this.exports["WindowsGetStringRawBuffer"] = (_ctx, _mem, args) =>
            strings.rawBuffer(args[0] >>> 0, args[1] >>> 0);
        this.exports["WindowsGetStringLen"] = (_ctx, _mem, args) => strings.length(args[0] >>> 0);
        this.exports["WindowsIsStringEmpty"] = (_ctx, _mem, args) => strings.isEmpty(args[0] >>> 0) ? 1 : 0;
    }

    reset(): void {
        this.strings?.reset();
    }
}
