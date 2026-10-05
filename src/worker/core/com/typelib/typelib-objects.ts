import { Process } from "../../process";
import { System } from "../../system";
import { ThunkImplementation } from "../../thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../logger";
import { Mem } from "../../memory/mem-accessor";
import { allocateComObject } from "../com-memory";
import { installComVtable, ComVtableMethod } from "../install-com-vtable";
import {
    TYPELIBATTR_SIZE,
    TYPEATTR_SIZE,
    TKIND_COCLASS,
    TypeLibDescriptor,
    TypeInfoDescriptor,
    normalizeGuid,
    readGuidFromMem,
    writeGuidToMem,
    SYS_WIN32,
} from "./typelib-types";
import { SUN_TYPELIB, matchSunTypeLibPath } from "./sun-tlb";

const S_OK = 0x00000000;
const E_POINTER = 0x80004003;
const E_NOINTERFACE = 0x80004002;
const E_INVALIDARG = 0x80070057;
const E_OUTOFMEMORY = 0x8007000e;
const TYPE_E_ELEMENTNOTFOUND = 0x8002802b;
const E_NOTIMPL = 0x80004001;

const IID_IUNKNOWN = "00000000-0000-0000-c000-000000000046";
const IID_ITYPELIB = "00020402-0000-0000-c000-000000000046";
const IID_ITYPEINFO = "00020401-0000-0000-c000-000000000046";

interface TypeLibState {
    refCount: number;
    descriptor: TypeLibDescriptor;
    libAttrAddr: number;
}

interface TypeInfoState {
    refCount: number;
    entry: TypeInfoDescriptor;
    libPtr: number;
    index: number;
    typeAttrAddr: number;
}

export class TypeLibRuntime {
    private process!: Process;
    private typeLibVtableAddr = 0;
    private typeInfoVtableAddr = 0;
    private typeLibInstances = new Map<number, TypeLibState>();
    private typeInfoInstances = new Map<number, TypeInfoState>();
    private descriptorsByPath = new Map<string, TypeLibDescriptor>();

    initialize(process: Process): void {
        this.process = process;
        this.descriptorsByPath.set(SUN_TYPELIB.path.toLowerCase(), SUN_TYPELIB);
        this.descriptorsByPath.set("sun.tlb", SUN_TYPELIB);
        this.recreateVTables(process);
    }

    reset(): void {
        this.typeLibInstances.clear();
        this.typeInfoInstances.clear();
        this.typeLibVtableAddr = 0;
        this.typeInfoVtableAddr = 0;
    }

    recreateVTables(process?: Process): void {
        if (process) this.process = process;
        this.reset();
        this.installTypeInfoVtable();
        this.installTypeLibVtable();
    }

    resolveDescriptor(path: string): TypeLibDescriptor | null {
        const key = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
        if (matchSunTypeLibPath(path)) return SUN_TYPELIB;
        return this.descriptorsByPath.get(key) ?? null;
    }

    resolveByLibId(libid: string): TypeLibDescriptor | null {
        const norm = normalizeGuid(libid);
        if (norm === normalizeGuid(SUN_TYPELIB.libid)) return SUN_TYPELIB;
        return null;
    }

    loadTypeLib(path: string, pptlib: number): number {
        const desc = this.resolveDescriptor(path);
        if (!desc) {
            Logger.warn(LogCategory.COM, `LoadTypeLib: unknown typelib "${path}"`);
            return TYPE_E_ELEMENTNOTFOUND;
        }
        return this.createTypeLib(desc, pptlib);
    }

    loadRegTypeLib(libidAddr: number, mem: Uint8Array, pptlib: number): number {
        const libid = readGuidFromMem(mem, libidAddr);
        const desc = this.resolveByLibId(libid);
        if (!desc) {
            Logger.warn(LogCategory.COM, `LoadRegTypeLib: unknown libid ${libid}`);
            return TYPE_E_ELEMENTNOTFOUND;
        }
        return this.createTypeLib(desc, pptlib);
    }

