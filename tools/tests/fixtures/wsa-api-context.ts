import { Process } from "../../../src/worker/core/process";
import { System } from "../../../src/worker/core/system";
import { AddressSpace } from "../../../src/worker/core/memory/address-space";
import { Mem } from "../../../src/worker/core/memory/mem-accessor";
import type { ThunkResult } from "../../../src/worker/core/thunking/thunk-dispatcher";
import type { WsaSocketTable } from "../../../src/worker/modules/wsa-network";
import type { WsaErrorSetter } from "../../../src/worker/modules/wsa-network-api";
import { makeSocketExports, makeSelect, WsaStartupCount } from "../../../src/worker/modules/wsa-stub-shared";

/** Real guest range validation and captured thread errors for Winsock ABI tests. */
export function createWsaApiFixture(table: WsaSocketTable, seedError = 12345) {
    const system = System.getInstance(), savedProcess = system.process;
    const savedMem = Object.getOwnPropertyDescriptors(Mem);
    const ram = new Uint8Array(2 << 20), space = new AddressSpace(() => ram);
    const owner = Object.create(Process.prototype) as Process;
    Object.assign(owner, { resetGeneration: 0, addressSpace: space, getMemory: () => ram, getCurrentMemory: () => ram, memory: {} });
    system.process = owner;
    Mem.bind(() => ram, (address, size, perms) => space.validateRange(address, size, perms));
    let thread = 1, disposed = false;
    const errors = new Map([[1, seedError], [2, 0x2222]]);
    const setError: WsaErrorSetter = code => { errors.set(thread, code); };
    setError.capture = () => { const issuingThread = thread; return code => { errors.set(issuingThread, code); }; };
    const counter = new WsaStartupCount(); counter.startup();
    const view = new DataView(ram.buffer);
    return {
        ram, table,
        api: makeSocketExports(table, setError, counter),
        select: makeSelect(table, setError, counter),
        put: (address: number, value: number) => view.setUint32(address, value, true),
        get: (address: number) => view.getUint32(address, true),
        error: (id = thread) => errors.get(id),
        seed: (value: number) => errors.set(thread, value),
        thread: (id: number) => { thread = id; },
        apply(result: ThunkResult) {
            for (const write of result.deferredWrites ?? []) {
                if ("bytes" in write) ram.set(write.bytes, write.address);
                else if (write.size === 1) view.setUint8(write.address, write.value);
                else if (write.size === 2) view.setUint16(write.address, write.value, true);
                else view.setUint32(write.address, write.value, true);
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            try { table.reset(); }
            finally {
                system.process = savedProcess;
                for (const key of ["memoryGetter", "validateRange", "getRegion"])
                    Object.defineProperty(Mem, key, savedMem[key]!);
            }
        },
    };
}
