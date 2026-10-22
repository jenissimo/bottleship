import { Mem } from "../../core/memory/mem-accessor";
import { DirectPlayGuestMemory } from "./guest-memory";
import type { SessionDesc, Entity } from "../dplayx/session";
import type { PlayerInfo } from "./peer";
import { utf16 } from "./constants";
export const byteHex = (bytes: Uint8Array): string => Array.from(bytes, n => n.toString(16).padStart(2, "0")).join("");
export const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], n => parseInt(n, 16));
export class StructBuffer {
    readonly bytes: Uint8Array;
    private offset: number;
    constructor(size: number, extra = 0, readonly base = 0) { this.bytes = new Uint8Array(size + extra); this.offset = size; }
    u32(offset: number, value: number): void { new DataView(this.bytes.buffer).setUint32(offset, value >>> 0, true); }
    blob(offset: number, bytes: Uint8Array): void {
        this.u32(offset, bytes.length ? this.base + this.offset : 0); this.bytes.set(bytes, this.offset); this.offset += bytes.length;
    }
}
export function readApplication(guest: DirectPlayGuestMemory, ptr: number): SessionDesc | null {
    if (!guest.valid(ptr, 72) || Mem.readUint32(ptr) !== 72) return null;
    const flags = Mem.readUint32(ptr + 4)!, maxPlayers = Mem.readUint32(ptr + 40)!;
    const name = Mem.readUint32(ptr + 48) ? guest.string(Mem.readUint32(ptr + 48)!) : "";
    const password = Mem.readUint32(ptr + 52) ? guest.string(Mem.readUint32(ptr + 52)!) : "";
    const rp = Mem.readUint32(ptr + 56)!, rs = Mem.readUint32(ptr + 60)!, ap = Mem.readUint32(ptr + 64)!, as = Mem.readUint32(ptr + 68)!;
    if (name === null || password === null || name.length > 1024 || password.length > 1024 || rs > 64 || as > 60000 ||
        (rs && !guest.valid(rp, rs)) || (as && !guest.valid(ap, as))) return null;
    return { instance: byteHex(Mem.readBytes(ptr + 8, 16)!), application: byteHex(Mem.readBytes(ptr + 24, 16)!),
        flags: (flags & 1 ? 0x1000 : 0) | (flags & 4) | (flags & 0x100 ? 0x200 : 0),
        name, password, maxPlayers, user: [0, 0, 0, 0], extended: { flags,
            reserved: rs ? Array.from(Mem.readBytes(rp, rs)!) : [], application: as ? Array.from(Mem.readBytes(ap, as)!) : [] } };
}
export function packApplication(desc: SessionDesc, players: number, base = 0): Uint8Array {
    const name = desc.name ? utf16(desc.name + "\0") : new Uint8Array(), password = desc.password ? utf16(desc.password + "\0") : new Uint8Array();
    const reserved = new Uint8Array(desc.extended?.reserved ?? []), app = new Uint8Array(desc.extended?.application ?? []);
    const out = new StructBuffer(72, name.length + password.length + reserved.length + app.length, base);
    out.u32(0, 72); out.u32(4, desc.extended?.flags ?? 0);
    out.bytes.set(fromHex(desc.instance), 8); out.bytes.set(fromHex(desc.application), 24);
    out.u32(40, desc.maxPlayers); out.u32(44, players); out.blob(48, name); out.blob(52, password);
    out.blob(56, reserved); out.u32(60, reserved.length); out.blob(64, app); out.u32(68, app.length); return out.bytes;
}
export function readInfo(guest: DirectPlayGuestMemory, ptr: number): { info: PlayerInfo; mask: number } | null {
    if (!guest.valid(ptr, 24) || Mem.readUint32(ptr) !== 24) return null;
    const mask = Mem.readUint32(ptr + 4)!, namePtr = Mem.readUint32(ptr + 8)!, dataPtr = Mem.readUint32(ptr + 12)!, size = Mem.readUint32(ptr + 16)!;
    if (mask & ~3 || size > 60000 || (mask & 2 && size && !guest.valid(dataPtr, size))) return null;
    const name = mask & 1 && namePtr ? guest.string(namePtr) : "";
    if (name === null || name.length > 1024) return null;
    return { mask, info: { name, data: mask & 2 && size ? Array.from(Mem.readBytes(dataPtr, size)!) : [], flags: Mem.readUint32(ptr + 20)! } };
}
export function packInfo(entity: Entity, flags: number, base = 0): Uint8Array {
    const name = entity.name.short ? utf16(entity.name.short + "\0") : new Uint8Array(), data = new Uint8Array(entity.data);
    const out = new StructBuffer(24, name.length + data.length, base);
    out.u32(0, 24); out.u32(4, 3); out.blob(8, name); out.blob(12, data); out.u32(16, data.length); out.u32(20, flags); return out.bytes;
}