    registerTypeLib(thisPtr: number, fullPath: string): number {
        const state = this.typeLibInstances.get(thisPtr);
        if (!state) return E_INVALIDARG;
        const desc = state.descriptor;
        const libid = normalizeGuid(desc.libid);
        const ver = `${desc.versionMajor}.${desc.versionMinor}`;
        const store = System.getInstance().registry;
        if (!store) {
            Logger.verbose(LogCategory.COM, `RegisterTypeLib: no registry, accepted path="${fullPath}"`);
            return S_OK;
        }
        const basePath = `TypeLib\\{${libid}}\\${ver}\\0`;
        store.createKey("HKEY_CLASSES_ROOT", basePath);
        const key = store.createKey("HKEY_CLASSES_ROOT", basePath).key;
        store.setValue(key, "", { name: "", type: "REG_SZ", data: desc.name });
        store.setValue(key, "win32", { name: "win32", type: "REG_SZ", data: fullPath || desc.path });
        Logger.log(LogCategory.COM, `RegisterTypeLib: ${desc.name} -> HKCR\\${basePath}`);
        return S_OK;
    }

    private createTypeLib(desc: TypeLibDescriptor, pptlib: number): number {
        this.ensureVtablesLive();
        if (!this.typeLibVtableAddr) return E_OUTOFMEMORY;
        const process = this.process;
        const libAttrAddr = this.allocLibAttr(desc);
        const objAddr = allocateComObject(process.memory, process.getCurrentMemory(), this.typeLibVtableAddr);
        this.typeLibInstances.set(objAddr, { refCount: 1, descriptor: desc, libAttrAddr });
        Mem.writeUint32(pptlib, objAddr);
        Logger.log(
            LogCategory.COM,
            `LoadTypeLib: obj=0x${objAddr.toString(16)} types=${desc.types.length} libid={${desc.libid}}`
        );
        return S_OK;
    }

    private allocLibAttr(desc: TypeLibDescriptor): number {
        const addr = this.process.memory.alloc(TYPELIBATTR_SIZE, "THUNK_DATA", "rw");
        const mem = this.process.getCurrentMemory();
        mem.fill(0, addr, addr + TYPELIBATTR_SIZE);
        writeGuidToMem(mem, addr, desc.libid);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(addr + 16, desc.lcid, true);
        view.setUint32(addr + 20, SYS_WIN32, true);
        view.setUint16(addr + 24, desc.versionMajor, true);
        view.setUint16(addr + 26, desc.versionMinor, true);
        view.setUint16(addr + 28, 0, true);
        return addr;
    }

    private allocTypeAttr(entry: TypeInfoDescriptor): number {
        const addr = this.process.memory.alloc(TYPEATTR_SIZE, "THUNK_DATA", "rw");
        const mem = this.process.getCurrentMemory();
        mem.fill(0, addr, addr + TYPEATTR_SIZE);
        writeGuidToMem(mem, addr, entry.guid);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(addr + 16, SUN_TYPELIB.lcid, true);
        view.setUint32(addr + 32, entry.kind, true);
        view.setUint16(addr + 36, 0, true);
        view.setUint16(addr + 38, 0, true);
        view.setUint16(addr + 40, entry.kind === TKIND_COCLASS ? 1 : 0, true);
        return addr;
    }

    private createTypeInfo(entry: TypeInfoDescriptor, libPtr: number, index: number): number {
        this.ensureVtablesLive();
        if (!this.typeInfoVtableAddr) return 0;
        const typeAttrAddr = this.allocTypeAttr(entry);
        const objAddr = allocateComObject(
            this.process.memory,
            this.process.getCurrentMemory(),
            this.typeInfoVtableAddr
        );
        this.typeInfoInstances.set(objAddr, { refCount: 1, entry, libPtr, index, typeAttrAddr });
        return objAddr;
    }

    private getTypeLibState(thisPtr: number) {
        return this.typeLibInstances.get(thisPtr >>> 0);
    }

    private getTypeInfoState(thisPtr: number) {
        return this.typeInfoInstances.get(thisPtr >>> 0);
    }

    private findTypeByGuid(desc: TypeLibDescriptor, guid: string): TypeInfoDescriptor | null {
        const norm = normalizeGuid(guid);
        return desc.types.find((t) => normalizeGuid(t.guid) === norm) ?? null;
    }

    private nullOutPtr(mem: Uint8Array, ptr: number) {
        if (ptr) Mem.writeUint32(ptr, 0);
    }

