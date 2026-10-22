import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { HleComServer } from '../../src/worker/core/com/hle-com-server';
import { BaseComObject, ComObjectFactory } from '../../src/worker/core/com/base-com-object';
import { registerComVtableOwner } from '../../src/worker/core/com/com-memory';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { guidBytes } from '../../src/worker/modules/dpnet/constants';
import type { Process } from '../../src/worker/core/process';
import type { ModuleDescriptor } from '../../src/worker/api/types';
import type { VTableInfo } from '../../src/worker/api/adapters/module-adapter';
import type { ThunkImplementation, X86Context } from '../../src/worker/core/thunking/thunk-dispatcher';

const system = System.getInstance(), resources = system.resourceProvider, saved = system.process;
const CLSID = 'e91b4460-b268-4ab7-8cad-4dd65be93101', IID = 'e91b4460-b268-4ab7-8cad-4dd65be93102';
const UNKNOWN = '00000000-0000-0000-c000-000000000046', FACTORY = '00000001-0000-0000-c000-000000000046';
let ram: Uint8Array, owner: Process, methods: Record<string, ThunkImplementation>, objects: Set<number>, server: HleComServer;
const call = (name: string, args: number[] = []) => methods[name]({} as X86Context, ram, args) as number;
const factory = () => { expect(call('DllGetClassObject', [0x1000, 0x1020, 0x1100])).toBe(0); return Mem.readUint32(0x1100); };
beforeEach(() => {
    ram = new Uint8Array(2 * 1024 * 1024); Mem.bind(() => ram); let next = 0x100000;
    objects = new Set(resources.getAllComObjects().map(o => o.handle));
    const alloc = (size: number) => { const result = next; next += (size + 15) & ~15; return result; };
    owner = { memory: { allocSystemBlock: alloc, freeSystemBlock() {} }, getCurrentMemory: () => ram,
        addressSpace: { validateRange: (p: number, n: number) => p >= 0x1000 && p + n <= ram.length } } as unknown as Process;
    system.process = owner;
    const descriptor = { name: 'com-factory-test', functions: [], interfaces: [{ name: 'TestObject', iid: IID, methods: [] }] } as ModuleDescriptor;
    const tables = { IClassFactory: { address: 0x6000, size: 5 }, TestObject: { address: 0x6100, size: 3 } } as Record<string, VTableInfo>;
    for (const table of Object.values(tables)) registerComVtableOwner(table.address, descriptor.name);
    ComObjectFactory.register(IID, class TestObject extends BaseComObject {
        constructor(table: number) { super(IID, table); } protected destroy() {}
    });
    server = new HleComServer(owner, descriptor, () => tables, [{ clsid: CLSID, interfaces: ['TestObject'] }]);
    methods = {}; server.install(methods);
    ram.set(guidBytes(CLSID), 0x1000); ram.set(guidBytes(FACTORY), 0x1020); ram.set(guidBytes(IID), 0x1040); ram.set(guidBytes(UNKNOWN), 0x1060);
});
afterEach(() => {
    for (const object of resources.getAllComObjects()) if (!objects.has(object.handle)) object.forceRelease();
    system.process = saved;
});
test('class factory identity and object references keep the owning DLL loaded', () => {
    expect(call('DllCanUnloadNow')).toBe(0); const f = factory();
    expect(call('DllCanUnloadNow')).toBe(1);
    expect(call('IClassFactory_QueryInterface', [f, 0x1060, 0x1104])).toBe(0);
    expect(Mem.readUint32(0x1104)).toBe(f); expect(call('IClassFactory_Release', [f])).toBe(1);
    expect(call('IClassFactory_CreateInstance', [f, 0, 0x1040, 0x1108])).toBe(0);
    const object = resources.getComObjectByAddress(Mem.readUint32(0x1108))!;
    expect(object.iid).toBe(IID); expect(Mem.readUint32(Mem.readUint32(0x1108))).toBe(0x6100);
    expect(call('IClassFactory_Release', [f])).toBe(0); expect(call('DllCanUnloadNow')).toBe(1);
    object.release(); expect(call('DllCanUnloadNow')).toBe(0);
});
test('LockServer survives factory release and factory failure respects each native output policy', () => {
    const f = factory(); expect(call('IClassFactory_LockServer', [f, 1])).toBe(0);
    call('IClassFactory_Release', [f]); expect(call('DllCanUnloadNow')).toBe(1);
    const f2 = factory(); call('IClassFactory_LockServer', [f2, 0]);
    Mem.writeUint32(0x1108, 0xfeed); expect(call('IClassFactory_CreateInstance', [f2, 1, 0x1040, 0x1108])).toBe(0x80040110);
    expect(Mem.readUint32(0x1108)).toBe(0);
    Mem.writeUint32(0x1108, 0xfeed);
    expect(server.create({ clsid: CLSID, interfaces: ['TestObject'], clearCreateOutputOnFailure: false }, 1, 0x1040, 0x1108, {} as X86Context)).toBe(0x80040110);
    expect(Mem.readUint32(0x1108)).toBe(0xfeed);
    call('IClassFactory_Release', [f2]); expect(call('DllCanUnloadNow')).toBe(0);
});
test('bad GUIDs and output pointers never allocate or overwrite outside a validated range', () => {
    ram.fill(0xcc, 0x1100, 0x1110);
    expect(call('DllGetClassObject', [0x1000, 0x1020, ram.length - 2])).toBe(0x80004003);
    expect(Mem.readUint32(0x1100)).toBe(0xcccccccc);
    expect(call('DllGetClassObject', [ram.length - 8, 0x1020, 0x1100])).toBe(0x80004003);
    expect(Mem.readUint32(0x1100)).toBe(0);
    expect(call('DllGetClassObject', [0x1040, 0x1020, 0x1100])).toBe(0x80040111);
    expect(call('DllGetClassObject', [0x1000, 0x1040, 0x1100])).toBe(0x80004002);
    expect(call('DllCanUnloadNow')).toBe(0);
});

