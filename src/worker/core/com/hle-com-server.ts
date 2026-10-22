import type { Process } from '../process';
import type { ThunkImplementation, X86Context } from '../thunking/thunk-dispatcher';
import type { ModuleDescriptor } from '../../api/types';
import type { VTableInfo } from '../../api/adapters/module-adapter';
import { BaseComObject, ComObjectFactory } from './base-com-object';
import { allocateComObject, comVtableOwner } from './com-memory';
import { SystemResourceProvider } from '../resources/system-resource-provider';
import { Mem } from '../memory/mem-accessor';
import { readGuidFromMem } from './typelib/typelib-types';
import { registerHleComServer, lookupHleComClass } from './hle-com-registry';

const UNKNOWN = '00000000-0000-0000-c000-000000000046';
const FACTORY = '00000001-0000-0000-c000-000000000046';
const E_POINTER = 0x80004003, E_NOINTERFACE = 0x80004002, E_OUTOFMEMORY = 0x8007000e;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111, CLASS_E_NOAGGREGATION = 0x80040110;
export interface HleComClass {
    clsid: string;
    /** First interface supplies the class's initial object implementation. */
    interfaces: readonly string[];
    /** Some legacy implementations leave CreateInstance's output untouched on failure. */
    clearCreateOutputOnFailure?: boolean;
}
class HleClassFactory extends BaseComObject {
    constructor(table: number, readonly server: HleComServer, readonly definition: HleComClass) { super(FACTORY, table); }
    protected destroy(): void {}
}
/** Standard in-process COM class factories backed by an HLE module's real objects. */
export class HleComServer {
    private locks = 0;
    private implementations: Partial<Record<string, ThunkImplementation>> = {};
    static lookup(process: Process, clsid: string) { return lookupHleComClass(process, clsid); }
    constructor(readonly process: Process, readonly descriptor: ModuleDescriptor,
        readonly tables: () => Record<string, VTableInfo>, readonly classes: readonly HleComClass[]) {
        registerHleComServer(process, this, classes);
    }
    reset(): void { this.locks = 0; }
    private valid(address: number, size: number, perms: 'r' | 'rw' = 'r'): boolean {
        return Number.isInteger(address) && address > 0 && this.process.addressSpace.validateRange(address, size, perms);
    }
    private guid(address: number): string | null {
        return this.valid(address, 16) ? readGuidFromMem(this.process.getCurrentMemory(), address) : null;
    }
    private factory(address: number): HleClassFactory | null {
        const object = SystemResourceProvider.getInstance().getComObjectByAddress(address);
        return object instanceof HleClassFactory && object.server === this ? object : null;
    }
    private allocate(object: BaseComObject, table: number): number {
        try {
            const memory = this.process.getCurrentMemory();
            const address = allocateComObject(this.process.memory, memory, table);
            SystemResourceProvider.getInstance().mapAddressToHandle(address, object.handle);
            return address;
        } catch { object.release(); return 0; }
    }
    create(definition: HleComClass, outer: number, iidAddress: number, out: number, context: X86Context): number {
        if (!this.valid(out, 4, 'rw')) return E_POINTER;
        if (definition.clearCreateOutputOnFailure !== false) Mem.writeUint32(out, 0);
        if (outer) return CLASS_E_NOAGGREGATION;
        const iid = this.guid(iidAddress); if (!iid) return E_POINTER;
        const supported = definition.interfaces.map(name => this.descriptor.interfaces?.find(iface => iface.name === name));
        const iface = iid === UNKNOWN ? supported[0] : supported.find(iface => iface?.iid?.toLowerCase() === iid);
        if (!iface?.iid) return E_NOINTERFACE;
        const table = this.tables()[iface.name]?.address;
        if (!table) return CLASS_E_CLASSNOTAVAILABLE;
        const object = ComObjectFactory.create(iface.iid, table);
        if (!object) return E_OUTOFMEMORY;
        const address = this.allocate(object, table); if (!address) return E_OUTOFMEMORY;
        if (iid !== UNKNOWN) { Mem.writeUint32(out, address); return 0; }
        const query = this.implementations[iface.name + '_QueryInterface'];
        let hr: number;
        try {
            const result = query ? query(context, this.process.getCurrentMemory(), [address, iidAddress, out]) :
                object.queryInterface(UNKNOWN, out, this.process.getCurrentMemory());
            hr = typeof result === 'number' ? result >>> 0 : E_NOINTERFACE;
        } catch { hr = E_OUTOFMEMORY; }
        // QueryInterface owns the returned reference; drop the constructor's initial one.
        const release = this.implementations[iface.name + '_Release'];
        if (release) release(context, this.process.getCurrentMemory(), [address]); else object.release();
        if (hr && definition.clearCreateOutputOnFailure !== false) Mem.writeUint32(out, 0);
        return hr;
    }
    getClassObject(context: X86Context, classAddress: number, iidAddress: number, out: number): number {
        const get = this.implementations.DllGetClassObject;
        if (!get) return CLASS_E_CLASSNOTAVAILABLE;
        const result = get(context, this.process.getCurrentMemory(), [classAddress, iidAddress, out]);
        return typeof result === 'number' ? result : CLASS_E_CLASSNOTAVAILABLE;
    }
    install(exports: Record<string, ThunkImplementation>): void {
        this.implementations = exports;
        exports.DllGetClassObject = (_ctx, _mem, args) => {
            const [classAddress, iidAddress, out] = args.map(value => value >>> 0);
            if (!this.valid(out, 4, 'rw')) return E_POINTER;
            Mem.writeUint32(out, 0);
            const clsid = this.guid(classAddress), iid = this.guid(iidAddress);
            if (!clsid || !iid) return E_POINTER;
            const definition = this.classes.find(item => item.clsid === clsid);
            if (!definition) return CLASS_E_CLASSNOTAVAILABLE;
            if (iid !== FACTORY && iid !== UNKNOWN) return E_NOINTERFACE;
            const table = this.tables().IClassFactory?.address;
            if (!table) return CLASS_E_CLASSNOTAVAILABLE;
            const address = this.allocate(new HleClassFactory(table, this, definition), table);
            if (!address) return E_OUTOFMEMORY;
            Mem.writeUint32(out, address); return 0;
        };
        exports.DllCanUnloadNow = () => this.locks !== 0 || SystemResourceProvider.getInstance().getAllComObjects()
            .some(object => comVtableOwner(object.vtableAddress) === this.descriptor.name) ? 1 : 0;
        exports.IClassFactory_QueryInterface = (_ctx, _mem, args) => {
            const [self, iidAddress, out] = args.map(value => value >>> 0);
            if (!this.valid(out, 4, 'rw')) return E_POINTER;
            Mem.writeUint32(out, 0);
            const object = this.factory(self), iid = this.guid(iidAddress);
            if (!iid) return E_POINTER;
            if (!object || (iid !== FACTORY && iid !== UNKNOWN)) return E_NOINTERFACE;
            object.addRef(); Mem.writeUint32(out, self); return 0;
        };
        exports.IClassFactory_AddRef = (_ctx, _mem, args) => this.factory(args[0] >>> 0)?.addRef() ?? 0;
        exports.IClassFactory_Release = (_ctx, _mem, args) => this.factory(args[0] >>> 0)?.release() ?? 0;
        exports.IClassFactory_CreateInstance = (ctx, _mem, args) => {
            const object = this.factory(args[0] >>> 0);
            return object ? this.create(object.definition, args[1] >>> 0, args[2] >>> 0, args[3] >>> 0, ctx) : E_NOINTERFACE;
        };
        exports.IClassFactory_LockServer = (_ctx, _mem, args) => {
            if (!this.factory(args[0] >>> 0)) return E_NOINTERFACE;
            this.locks += args[1] ? 1 : -1; return 0;
        };
    }
}