    private isVtableLive(vtableAddr: number): boolean {
        if (!vtableAddr) return false;
        for (let i = 0; i < 3; i++) {
            const slot = Mem.readUint32(vtableAddr + i * 4);
            if (!slot) return false;
        }
        return true;
    }

    private ensureVtablesLive(): void {
        if (this.isVtableLive(this.typeInfoVtableAddr) && this.isVtableLive(this.typeLibVtableAddr)) {
            return;
        }

        if (this.typeInfoVtableAddr || this.typeLibVtableAddr) {
            Logger.warn(
                LogCategory.COM,
                `TypeLibRuntime: vtable memory was cleared, recreating TypeInfo/TypeLib vtables`
            );
        }

        this.recreateVTables();
    }

    private installTypeLibVtable(): void {
        if (this.typeLibVtableAddr) return;
        const self = this;

        const qi: ThunkImplementation = (_ctx, mem, args) => {
            const thisPtr = args[0] >>> 0;
            const riid = args[1] >>> 0;
            const ppv = args[2] >>> 0;
            if (!ppv || !riid || riid + 16 > mem.length) return E_POINTER;
            if (!self.getTypeLibState(thisPtr)) return 0x80004005;
            const iid = normalizeGuid(readGuidFromMem(mem, riid));
            if (iid === IID_IUNKNOWN || iid === IID_ITYPELIB) {
                const state = self.getTypeLibState(thisPtr)!;
                state.refCount++;
                Mem.writeUint32(ppv, thisPtr);
                return S_OK;
            }
            Mem.writeUint32(ppv, 0);
            return E_NOINTERFACE;
        };

        const addRef: ThunkImplementation = (_ctx, _mem, args) => {
            const state = self.getTypeLibState(args[0]);
            if (!state) return 0;
            return ++state.refCount;
        };

        const release: ThunkImplementation = (_ctx, _mem, args) => {
            const thisPtr = args[0] >>> 0;
            const state = self.getTypeLibState(thisPtr);
            if (!state) return 0;
            state.refCount--;
            if (state.refCount <= 0) self.typeLibInstances.delete(thisPtr);
            return Math.max(state.refCount, 0);
        };

        const getTypeInfoCount: ThunkImplementation = (_ctx, _mem, args) => {
            const thisPtr = args[0] >>> 0;
            const state = self.getTypeLibState(thisPtr);
            return state ? state.descriptor.types.length : 0;
        };

        const getTypeInfo: ThunkImplementation = (_ctx, _mem, args) => {
            const thisPtr = args[0] >>> 0;
            const index = args[1] >>> 0;
            const pptinfo = args[2] >>> 0;
            const state = self.getTypeLibState(thisPtr);
            if (!state) return 0x80004005;
            if (!pptinfo) return E_POINTER;
            if (index >= state.descriptor.types.length) {
                Mem.writeUint32(pptinfo, 0);
                return TYPE_E_ELEMENTNOTFOUND;
            }
            const ti = self.createTypeInfo(state.descriptor.types[index], thisPtr, index);
            Mem.writeUint32(pptinfo, ti);
            return S_OK;
        };

        const getTypeInfoType: ThunkImplementation = (_ctx, _mem, args) => {
            const thisPtr = args[0] >>> 0;
            const index = args[1] >>> 0;
            const ptypekind = args[2] >>> 0;
            const state = self.getTypeLibState(thisPtr);
            if (!state) return 0x80004005;
            if (!ptypekind) return E_POINTER;
            if (index >= state.descriptor.types.length) return TYPE_E_ELEMENTNOTFOUND;
            Mem.writeUint32(ptypekind, state.descriptor.types[index].kind);
            return S_OK;
        };

        const getTypeInfoOfGuid: ThunkImplementation = (_ctx, mem, args) => {
            const thisPtr = args[0] >>> 0;
            const guidAddr = args[1] >>> 0;
            const pptinfo = args[2] >>> 0;
            const state = self.getTypeLibState(thisPtr);
            if (!state) return 0x80004005;
            if (!pptinfo || !guidAddr) return E_POINTER;
            const entry = self.findTypeByGuid(state.descriptor, readGuidFromMem(mem, guidAddr));
            if (!entry) {
                Mem.writeUint32(pptinfo, 0);
                return TYPE_E_ELEMENTNOTFOUND;
            }
            const index = state.descriptor.types.indexOf(entry);
            const ti = self.createTypeInfo(entry, thisPtr, index);
            Mem.writeUint32(pptinfo, ti);
            return S_OK;
        };

        const getLibAttr: ThunkImplementation = (_ctx, _mem, args) => {
            const thisPtr = args[0] >>> 0;
            const ppTLibAttr = args[1] >>> 0;
            const state = self.getTypeLibState(thisPtr);
            if (!state) return 0x80004005;
            if (!ppTLibAttr) return E_POINTER;
            Mem.writeUint32(ppTLibAttr, state.libAttrAddr);
            return S_OK;
        };

        const getTypeComp: ThunkImplementation = (_ctx, mem, args) => {
            self.nullOutPtr(mem, args[1] >>> 0);
            return E_NOTIMPL;
        };

        const getDocumentation: ThunkImplementation = (_ctx, mem, args) => {
            const thisPtr = args[0] >>> 0;
            const index = args[1] >>> 0;
            const state = self.getTypeLibState(thisPtr);
            if (!state) return 0x80004005;
            if (index >= state.descriptor.types.length) return TYPE_E_ELEMENTNOTFOUND;
            const entry = state.descriptor.types[index];
            const writeBstr = (ptr: number, text: string) => {
                if (!ptr) return;
                const wide = new Uint8Array((text.length + 1) * 2);
                for (let i = 0; i < text.length; i++) {
                    wide[i * 2] = text.charCodeAt(i) & 0xff;
                    wide[i * 2 + 1] = (text.charCodeAt(i) >> 8) & 0xff;
                }
                const block = self.process.memory.alloc(4 + wide.length, "THUNK_DATA");
                const m = self.process.getCurrentMemory();
                const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
                v.setUint32(block, text.length * 2, true);
                m.set(wide, block + 4);
                Mem.writeUint32(ptr, block + 4);
            };
            writeBstr(args[2] >>> 0, entry.name);
            writeBstr(args[3] >>> 0, entry.docString ?? entry.name);
            Mem.writeUint32(args[4] >>> 0, entry.helpContext ?? 0);
            self.nullOutPtr(mem, args[5] >>> 0);
            return S_OK;
        };

        const isName: ThunkImplementation = (_ctx, mem, args) => {
            const thisPtr = args[0] >>> 0;
            const nameAddr = args[1] >>> 0;
            const pfName = args[3] >>> 0;
            const state = self.getTypeLibState(thisPtr);
            if (!state) return 0x80004005;
            if (!pfName) return E_POINTER;
            let name = "";
            if (nameAddr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                for (let p = nameAddr; p + 1 < mem.length; p += 2) {
                    const ch = view.getUint16(p, true);
                    if (ch === 0) break;
                    name += String.fromCharCode(ch);
                }
            }
            const found = state.descriptor.types.findIndex(
                (t) => t.name.toLowerCase() === name.toLowerCase()
            );
            Mem.writeUint32(pfName, found >= 0 ? 1 : 0);
            return S_OK;
        };

        const findName: ThunkImplementation = (_ctx, mem, args) => {
            const thisPtr = args[0] >>> 0;
            const nameAddr = args[1] >>> 0;
            const ppTInfo = args[3] >>> 0;
            const rgMemId = args[4] >>> 0;
            const pcFound = args[5] >>> 0;
            const state = self.getTypeLibState(thisPtr);
            if (!state) return 0x80004005;
            if (!ppTInfo || !pcFound) return E_POINTER;
            let name = "";
            if (nameAddr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                for (let p = nameAddr; p + 1 < mem.length; p += 2) {
                    const ch = view.getUint16(p, true);
                    if (ch === 0) break;
                    name += String.fromCharCode(ch);
                }
            }
            const found = state.descriptor.types.findIndex(
                (t) => t.name.toLowerCase().startsWith(name.toLowerCase())
            );
            if (found >= 0 && ppTInfo) {
                const ti = self.createTypeInfo(state.descriptor.types[found], thisPtr, found);
                Mem.writeUint32(ppTInfo, ti);
                if (rgMemId) Mem.writeUint32(rgMemId, 0xffffffff);
                Mem.writeUint16(pcFound, 1);
            } else if (ppTInfo) {
                Mem.writeUint32(ppTInfo, 0);
                Mem.writeUint16(pcFound, 0);
            }
            return found >= 0 ? S_OK : TYPE_E_ELEMENTNOTFOUND;
        };

        const releaseTLibAttr: ThunkImplementation = () => S_OK;

        const handlers: Record<string, ThunkImplementation> = {
            TL_QueryInterface: qi,
            TL_AddRef: addRef,
            TL_Release: release,
            TL_GetTypeInfoCount: getTypeInfoCount,
            TL_GetTypeInfo: getTypeInfo,
            TL_GetTypeInfoType: getTypeInfoType,
            TL_GetTypeInfoOfGuid: getTypeInfoOfGuid,
            TL_GetLibAttr: getLibAttr,
            TL_GetTypeComp: getTypeComp,
            TL_GetDocumentation: getDocumentation,
            TL_IsName: isName,
            TL_FindName: findName,
            TL_ReleaseTLibAttr: releaseTLibAttr,
        };

        const methods: ComVtableMethod[] = [
            { name: "TL_QueryInterface", argCount: 3, stackCleanupBytes: 12 },
            { name: "TL_AddRef", argCount: 1, stackCleanupBytes: 4 },
            { name: "TL_Release", argCount: 1, stackCleanupBytes: 4 },
            { name: "TL_GetTypeInfoCount", argCount: 1, stackCleanupBytes: 4 },
            { name: "TL_GetTypeInfo", argCount: 3, stackCleanupBytes: 12 },
            { name: "TL_GetTypeInfoType", argCount: 3, stackCleanupBytes: 12 },
            { name: "TL_GetTypeInfoOfGuid", argCount: 3, stackCleanupBytes: 12 },
            { name: "TL_GetLibAttr", argCount: 2, stackCleanupBytes: 8 },
            { name: "TL_GetTypeComp", argCount: 2, stackCleanupBytes: 8 },
            { name: "TL_GetDocumentation", argCount: 6, stackCleanupBytes: 24 },
            { name: "TL_IsName", argCount: 4, stackCleanupBytes: 16 },
            { name: "TL_FindName", argCount: 6, stackCleanupBytes: 24 },
            { name: "TL_ReleaseTLibAttr", argCount: 2, stackCleanupBytes: 8 },
        ];

        const installed = installComVtable(this.process, {
            moduleName: "oleaut32_typelib",
            methods,
            handlers,
            logLabel: "TypeLib",
        });
        if (installed) this.typeLibVtableAddr = installed.vtableAddr;
    }

