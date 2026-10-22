import { beforeEach, afterEach, expect, test } from "bun:test";
import { DirectPlayAddressApi } from "../../src/worker/modules/dpnet/address-api";
import { DirectPlayAddress } from "../../src/worker/modules/dpnet/address";
import { DPN, DP8_ADDRESS, DP8_ADDRESS_IP, DP8_TCPIP, guidBytes, utf16, fromUtf16 } from "../../src/worker/modules/dpnet/constants";
import { dpnetModule, IDirectPlay8Address, IDirectPlay8AddressIP } from "../../src/worker/api/dpnet.api";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { BaseComObject, ComObjectFactory } from "../../src/worker/core/com/base-com-object";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { System } from "../../src/worker/core/system";
import { LanNetwork } from "../../src/worker/net/lan-network";
import type { Process } from "../../src/worker/core/process";
import type { ThunkImplementation, ThunkResult, X86Context } from "../../src/worker/core/thunking/thunk-dispatcher";
import type { VTableInfo } from "../../src/worker/api/adapters/module-adapter";
const system = System.getInstance(), resource = SystemResourceProvider.getInstance(), previous = system.process;
let memory: Uint8Array, process: Process, api: DirectPlayAddressApi, exports: Record<string, ThunkImplementation>, primary: number, objects: BaseComObject[], allocated: number, network: LanNetwork;
const u32 = (p: number, n: number) => new DataView(memory.buffer).setUint32(p, n >>> 0, true);
const read = (p: number) => new DataView(memory.buffer).getUint32(p, true);
const wide = (p: number, s: string) => memory.set(utf16(s + "\0"), p);
const call = (method: string, args: number[] = [], iface = "IDirectPlay8Address") => exports[iface + "_" + method]({ esp: 0x9000 } as X86Context, memory, [primary, ...args]);
beforeEach(() => {
    memory = new Uint8Array(2 * 1024 * 1024); objects = []; allocated = 0x100000;
    const alloc = (size: number) => { const p = allocated; allocated += (size + 15) & ~15; return p; };
    process = { getCurrentMemory: () => memory, memory: { alloc, allocSystemBlock: alloc, freeSystemBlock() {} },
        addressSpace: { validateRange: (p: number, n: number) => p >= 0x1000 && p + n <= memory.length } } as unknown as Process;
    system.process = process; Mem.bind(() => memory);
    const tables = Object.fromEntries(dpnetModule.interfaces!.map((i, n) => [i.name, { address: 0x6000 + n * 0x100, size: i.methods.length }])) as Record<string, VTableInfo>;
    for (const iface of dpnetModule.interfaces!) {
        if (!iface.iid) continue;
        const iid = iface.iid;
        ComObjectFactory.register(iid, class AddressTestCom extends BaseComObject {
            constructor(vtable: number) { super(iid, vtable); objects.push(this); } protected destroy() {}
        });
    }
    network = new LanNetwork(new Uint8Array([2, 0, 0, 0, 0, 1]));
    api = new DirectPlayAddressApi(process, () => tables, network); exports = {}; api.install(exports); primary = api.create(new DirectPlayAddress());
});
afterEach(() => { api.reset(); for (const obj of objects) resource.unregisterComObject(obj.handle); system.process = previous; });
test("DP8 Address and AddressIP native vtables and COM identity", () => {
    expect(IDirectPlay8Address.methods.length).toBe(22); expect(IDirectPlay8AddressIP.methods.length).toBe(9);
    expect(call("GetSP", [0x2000])).toBe(DPN.DOESNOTEXIST);
    memory.set(guidBytes(DP8_ADDRESS_IP), 0x2100); expect(call("QueryInterface", [0x2100, 0x2200])).toBe(DPN.OK);
    const ip = read(0x2200), first = primary; expect(ip).not.toBe(primary); expect(read(ip)).not.toBe(read(primary));
    primary = ip; memory.set(guidBytes("00000000-0000-0000-c000-000000000046"), 0x2100);
    expect(call("QueryInterface", [0x2100, 0x2200], "IDirectPlay8AddressIP")).toBe(DPN.OK); expect(read(0x2200)).toBe(first);
    memory.set(guidBytes(DP8_ADDRESS), 0x2100); expect(call("QueryInterface", [0x2100, 0x2200], "IDirectPlay8AddressIP")).toBe(DPN.OK);
    expect(resource.getComObjectByAddress(read(0x2200))?.handle).toBe(resource.getComObjectByAddress(first)?.handle);
});
test("DP8 native address output sizes, exact structs, ANSI conversion and invalid pointers", () => {
    memory.set(guidBytes(DP8_TCPIP), 0x2000); expect(call("SetSP", [0x2000])).toBe(DPN.OK);
    wide(0x2100, "hostname"); memory.set([108, 111, 99, 97, 108, 104, 111, 115, 116, 0], 0x2300);
    expect(call("AddComponent", [0x2100, 0x2300, 10, 5])).toBe(DPN.OK);
    u32(0x2400, 0); expect(call("GetComponentByName", [0x2100, 0, 0x2400, 0x2404])).toBe(DPN.BUFFERTOOSMALL);
    expect(read(0x2400)).toBe(20); expect(read(0x2404)).toBe(1);
    u32(0x2400, 1); expect(call("GetComponentByName", [0x2100, 0, 0x2400, 0x2404])).toBe(DPN.INVALIDPOINTER);
    u32(0x2400, 40); expect(call("GetComponentByName", [0x2100, 0x2500, 0x2400, 0x2404])).toBe(DPN.OK);
    expect(fromUtf16(memory.slice(0x2500, 0x2514))).toBe("localhost");
    wide(0x2100, "HOSTNAME"); u32(0x2400, 0); expect(call("GetComponentByName", [0x2100, 0, 0x2400, 0x2404])).toBe(DPN.BUFFERTOOSMALL);
    expect(read(0x2400)).toBe(20);
    u32(0x2410, 0); u32(0x2400, 0);
    expect(call("GetComponentByIndex", [0, 0, 0x2410, 0, 0x2400, 0x2404])).toBe(DPN.BUFFERTOOSMALL);
    expect(read(0x2410)).toBe(9); expect(read(0x2400)).toBe(16); expect(read(0x2404)).toBe(3);
    expect(call("GetNumComponents", [0])).toBe(DPN.INVALIDPOINTER);
    expect(call("GetURLW", [0, 0])).toBe(DPN.INVALIDPOINTER);
    expect(call("AddComponent", [0x2100, 0, 0, 4])).toBe(DPN.INVALIDPOINTER);
    wide(0x2100, ""); wide(0x2300, "empty"); expect(call("AddComponent", [0x2100, 0x2300, 12, 1])).toBe(DPN.OK);
});
test("DP8 native URL Unicode escaping and GetUserData success preserves caller capacity", () => {
    const address = api.address(primary)!; address.setGuid("provider", DP8_TCPIP); address.setText("hostname", "A %;#{}éЖ");
    u32(0x2400, 0); expect(call("GetURLW", [0, 0x2400])).toBe(DPN.BUFFERTOOSMALL);
    const length = read(0x2400); u32(0x2400, length);
    expect(call("GetURLW", [0x2500, 0x2400])).toBe(DPN.OK);
    expect(fromUtf16(memory.slice(0x2500, 0x2500 + length * 2))).toBe("x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=A%20%%%3B%23%7B%7D%E9%41");
    u32(0x2400, 0); expect(call("GetUserData", [0, 0x2400])).toBe(DPN.DOESNOTEXIST);
    memory.set([1, 2, 3], 0x2300); expect(call("SetUserData", [0x2300, 3])).toBe(DPN.OK);
    u32(0x2400, 2); memory.fill(0xcc, 0x2500, 0x2508);
    expect(call("GetUserData", [0x2500, 0x2400])).toBe(DPN.BUFFERTOOSMALL); expect(read(0x2400)).toBe(3); expect(memory[0x2500]).toBe(0xcc);
    u32(0x2400, 8); expect(call("GetUserData", [0x2500, 0x2400])).toBe(DPN.OK); expect(read(0x2400)).toBe(8);
    expect([...memory.slice(0x2500, 0x2504)]).toEqual([1, 2, 3, 0xcc]);
});
test("DP8 AddressIP Build/GetSockAddress network byte order and owner-safe asynchronous DNS", async () => {
    const address = api.address(primary)!; address.buildHost("127.10.20.30", 2300);
    u32(0x2400, 0); expect(call("GetSockAddress", [0, 0x2400], "IDirectPlay8AddressIP")).toBe(DPN.BUFFERTOOSMALL); expect(read(0x2400)).toBe(16);
    u32(0x2400, 16); expect(call("GetSockAddress", [0x2500, 0x2400], "IDirectPlay8AddressIP")).toBe(DPN.OK);
    expect([...memory.slice(0x2500, 0x2508)]).toEqual([2, 0, 8, 252, 127, 10, 20, 30]);
    address.buildHost("server.test", 2400);
    let resolve!: (value: { canonicalName: string; addresses: { family: 4; address: string }[] }) => void;
    network.resolve = () => new Promise(r => { resolve = r; });
    const pending = call("GetSockAddress", [0x2500, 0x2400], "IDirectPlay8AddressIP") as Promise<ThunkResult>;
    const foreign = new Uint8Array(memory.length); Mem.bind(() => foreign);
    resolve({ canonicalName: "server.test", addresses: [{ family: 4, address: "10.1.2.3" }] });
    const reply = await pending; expect(reply.value).toBe(DPN.OK);
    expect(memory[0x2504]).toBe(127); expect(foreign[0x2504]).toBe(0);
    Mem.bind(() => memory); for (const w of reply.deferredWrites!) Mem.writeUint8(w.address, w.value);
    expect([...memory.slice(0x2500, 0x2508)]).toEqual([2, 0, 9, 96, 10, 1, 2, 3]);
});