test('CreateInstance for IUnknown selects the implementation controlling unknown and transfers one reference', () => {
    const f = factory(); let queries = 0, releases = 0, canonical = 0;
    methods.TestObject_QueryInterface = (_ctx, _mem, args) => {
        queries++;
        const object = resources.getComObjectByAddress(args[0])!;
        if (!canonical) {
            canonical = owner.memory.allocSystemBlock(16);
            Mem.writeUint32(canonical, object.vtableAddress);
            resources.mapAddressToHandle(canonical, object.handle);
        }
        object.addRef(); Mem.writeUint32(args[2], canonical); return 0;
    };
    methods.TestObject_Release = (_ctx, _mem, args) => { releases++; return resources.getComObjectByAddress(args[0])!.release(); };
    expect(call('IClassFactory_CreateInstance', [f, 0, 0x1060, 0x1108])).toBe(0);
    const object = resources.getComObjectByAddress(Mem.readUint32(0x1108))!;
    expect(Mem.readUint32(0x1108)).toBe(canonical);
    expect(resources.getPrimaryAddressForHandle(object.handle)).not.toBe(canonical);
    expect(queries).toBe(1); expect(releases).toBe(1);
    expect(methods.TestObject_QueryInterface({} as X86Context, ram, [canonical, 0x1060, 0x110c])).toBe(0);
    expect(Mem.readUint32(0x110c)).toBe(canonical);
    expect(object.release()).toBe(1); expect(object.release()).toBe(0);
    call('IClassFactory_Release', [f]); expect(call('DllCanUnloadNow')).toBe(0);
});
test('a failed controlling-unknown query discards the constructor reference and clears output', () => {
    const f = factory(); methods.TestObject_QueryInterface = () => 0x8007000e;
    methods.TestObject_Release = (_ctx, _mem, args) => resources.getComObjectByAddress(args[0])!.release();
    Mem.writeUint32(0x1108, 0xfeed);
    expect(call('IClassFactory_CreateInstance', [f, 0, 0x1060, 0x1108])).toBe(0x8007000e);
    expect(Mem.readUint32(0x1108)).toBe(0);
    call('IClassFactory_Release', [f]); expect(call('DllCanUnloadNow')).toBe(0);
});
test('class lookup is scoped to its owning process and keeps class-to-interface restrictions', () => {
    expect(HleComServer.lookup(owner, CLSID.toUpperCase())?.server).toBe(server);
    expect(HleComServer.lookup({} as Process, CLSID)).toBeUndefined();
    expect(HleComServer.lookup(owner, IID)).toBeUndefined();
    const f = factory();
    expect(call('IClassFactory_CreateInstance', [f, 0, 0x1020, 0x1108])).toBe(0x80004002);
    expect(Mem.readUint32(0x1108)).toBe(0); call('IClassFactory_Release', [f]);
});
