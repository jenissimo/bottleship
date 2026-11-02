import { Mem } from "../../core/memory/mem-accessor";
import type { Process } from "../../core/process";
import type { SessionDesc } from "../dplayx/session";
import { DirectPlayGuestMemory } from "../dpnet/guest-memory";
import { DirectPlayAddress, type AddressComponent } from "../dpnet/address";
import type { DirectPlayAddressApi } from "../dpnet/address-api";
import { byteHex, packApplication } from "../dpnet/structures";
import { DPN, guidBytes, guidString, utf16 } from "../dpnet/constants";

export interface Lobby8Address { components: AddressComponent[]; userData: Uint8Array; }
export interface Lobby8Settings { flags: number; desc: SessionDesc; players: number; host: Lobby8Address | null; devices: Lobby8Address[]; player: string | null; namePresent?: boolean; passwordPresent?: boolean; }
export interface Lobby8Program { guid: string; strings: (string | null)[]; running?: number; waiting?: number; }
export interface Lobby8Event { serial: number; type: number; connection: number; settings?: Lobby8Settings; data?: Uint8Array; result?: number; status?: number; }
const addressModel = (address: DirectPlayAddress): Lobby8Address => structuredClone({ components: address.components, userData: address.userData });
export function readSettings(guest: DirectPlayGuestMemory, addresses: DirectPlayAddressApi, ptr: number): { hr: number; value?: Lobby8Settings } {
    if (!guest.valid(ptr, 96)) return { hr: DPN.INVALIDPOINTER };
    if (Mem.readUint32(ptr) !== 96) return { hr: DPN.INVALIDPARAM };
    const flags = Mem.readUint32(ptr + 4)!;
    if (flags & ~1) return { hr: DPN.INVALIDFLAGS };
    if (Mem.readUint32(ptr + 8) !== 72) return { hr: DPN.INVALIDPOINTER };
    const namePtr = Mem.readUint32(ptr + 56)!, passwordPtr = Mem.readUint32(ptr + 60)!;
    const name = namePtr ? guest.string(namePtr) : "", password = passwordPtr ? guest.string(passwordPtr) : "";
    if (name === null || password === null) return { hr: DPN.INVALIDSTRING };
    const reserved = Mem.readUint32(ptr + 64)!, reservedSize = Mem.readUint32(ptr + 68)!;
    const applicationData = Mem.readUint32(ptr + 72)!, applicationSize = Mem.readUint32(ptr + 76)!;
    if ((reservedSize && !guest.valid(reserved, reservedSize)) || (applicationSize && !guest.valid(applicationData, applicationSize))) return { hr: DPN.INVALIDPOINTER };
    const applicationFlags = Mem.readUint32(ptr + 12)!;
    const desc: SessionDesc = { instance: byteHex(Mem.readBytes(ptr + 16, 16)!), application: byteHex(Mem.readBytes(ptr + 32, 16)!),
        flags: 0, maxPlayers: Mem.readUint32(ptr + 48)!, name, password, user: [0, 0, 0, 0],
        extended: { flags: applicationFlags, reserved: reservedSize ? Array.from(Mem.readBytes(reserved, reservedSize)!) : [],
            application: applicationSize ? Array.from(Mem.readBytes(applicationData, applicationSize)!) : [] } };
    const count = Mem.readUint32(ptr + 88)!, array = Mem.readUint32(ptr + 84)!, hostPtr = Mem.readUint32(ptr + 80)!;
    const host = hostPtr ? addresses.address(hostPtr) : null;
    if ((flags & 1) && hostPtr) return { hr: DPN.INVALIDPARAM };
    if (!(flags & 1) && !host) return { hr: DPN.INVALIDHOSTADDRESS };
    if (!guest.valid(array, count * 4)) return { hr: DPN.INVALIDDEVICEADDRESS };
    if (!count) return { hr: DPN.INVALIDPARAM };
    const devices: Lobby8Address[] = [];
    for (let i = 0; i < count; i++) {
        const device = addresses.address(Mem.readUint32(array + i * 4)!);
        if (!device) return { hr: DPN.INVALIDPARAM };
        devices.push(addressModel(device));
    }
    const playerPtr = Mem.readUint32(ptr + 92)!, player = playerPtr ? guest.string(playerPtr) : null;
    if (playerPtr && player === null) return { hr: DPN.INVALIDPOINTER };
    return { hr: DPN.OK, value: { flags, desc, players: Mem.readUint32(ptr + 52)!, host: host ? addressModel(host) : null, devices, player, namePresent: !!Mem.readUint32(ptr + 56), passwordPresent: !!Mem.readUint32(ptr + 60) } };
}
const align4 = (value: number): number => (value + 3) & ~3;
function settingsBlobs(value: Lobby8Settings): Array<{ offset: number; bytes: Uint8Array }> {
    return [
        { offset: 56, bytes: (value.namePresent ?? !!value.desc.name) ? utf16(value.desc.name + "\0") : new Uint8Array() },
        { offset: 92, bytes: value.player === null ? new Uint8Array() : utf16(value.player + "\0") },
        { offset: 60, bytes: (value.passwordPresent ?? !!value.desc.password) ? utf16(value.desc.password + "\0") : new Uint8Array() },
        { offset: 64, bytes: new Uint8Array(value.desc.extended?.reserved ?? []) },
        { offset: 72, bytes: new Uint8Array(value.desc.extended?.application ?? []) },
    ];
}
export function settingsSize(value: Lobby8Settings): number {
    return 96 + value.devices.length * 4 + settingsBlobs(value).reduce((size, blob) => size + align4(blob.bytes.length), 0);
}
export function settingsStorage(value: Lobby8Settings | undefined): number {
    return !value ? 0 : settingsSize(value) + [value.host, ...value.devices].reduce((size, address) =>
        size + (address ? address.userData.length + address.components.reduce((n, c) => n + c.name.length * 2 + c.data.length + 12, 0) : 0), 0);
}
export function releaseAddresses(pointers: number[], addresses: DirectPlayAddressApi): void {
    for (const ptr of pointers) {
        const object = addresses.process.resourceProvider.getComObjectByAddress(ptr);
        if (object && !object.release()) addresses.release(object.handle);
    }
}
/** Called only at a guest owner safe point. All new address references belong to the caller. */
export function packSettings(value: Lobby8Settings, base: number, addresses: DirectPlayAddressApi): { bytes: Uint8Array; pointers: number[] } {
    const pointers: number[] = [];
    try {
        const make = (model: Lobby8Address) => {
            const address = new DirectPlayAddress(); address.components = structuredClone(model.components); address.userData = model.userData.slice();
            const ptr = addresses.create(address); if (!ptr) throw new Error("DirectPlay address allocation failed");
            pointers.push(ptr); return ptr;
        };
        const bytes = new Uint8Array(settingsSize(value)), view = new DataView(bytes.buffer);
        view.setUint32(0, 96, true); view.setUint32(4, value.flags, true);
        bytes.set(packApplication(value.desc, value.players).subarray(0, 72), 8);
        let tail = bytes.length;
        for (const blob of settingsBlobs(value)) {
            if (!blob.bytes.length) { view.setUint32(blob.offset, 0, true); continue; }
            tail -= align4(blob.bytes.length); bytes.set(blob.bytes, tail); view.setUint32(blob.offset, base + tail, true);
        }
        tail -= value.devices.length * 4;
        view.setUint32(80, value.host ? make(value.host) : 0, true);
        view.setUint32(84, value.devices.length ? base + tail : 0, true); view.setUint32(88, value.devices.length, true);
        value.devices.forEach((model, i) => view.setUint32(tail + i * 4, make(model), true));
        return { bytes, pointers };
    } catch (error) { releaseAddresses(pointers, addresses); throw error; }
}
export function readProgram(guest: DirectPlayGuestMemory, ptr: number): { hr: number; value?: Lobby8Program } {
    if (!guest.valid(ptr, 56)) return { hr: DPN.INVALIDPOINTER };
    if (Mem.readUint32(ptr) !== 56) return { hr: DPN.INVALIDPARAM };
    if (Mem.readUint32(ptr + 4)) return { hr: DPN.INVALIDFLAGS };
    if (Mem.readBytes(ptr + 8, 16)!.every(byte => byte === 0)) return { hr: DPN.INVALIDPARAM };
    const strings: (string | null)[] = [];
    for (let i = 0; i < 8; i++) {
        const address = Mem.readUint32(ptr + 24 + i * 4)!;
        const text = address ? guest.string(address) : null;
        if (!address && [0, 4].includes(i)) return { hr: DPN.INVALIDPARAM };
        if (address && text === null) return { hr: DPN.INVALIDSTRING };
        strings.push(text);
    }
    return { hr: DPN.OK, value: { guid: guidString(Mem.readBytes(ptr + 8, 16)!), strings } };
}
export function packPrograms(programs: Lobby8Program[], base: number): Uint8Array {
    const names = programs.map(p => utf16((p.strings[0] ?? "") + "\0"));
    const bytes = new Uint8Array(programs.length * 32 + names.reduce((n, name) => n + name.length, 0)), view = new DataView(bytes.buffer);
    let offset = programs.length * 32;
    programs.forEach((program, i) => {
        bytes.set(guidBytes(program.guid), i * 32); view.setUint32(i * 32 + 16, base + offset, true);
        view.setUint32(i * 32 + 20, program.running ?? 0, true); view.setUint32(i * 32 + 24, program.waiting ?? 0, true);
        bytes.set(names[i], offset); offset += names[i].length;
    }); return bytes;
}