    private installTypeInfoVtable(): void {
        if (this.typeInfoVtableAddr) return;
        const self = this;

        const qi: ThunkImplementation = (_ctx, mem, args) => {
            const thisPtr = args[0] >>> 0;
            const riid = args[1] >>> 0;
            const ppv = args[2] >>> 0;
            if (!ppv || !riid || riid + 16 > mem.length) return E_POINTER;
            if (!self.getTypeInfoState(thisPtr)) return 0x80004005;
            const iid = normalizeGuid(readGuidFromMem(mem, riid));
            if (iid === IID_IUNKNOWN || iid === IID_ITYPEINFO) {
                const state = self.getTypeInfoState(thisPtr)!;
                state.refCount++;
                Mem.writeUint32(ppv, thisPtr);
                return S_OK;
            }
            Mem.writeUint32(ppv, 0);
            return E_NOINTERFACE;
        };

        const addRef: ThunkImplementation = (_ctx, _mem, args) => {
            const state = self.getTypeInfoState(args[0]);
            if (!state) return 0;
            return ++state.refCount;
        };

        const release: ThunkImplementation = (_ctx, _mem, args) => {
            const thisPtr = args[0] >>> 0;
            const state = self.getTypeInfoState(thisPtr);
            if (!state) return 0;
            state.refCount--;
            if (state.refCount <= 0) self.typeInfoInstances.delete(thisPtr);
            return Math.max(state.refCount, 0);
        };

        const getTypeAttr: ThunkImplementation = (_ctx, _mem, args) => {
            const thisPtr = args[0] >>> 0;
            const ppTypeAttr = args[1] >>> 0;
            const state = self.getTypeInfoState(thisPtr);
            if (!state) return 0x80004005;
            if (!ppTypeAttr) return E_POINTER;
            Mem.writeUint32(ppTypeAttr, state.typeAttrAddr);
            return S_OK;
        };

        const releaseTypeAttr: ThunkImplementation = () => S_OK;

        const getContainingTypeLib: ThunkImplementation = (_ctx, _mem, args) => {
            const thisPtr = args[0] >>> 0;
            const state = self.getTypeInfoState(thisPtr);
            if (!state) return 0x80004005;
            const ppTLib = args[1] >>> 0;
            const pIndex = args[2] >>> 0;
            if (!ppTLib || !pIndex) return E_POINTER;
            const libState = self.getTypeLibState(state.libPtr);
            if (libState) libState.refCount++;
            Mem.writeUint32(ppTLib, state.libPtr);
            Mem.writeUint32(pIndex, state.index);
            return S_OK;
        };

        const notImpl: ThunkImplementation = () => E_NOTIMPL;

        const handlers: Record<string, ThunkImplementation> = {
            TI_QueryInterface: qi,
            TI_AddRef: addRef,
            TI_Release: release,
            TI_GetTypeAttr: getTypeAttr,
            TI_GetTypeComp: notImpl,
            TI_GetFuncDesc: notImpl,
            TI_GetVarDesc: notImpl,
            TI_GetNames: notImpl,
            TI_GetRefTypeOfImplType: notImpl,
            TI_GetImplTypeFlags: notImpl,
            TI_GetIDsOfNames: notImpl,
            TI_Invoke: notImpl,
            TI_GetDocumentation: notImpl,
            TI_GetDllEntry: notImpl,
            TI_GetRefTypeInfo: notImpl,
            TI_AddressOfMember: notImpl,
            TI_CreateInstance: notImpl,
            TI_GetMops: notImpl,
            TI_GetContainingTypeLib: getContainingTypeLib,
            TI_ReleaseTypeAttr: releaseTypeAttr,
            TI_ReleaseFuncDesc: notImpl,
            TI_ReleaseVarDesc: notImpl,
        };

        const methods: ComVtableMethod[] = [
            { name: "TI_QueryInterface", argCount: 3, stackCleanupBytes: 12 },
            { name: "TI_AddRef", argCount: 1, stackCleanupBytes: 4 },
            { name: "TI_Release", argCount: 1, stackCleanupBytes: 4 },
            { name: "TI_GetTypeAttr", argCount: 2, stackCleanupBytes: 8 },
            { name: "TI_GetTypeComp", argCount: 2, stackCleanupBytes: 8 },
            { name: "TI_GetFuncDesc", argCount: 3, stackCleanupBytes: 12 },
            { name: "TI_GetVarDesc", argCount: 3, stackCleanupBytes: 12 },
            { name: "TI_GetNames", argCount: 5, stackCleanupBytes: 20 },
            { name: "TI_GetRefTypeOfImplType", argCount: 3, stackCleanupBytes: 12 },
            { name: "TI_GetImplTypeFlags", argCount: 3, stackCleanupBytes: 12 },
            { name: "TI_GetIDsOfNames", argCount: 4, stackCleanupBytes: 16 },
            { name: "TI_Invoke", argCount: 8, stackCleanupBytes: 32 },
            { name: "TI_GetDocumentation", argCount: 6, stackCleanupBytes: 24 },
            { name: "TI_GetDllEntry", argCount: 6, stackCleanupBytes: 24 },
            { name: "TI_GetRefTypeInfo", argCount: 3, stackCleanupBytes: 12 },
            { name: "TI_AddressOfMember", argCount: 4, stackCleanupBytes: 16 },
            { name: "TI_CreateInstance", argCount: 4, stackCleanupBytes: 16 },
            { name: "TI_GetMops", argCount: 3, stackCleanupBytes: 12 },
            { name: "TI_GetContainingTypeLib", argCount: 3, stackCleanupBytes: 12 },
            { name: "TI_ReleaseTypeAttr", argCount: 2, stackCleanupBytes: 8 },
            { name: "TI_ReleaseFuncDesc", argCount: 2, stackCleanupBytes: 8 },
            { name: "TI_ReleaseVarDesc", argCount: 2, stackCleanupBytes: 8 },
        ];

        const installed = installComVtable(this.process, {
            moduleName: "oleaut32_typeinfo",
            methods,
            handlers,
            logLabel: "TypeInfo",
        });
        if (installed) this.typeInfoVtableAddr = installed.vtableAddr;
    }
}
