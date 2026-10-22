import type { Process } from "../../core/process";
import type { VTableInfo } from "../../api/adapters/module-adapter";
import type { ThunkImplementation, ThunkResult, DeferredWrite } from "../../core/thunking/thunk-dispatcher";
import { Mem } from "../../core/memory/mem-accessor";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { ComObjectFactory } from "../../core/com/base-com-object";
import { allocateComObject } from "../../core/com/com-memory";
import { dpnetModule } from "../../api/dpnet.api";
import { lanNetwork, type LanNetwork } from "../../net/lan-network";
import { encodeAnsi } from "../codepage-utils";
import { DirectPlayAddress, type AddressComponent } from "./address";
import { DirectPlayGuestMemory } from "./guest-memory";
import { DPN, DP8_ADDRESS, DP8_ADDRESS_IP, DP8_TCPIP, guidString, utf16 } from "./constants";

interface AddressState { address: DirectPlayAddress; interfaces: Map<string, number>; }
export class DirectPlayAddressApi {
    private states = new Map<number, AddressState>();
    private guest: DirectPlayGuestMemory;
    private generation = 0;
    constructor(readonly process: Process, readonly tables: () => Record<string, VTableInfo>, readonly network: LanNetwork = lanNetwork) {
        this.guest = new DirectPlayGuestMemory(process);
    }
    reset(): void { ++this.generation; this.states.clear(); }
    release(handle: number): void { this.states.delete(handle); }
    address(ptr: number): DirectPlayAddress | null { return this.state(ptr)?.address ?? null; }
    create(address: DirectPlayAddress, iface = "IDirectPlay8Address"): number {
        const desc = dpnetModule.interfaces!.find(i => i.name === iface)!, table = this.tables()[iface]?.address;
        if (!table) return 0;
        const obj = ComObjectFactory.create(desc.iid!, table); if (!obj) return 0;
        const memory = this.process.getCurrentMemory(), ptr = allocateComObject(this.process.memory, memory, table);
        SystemResourceProvider.getInstance().mapAddressToHandle(ptr, obj.handle);
        this.states.set(obj.handle, { address: address.clone(), interfaces: new Map([[iface, ptr]]) }); return ptr;
    }
    private state(ptr: number): AddressState | null {
        const object = SystemResourceProvider.getInstance().getComObjectByAddress(ptr);
        if (!object || (object.iid !== DP8_ADDRESS && object.iid !== DP8_ADDRESS_IP)) return null;
        let state = this.states.get(object.handle);
        if (!state) { state = { address: new DirectPlayAddress(), interfaces: new Map() }; this.states.set(object.handle, state); }
        return state;
    }
    private copy(out: number, size: number, bytes: Uint8Array): number {
        if (!this.guest.valid(size, 4, "rw")) return DPN.INVALIDPOINTER;
        const capacity = Mem.readUint32(size)!;
        if (capacity && !this.guest.valid(out, capacity, "rw")) return DPN.INVALIDPOINTER;
        Mem.writeUint32(size, bytes.length);
        if (!out || capacity < bytes.length) return DPN.BUFFERTOOSMALL;
        Mem.writeBytes(out, bytes); return DPN.OK;
    }
    install(exports: Record<string, ThunkImplementation>): void {
        const methods: Record<string, (state: AddressState, args: number[]) => number | ThunkResult | Promise<ThunkResult>> = {};
        methods.QueryInterface = (s, a) => {
            if (!this.guest.valid(a[2], 4, "rw") || !this.guest.valid(a[1], 16)) return DPN.INVALIDPOINTER;
            Mem.writeUint32(a[2], 0);
            const iid = guidString(Mem.readBytes(a[1], 16)!), object = SystemResourceProvider.getInstance().getComObjectByAddress(a[0])!;
            const resource = SystemResourceProvider.getInstance();
            let ptr: number;
            if (iid === "00000000-0000-0000-c000-000000000046") ptr = resource.getPrimaryAddressForHandle(object.handle) ?? a[0];
            else {
                const iface = dpnetModule.interfaces!.find(i => i.iid === iid && /^IDirectPlay8Address/.test(i.name));
                if (!iface) return DPN.NOINTERFACE;
                ptr = s.interfaces.get(iface.name) ?? 0;
                if (!ptr) {
                    const memory = this.process.getCurrentMemory();
                    ptr = allocateComObject(this.process.memory, memory, this.tables()[iface.name].address);
                    resource.mapAddressToHandle(ptr, object.handle); s.interfaces.set(iface.name, ptr);
                }
            }
            object.addRef(); Mem.writeUint32(a[2], ptr); return DPN.OK;
        };
        methods.AddRef = (_s, a) => SystemResourceProvider.getInstance().getComObjectByAddress(a[0])!.addRef();
        methods.Release = (_s, a) => {
            const obj = SystemResourceProvider.getInstance().getComObjectByAddress(a[0])!, handle = obj.handle, count = obj.release();
            if (!count) this.release(handle); return count;
        };
        methods.Clear = s => { s.address.clear(); return DPN.OK; };
        for (const [method, wide] of [["BuildFromURLA", false], ["BuildFromURLW", true]] as const) methods[method] = (s, a) => {
            const text = this.guest.string(a[1], wide); return text === null ? DPN.INVALIDPOINTER : s.address.buildURL(text);
        };
        for (const [method, wide] of [["GetURLA", false], ["GetURLW", true]] as const) methods[method] = (s, a) => {
            if (!this.guest.valid(a[2], 4, "rw")) return DPN.INVALIDPOINTER;
            const url = s.address.url() + "\0", bytes = wide ? utf16(url) : encodeAnsi(url), capacity = Mem.readUint32(a[2])!, count = wide ? url.length : bytes.length;
            if (capacity && !this.guest.valid(a[1], capacity * (wide ? 2 : 1), "rw")) return DPN.INVALIDPOINTER;
            Mem.writeUint32(a[2], count);
            if (!a[1] || capacity < count) return DPN.BUFFERTOOSMALL;
            Mem.writeBytes(a[1], bytes); return DPN.OK;
        };
        methods.Duplicate = (s, a) => {
            if (!this.guest.valid(a[1], 4, "rw")) return DPN.INVALIDPOINTER;
            const ptr = this.create(s.address); Mem.writeUint32(a[1], ptr); return ptr ? DPN.OK : DPN.OUTOFMEMORY;
        };
        methods.SetEqual = (s, a) => { const other = this.address(a[1]); if (!other) return a[1] ? DPN.INVALIDOBJECT : DPN.INVALIDPOINTER; s.address.assign(other); return DPN.OK; };
        methods.IsEqual = (s, a) => { const other = this.address(a[1]); return !other ? a[1] ? DPN.INVALIDOBJECT : DPN.INVALIDPOINTER : s.address.equal(other) ? DPN.EQUAL : DPN.NOTEQUAL; };
        for (const [getter, setter, key] of [["GetSP", "SetSP", "provider"], ["GetDevice", "SetDevice", "device"]] as const) {
            methods[getter] = (s, a) => {
                if (!this.guest.valid(a[1], 16, "rw")) return DPN.INVALIDPOINTER;
                const c = s.address.get(key); if (!c) return DPN.DOESNOTEXIST;
                Mem.writeBytes(a[1], c.data); return DPN.OK;
            };
            methods[setter] = (s, a) => !this.guest.valid(a[1], 16) ? DPN.INVALIDPOINTER : s.address.set(key, Mem.readBytes(a[1], 16)!, 3);
        }
        methods.SetUserData = (s, a) => {
            if (a[2] && !this.guest.valid(a[1], a[2])) return DPN.INVALIDPOINTER;
            s.address.userData = a[2] ? Mem.readBytes(a[1], a[2])!.slice() : new Uint8Array(); return DPN.OK;
        };
        methods.GetUserData = (s, a) => {
            if (!this.guest.valid(a[2], 4, "rw")) return DPN.INVALIDPOINTER;
            if (!s.address.userData.length) return DPN.DOESNOTEXIST;
            const capacity = Mem.readUint32(a[2])!;
            if (capacity && !this.guest.valid(a[1], capacity, "rw")) return DPN.INVALIDPOINTER;
            if (capacity < s.address.userData.length) { Mem.writeUint32(a[2], s.address.userData.length); return DPN.BUFFERTOOSMALL; }
            if (!this.guest.valid(a[1], s.address.userData.length, "rw")) return DPN.INVALIDPOINTER;
            Mem.writeBytes(a[1], s.address.userData); return DPN.OK;
        };
        methods.GetNumComponents = (s, a) => {
            if (!this.guest.valid(a[1], 4, "rw")) return DPN.INVALIDPOINTER;
            Mem.writeUint32(a[1], s.address.components.length); return DPN.OK;
        };
        methods.AddComponent = (s, a) => {
            if (!a[1] || !this.guest.valid(a[2], a[3])) return DPN.INVALIDPOINTER;
            const name = this.guest.string(a[1]); if (name === null) return DPN.INVALIDSTRING;
            return s.address.set(name, Mem.readBytes(a[2], a[3])!, a[4]);
        };
        const component = (s: AddressState, a: number[], c: AddressComponent | undefined, index: boolean): number => {
            const out = a[index ? 4 : 2], psize = a[index ? 5 : 3], ptype = a[index ? 6 : 4];
            if (!this.guest.valid(psize, 4, "rw") || !this.guest.valid(ptype, 4, "rw")) return DPN.INVALIDPOINTER;
            const capacity = Mem.readUint32(psize)!;
            if (capacity && !this.guest.valid(out, capacity, "rw")) return DPN.INVALIDPOINTER;
            const nameCapacity = index ? Mem.readUint32(a[3])! : 0;
            if (index && nameCapacity && !this.guest.valid(a[2], nameCapacity * 2, "rw")) return DPN.INVALIDPOINTER;
            if (!c) return DPN.DOESNOTEXIST;
            Mem.writeUint32(psize, c.data.length); Mem.writeUint32(ptype, c.type);
            if (index) Mem.writeUint32(a[3], c.name.length + 1);
            if (capacity < c.data.length || !out || (index && (nameCapacity < c.name.length + 1 || !a[2]))) return DPN.BUFFERTOOSMALL;
            Mem.writeBytes(out, c.data); if (index) Mem.writeBytes(a[2], utf16(c.name + "\0")); return DPN.OK;
        };
        methods.GetComponentByName = (s, a) => {
            const name = this.guest.string(a[1]); if (name === null) return DPN.INVALIDPOINTER;
            return component(s, a, s.address.get(name), false);
        };
        methods.GetComponentByIndex = (s, a) => {
            if (!this.guest.valid(a[3], 4, "rw")) return DPN.INVALIDPOINTER;
            return component(s, a, s.address.components[a[1]], true);
        };
        methods.BuildAddress = (s, a) => {
            const host = this.guest.string(a[1]); return host === null ? DPN.INVALIDPOINTER : s.address.buildHost(host, a[2]);
        };
        methods.BuildLocalAddress = (s, a) => !this.guest.valid(a[1], 16) ? DPN.INVALIDPOINTER : s.address.buildLocal(guidString(Mem.readBytes(a[1], 16)!), a[2]);
        methods.BuildFromSockAddr = (s, a) => {
            if (!this.guest.valid(a[1], 16)) return DPN.INVALIDPOINTER;
            if (Mem.readUint16(a[1]) !== 2) return DPN.INVALIDPARAM;
            const ip = Mem.readBytes(a[1] + 4, 4)!, port = (Mem.readUint8(a[1] + 2)! << 8) | Mem.readUint8(a[1] + 3)!;
            return s.address.buildHost(Array.from(ip).join("."), port);
        };
        const ipError = (address: DirectPlayAddress): number => !address.guid("provider") ? DPN.INCOMPLETEADDRESS : address.guid("provider") !== DP8_TCPIP ? DPN.INVALIDADDRESSFORMAT : DPN.OK;
        methods.GetAddress = (s, a) => {
            if (!this.guest.valid(a[2], 4, "rw") || !this.guest.valid(a[3], 2, "rw")) return DPN.INVALIDPOINTER;
            const capacity = Mem.readUint32(a[2])!;
            if (capacity && !this.guest.valid(a[1], capacity * 2, "rw")) return DPN.INVALIDPOINTER;
            const hr = ipError(s.address); if (hr) return hr;
            const host = s.address.text("hostname"), port = s.address.dword("port"); if (host === undefined || port === undefined) return DPN.INCOMPLETEADDRESS;
            Mem.writeUint32(a[2], host.length + 1);
            if (!a[1] || capacity < host.length + 1) return DPN.BUFFERTOOSMALL;
            Mem.writeBytes(a[1], utf16(host + "\0")); Mem.writeUint16(a[3], port & 0xffff); return DPN.OK;
        };
        methods.GetLocalAddress = (s, a) => {
            if (!this.guest.valid(a[1], 16, "rw") || !this.guest.valid(a[2], 2, "rw")) return DPN.INVALIDPOINTER;
            const hr = ipError(s.address); if (hr) return hr;
            const device = s.address.get("device"), port = s.address.dword("port"); if (!device || port === undefined) return DPN.INCOMPLETEADDRESS;
            Mem.writeBytes(a[1], device.data); Mem.writeUint16(a[2], port & 0xffff); return DPN.OK;
        };
        methods.GetSockAddress = (s, a) => {
            if (!this.guest.valid(a[2], 4, "rw")) return DPN.INVALIDPOINTER;
            const capacity = Mem.readUint32(a[2])!;
            if (capacity && !this.guest.valid(a[1], capacity, "rw")) return DPN.INVALIDPOINTER;
            const hr = ipError(s.address); if (hr) return hr;
            const host = s.address.text("hostname"), port = s.address.dword("port"); if (host === undefined || port === undefined) return DPN.INCOMPLETEADDRESS;
            Mem.writeUint32(a[2], 16);
            if (!a[1] || capacity < 16) return DPN.BUFFERTOOSMALL;
            const encode = (ip: string): Uint8Array | null => {
                if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.split(".").some(c => +c > 255)) return null;
                const b = new Uint8Array(16); new DataView(b.buffer).setUint16(0, 2, true); b[2] = port >>> 8; b[3] = port & 255;
                b.set(ip.split(".").map(Number), 4); return b;
            };
            const bytes = encode(host.toLowerCase() === "localhost" ? "127.0.0.1" : host);
            if (bytes) { Mem.writeBytes(a[1], bytes); return DPN.OK; }
            const generation = this.generation, owner = SystemResourceProvider.getInstance().getComObjectByAddress(a[0])!, out = a[1];
            return this.network.resolve(host, 4).then<ThunkResult, ThunkResult>(result => {
                if (generation !== this.generation || !this.states.has(owner.handle)) return { value: DPN.INVALIDOBJECT };
                const ip = result.addresses.find(v => v.family === 4), data = ip && encode(ip.address);
                return !data ? { value: DPN.CONVERSION } : { value: DPN.OK,
                    deferredWrites: Array.from(data, (value, i): DeferredWrite => ({ address: out + i, value, size: 1 })) };
            }, () => ({ value: DPN.CONVERSION }));
        };
        methods.BuildFromDirectPlay4Address = (s, a) => {
            if (!a[2]) return DPN.INVALIDPARAM;
            if (!this.guest.valid(a[1], a[2])) return DPN.INVALIDPOINTER;
            const bytes = Mem.readBytes(a[1], a[2])!, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            s.address.clear();
            const mapping: Record<string, [string, number]> = {
                "07d916c0-e0af-11cf-9c4e-00a0c905425e": ["provider", 3],
                "c4a54da0-e0af-11cf-9c4e-00a0c905425e": ["hostname", 5],
                "e4524541-8ea5-11d1-8a96-006097b01411": ["port", 2],
                "7d916c00-e0af-11cf-9c4e-00a0c905425e": ["hostname", 1],
            };
            let offset = 0;
            while (offset < bytes.length) {
                if (bytes.length - offset < 20) return DPN.INVALIDADDRESSFORMAT;
                const key = guidString(bytes.subarray(offset, offset + 16)), size = view.getUint32(offset + 16, true); offset += 20;
                if (size > bytes.length - offset) return DPN.INVALIDADDRESSFORMAT;
                const map = mapping[key];
                if (key !== "1318f560-912c-11d0-9daa-00a0c90a43cb") {
                    if (!map || s.address.set(map[0], bytes.slice(offset, offset + size), map[1])) return DPN.INVALIDADDRESSFORMAT;
                }
                offset += size;
            }
            return DPN.OK;
        };
        const bind = (method: string): ThunkImplementation => (_ctx, _mem, args) => {
            const state = this.state(args[0]); return state ? methods[method](state, [...args]) : DPN.INVALIDOBJECT;
        };
        exports["IDirectPlay8Address_QueryInterface"] = bind("QueryInterface");
        exports["IDirectPlay8Address_AddRef"] = bind("AddRef");
        exports["IDirectPlay8Address_Release"] = bind("Release");
        exports["IDirectPlay8Address_BuildFromURLW"] = bind("BuildFromURLW");
        exports["IDirectPlay8Address_BuildFromURLA"] = bind("BuildFromURLA");
        exports["IDirectPlay8Address_Duplicate"] = bind("Duplicate");
        exports["IDirectPlay8Address_SetEqual"] = bind("SetEqual");
        exports["IDirectPlay8Address_IsEqual"] = bind("IsEqual");
        exports["IDirectPlay8Address_Clear"] = bind("Clear");
        exports["IDirectPlay8Address_GetURLW"] = bind("GetURLW");
        exports["IDirectPlay8Address_GetURLA"] = bind("GetURLA");
        exports["IDirectPlay8Address_GetSP"] = bind("GetSP");
        exports["IDirectPlay8Address_GetUserData"] = bind("GetUserData");
        exports["IDirectPlay8Address_SetSP"] = bind("SetSP");
        exports["IDirectPlay8Address_SetUserData"] = bind("SetUserData");
        exports["IDirectPlay8Address_GetNumComponents"] = bind("GetNumComponents");
        exports["IDirectPlay8Address_GetComponentByName"] = bind("GetComponentByName");
        exports["IDirectPlay8Address_GetComponentByIndex"] = bind("GetComponentByIndex");
        exports["IDirectPlay8Address_AddComponent"] = bind("AddComponent");
        exports["IDirectPlay8Address_GetDevice"] = bind("GetDevice");
        exports["IDirectPlay8Address_SetDevice"] = bind("SetDevice");
        exports["IDirectPlay8Address_BuildFromDirectPlay4Address"] = bind("BuildFromDirectPlay4Address");
        exports["IDirectPlay8AddressIP_QueryInterface"] = bind("QueryInterface");
        exports["IDirectPlay8AddressIP_AddRef"] = bind("AddRef");
        exports["IDirectPlay8AddressIP_Release"] = bind("Release");
        exports["IDirectPlay8AddressIP_BuildFromSockAddr"] = bind("BuildFromSockAddr");
        exports["IDirectPlay8AddressIP_BuildAddress"] = bind("BuildAddress");
        exports["IDirectPlay8AddressIP_BuildLocalAddress"] = bind("BuildLocalAddress");
        exports["IDirectPlay8AddressIP_GetSockAddress"] = bind("GetSockAddress");
        exports["IDirectPlay8AddressIP_GetLocalAddress"] = bind("GetLocalAddress");
        exports["IDirectPlay8AddressIP_GetAddress"] = bind("GetAddress");
    }
}
