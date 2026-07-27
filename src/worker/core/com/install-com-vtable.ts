import { Process } from "../process";
import { ThunkImplementation } from "../thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../logger";
import { Mem } from "../memory/mem-accessor";
import { verifyComVtableSlot } from "./com-memory";
import { writeGuestCode } from "../memory/guest-code";

export interface ComVtableMethod {
    name: string;
    argCount?: number;
    stackCleanupBytes: number;
    callingConvention?: string;
}

export interface InstallComVtableOptions {
    moduleName: string;
    methods: ComVtableMethod[];
    handlers: Record<string, ThunkImplementation>;
    logLabel?: string;
}

export interface InstalledComVtable {
    vtableAddr: number;
    stubBase: number;
    exportTable: Map<string, number>;
}

/**
 * Install COM interface stubs in THUNK_CODE and vtable pointer array in THUNK_DATA.
 */
export function installComVtable(process: Process, options: InstallComVtableOptions): InstalledComVtable | null {
    const { moduleName, methods, handlers, logLabel = moduleName } = options;
    const tg = process.thunkGenerator;

    process.dispatcher.registerModule(moduleName, handlers);

    const stubDll = tg.generateStubDll(
        moduleName,
        methods.map((m) => ({
            name: m.name,
            argCount: m.argCount,
            stackCleanupBytes: m.stackCleanupBytes,
            callingConvention: m.callingConvention ?? "stdcall",
        }))
    );

    if (stubDll.stubCode.length === 0) {
        Logger.error(LogCategory.COM, `${logLabel}: stub batch empty`);
        return null;
    }

    const stubBase = stubDll.baseAddress;
    try {
        process.memory.allocAt(stubBase, stubDll.stubCode.length, "THUNK_CODE", "rx");
    } catch {
        // Already reserved — PE loader or prior batch
    }

    let mem = process.getCurrentMemory();
    if (stubBase + stubDll.stubCode.length > mem.length) {
        Logger.error(LogCategory.COM, `${logLabel}: stub write OOB stubBase=0x${stubBase.toString(16)} len=${stubDll.stubCode.length}`);
        return null;
    }
    writeGuestCode(mem, stubDll.stubCode, stubBase);

    const vtableAddr = process.memory.alloc(methods.length * 4, "THUNK_DATA", "rw");
    mem = process.getCurrentMemory();

    for (let i = 0; i < methods.length; i++) {
        const key = methods[i].name.toLowerCase();
        const stubAddr = stubDll.exportTable.get(key);
        if (stubAddr === undefined) {
            Logger.error(LogCategory.COM, `${logLabel}: missing stub export ${methods[i].name}`);
            return null;
        }
        Mem.writeUint32(vtableAddr + i * 4, stubAddr);
        if (!verifyComVtableSlot(mem, stubAddr)) {
            Logger.error(
                LogCategory.COM,
                `${logLabel}: invalid stub at slot ${i} (${methods[i].name}) addr=0x${stubAddr.toString(16)} byte=0x${mem[stubAddr]?.toString(16) ?? "??"}`
            );
            return null;
        }
    }

    process.dispatcher.applyPendingRegistrations();

    const releaseAddr = stubDll.exportTable.get(
        methods.find((m) => m.name.toLowerCase().includes("release") && !m.name.toLowerCase().includes("tlibattr") && !m.name.toLowerCase().includes("typeattr"))?.name.toLowerCase()
        ?? methods[2]?.name.toLowerCase()
        ?? ""
    );
    Logger.log(
        LogCategory.COM,
        `${logLabel}: vtable at 0x${vtableAddr.toString(16)}, stubs at 0x${stubBase.toString(16)}, Release=0x${(releaseAddr ?? 0).toString(16)}`
    );

    return { vtableAddr, stubBase, exportTable: stubDll.exportTable };
}
