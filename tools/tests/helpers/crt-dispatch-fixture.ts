import {expect} from "bun:test";
import {Mem} from "../../../src/worker/core/memory/mem-accessor";
import {AddressSpace} from "../../../src/worker/core/memory/address-space";
import {System} from "../../../src/worker/core/system";
import {ThunkDispatcher} from "../../../src/worker/core/thunking/thunk-dispatcher";
import {ThunkBoundaryKind} from "../../../src/worker/core/scheduler/types";
import {SEH_SCRATCH_LAYOUT as L} from "../../../src/worker/core/thunking/seh-layout";
import {Msvcrt} from "../../../src/worker/modules/msvcrt";
import {msvcrtModule} from "../../../src/worker/api/msvcrt.api";

/** Production CRT registration and dispatcher with fixture CPU storage, not an emulator. */
export function crtDispatchFixture(name: string) {
    const system = System.getInstance(), originalProcess = system.process;
    const savedMem = ["memoryGetter", "validateRange", "getRegion", "dataRoutes"].map(k => [k, Object.getOwnPropertyDescriptor(Mem, k)] as const);
    const mem = new Uint8Array(0x50000), dv = new DataView(mem.buffer);
    const esp = 0x30000, ret = 0x18000, retry = 0x14000, teb = 0x10000, frame = 0x2f000, id = 0x1000;
    const spec = msvcrtModule.functions.find(f => f.name === name)!;
    const stub = {address: retry, dllName: "msvcrt", functionName: name, argCount: spec.params.length};
    const v86: any = {add_listener() {}};
    const d: any = new ThunkDispatcher(v86, {getStubById: () => stub} as any);
    const cpu: any = {reg32: new Int32Array(mem.buffer, 64, 8), instruction_pointer: new Int32Array(mem.buffer, 556, 1),
        flags: new Int32Array(mem.buffer, 120, 1), flags_changed: new Int32Array(1),
        segment_offsets: new Int32Array(mem.buffer, 736, 8), get_eflags: () => 0x202};
    v86.cpu = cpu; v86.mem8 = mem;
    const space = new AddressSpace(() => mem);
    const process: any = {v86, dispatcher: d, addressSpace: space};
    system.process = process;
    d.cachedCpu = cpu; d.cachedMem8 = mem; d.cachedDataView = dv; d.memLength = mem.length;
    d.cachedWasmBuffer = mem.buffer; d.cachedReg32Raw = cpu.reg32; d.cachedFlagsRaw = cpu.flags;
    d.cachedIpRaw = cpu.instruction_pointer; d.cachedSegOffsetsRaw = cpu.segment_offsets;
    d.cachedMem32 = new Uint32Array(mem.buffer);
    d.sehScratchAddr = 0x40000; d.sehDispatchStubAddress = 0x11000;
    d._enterSehCriticalRuntime = d._leaveSehCriticalRuntime = () => {};
    d.validateReturnAddrFast = d.validateReturnAddr = () => true;
    const boundaries: Array<[ThunkBoundaryKind, number]> = [];
    d.ensureScheduler = () => ({isThreadExitId: () => false, getCurrentThreadId: () => 1,
        getCurrentThread: () => null, setLastError() {},
        onThunkBoundary: (_cpu: unknown, kind: ThunkBoundaryKind, bytes: number) => boundaries.push([kind, bytes])});
    d.namesTable[id] = "msvcrt:" + name; d.argCountsTable[id] = spec.params.length; d.stackCleanupTable[id] = 0;
    d.markHleRegistrationComplete();
    Mem.bind(() => mem);
    const crt: any = new Msvcrt();
    // Runtime allocation/data-export publication is unrelated to these calls. Keep the
    // production initialize/registration, formatter, readers and errno writer intact.
    crt.ensureRuntimeStorage = crt.registerDataExports = () => {};
    crt.errnoAddr = 0x10800;
    crt.initialize(process);
    d.dispatchTable[id] = crt.exports[name];
    expect(typeof d.dispatchTable[id]).toBe("function");
    let denied = -1, deniedRead = -1;
    let callArgs: number[] = [];
    const writes: number[] = [], reads: number[] = [];
    Mem.bind(() => mem, (address, size, perms) => {
        if (!perms.includes("w")) {
            reads.push(address);
            return address >= 0 && address + size <= mem.length && space.validateRange(address, size, perms) &&
                !(address <= deniedRead && deniedRead < address + size);
        }
        writes.push(address);
        return address >= 0 && address + size <= mem.length && space.validateRange(address, size, perms) &&
            !(address <= denied && denied < address + size);
    });
    function put(address: number, text: string): number {
        for (let i = 0; i <= text.length; i++) dv.setUint16(address + i * 2, i === text.length ? 0 : text.charCodeAt(i), true);
        return address;
    }
    return {mem, dv, cpu, d, esp, ret, retry, writes, reads, put,
        protect(address: number, size: number, perms: "r" | "noaccess") { expect(space.protect(address, size, perms)).toBe(true); },
        useProductionBinding() { Mem.bind(() => mem); },
        deny(address: number) { denied = address; },
        denyRead(address: number) { deniedRead = address; },
        call(args: number[]) {
            callArgs = args.slice();
            cpu.reg32[0] = id; cpu.reg32[4] = esp; cpu.instruction_pointer[0] = retry + 11;
            cpu.segment_offsets[4] = teb; cpu.flags[0] = 0x202;
            dv.setUint32(teb, frame, true); dv.setUint32(frame, 0xffffffff, true); dv.setUint32(frame + 4, 0x12000, true);
            dv.setUint32(esp, ret, true); args.forEach((value, i) => dv.setUint32(esp + 4 + i * 4, value, true));
            dv.setUint32(0x10800, 123, true);
            d._handlePortWriteSlow(id, true);
        },
        expectFault(address: number, access = "w") {
            expect(d.sehDispatchStack).toHaveLength(1);
            const state = d.sehDispatchStack[0], s = state.scratchAddr;
            expect(state.kind).toBe("hle-access");
            expect(state.access).toEqual({thunkEsp: esp, returnAddr: ret});
            expect(callArgs.map((_, i) => dv.getUint32(esp + 4 + i * 4, true))).toEqual(callArgs);
            expect(dv.getUint32(s, true)).toBe(0xc0000005);
            expect(dv.getUint32(s + 20, true)).toBe(access === "w" ? 1 : 0);
            expect(dv.getUint32(s + 24, true)).toBe(address);
            expect(dv.getUint32(s + L.CONTEXT + 0xb8, true)).toBe(retry);
            expect(dv.getUint32(s + L.CONTEXT + 0xc4, true)).toBe(esp);
            expect(dv.getUint32(esp, true)).toBe(d.sehDispatchStubAddress);
            expect(boundaries).toEqual([[ThunkBoundaryKind.CALLBACK_STUB, 0]]);
            expect(d.lastExpectedEspAfterReturn).toBe(0);
            expect(dv.getUint32(0x10800, true)).toBe(123);
        },
        expectReturn(value: number, errno = 123) {
            expect(d.sehDispatchStack).toHaveLength(0);
            expect(cpu.reg32[0] >>> 0).toBe(value >>> 0);
            expect(boundaries).toEqual([[ThunkBoundaryKind.THUNK_STUB, 0]]);
            expect(d.lastExpectedEspAfterReturn).toBe(esp + 4);
            expect(dv.getUint32(esp, true)).toBe(ret);
            expect(dv.getUint32(0x10800, true)).toBe(errno);
        },
        expectRetry() {
            const s = d.sehDispatchStack[0].scratchAddr;
            dv.setUint32(s + L.DISPATCH_RESULT, 0, true);
            cpu.reg32[4] = s - 0x10;
            d._handleSehDispatchResult(cpu);
            expect(d.sehDispatchStack).toHaveLength(0);
            expect(cpu.reg32[4]).toBe(esp - 4);
            expect(dv.getUint32(esp - 4, true)).toBe(retry);
            expect(dv.getUint32(esp, true)).toBe(ret);
            expect(callArgs.map((_, i) => dv.getUint32(esp + 4 + i * 4, true))).toEqual(callArgs);
        },
        restore() {
            system.process = originalProcess;
            for (const [k, desc] of savedMem) if (desc) Object.defineProperty(Mem, k, desc);
        },
    };
}
