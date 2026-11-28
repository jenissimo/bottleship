import type {Process} from '../core/process';
import type {ThunkResult, X86Context} from '../core/thunking/thunk-dispatcher';
import {Mem} from '../core/memory/mem-accessor';
import {readGuidFromMem, writeGuidToMem} from '../core/com/typelib/typelib-types';
import {isValidUserAddress} from '../core/memory/address-guard';

const E_FAIL = 0x80004005;
const E_POINTER = 0x80004003;
const E_OUTOFMEMORY = 0x8007000e;
const REGDB_E_CLASSNOTREG = 0x80040154;
const STG_E_READFAULT = 0x8003001e;
const STG_E_WRITEFAULT = 0x8003001d;
const IPERSISTSTREAM = '00000109-0000-0000-c000-000000000046';

type Continue = (hr: number) => number | null;
type Dispatch = (object: number, slot: number, args: number[], done: Continue) => number;

function callWithScratch(
    process: Process, ctx: X86Context, cleanup: number, name: string,
    begin: (scratch: number, call: Dispatch, finish: (hr: number) => number) => number,
): number | ThunkResult {
    const callbacks = process.dispatcher.callbackManager;
    if (!callbacks) return E_FAIL;
    let scratch: number;
    try {
        scratch = process.memory.alloc(40, 'THUNK_DATA');
    } catch {
        return E_OUTOFMEMORY;
    }
    if (!scratch) return E_OUTOFMEMORY;
    const finish = (hr: number): number => {
        process.memory.free(scratch);
        return hr >>> 0;
    };
    const frame = callbacks.saveSuspendedThunkContext(ctx, cleanup, name);
    if (!frame) return finish(E_FAIL);

    const call: Dispatch = (object, slot, args, done) => {
        const table = object ? Mem.readUint32(object) ?? 0 : 0;
        const method = table ? Mem.readUint32(table + 4 * slot) ?? 0 : 0;
        if (!method) return 0;
        try {
            return callbacks.invokeCallback(method, [object, ...args], (args.length + 1) * 4, done, false, name, frame).callbackId;
        } catch {
            return 0;
        }
    };
    const id = begin(scratch, call, finish);
    if (!id) {
        callbacks.abandonSuspendedFrame(frame);
        return finish(E_POINTER);
    }
    return {value: 0, stackCleanup: cleanup, suspendedForCallback: true, callbackId: id};
}

export function oleSaveToStream(process: Process, ctx: X86Context, persist: number, stream: number): number | ThunkResult {
    if (!persist || !stream) return E_POINTER;
    return callWithScratch(process, ctx, 8, 'OleSaveToStream', (scratch, call, finish) => {
        const bytesWritten = scratch + 16;
        Mem.writeUint32(bytesWritten, 0);
        return call(persist, 3, [scratch], hr => {
            if ((hr | 0) < 0) return finish(hr);
            const wrote = call(stream, 4, [scratch, 16, bytesWritten], writeHr => {
                if ((writeHr | 0) < 0) return finish(writeHr);
                if (Mem.readUint32(bytesWritten) !== 16) return finish(STG_E_WRITEFAULT);
                return call(persist, 6, [stream, 1], finish) ? null : finish(E_POINTER);
            });
            return wrote ? null : finish(E_POINTER);
        });
    });
}

export function oleLoadFromStream(
    process: Process, ctx: X86Context, mem: Uint8Array, stream: number, iid: number, out: number,
    findFactory: (clsid: string) => number,
): number | ThunkResult {
    if (!isValidUserAddress(mem, out, 4, 'rw')) return E_POINTER;
    Mem.writeUint32(out, 0);
    if (!stream || !isValidUserAddress(mem, iid, 16, 'r')) return E_POINTER;
    return callWithScratch(process, ctx, 12, 'OleLoadFromStream', (scratch, call, finish) => {
        const readCount = scratch + 16;
        const persistIID = scratch + 20;
        const persistOut = scratch + 36;
        Mem.writeUint32(readCount, 0);
        Mem.writeUint32(persistOut, 0);
        writeGuidToMem(process.getCurrentMemory(), persistIID, IPERSISTSTREAM);
        return call(stream, 3, [scratch, 16, readCount], hr => {
            if ((hr | 0) < 0) return finish(hr);
            if (Mem.readUint32(readCount) !== 16) return finish(STG_E_READFAULT);
            const clsid = readGuidFromMem(process.getCurrentMemory(), scratch);
            const factory = findFactory(clsid);
            if (!factory) return finish(REGDB_E_CLASSNOTREG);
            const created = call(factory, 3, [0, persistIID, persistOut], createHr => {
                if ((createHr | 0) < 0) return finish(createHr);
                const persist = Mem.readUint32(persistOut) ?? 0;
                if (!persist) return finish(E_FAIL);
                const release = (result: number) =>
                    call(persist, 2, [], () => finish(result)) ? null : finish(result);
                const loaded = call(persist, 5, [stream], loadHr => {
                    if ((loadHr | 0) < 0) return release(loadHr);
                    return call(persist, 0, [iid, out], release) ? null : release(E_POINTER);
                });
                return loaded ? null : release(E_POINTER);
            });
            return created ? null : finish(REGDB_E_CLASSNOTREG);
        });
    });
}
