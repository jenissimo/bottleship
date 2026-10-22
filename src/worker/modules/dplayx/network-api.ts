import type { Process } from "../../core/process";
import type { ThunkImplementation, ThunkResult } from "../../core/thunking/thunk-dispatcher";
import type { VTableInfo } from "../../api/adapters/module-adapter";
import { Mem } from "../../core/memory/mem-accessor";
import { System } from "../../core/system";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { allocateComObject } from "../../core/com/com-memory";
import { ComObjectFactory } from "../../core/com/base-com-object";
import { dplayxModule } from "../../api/dplayx.api";
import { lanNetwork, type LanNetwork } from "../../net/lan-network";
import { decodeAnsiString, encodeAnsi, getAnsiCodePage } from "../codepage-utils";
import { DirectPlaySendQueue } from "./send-queue";
import { DirectPlayLobbyEndpoint, type LobbySettings, type LobbyReply } from "./lobby-broker";
import { DIRECTPLAY_APPLICATIONS, registeredDirectPlayApplications, guidString } from "./lobby-registry";
import { prepareChildLaunch, type PreparedChildLaunch } from "../../core/launch-child";
import { DirectPlaySession, DP, DPLAY_MAX_MESSAGE, type SessionDesc, type PlayerName, type Entity, type Message, type Reply } from "./session";

const E_POINTER = 0x80004003;
const E_NOINTERFACE = 0x80004002;
const DPERR_INVALIDOBJECT = 0x88770082;
const IID1 = "5454e9a0-db65-11ce-921c-00aa006c4972";
const IID4 = "0ab1c531-4745-11d1-a7a1-0000f803abfc";
const ZERO_GUID = "0".repeat(32);
const PROVIDERS = [
    { guid: "e05ee9367785cf11960c0080c7534e82", name: "Internet TCP/IP Connection For DirectPlay" },
    { guid: "00c45b682c9dcf11a9cd00aa006886e3", name: "IPX Connection For DirectPlay" },
];
const SERVICE_GUID = "c016d907afe0cf119c4e00a0c905425e";
const TOTAL_GUID = "60f518132c91d0119daa00a0c90a43cb";
const INET_GUID = "a04da5c4afe0cf119c4e00a0c905425e";
const INET_PORT_GUID = "414552e4a58ed1118a96006097b01411";
const hex = (b: Uint8Array): string => Array.from(b, n => n.toString(16).padStart(2, "0")).join("");
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], b => parseInt(b, 16));
const iidHex = (iid: string): string => {
    const s = iid.replace(/[{}-]/g, "");
    return [s.slice(0, 8).match(/../g)!.reverse().join(""), s.slice(8, 12).match(/../g)!.reverse().join(""),
        s.slice(12, 16).match(/../g)!.reverse().join(""), s.slice(16)].join("");
};
const EMPTY: Uint8Array = new Uint8Array();

function encodeText(text: string, wide = false): Uint8Array {
    if (!wide) return encodeAnsi(text);
    const bytes = new Uint8Array(text.length * 2), view = new DataView(bytes.buffer);
    for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
    return bytes;
}
class BufferWriter {
    readonly bytes: Uint8Array;
    readonly view: DataView;
    private offset: number;
    constructor(size: number, extra = 0, readonly base = 0) {
        this.bytes = new Uint8Array(size + extra); this.view = new DataView(this.bytes.buffer); this.offset = size;
    }
    u32(offset: number, value: number): void { this.view.setUint32(offset, value >>> 0, true); }
    blob(offset: number, bytes: Uint8Array): void {
        this.u32(offset, bytes.length ? this.base + this.offset : 0);
        this.bytes.set(bytes, this.offset); this.offset += bytes.length;
    }
    string(offset: number, value: string, wide = false): void { this.blob(offset, encodeText(value + "\0", wide)); }
}
function nameExtra(name: PlayerName, wide = false): number { return (name.shortNull ? 0 : encodeText(name.short + "\0", wide).length) + (name.longNull ? 0 : encodeText(name.long + "\0", wide).length); }
function writeName(b: BufferWriter, offset: number, name: PlayerName, wide = false): void {
    b.u32(offset, 16); b.u32(offset + 4, 0);
    if (!name.shortNull) b.string(offset + 8, name.short, wide);
    if (!name.longNull) b.string(offset + 12, name.long, wide);
}
function packName(name: PlayerName, base: number, wide = false): Uint8Array {
    const b = new BufferWriter(16, nameExtra(name, wide), base); writeName(b, 0, name, wide); return b.bytes;
}
function packDesc(desc: SessionDesc, players: number, base: number, legacy: boolean, wide = false): Uint8Array {
    if (legacy) {
        const bytes = new Uint8Array(124), v = new DataView(bytes.buffer);
        v.setUint32(0, 124, true); bytes.set(unhex(desc.application), 4);
        v.setUint32(20, new DataView(unhex(desc.instance).buffer).getUint32(0, true), true);
        v.setUint32(24, desc.maxPlayers, true); v.setUint32(28, players, true); v.setUint32(32, desc.flags, true);
        bytes.set(encodeAnsi(desc.name).subarray(0, 31), 36); bytes.set(encodeAnsi(desc.password).subarray(0, 15), 88);
        desc.user.forEach((n, i) => v.setUint32(108 + i * 4, n, true));
        return bytes;
    }
    const b = new BufferWriter(80, (desc.nameNull ? 0 : encodeText(desc.name + "\0", wide).length) + (desc.passwordNull ? 0 : encodeText(desc.password + "\0", wide).length), base);
    b.u32(0, 80); b.u32(4, desc.flags); b.bytes.set(unhex(desc.instance), 8); b.bytes.set(unhex(desc.application), 24);
    b.u32(40, desc.maxPlayers); b.u32(44, players);
    if (!desc.nameNull) b.string(48, desc.name, wide);
    if (!desc.passwordNull) b.string(52, desc.password, wide);
    desc.user.forEach((n, i) => b.u32(64 + i * 4, n)); return b.bytes;
}
export function packDirectPlayMessage(m: Message, base: number, currentPlayers: number, wide = false): Uint8Array {
    if (!m.system) return m.data;
    const s = m.system, e = s.entity;
    if (e && (s.type === 3 || s.type === 5)) {
        const size = s.type === 3 ? 48 : 52;
        const b = new BufferWriter(size, e.data.length + nameExtra(e.name, wide), base);
        b.u32(0, s.type); b.u32(4, e.group ? 0 : 1); b.u32(8, e.id);
        if (s.type === 3) {
            b.u32(12, s.currentPlayers ?? currentPlayers); b.blob(16, new Uint8Array(e.data)); b.u32(20, e.data.length);
            writeName(b, 24, e.name, wide); b.u32(40, e.parent); b.u32(44, e.flags);
        } else {
            b.blob(20, new Uint8Array(e.data)); b.u32(24, e.data.length);
            writeName(b, 28, e.name, wide); b.u32(44, e.parent); b.u32(48, e.flags);
        }
        return b.bytes;
    }
    if (e && s.type === 0x102) {
        const b = new BufferWriter(20, e.data.length, base);
        b.u32(0, s.type); b.u32(4, e.group ? 0 : 1); b.u32(8, e.id); b.blob(12, new Uint8Array(e.data)); b.u32(16, e.data.length);
        return b.bytes;
    }
    if (e && s.type === 0x103) {
        const b = new BufferWriter(28, nameExtra(e.name, wide), base);
        b.u32(0, s.type); b.u32(4, e.group ? 0 : 1); b.u32(8, e.id); writeName(b, 12, e.name, wide); return b.bytes;
    }
    if (s.type === 0x10d && s.completion) {
        const c = s.completion, b = new BufferWriter(40);
        [s.type, c.from, c.to, c.flags, c.priority, c.timeout, c.context, c.id, c.hr, c.sendTime].forEach((n, i) => b.u32(i * 4, n));
        return b.bytes;
    }
    if (s.type === 0x109 && s.chat) {
        const c = s.chat, b = new BufferWriter(36, encodeText(c.text + "\0", wide).length, base);
        [s.type, c.flags, c.from, c.to, c.group, base + 24, 12, 0].forEach((n, i) => b.u32(i * 4, n));
        b.string(32, c.text, wide); return b.bytes;
    }
    if (s.type === 0x104 && s.desc) {
        const desc = packDesc(s.desc, currentPlayers, base + 4, false, wide);
        const b = new BufferWriter(4 + desc.length); b.u32(0, s.type); b.bytes.set(desc, 4); return b.bytes;
    }
    const b = new BufferWriter(s.group === undefined ? 4 : s.type === 0x10a ? 16 : 12);
    b.u32(0, s.type); if (s.group !== undefined) { b.u32(4, s.group); b.u32(8, s.player ?? 0); }
    if (s.type === 0x10a) b.u32(12, s.oldOwner ?? 0);
    return b.bytes;
}

function packAddress(elements: { guid: string; data: Uint8Array }[]): Uint8Array {
    const size = 24 + elements.reduce((sum, e) => sum + 20 + e.data.length, 0), b = new BufferWriter(size);
    b.bytes.set(unhex(TOTAL_GUID)); b.u32(16, 4); b.u32(20, size);
    let offset = 24;
    for (const e of elements) { b.bytes.set(unhex(e.guid), offset); b.u32(offset + 16, e.data.length); b.bytes.set(e.data, offset + 20); offset += 20 + e.data.length; }
    return b.bytes;
}
interface GuestState {
    session: DirectPlaySession; events: Map<number, number>; localData: Map<number, Uint8Array>;
    interfaces: Map<string, number>; sendQueue: Map<number, { from: number; to: number; bytes: number }>;
    nextMessage: number; asyncSends: DirectPlaySendQueue;
}
type Frame = { esp: number; returnAddr?: number };
type EnumerationEntry = { args: (base: number) => number[]; pack: (base: number) => Uint8Array };
/** Guest COM/ABI boundary. Session state is keyed by the COM object, never by the process. */
export class DirectPlayNetworkApi {
    private states = new Map<number, GuestState>();
    private lobbyInterfaces = new Map<number, Map<string, number>>();
    private generation = 0;
    private lobbyEndpoint?: DirectPlayLobbyEndpoint;
    private lobbyEvents = new Map<number, Map<number, number>>();
    private lobbyOwnedEvents = new Set<number>();
    constructor(private process: Process, private tables: () => Record<string, VTableInfo>, private network: LanNetwork = lanNetwork) {}
    private valid(ptr: number, size: number, perms: "r" | "rw" | "rx" = "r"): boolean {
        return Number.isSafeInteger(ptr) && ptr >= 0x1000 && Number.isSafeInteger(size) && size >= 0
            && ptr + size <= this.process.getCurrentMemory().length && (this.process.addressSpace?.validateRange(ptr, size, perms) ?? true);
    }
    private text(ptr: number, limit = 1024, wide = false): string | null {
        if (!ptr) return "";
        if (wide) {
            let value = "";
            for (let i = 0; i <= limit; i++) {
                if (!this.valid(ptr + i * 2, 2)) return null;
                const unit = Mem.readUint16(ptr + i * 2)!;
                if (!unit) return value;
                value += String.fromCharCode(unit);
            }
            return null;
        }
        const data: number[] = [];
        for (let i = 0; i <= limit; i++) {
            if (!this.valid(ptr + i, 1)) return null;
            const n = Mem.readUint8(ptr + i);
            if (!n) return decodeAnsiString(new Uint8Array(data), 0, data.length, getAnsiCodePage());
            data.push(n);
        }
        return null;
    }
    private name(ptr: number, wide = false): PlayerName | null {
        if (!ptr) return { short: "", long: "", shortNull: true, longNull: true };
        if (!this.valid(ptr, 16) || Mem.readUint32(ptr) !== 16 || Mem.readUint32(ptr + 4)) return null;
        const short = this.text(Mem.readUint32(ptr + 8)!, 1024, wide), long = this.text(Mem.readUint32(ptr + 12)!, 1024, wide);
        return short === null || long === null ? null : { short, long, shortNull: !Mem.readUint32(ptr + 8), longNull: !Mem.readUint32(ptr + 12) };
    }
    private desc(ptr: number, legacy: boolean, wide = false): SessionDesc | null {
        if (!this.valid(ptr, legacy ? 124 : 80) || Mem.readUint32(ptr) !== (legacy ? 124 : 80)) return null;
        const application = hex(Mem.readBytes(ptr + (legacy ? 4 : 24), 16)!);
        const instance = legacy ? hex(Mem.readBytes(ptr + 20, 4)!) + "0".repeat(24) : hex(Mem.readBytes(ptr + 8, 16)!);
        const name = legacy ? this.text(ptr + 36, 31) : this.text(Mem.readUint32(ptr + 48)!, 1024, wide);
        const password = legacy ? this.text(ptr + 88, 15) : this.text(Mem.readUint32(ptr + 52)!, 1024, wide);
        if (name === null || password === null) return null;
        return { application, instance, flags: Mem.readUint32(ptr + (legacy ? 32 : 4))!,
            maxPlayers: Mem.readUint32(ptr + (legacy ? 24 : 40))!, name, password,
            nameNull: !legacy && !Mem.readUint32(ptr + 48), passwordNull: !legacy && !Mem.readUint32(ptr + 52),
            user: [0, 1, 2, 3].map(i => Mem.readUint32(ptr + (legacy ? 108 : 64) + i * 4)!) };
    }
    private state(ptr: number): GuestState | null {
        const obj = SystemResourceProvider.getInstance().getComObjectByAddress(ptr);
        if (!obj) return null;
        let state = this.states.get(obj.handle);
        if (!state) {
            state = { session: new DirectPlaySession(this.network), events: new Map(), localData: new Map(), interfaces: new Map(), sendQueue: new Map(), nextMessage: 1, asyncSends: null! };
            const ownState = state;
            state.asyncSends = new DirectPlaySendQueue((job, data) => ownState.session.send(job.from, job.to, job.flags & 0x1f, data),
                completion => ownState.session.enqueueSystem(completion.from, { type: 0x10d, completion }));
            state.session.onMessage = id => { const event = state!.events.get(id); if (event) System.getInstance().scheduler.setEvent(event); };
            this.states.set(obj.handle, state);
        }
        return state;
    }
    reset(): void {
        ++this.generation;
        this.lobbyEndpoint?.close(); this.lobbyEndpoint = undefined;
        for (const alias of this.lobbyOwnedEvents) System.getInstance().scheduler.syncObjects.closeEvent(alias);
        this.lobbyOwnedEvents.clear(); this.lobbyEvents.clear();
        for (const state of this.states.values()) { state.asyncSends.reset(); state.session.dispose(); }
        this.states.clear(); this.lobbyInterfaces.clear();
    }
    private lobby(): DirectPlayLobbyEndpoint {
        if (!this.lobbyEndpoint) {
            this.lobbyEndpoint = new DirectPlayLobbyEndpoint();
            this.lobbyEndpoint.onMessage = game => {
                for (const events of this.lobbyEvents.values()) {
                    const event = events.get(game);
                    if (event) System.getInstance().scheduler.setEvent(event);
                }
            };
        }
        return this.lobbyEndpoint;
    }
    private retainLobbyEvent(handle: number): number {
        if (!handle) return 0;
        const alias = System.getInstance().scheduler.syncObjects.duplicateEvent(handle) ?? 0;
        if (alias) this.lobbyOwnedEvents.add(alias);
        return alias;
    }
    private releaseLobbyEvent(alias: number): void {
        if (this.lobbyOwnedEvents.delete(alias)) System.getInstance().scheduler.syncObjects.closeEvent(alias);
    }
    private setLobbyEvent(owner: number, game: number, alias: number): number {
        const events = this.lobbyEvents.get(owner) ?? new Map<number, number>(), previous = events.get(game) ?? 0;
        if (alias) { events.set(game, alias); this.lobbyEvents.set(owner, events); }
        else { events.delete(game); if (!events.size) this.lobbyEvents.delete(owner); }
        return previous;
    }
    private lobbySubscribed(game: number): boolean {
        return [...this.lobbyEvents.values()].some(events => events.has(game));
    }
    private connection(ptr: number, wide: boolean): LobbySettings | null {
        if (!this.valid(ptr, 40) || Mem.readUint32(ptr) !== 40) return null;
        const flags = Mem.readUint32(ptr + 4)!, desc = this.desc(Mem.readUint32(ptr + 8)!, false, wide);
        const playerPtr = Mem.readUint32(ptr + 12)!, player = playerPtr ? this.name(playerPtr, wide) : null;
        const provider = hex(Mem.readBytes(ptr + 16, 16)!);
        const addressPtr = Mem.readUint32(ptr + 32)!, addressSize = Mem.readUint32(ptr + 36)!;
        if (!desc || (playerPtr && !player) || (flags !== 1 && flags !== 2) || addressSize > 65536 ||
            (addressSize && !this.valid(addressPtr, addressSize))) return null;
        return { desc, create: flags === 2, player, provider, address: addressSize ? Mem.readBytes(addressPtr, addressSize)!.slice() : EMPTY };
    }
    private packConnection(settings: LobbySettings, base: number, wide: boolean): Uint8Array {
        const desc = packDesc(settings.desc, 0, base + 40, false, wide);
        const headers = 120 + (settings.player ? 16 : 0);
        const b = new BufferWriter(headers, desc.length - 80 + (settings.player ? nameExtra(settings.player, wide) : 0) + settings.address.length, base);
        b.u32(0, 40); b.u32(4, settings.create ? 2 : 1); b.u32(8, base + 40);
        b.bytes.set(desc.subarray(0, 80), 40); b.bytes.set(unhex(settings.provider), 16);
        // Native DPLCONNECTION places every fixed structure before the strings.
        if (!settings.desc.nameNull) b.string(88, settings.desc.name, wide);
        if (!settings.desc.passwordNull) b.string(92, settings.desc.password, wide);
        if (settings.player) { b.u32(12, base + 120); writeName(b, 120, settings.player, wide); }
        if (settings.address.length) { b.blob(32, settings.address); b.u32(36, settings.address.length); }
        return b.bytes;
    }
    private lobbyHr(result: LobbyReply | Promise<LobbyReply>, after?: (reply: LobbyReply) => void): number | Promise<ThunkResult> {
        const finish = (reply: LobbyReply) => { if (!reply.hr) after?.(reply); return reply.hr; };
        if (!(result instanceof Promise)) return finish(result);
        const generation = this.generation;
        return result.then(reply => ({ value: generation === this.generation ? finish(reply) : DP.SESSIONLOST }));
    }
    private lobbyBuffer(result: LobbyReply | Promise<LobbyReply>, out: number, sizePtr: number, capacity: number,
        pack: (reply: LobbyReply, base: number) => Uint8Array): number | Promise<ThunkResult> {
        const generation = this.generation;
        const prepared = (reply: LobbyReply): { hr: number; bytes?: Uint8Array; size?: number } => {
            if (reply.hr) return { hr: reply.hr };
            // Native includes its two-DWORD packed-header overhead in the required
            // capacity, then unpacks only the actual structures and preserves a large
            // caller capacity on success. The unused eight trailing bytes stay untouched.
            const size = pack(reply, 0).length + 8;
            return !out || capacity < size ? { hr: DP.BUFFERTOOSMALL, size } : { hr: DP.OK, bytes: pack(reply, out) };
        };
        if (!(result instanceof Promise)) {
            const value = prepared(result);
            if (value.size !== undefined) Mem.writeUint32(sizePtr, value.size);
            if (value.bytes) Mem.writeBytes(out, value.bytes);
            return value.hr;
        }
        return result.then(reply => {
            if (generation !== this.generation) return { value: DP.SESSIONLOST };
            const value = prepared(reply);
            return { value: value.hr, startCallbackChain: () => {
                if (generation === this.generation) {
                    if (value.size !== undefined) Mem.writeUint32(sizePtr, value.size);
                    if (value.bytes) Mem.writeBytes(out, value.bytes);
                }
                return false;
            } };
        });
    }
    private buffer(out: number, sizePtr: number, pack: (base: number) => Uint8Array): number {
        if (!this.valid(sizePtr, 4, "rw")) return E_POINTER;
        const size = pack(0).length, capacity = Mem.readUint32(sizePtr)!;
        Mem.writeUint32(sizePtr, size);
        if (!size) return DP.OK;
        if (!out || capacity < size) return DP.BUFFERTOOSMALL;
        if (!this.valid(out, size, "rw")) return E_POINTER;
        Mem.writeBytes(out, pack(out)); return DP.OK;
    }
    private enumerate(frame: Frame, callback: number, cleanup: number, entries: EnumerationEntry[]): number | ThunkResult {
        if (!this.valid(callback, 1, "rx")) return DP.INVALIDPARAMS;
        if (!entries.length) return DP.OK;
        const manager = this.process.dispatcher.callbackManager;
        if (!manager) return DP.UNAVAILABLE;
        const size = Math.max(...entries.map(e => e.pack(0).length), 4);
        const allocation = this.process.memory.alloc(size);
        if (!allocation) return 0x8007000e;
        const id = manager.saveSuspendedThunkContext(frame, cleanup, "DirectPlay enumeration");
        if (!id) { this.process.memory.free(allocation); return DP.UNAVAILABLE; }
        let index = 0, first = 0;
        const release = (): void => this.process.memory.free(allocation);
        const next = (): void => {
            const entry = entries[index++];
            Mem.writeBytes(allocation, entry.pack(allocation));
            const invocation = manager.invokeCallback(callback, entry.args(allocation), 0, value => {
                if (!value || index === entries.length) { release(); return DP.OK; }
                return null;
            }, false, "DirectPlay enumeration", id);
            if (!first) first = invocation.callbackId;
            const pending = manager.getPendingCallback(invocation.callbackId);
            if (pending) pending.enumerationState = { continueEnumeration: next, finishEnumeration: release };
        };
        try { next(); } catch { release(); manager.abandonSuspendedFrame(id); return DP.UNAVAILABLE; }
        if (!first) { release(); manager.abandonSuspendedFrame(id); return DP.UNAVAILABLE; }
        return { value: DP.OK, suspendedForCallback: true, callbackId: first, stackCleanup: cleanup, skipStackCheck: true };
    }
    install(exports: Record<string, ThunkImplementation>): void {
        const methods: Record<string, (s: GuestState, a: number[], legacy: boolean, ctx: Frame, wide?: boolean) => ReturnType<ThunkImplementation>> = {};
        // NT5 iplay.c DP_Initialize is obsolete and always answers ALREADYINITIALIZED.
        methods.Initialize = () => DP.ALREADYINITIALIZED;
        methods.InitializeConnection = (s, a) => {
            if (a[2]) return DP.INVALIDFLAGS;
            if (!this.valid(a[1], 20)) return DP.INVALIDPARAMS;
            let ptr = a[1], total = 0, provider = "";
            for (let i = 0; i < 64; i++) {
                if (!this.valid(ptr, 20)) break;
                const type = hex(Mem.readBytes(ptr, 16)!), size = Mem.readUint32(ptr + 16)!;
                if (size > 65536 || !this.valid(ptr + 20, size)) return DP.INVALIDPARAMS;
                if (type === TOTAL_GUID && size === 4) total = Mem.readUint32(ptr + 20)!;
                if (type === SERVICE_GUID && size === 16) { provider = hex(Mem.readBytes(ptr + 20, 16)!); break; }
                ptr += 20 + size;
                if (total && ptr >= a[1] + total) break;
            }
            return PROVIDERS.some(p => p.guid === provider) ? s.session.initialize() : DP.UNAVAILABLE;
        };
        methods.Open = (s, a, legacy, ctx, wide = false) => {
            if (s.session.readyError) return s.session.readyError;
            const desc = this.desc(a[1], legacy, wide);
            if (!desc) return DP.INVALIDPARAMS;
            const flags = legacy ? (desc.instance.startsWith("00000000") ? 2 : 1) : a[2];
            if (flags & ~0x83 || (flags & 3) === 3 || !(flags & 3)) return DP.INVALIDFLAGS;
            if (flags & 2) return s.session.create(desc);
            if (legacy) {
                const found = [...s.session.discovered.keys()].find(id => id.startsWith(desc.instance.slice(0, 8)));
                if (found) desc.instance = found;
            }
            return s.session.join(desc);
        };
        methods.Close = s => { s.asyncSends.reset(); s.events.clear(); s.localData.clear(); s.sendQueue.clear(); return s.session.close(); };
        for (const group of [false, true]) {
            const kind = group ? "Group" : "Player";
            methods["Create" + kind] = (s, a, legacy, _ctx, wide = false) => {
                if (s.session.openError) return s.session.openError;
                if (!this.valid(a[1], 4, "rw")) return E_POINTER;
                const name = legacy ? { short: this.text(a[2]), long: this.text(a[3]), shortNull: !a[2], longNull: !a[3] } : this.name(a[2], wide);
                if (!name || name.short === null || name.long === null) return DP.INVALIDPARAMS;
                const dataPtr = legacy ? 0 : a[group ? 3 : 4], dataSize = legacy ? 0 : a[group ? 4 : 5];
                const flags = legacy ? 0 : a[group ? 5 : 6];
                if (flags & ~(group ? 0x1800 : 0x300)) return DP.INVALIDFLAGS;
                if (dataSize > DPLAY_MAX_MESSAGE || (dataSize && !this.valid(dataPtr, dataSize))) return DP.INVALIDPARAMS;
                const event = group ? 0 : legacy ? (a[4] && this.valid(a[4], 4) ? Mem.readUint32(a[4])! : 0) : a[3];
                const result = s.session.mutate({ op: "mutate", action: "create", group, flags, name, parent: group ? a[6] ?? 0 : 0,
                    data: dataSize ? Array.from(Mem.readBytes(dataPtr, dataSize)!) : [] });
                const finish = (reply: Reply): number => {
                    if (!reply.hr && reply.id) {
                        if (!this.valid(a[1], 4, "rw")) return E_POINTER;
                        Mem.writeUint32(a[1], reply.id); if (event) s.events.set(reply.id, event);
                    }
                    return reply.hr;
                };
                if (!(result instanceof Promise)) return finish(result);
                return result.then<ThunkResult>(reply => {
                    if (reply.hr || !reply.id) return { value: reply.hr };
                    if (!this.valid(a[1], 4, "rw")) return { value: E_POINTER };
                    if (event) s.events.set(reply.id, event);
                    return { value: DP.OK, deferredWrites: [{ address: a[1], value: reply.id, size: 4 }] };
                });
            };
            methods["Destroy" + kind] = (s, a) => {
                const e = s.session.entities.get(a[1]);
                if (e?.group !== group) return group ? DP.INVALIDGROUP : DP.INVALIDPLAYER;
                const result = s.session.mutate({ op: "mutate", action: "destroy", id: a[1], group });
                const finish = (r: Reply): number => { if (!r.hr) { s.events.delete(a[1]); s.localData.delete(a[1]); } return r.hr; };
                return result instanceof Promise ? result.then<number>(finish) : finish(result);
            };
            methods["Get" + kind + "Name"] = (s, a, legacy, _ctx, wide = false) => {
                const e = s.session.entities.get(a[1]);
                if (e?.group !== group) return group ? DP.INVALIDGROUP : DP.INVALIDPLAYER;
                if (legacy) {
                    const short = encodeAnsi(e.name.short + "\0"), long = encodeAnsi(e.name.long + "\0");
                    if (!this.valid(a[3], 4, "rw") || !this.valid(a[5], 4, "rw")) return E_POINTER;
                    const cap1 = Mem.readUint32(a[3])!, cap2 = Mem.readUint32(a[5])!;
                    Mem.writeUint32(a[3], short.length); Mem.writeUint32(a[5], long.length);
                    if (!a[2] || !a[4] || cap1 < short.length || cap2 < long.length) return DP.BUFFERTOOSMALL;
                    if (!this.valid(a[2], short.length, "rw") || !this.valid(a[4], long.length, "rw")) return E_POINTER;
                    Mem.writeBytes(a[2], short); Mem.writeBytes(a[4], long); return DP.OK;
                }
                return this.buffer(a[2], a[3], base => packName(e.name, base, wide));
            };
            methods["Set" + kind + "Name"] = (s, a, legacy, _ctx, wide = false) => {
                const name = legacy ? { short: this.text(a[2]), long: this.text(a[3]), shortNull: !a[2], longNull: !a[3] } : this.name(a[2], wide);
                if (!name || name.short === null || name.long === null) return DP.INVALIDPARAMS;
                if (!legacy && a[3] & ~2) return DP.INVALIDFLAGS;
                const r = s.session.mutate({ op: "mutate", action: "name", id: a[1], group, name });
                return r instanceof Promise ? r.then<number>(v => v.hr) : r.hr;
            };
            methods["Get" + kind + "Data"] = (s, a) => {
                const e = s.session.entities.get(a[1]);
                if (e?.group !== group) return group ? DP.INVALIDGROUP : DP.INVALIDPLAYER;
                if (a[4] & ~1) return DP.INVALIDFLAGS;
                const data = a[4] & 1 ? s.localData.get(e.id) ?? EMPTY : new Uint8Array(e.data);
                return this.buffer(a[2], a[3], () => data);
            };
            methods["Set" + kind + "Data"] = (s, a) => {
                const e = s.session.entities.get(a[1]);
                if (e?.group !== group) return group ? DP.INVALIDGROUP : DP.INVALIDPLAYER;
                if (a[4] & ~3) return DP.INVALIDFLAGS;
                if (a[3] > DPLAY_MAX_MESSAGE || (a[3] && !this.valid(a[2], a[3]))) return DP.INVALIDPARAMS;
                const data = a[3] ? Mem.readBytes(a[2], a[3])!.slice() : EMPTY;
                if (a[4] & 1) { s.localData.set(e.id, data); return DP.OK; }
                const r = s.session.mutate({ op: "mutate", action: "data", id: e.id, group, data: Array.from(data) });
                return r instanceof Promise ? r.then<number>(v => v.hr) : r.hr;
            };
        }
        for (const add of [false, true]) for (const group of [false, true]) {
            const method = (add ? "Add" : "Delete") + (group ? "Group" : "Player") + (add ? "ToGroup" : "FromGroup");
            methods[method] = (s, a) => {
                if (s.session.entities.get(a[2])?.group !== group) return group ? DP.INVALIDGROUP : DP.INVALIDPLAYER;
                const r = s.session.mutate({ op: "mutate", action: "member", id: a[1], member: a[2], add });
                return r instanceof Promise ? r.then<number>(v => v.hr) : r.hr;
            };
        }
        methods.CreateGroupInGroup = (s, a, legacy, ctx, wide = false) =>
            methods.CreateGroup(s, [a[0], a[2], a[3], a[4], a[5], a[6], a[1]], legacy, ctx, wide);
        methods.SetGroupOwner = (s, a) => {
            const r = s.session.mutate({ op: "mutate", action: "owner", id: a[1], player: a[2] });
            return r instanceof Promise ? r.then<number>(v => v.hr) : r.hr;
        };
        methods.SendEx = (s, a, legacy, ctx, wide = false) => {
            const from = s.session.entities.get(a[1]);
            if (!from || from.group) return DP.INVALIDPLAYER;
            if (from.owner !== s.session.ownKey) return DP.ACCESSDENIED;
            if (a[2] && !s.session.entities.has(a[2])) return DP.INVALIDPLAYER;
            if (a[3] & ~0xe7f || (a[3] & 0x60) || (!(a[3] & 0x200) && (a[3] & 0x400))) return DP.INVALIDFLAGS;
            if (a[6] > 0xffff) return DP.INVALIDPRIORITY;
            if (!this.valid(a[9], 4, "rw") || !a[5] || a[5] > DPLAY_MAX_MESSAGE || !this.valid(a[4], a[5])) return DP.INVALIDPARAMS;
            if (!(a[3] & 0x200)) {
                Mem.writeUint32(a[9], 0);
                return methods.Send(s, a.slice(0, 6), legacy, ctx, wide);
            }
            const admissionError = s.asyncSends.admissionError(a[5]); if (admissionError) return admissionError;
            const copied = a[3] & 0x800 ? null : Mem.readBytes(a[4], a[5])!.slice();
            const admitted = s.asyncSends.enqueue({ from: a[1], to: a[2], flags: a[3], priority: a[6], timeout: a[7], context: a[8],
                data: () => copied ?? (this.valid(a[4], a[5]) ? this.process.getCurrentMemory().slice(a[4], a[4] + a[5]) : null) }, a[5]);
            if (admitted.hr) return admitted.hr;
            Mem.writeUint32(a[9], admitted.id); return DP.PENDING;
        };
        methods.CancelMessage = (s, a) => a[2] ? DP.INVALIDFLAGS : s.asyncSends.cancel(a[1]);
        methods.CancelPriority = (s, a) => a[3] ? DP.INVALIDFLAGS : s.asyncSends.cancelPriority(a[1], a[2]);
        methods.SendChatMessage = (s, a, _legacy, _ctx, wide = false) => {
            const player = s.session.entities.get(a[1]);
            if (!player || player.group) return DP.INVALIDPLAYER;
            if (player.owner !== s.session.ownKey) return DP.ACCESSDENIED;
            if (a[3] & ~1) return DP.INVALIDFLAGS;
            if (!this.valid(a[4], 12) || Mem.readUint32(a[4]) !== 12) return DP.INVALIDPARAMS;
            if (Mem.readUint32(a[4] + 4)) return DP.INVALIDFLAGS;
            const ptr = Mem.readUint32(a[4] + 8)!;
            if (!ptr) return DP.INVALIDPARAMS;
            const text = this.text(ptr, 1024, wide); if (text === null) return DP.INVALIDPARAMS;
            return s.session.sendChat(a[1], a[2], a[3], text);
        };
        // NT5 iplay1.c: DP_1_SaveSession is unimplemented even for an open session.
        methods.SaveSession = () => DP.UNSUPPORTED;
        methods.GetPlayerAccount = (s, a) => {
            if (a[2]) return DP.INVALIDFLAGS;
            if (!s.session.desc) return DP.NOSESSIONS;
            if (!(s.session.desc.flags & 0x100)) return DP.UNSUPPORTED;
            if (!s.session.isHost) return DP.ACCESSDENIED;
            return DP.INVALIDPLAYER;
        };
        // A TCP/IP/IPX service provider is not a lobby service provider (NT5 group.c).
        methods.GetGroupConnectionSettings = () => DP.UNSUPPORTED;
        methods.SetGroupConnectionSettings = () => DP.UNSUPPORTED;
        methods.StartSession = () => DP.UNSUPPORTED;
        methods.SecureOpen = (s, a, legacy, ctx, wide = false) => {
            if (a[3] || a[4]) return DP.UNSUPPORTED;
            return methods.Open(s, a.slice(0, 3), legacy, ctx, wide);
        };
        methods.Send = (s, a) => {
            if (a[5] > DPLAY_MAX_MESSAGE || (a[5] && !this.valid(a[4], a[5]))) return DP.INVALIDPARAMS;
            const data = a[5] ? Mem.readBytes(a[4], a[5])!.slice() : EMPTY;
            const id = s.nextMessage++, result = s.session.send(a[1], a[2], a[3], data);
            if (!(result instanceof Promise)) return result;
            s.sendQueue.set(id, { from: a[1], to: a[2], bytes: data.length });
            return result.then<number>(hr => { s.sendQueue.delete(id); return hr; });
        };
        methods.Receive = (s, a, legacy, ctx, wide = false) => {
            if (a[3] & ~15 || (a[3] & 1 && a[3] & 6)) return DP.INVALIDFLAGS;
            if (!this.valid(a[5], 4, "rw") || (a[1] && !this.valid(a[1], 4, "rw")) || (a[2] && !this.valid(a[2], 4, "rw"))) return E_POINTER;
            if ((a[3] & 4 && !a[1]) || (a[3] & 2 && !a[2])) return E_POINTER;
            const from = a[3] & 4 ? Mem.readUint32(a[1])! : 0, to = a[3] & 2 ? Mem.readUint32(a[2])! : 0;
            const index = s.session.queue.findIndex(m => (!(a[3] & 4) || m.from === from) && (!(a[3] & 2) || m.to === to));
            if (index < 0) return s.session.readyError || DP.NOMESSAGES;
            const m = s.session.queue[index];
            const result = this.buffer(a[4], a[5], base => packDirectPlayMessage(m, base, s.session.currentPlayers, wide));
            if (!result) {
                if (a[1]) Mem.writeUint32(a[1], m.from); if (a[2]) Mem.writeUint32(a[2], m.to);
                if (!(a[3] & 8)) s.session.removeMessage(index);
            }
            return result;
        };
        methods.GetMessageCount = (s, a) => {
            if (!this.valid(a[2], 4, "rw")) return E_POINTER;
            if (a[1] && (s.session.entities.get(a[1])?.owner !== s.session.ownKey || s.session.entities.get(a[1])?.group)) return DP.INVALIDPLAYER;
            Mem.writeUint32(a[2], s.session.queue.filter(m => !a[1] || m.to === a[1]).length); return DP.OK;
        };
        methods.GetMessageQueue = (s, a, legacy, ctx, wide = false) => {
            const flags = a[3] || 1;
            if (flags !== 1 && flags !== 2) return DP.INVALIDFLAGS;
            for (const [id, local] of [[a[1], flags === 1], [a[2], flags === 2]] as const) {
                if (!id) continue;
                const entity = s.session.entities.get(id);
                if (!entity || entity.group || (local && entity.owner !== s.session.ownKey)) return DP.INVALIDPLAYER;
            }
            if ((a[4] && !this.valid(a[4], 4, "rw")) || (a[5] && !this.valid(a[5], 4, "rw"))) return E_POINTER;
            const queue = flags === 1 ? [...s.sendQueue.values(), ...s.asyncSends.pending] : s.session.queue.map(m => ({ from: m.from, to: m.to, bytes: packDirectPlayMessage(m, 0, s.session.currentPlayers, wide).length }));
            const filtered = queue.filter(m => (!a[1] || m.from === a[1]) && (!a[2] || m.to === a[2]));
            if (a[4]) Mem.writeUint32(a[4], filtered.length); if (a[5]) Mem.writeUint32(a[5], filtered.reduce((n, m) => n + m.bytes, 0));
            return DP.OK;
        };
        methods.GetPlayerAddress = (s, a) => {
            const e = s.session.entities.get(a[1]); if (!e || e.group) return DP.INVALIDPLAYER;
            const node = e.owner.split(":")[0].split(".").map(Number);
            const address = encodeAnsi([10, node[3], node[4], node[5]].join(".") + "\0");
            return this.buffer(a[2], a[3], () => packAddress([
                { guid: SERVICE_GUID, data: unhex(PROVIDERS[0].guid) }, { guid: INET_GUID, data: address },
            ]));
        };
        methods.GetSessionDesc = (s, a, legacy, ctx, wide = false) => s.session.desc ? this.buffer(a[1], a[2], base => packDesc(s.session.desc!, s.session.currentPlayers, base, legacy, wide)) : DP.NOSESSIONS;
        methods.SetSessionDesc = (s, a, legacy, ctx, wide = false) => {
            if (a[2]) return DP.INVALIDPARAMS;
            const desc = this.desc(a[1], false, wide); if (!desc) return DP.INVALIDPARAMS;
            const current = s.session.desc; if (!current) return 0x80004005;
            if (desc.flags & ~0xffed) return DP.INVALIDFLAGS;
            if ((desc.flags ^ current.flags) & 0xb94c) return DP.INVALIDPARAMS;
            if (desc.maxPlayers && desc.maxPlayers < s.session.currentPlayers) return DP.INVALIDPARAMS;
            desc.instance = current.instance; desc.application = current.application;
            const r = s.session.mutate({ op: "mutate", action: "session", desc });
            return r instanceof Promise ? r.then<number>(v => v.hr) : r.hr;
        };
        methods.EnableNewPlayers = (s, a) => {
            if (!s.session.desc) return DP.NOSESSIONS;
            const desc = { ...s.session.desc, flags: a[1] ? s.session.desc.flags & ~1 : s.session.desc.flags | 1 };
            const r = s.session.mutate({ op: "mutate", action: "session", desc }); return r instanceof Promise ? r.then<number>(v => v.hr) : r.hr;
        };
        methods.GetCaps = (s, a, legacy) => {
            const size = legacy ? 24 : 40;
            if (!this.valid(a[1], size, "rw") || Mem.readUint32(a[1]) !== size) return DP.INVALIDPARAMS;
            const b = new BufferWriter(size); b.u32(0, size); b.u32(4, (s.session.isHost ? 2 : 0) | 0x1f040);
            b.u32(8, DPLAY_MAX_MESSAGE); b.u32(12, 4 * 1024 * 1024); b.u32(16, 64);
            if (!legacy) { b.u32(28, 64); b.u32(36, 10000); }
            Mem.writeBytes(a[1], b.bytes); return DP.OK;
        };
        methods.GetPlayerCaps = (s, a, legacy, ctx, wide = false) => {
            if (!s.session.entities.has(a[1])) return DP.INVALIDPLAYER;
            return methods.GetCaps(s, [a[0], a[2], legacy ? 0 : a[3]], legacy, ctx, wide);
        };
        for (const field of ["PlayerFlags", "GroupFlags", "GroupParent", "GroupOwner"]) {
            methods["Get" + field] = (s, a) => {
                const e = s.session.entities.get(a[1]), group = field.startsWith("Group");
                if (e?.group !== group) return group ? DP.INVALIDGROUP : DP.INVALIDPLAYER;
                if (!this.valid(a[2], 4, "rw")) return E_POINTER;
                const value = field.endsWith("Parent") ? e.parent : field.endsWith("Owner") ? e.groupOwner : e.flags | (e.owner === s.session.ownKey ? 8 : 0);
                Mem.writeUint32(a[2], value); return DP.OK;
            };
        }
        for (const method of ["EnumPlayers", "EnumGroups", "EnumGroupPlayers", "EnumGroupsInGroup"]) {
            methods[method] = (s, a, legacy, ctx, wide = false) => {
                const inGroup = method.endsWith("InGroup") || method === "EnumGroupPlayers";
                const groups = method === "EnumGroups" || method === "EnumGroupsInGroup";
                const cbIndex = inGroup ? legacy ? 2 : 3 : 2;
                const cb = a[cbIndex], context = a[cbIndex + 1], flags = a[cbIndex + 2];
                const allowed = groups ? 0x1c98 : method === "EnumGroupPlayers" ? 0x2398 : 0x3b8;
                if (flags & ~allowed) return DP.INVALIDFLAGS;
                if (!this.valid(cb, 1, "rx")) return DP.INVALIDPARAMS;
                const cleanup = (inGroup ? legacy ? 5 : 6 : 5) * 4;
                const entries = (): EnumerationEntry[] => {
                    const parent = inGroup ? s.session.entities.get(a[1]) : undefined;
                    return [...s.session.entities.values()].filter(e => {
                        const eligibleType = e.group === groups || (method === "EnumPlayers" && !!(flags & 0x20) && e.group);
                        if (!eligibleType || (parent && !parent.members.includes(e.id))) return false;
                        if ((flags & 8) && e.owner !== s.session.ownKey) return false;
                        if ((flags & 16) && e.owner === s.session.ownKey) return false;
                        if (!e.group && ((flags & 0x100 && !(e.flags & 0x100)) || (flags & 0x200 && !(e.flags & 0x200)))) return false;
                        if (flags & 0x2000 && parent?.groupOwner !== e.id) return false;
                        if (e.group && (flags & 0x800) && !(e.flags & 0x800)) return false;
                        if (e.group && (flags & 0x1000) && !(e.flags & 0x1000)) return false;
                        if (e.group && (flags & 0x400) && (!parent || e.parent === parent.id)) return false;
                        return true;
                    }).map(e => ({
                        pack: (base: number) => packName(e.name, base, wide),
                        args: (base: number) => {
                            const callbackFlags = flags | e.flags | (parent?.groupOwner === e.id ? 0x2000 : 0)
                                | (e.group && parent && e.parent !== parent.id ? 0x400 : 0);
                            return legacy ? [e.id, base + 16, base + 16 + encodeAnsi(e.name.short + "\\0").length, callbackFlags, context]
                                : [e.id, e.group ? 0 : 1, base, callbackFlags, context];
                        },
                    }));
                };
                if (flags & 0x80) {
                    if (s.session.desc) return DP.INVALIDPARAMS;
                    const guidPtr = a[inGroup ? 2 : 1];
                    if (legacy || !this.valid(guidPtr, 16)) return DP.INVALIDPARAMS;
                    const instance = hex(Mem.readBytes(guidPtr, 16)!);
                    const target = s.session.discovered.get(instance); if (!target) return DP.NOSESSIONS;
                    return s.session.join(target.desc).then<ThunkResult>(hr => {
                        if (hr) return { value: hr };
                        const items = entries(); s.session.close();
                        return { value: DP.OK, startCallbackChain: frame => {
                            const result = this.enumerate(frame, cb, cleanup, items);
                            return typeof result === "object" && !!result.suspendedForCallback;
                        } };
                    });
                }
                if (s.session.openError) return s.session.openError;
                if (inGroup && !s.session.entities.get(a[1])?.group) return DP.INVALIDGROUP;
                return this.enumerate(ctx, cb, cleanup, entries());
            };
        }
        methods.EnumSessions = (s, a, legacy, ctx, wide = false) => {
            if (a[5] & 0x20) { s.session.stopDiscovery(); return DP.OK; }
            if (a[5] & ~0xf3) return DP.INVALIDFLAGS;
            if (!this.valid(a[3], 1, "rx")) return DP.INVALIDPARAMS;
            const desc = this.desc(a[1], legacy, wide); if (!desc) return DP.INVALIDPARAMS;
            const error = s.session.discover(desc.application); if (error) return error;
            const timeout = Math.min(a[2] || 1000, 30000);
            const entriesForCache = (): EnumerationEntry[] => {
                const entries: EnumerationEntry[] = [...s.session.discovered.values()]
                    .filter(d => desc.application === ZERO_GUID || d.desc.application === desc.application)
                    .filter(d => !(a[5] & 1) || !d.desc.maxPlayers || d.currentPlayers < d.desc.maxPlayers)
                    .map(d => ({
                        pack: (base: number) => {
                            const sd = packDesc(d.desc, d.currentPlayers, base, legacy, wide), bytes = new Uint8Array(sd.length + 4);
                            bytes.set(sd); new DataView(bytes.buffer).setUint32(sd.length, timeout, true); return bytes;
                        },
                        args: (base: number) => {
                            const len = packDesc(d.desc, d.currentPlayers, 0, legacy, wide).length;
                            return legacy ? [base, a[4], base + len, 0] : [base, base + len, 0, a[4]];
                        },
                    }));
                entries.push({ pack: () => new Uint8Array(4), args: base => legacy ? [0, a[4], base, 1] : [0, base, 1, a[4]] });
                return entries;
            };
            if (a[5] & 0x10) {
                s.session.startDiscovery(desc.application, timeout);
                return this.enumerate(ctx, a[3], 24, entriesForCache());
            }
            return new Promise<ThunkResult>(resolve => setTimeout(() => resolve({
                value: DP.OK, startCallbackChain: frame => {
                    const result = this.enumerate(frame, a[3], 24, entriesForCache());
                    return typeof result === "object" && !!result.suspendedForCallback;
                },
            }), timeout));
        };
        methods.EnumConnections = (_s, a, _legacy, ctx, wide = false) => this.enumerate(ctx, a[2], 20, PROVIDERS.map(provider => ({
            pack: (base: number) => {
                const name = { short: provider.name, long: provider.name }, b = new BufferWriter(16 + 36 + 16, nameExtra(name, wide), base);
                b.bytes.set(unhex(provider.guid)); b.bytes.set(unhex(SERVICE_GUID), 16); b.u32(32, 16); b.bytes.set(unhex(provider.guid), 36);
                writeName(b, 52, name, wide); return b.bytes;
            },
            args: base => [base, base + 16, 36, base + 52, 1, a[3]],
        })));
        const resource = SystemResourceProvider.getInstance();
        const bind = (ifaceName: string, methodName: string): ThunkImplementation => {
            const iface = dplayxModule.interfaces!.find(i => i.name === ifaceName)!;
            const method = iface.methods.find(m => m.name === methodName)!;
            const legacy = ifaceName === "IDirectPlay";
            const wide = !legacy && !ifaceName.endsWith("A");
            const handler = methods[methodName];
            return (ctx, _mem, args) => {
                const a = args.slice(0, method.params.length);
                if (methodName === "QueryInterface") {
                    if (!this.valid(a[2], 4, "rw") || !this.valid(a[1], 16)) return E_POINTER;
                    Mem.writeUint32(a[2], 0);
                    const obj = resource.getComObjectByAddress(a[0]), state = this.state(a[0]);
                    if (!obj || !state) return DPERR_INVALIDOBJECT;
                    const iid = hex(Mem.readBytes(a[1], 16)!);
                    const target = (dplayxModule.interfaces ?? []).find(i => i.name.startsWith("IDirectPlay") && !i.name.includes("Lobby") && i.iid && iidHex(i.iid) === iid);
                    const unknown = iid === iidHex("00000000-0000-0000-c000-000000000046");
                    if (!target && !unknown) return E_NOINTERFACE;
                    let ptr = unknown ? resource.getPrimaryAddressForHandle(obj.handle) ?? a[0] : state.interfaces.get(target!.name);
                    if (!ptr) {
                        ptr = allocateComObject(this.process.memory, this.process.getCurrentMemory(), this.tables()[target!.name].address);
                        resource.mapAddressToHandle(ptr, obj.handle); state.interfaces.set(target!.name, ptr);
                    }
                    obj.addRef(); Mem.writeUint32(a[2], ptr); return DP.OK;
                }
                if (methodName === "AddRef") return resource.getComObjectByAddress(a[0])?.addRef() ?? 0;
                if (methodName === "Release") {
                    const obj = resource.getComObjectByAddress(a[0]); if (!obj) return 0;
                    const handle = obj.handle, result = obj.release();
                    if (!result) { this.states.get(handle)?.asyncSends.reset(); this.states.get(handle)?.session.dispose(); this.states.delete(handle); }
                    return result;
                }
                const state = this.state(a[0]);
                if (!state) return DPERR_INVALIDOBJECT;
                if (!["Initialize", "InitializeConnection", "EnumConnections", "SaveSession"].includes(methodName) && state.session.readyError
                    && !(methodName === "Receive" && state.session.queue.length)) return state.session.readyError;
                return handler ? handler(state, a, legacy, ctx, wide) : DP.UNSUPPORTED;
            };
        };
        exports["IDirectPlay_QueryInterface"] = bind("IDirectPlay", "QueryInterface");
        exports["IDirectPlay_AddRef"] = bind("IDirectPlay", "AddRef");
        exports["IDirectPlay_Release"] = bind("IDirectPlay", "Release");
        exports["IDirectPlay_AddPlayerToGroup"] = bind("IDirectPlay", "AddPlayerToGroup");
        exports["IDirectPlay_Close"] = bind("IDirectPlay", "Close");
        exports["IDirectPlay_CreatePlayer"] = bind("IDirectPlay", "CreatePlayer");
        exports["IDirectPlay_CreateGroup"] = bind("IDirectPlay", "CreateGroup");
        exports["IDirectPlay_DeletePlayerFromGroup"] = bind("IDirectPlay", "DeletePlayerFromGroup");
        exports["IDirectPlay_DestroyPlayer"] = bind("IDirectPlay", "DestroyPlayer");
        exports["IDirectPlay_DestroyGroup"] = bind("IDirectPlay", "DestroyGroup");
        exports["IDirectPlay_EnableNewPlayers"] = bind("IDirectPlay", "EnableNewPlayers");
        exports["IDirectPlay_EnumGroupPlayers"] = bind("IDirectPlay", "EnumGroupPlayers");
        exports["IDirectPlay_EnumGroups"] = bind("IDirectPlay", "EnumGroups");
        exports["IDirectPlay_EnumPlayers"] = bind("IDirectPlay", "EnumPlayers");
        exports["IDirectPlay_EnumSessions"] = bind("IDirectPlay", "EnumSessions");
        exports["IDirectPlay_GetCaps"] = bind("IDirectPlay", "GetCaps");
        exports["IDirectPlay_GetMessageCount"] = bind("IDirectPlay", "GetMessageCount");
        exports["IDirectPlay_GetPlayerCaps"] = bind("IDirectPlay", "GetPlayerCaps");
        exports["IDirectPlay_GetPlayerName"] = bind("IDirectPlay", "GetPlayerName");
        exports["IDirectPlay_Initialize"] = bind("IDirectPlay", "Initialize");
        exports["IDirectPlay_Open"] = bind("IDirectPlay", "Open");
        exports["IDirectPlay_Receive"] = bind("IDirectPlay", "Receive");
        exports["IDirectPlay_SaveSession"] = bind("IDirectPlay", "SaveSession");
        exports["IDirectPlay_Send"] = bind("IDirectPlay", "Send");
        exports["IDirectPlay_SetPlayerName"] = bind("IDirectPlay", "SetPlayerName");
        exports["IDirectPlay2A_QueryInterface"] = bind("IDirectPlay2A", "QueryInterface");
        exports["IDirectPlay2A_AddRef"] = bind("IDirectPlay2A", "AddRef");
        exports["IDirectPlay2A_Release"] = bind("IDirectPlay2A", "Release");
        exports["IDirectPlay2A_AddPlayerToGroup"] = bind("IDirectPlay2A", "AddPlayerToGroup");
        exports["IDirectPlay2A_Close"] = bind("IDirectPlay2A", "Close");
        exports["IDirectPlay2A_CreateGroup"] = bind("IDirectPlay2A", "CreateGroup");
        exports["IDirectPlay2A_CreatePlayer"] = bind("IDirectPlay2A", "CreatePlayer");
        exports["IDirectPlay2A_DeletePlayerFromGroup"] = bind("IDirectPlay2A", "DeletePlayerFromGroup");
        exports["IDirectPlay2A_DestroyGroup"] = bind("IDirectPlay2A", "DestroyGroup");
        exports["IDirectPlay2A_DestroyPlayer"] = bind("IDirectPlay2A", "DestroyPlayer");
        exports["IDirectPlay2A_EnumGroupPlayers"] = bind("IDirectPlay2A", "EnumGroupPlayers");
        exports["IDirectPlay2A_EnumGroups"] = bind("IDirectPlay2A", "EnumGroups");
        exports["IDirectPlay2A_EnumPlayers"] = bind("IDirectPlay2A", "EnumPlayers");
        exports["IDirectPlay2A_EnumSessions"] = bind("IDirectPlay2A", "EnumSessions");
        exports["IDirectPlay2A_GetCaps"] = bind("IDirectPlay2A", "GetCaps");
        exports["IDirectPlay2A_GetGroupData"] = bind("IDirectPlay2A", "GetGroupData");
        exports["IDirectPlay2A_GetGroupName"] = bind("IDirectPlay2A", "GetGroupName");
        exports["IDirectPlay2A_GetMessageCount"] = bind("IDirectPlay2A", "GetMessageCount");
        exports["IDirectPlay2A_GetPlayerAddress"] = bind("IDirectPlay2A", "GetPlayerAddress");
        exports["IDirectPlay2A_GetPlayerCaps"] = bind("IDirectPlay2A", "GetPlayerCaps");
        exports["IDirectPlay2A_GetPlayerData"] = bind("IDirectPlay2A", "GetPlayerData");
        exports["IDirectPlay2A_GetPlayerName"] = bind("IDirectPlay2A", "GetPlayerName");
        exports["IDirectPlay2A_GetSessionDesc"] = bind("IDirectPlay2A", "GetSessionDesc");
        exports["IDirectPlay2A_Initialize"] = bind("IDirectPlay2A", "Initialize");
        exports["IDirectPlay2A_Open"] = bind("IDirectPlay2A", "Open");
        exports["IDirectPlay2A_Receive"] = bind("IDirectPlay2A", "Receive");
        exports["IDirectPlay2A_Send"] = bind("IDirectPlay2A", "Send");
        exports["IDirectPlay2A_SetGroupData"] = bind("IDirectPlay2A", "SetGroupData");
        exports["IDirectPlay2A_SetGroupName"] = bind("IDirectPlay2A", "SetGroupName");
        exports["IDirectPlay2A_SetPlayerData"] = bind("IDirectPlay2A", "SetPlayerData");
        exports["IDirectPlay2A_SetPlayerName"] = bind("IDirectPlay2A", "SetPlayerName");
        exports["IDirectPlay2A_SetSessionDesc"] = bind("IDirectPlay2A", "SetSessionDesc");
        exports["IDirectPlay3A_QueryInterface"] = bind("IDirectPlay3A", "QueryInterface");
        exports["IDirectPlay3A_AddRef"] = bind("IDirectPlay3A", "AddRef");
        exports["IDirectPlay3A_Release"] = bind("IDirectPlay3A", "Release");
        exports["IDirectPlay3A_AddPlayerToGroup"] = bind("IDirectPlay3A", "AddPlayerToGroup");
        exports["IDirectPlay3A_Close"] = bind("IDirectPlay3A", "Close");
        exports["IDirectPlay3A_CreateGroup"] = bind("IDirectPlay3A", "CreateGroup");
        exports["IDirectPlay3A_CreatePlayer"] = bind("IDirectPlay3A", "CreatePlayer");
        exports["IDirectPlay3A_DeletePlayerFromGroup"] = bind("IDirectPlay3A", "DeletePlayerFromGroup");
        exports["IDirectPlay3A_DestroyGroup"] = bind("IDirectPlay3A", "DestroyGroup");
        exports["IDirectPlay3A_DestroyPlayer"] = bind("IDirectPlay3A", "DestroyPlayer");
        exports["IDirectPlay3A_EnumGroupPlayers"] = bind("IDirectPlay3A", "EnumGroupPlayers");
        exports["IDirectPlay3A_EnumGroups"] = bind("IDirectPlay3A", "EnumGroups");
        exports["IDirectPlay3A_EnumPlayers"] = bind("IDirectPlay3A", "EnumPlayers");
        exports["IDirectPlay3A_EnumSessions"] = bind("IDirectPlay3A", "EnumSessions");
        exports["IDirectPlay3A_GetCaps"] = bind("IDirectPlay3A", "GetCaps");
        exports["IDirectPlay3A_GetGroupData"] = bind("IDirectPlay3A", "GetGroupData");
        exports["IDirectPlay3A_GetGroupName"] = bind("IDirectPlay3A", "GetGroupName");
        exports["IDirectPlay3A_GetMessageCount"] = bind("IDirectPlay3A", "GetMessageCount");
        exports["IDirectPlay3A_GetPlayerAddress"] = bind("IDirectPlay3A", "GetPlayerAddress");
        exports["IDirectPlay3A_GetPlayerCaps"] = bind("IDirectPlay3A", "GetPlayerCaps");
        exports["IDirectPlay3A_GetPlayerData"] = bind("IDirectPlay3A", "GetPlayerData");
        exports["IDirectPlay3A_GetPlayerName"] = bind("IDirectPlay3A", "GetPlayerName");
        exports["IDirectPlay3A_GetSessionDesc"] = bind("IDirectPlay3A", "GetSessionDesc");
        exports["IDirectPlay3A_Initialize"] = bind("IDirectPlay3A", "Initialize");
        exports["IDirectPlay3A_Open"] = bind("IDirectPlay3A", "Open");
        exports["IDirectPlay3A_Receive"] = bind("IDirectPlay3A", "Receive");
        exports["IDirectPlay3A_Send"] = bind("IDirectPlay3A", "Send");
        exports["IDirectPlay3A_SetGroupData"] = bind("IDirectPlay3A", "SetGroupData");
        exports["IDirectPlay3A_SetGroupName"] = bind("IDirectPlay3A", "SetGroupName");
        exports["IDirectPlay3A_SetPlayerData"] = bind("IDirectPlay3A", "SetPlayerData");
        exports["IDirectPlay3A_SetPlayerName"] = bind("IDirectPlay3A", "SetPlayerName");
        exports["IDirectPlay3A_SetSessionDesc"] = bind("IDirectPlay3A", "SetSessionDesc");
        exports["IDirectPlay3A_AddGroupToGroup"] = bind("IDirectPlay3A", "AddGroupToGroup");
        exports["IDirectPlay3A_CreateGroupInGroup"] = bind("IDirectPlay3A", "CreateGroupInGroup");
        exports["IDirectPlay3A_DeleteGroupFromGroup"] = bind("IDirectPlay3A", "DeleteGroupFromGroup");
        exports["IDirectPlay3A_EnumConnections"] = bind("IDirectPlay3A", "EnumConnections");
        exports["IDirectPlay3A_EnumGroupsInGroup"] = bind("IDirectPlay3A", "EnumGroupsInGroup");
        exports["IDirectPlay3A_GetGroupConnectionSettings"] = bind("IDirectPlay3A", "GetGroupConnectionSettings");
        exports["IDirectPlay3A_InitializeConnection"] = bind("IDirectPlay3A", "InitializeConnection");
        exports["IDirectPlay3A_SecureOpen"] = bind("IDirectPlay3A", "SecureOpen");
        exports["IDirectPlay3A_SendChatMessage"] = bind("IDirectPlay3A", "SendChatMessage");
        exports["IDirectPlay3A_SetGroupConnectionSettings"] = bind("IDirectPlay3A", "SetGroupConnectionSettings");
        exports["IDirectPlay3A_StartSession"] = bind("IDirectPlay3A", "StartSession");
        exports["IDirectPlay3A_GetGroupFlags"] = bind("IDirectPlay3A", "GetGroupFlags");
        exports["IDirectPlay3A_GetGroupParent"] = bind("IDirectPlay3A", "GetGroupParent");
        exports["IDirectPlay4A_QueryInterface"] = bind("IDirectPlay4A", "QueryInterface");
        exports["IDirectPlay4A_AddRef"] = bind("IDirectPlay4A", "AddRef");
        exports["IDirectPlay4A_Release"] = bind("IDirectPlay4A", "Release");
        exports["IDirectPlay4A_AddPlayerToGroup"] = bind("IDirectPlay4A", "AddPlayerToGroup");
        exports["IDirectPlay4A_Close"] = bind("IDirectPlay4A", "Close");
        exports["IDirectPlay4A_CreateGroup"] = bind("IDirectPlay4A", "CreateGroup");
        exports["IDirectPlay4A_CreatePlayer"] = bind("IDirectPlay4A", "CreatePlayer");
        exports["IDirectPlay4A_DeletePlayerFromGroup"] = bind("IDirectPlay4A", "DeletePlayerFromGroup");
        exports["IDirectPlay4A_DestroyGroup"] = bind("IDirectPlay4A", "DestroyGroup");
        exports["IDirectPlay4A_DestroyPlayer"] = bind("IDirectPlay4A", "DestroyPlayer");
        exports["IDirectPlay4A_EnumGroupPlayers"] = bind("IDirectPlay4A", "EnumGroupPlayers");
        exports["IDirectPlay4A_EnumGroups"] = bind("IDirectPlay4A", "EnumGroups");
        exports["IDirectPlay4A_EnumPlayers"] = bind("IDirectPlay4A", "EnumPlayers");
        exports["IDirectPlay4A_EnumSessions"] = bind("IDirectPlay4A", "EnumSessions");
        exports["IDirectPlay4A_GetCaps"] = bind("IDirectPlay4A", "GetCaps");
        exports["IDirectPlay4A_GetGroupData"] = bind("IDirectPlay4A", "GetGroupData");
        exports["IDirectPlay4A_GetGroupName"] = bind("IDirectPlay4A", "GetGroupName");
        exports["IDirectPlay4A_GetMessageCount"] = bind("IDirectPlay4A", "GetMessageCount");
        exports["IDirectPlay4A_GetPlayerAddress"] = bind("IDirectPlay4A", "GetPlayerAddress");
        exports["IDirectPlay4A_GetPlayerCaps"] = bind("IDirectPlay4A", "GetPlayerCaps");
        exports["IDirectPlay4A_GetPlayerData"] = bind("IDirectPlay4A", "GetPlayerData");
        exports["IDirectPlay4A_GetPlayerName"] = bind("IDirectPlay4A", "GetPlayerName");
        exports["IDirectPlay4A_GetSessionDesc"] = bind("IDirectPlay4A", "GetSessionDesc");
        exports["IDirectPlay4A_Initialize"] = bind("IDirectPlay4A", "Initialize");
        exports["IDirectPlay4A_Open"] = bind("IDirectPlay4A", "Open");
        exports["IDirectPlay4A_Receive"] = bind("IDirectPlay4A", "Receive");
        exports["IDirectPlay4A_Send"] = bind("IDirectPlay4A", "Send");
        exports["IDirectPlay4A_SetGroupData"] = bind("IDirectPlay4A", "SetGroupData");
        exports["IDirectPlay4A_SetGroupName"] = bind("IDirectPlay4A", "SetGroupName");
        exports["IDirectPlay4A_SetPlayerData"] = bind("IDirectPlay4A", "SetPlayerData");
        exports["IDirectPlay4A_SetPlayerName"] = bind("IDirectPlay4A", "SetPlayerName");
        exports["IDirectPlay4A_SetSessionDesc"] = bind("IDirectPlay4A", "SetSessionDesc");
        exports["IDirectPlay4A_AddGroupToGroup"] = bind("IDirectPlay4A", "AddGroupToGroup");
        exports["IDirectPlay4A_CreateGroupInGroup"] = bind("IDirectPlay4A", "CreateGroupInGroup");
        exports["IDirectPlay4A_DeleteGroupFromGroup"] = bind("IDirectPlay4A", "DeleteGroupFromGroup");
        exports["IDirectPlay4A_EnumConnections"] = bind("IDirectPlay4A", "EnumConnections");
        exports["IDirectPlay4A_EnumGroupsInGroup"] = bind("IDirectPlay4A", "EnumGroupsInGroup");
        exports["IDirectPlay4A_GetGroupConnectionSettings"] = bind("IDirectPlay4A", "GetGroupConnectionSettings");
        exports["IDirectPlay4A_InitializeConnection"] = bind("IDirectPlay4A", "InitializeConnection");
        exports["IDirectPlay4A_SecureOpen"] = bind("IDirectPlay4A", "SecureOpen");
        exports["IDirectPlay4A_SendChatMessage"] = bind("IDirectPlay4A", "SendChatMessage");
        exports["IDirectPlay4A_SetGroupConnectionSettings"] = bind("IDirectPlay4A", "SetGroupConnectionSettings");
        exports["IDirectPlay4A_StartSession"] = bind("IDirectPlay4A", "StartSession");
        exports["IDirectPlay4A_GetGroupFlags"] = bind("IDirectPlay4A", "GetGroupFlags");
        exports["IDirectPlay4A_GetGroupParent"] = bind("IDirectPlay4A", "GetGroupParent");
        exports["IDirectPlay4A_GetPlayerAccount"] = bind("IDirectPlay4A", "GetPlayerAccount");
        exports["IDirectPlay4A_GetPlayerFlags"] = bind("IDirectPlay4A", "GetPlayerFlags");
        exports["IDirectPlay4A_GetGroupOwner"] = bind("IDirectPlay4A", "GetGroupOwner");
        exports["IDirectPlay4A_SetGroupOwner"] = bind("IDirectPlay4A", "SetGroupOwner");
        exports["IDirectPlay4A_SendEx"] = bind("IDirectPlay4A", "SendEx");
        exports["IDirectPlay4A_GetMessageQueue"] = bind("IDirectPlay4A", "GetMessageQueue");
        exports["IDirectPlay4A_CancelMessage"] = bind("IDirectPlay4A", "CancelMessage");
        exports["IDirectPlay4A_CancelPriority"] = bind("IDirectPlay4A", "CancelPriority");
        exports["IDirectPlay2_QueryInterface"] = bind("IDirectPlay2", "QueryInterface");
        exports["IDirectPlay2_AddRef"] = bind("IDirectPlay2", "AddRef");
        exports["IDirectPlay2_Release"] = bind("IDirectPlay2", "Release");
        exports["IDirectPlay2_AddPlayerToGroup"] = bind("IDirectPlay2", "AddPlayerToGroup");
        exports["IDirectPlay2_Close"] = bind("IDirectPlay2", "Close");
        exports["IDirectPlay2_CreateGroup"] = bind("IDirectPlay2", "CreateGroup");
        exports["IDirectPlay2_CreatePlayer"] = bind("IDirectPlay2", "CreatePlayer");
        exports["IDirectPlay2_DeletePlayerFromGroup"] = bind("IDirectPlay2", "DeletePlayerFromGroup");
        exports["IDirectPlay2_DestroyGroup"] = bind("IDirectPlay2", "DestroyGroup");
        exports["IDirectPlay2_DestroyPlayer"] = bind("IDirectPlay2", "DestroyPlayer");
        exports["IDirectPlay2_EnumGroupPlayers"] = bind("IDirectPlay2", "EnumGroupPlayers");
        exports["IDirectPlay2_EnumGroups"] = bind("IDirectPlay2", "EnumGroups");
        exports["IDirectPlay2_EnumPlayers"] = bind("IDirectPlay2", "EnumPlayers");
        exports["IDirectPlay2_EnumSessions"] = bind("IDirectPlay2", "EnumSessions");
        exports["IDirectPlay2_GetCaps"] = bind("IDirectPlay2", "GetCaps");
        exports["IDirectPlay2_GetGroupData"] = bind("IDirectPlay2", "GetGroupData");
        exports["IDirectPlay2_GetGroupName"] = bind("IDirectPlay2", "GetGroupName");
        exports["IDirectPlay2_GetMessageCount"] = bind("IDirectPlay2", "GetMessageCount");
        exports["IDirectPlay2_GetPlayerAddress"] = bind("IDirectPlay2", "GetPlayerAddress");
        exports["IDirectPlay2_GetPlayerCaps"] = bind("IDirectPlay2", "GetPlayerCaps");
        exports["IDirectPlay2_GetPlayerData"] = bind("IDirectPlay2", "GetPlayerData");
        exports["IDirectPlay2_GetPlayerName"] = bind("IDirectPlay2", "GetPlayerName");
        exports["IDirectPlay2_GetSessionDesc"] = bind("IDirectPlay2", "GetSessionDesc");
        exports["IDirectPlay2_Initialize"] = bind("IDirectPlay2", "Initialize");
        exports["IDirectPlay2_Open"] = bind("IDirectPlay2", "Open");
        exports["IDirectPlay2_Receive"] = bind("IDirectPlay2", "Receive");
        exports["IDirectPlay2_Send"] = bind("IDirectPlay2", "Send");
        exports["IDirectPlay2_SetGroupData"] = bind("IDirectPlay2", "SetGroupData");
        exports["IDirectPlay2_SetGroupName"] = bind("IDirectPlay2", "SetGroupName");
        exports["IDirectPlay2_SetPlayerData"] = bind("IDirectPlay2", "SetPlayerData");
        exports["IDirectPlay2_SetPlayerName"] = bind("IDirectPlay2", "SetPlayerName");
        exports["IDirectPlay2_SetSessionDesc"] = bind("IDirectPlay2", "SetSessionDesc");
        exports["IDirectPlay3_QueryInterface"] = bind("IDirectPlay3", "QueryInterface");
        exports["IDirectPlay3_AddRef"] = bind("IDirectPlay3", "AddRef");
        exports["IDirectPlay3_Release"] = bind("IDirectPlay3", "Release");
        exports["IDirectPlay3_AddPlayerToGroup"] = bind("IDirectPlay3", "AddPlayerToGroup");
        exports["IDirectPlay3_Close"] = bind("IDirectPlay3", "Close");
        exports["IDirectPlay3_CreateGroup"] = bind("IDirectPlay3", "CreateGroup");
        exports["IDirectPlay3_CreatePlayer"] = bind("IDirectPlay3", "CreatePlayer");
        exports["IDirectPlay3_DeletePlayerFromGroup"] = bind("IDirectPlay3", "DeletePlayerFromGroup");
        exports["IDirectPlay3_DestroyGroup"] = bind("IDirectPlay3", "DestroyGroup");
        exports["IDirectPlay3_DestroyPlayer"] = bind("IDirectPlay3", "DestroyPlayer");
        exports["IDirectPlay3_EnumGroupPlayers"] = bind("IDirectPlay3", "EnumGroupPlayers");
        exports["IDirectPlay3_EnumGroups"] = bind("IDirectPlay3", "EnumGroups");
        exports["IDirectPlay3_EnumPlayers"] = bind("IDirectPlay3", "EnumPlayers");
        exports["IDirectPlay3_EnumSessions"] = bind("IDirectPlay3", "EnumSessions");
        exports["IDirectPlay3_GetCaps"] = bind("IDirectPlay3", "GetCaps");
        exports["IDirectPlay3_GetGroupData"] = bind("IDirectPlay3", "GetGroupData");
        exports["IDirectPlay3_GetGroupName"] = bind("IDirectPlay3", "GetGroupName");
        exports["IDirectPlay3_GetMessageCount"] = bind("IDirectPlay3", "GetMessageCount");
        exports["IDirectPlay3_GetPlayerAddress"] = bind("IDirectPlay3", "GetPlayerAddress");
        exports["IDirectPlay3_GetPlayerCaps"] = bind("IDirectPlay3", "GetPlayerCaps");
        exports["IDirectPlay3_GetPlayerData"] = bind("IDirectPlay3", "GetPlayerData");
        exports["IDirectPlay3_GetPlayerName"] = bind("IDirectPlay3", "GetPlayerName");
        exports["IDirectPlay3_GetSessionDesc"] = bind("IDirectPlay3", "GetSessionDesc");
        exports["IDirectPlay3_Initialize"] = bind("IDirectPlay3", "Initialize");
        exports["IDirectPlay3_Open"] = bind("IDirectPlay3", "Open");
        exports["IDirectPlay3_Receive"] = bind("IDirectPlay3", "Receive");
        exports["IDirectPlay3_Send"] = bind("IDirectPlay3", "Send");
        exports["IDirectPlay3_SetGroupData"] = bind("IDirectPlay3", "SetGroupData");
        exports["IDirectPlay3_SetGroupName"] = bind("IDirectPlay3", "SetGroupName");
        exports["IDirectPlay3_SetPlayerData"] = bind("IDirectPlay3", "SetPlayerData");
        exports["IDirectPlay3_SetPlayerName"] = bind("IDirectPlay3", "SetPlayerName");
        exports["IDirectPlay3_SetSessionDesc"] = bind("IDirectPlay3", "SetSessionDesc");
        exports["IDirectPlay3_AddGroupToGroup"] = bind("IDirectPlay3", "AddGroupToGroup");
        exports["IDirectPlay3_CreateGroupInGroup"] = bind("IDirectPlay3", "CreateGroupInGroup");
        exports["IDirectPlay3_DeleteGroupFromGroup"] = bind("IDirectPlay3", "DeleteGroupFromGroup");
        exports["IDirectPlay3_EnumConnections"] = bind("IDirectPlay3", "EnumConnections");
        exports["IDirectPlay3_EnumGroupsInGroup"] = bind("IDirectPlay3", "EnumGroupsInGroup");
        exports["IDirectPlay3_GetGroupConnectionSettings"] = bind("IDirectPlay3", "GetGroupConnectionSettings");
        exports["IDirectPlay3_InitializeConnection"] = bind("IDirectPlay3", "InitializeConnection");
        exports["IDirectPlay3_SecureOpen"] = bind("IDirectPlay3", "SecureOpen");
        exports["IDirectPlay3_SendChatMessage"] = bind("IDirectPlay3", "SendChatMessage");
        exports["IDirectPlay3_SetGroupConnectionSettings"] = bind("IDirectPlay3", "SetGroupConnectionSettings");
        exports["IDirectPlay3_StartSession"] = bind("IDirectPlay3", "StartSession");
        exports["IDirectPlay3_GetGroupFlags"] = bind("IDirectPlay3", "GetGroupFlags");
        exports["IDirectPlay3_GetGroupParent"] = bind("IDirectPlay3", "GetGroupParent");
        exports["IDirectPlay4_QueryInterface"] = bind("IDirectPlay4", "QueryInterface");
        exports["IDirectPlay4_AddRef"] = bind("IDirectPlay4", "AddRef");
        exports["IDirectPlay4_Release"] = bind("IDirectPlay4", "Release");
        exports["IDirectPlay4_AddPlayerToGroup"] = bind("IDirectPlay4", "AddPlayerToGroup");
        exports["IDirectPlay4_Close"] = bind("IDirectPlay4", "Close");
        exports["IDirectPlay4_CreateGroup"] = bind("IDirectPlay4", "CreateGroup");
        exports["IDirectPlay4_CreatePlayer"] = bind("IDirectPlay4", "CreatePlayer");
        exports["IDirectPlay4_DeletePlayerFromGroup"] = bind("IDirectPlay4", "DeletePlayerFromGroup");
        exports["IDirectPlay4_DestroyGroup"] = bind("IDirectPlay4", "DestroyGroup");
        exports["IDirectPlay4_DestroyPlayer"] = bind("IDirectPlay4", "DestroyPlayer");
        exports["IDirectPlay4_EnumGroupPlayers"] = bind("IDirectPlay4", "EnumGroupPlayers");
        exports["IDirectPlay4_EnumGroups"] = bind("IDirectPlay4", "EnumGroups");
        exports["IDirectPlay4_EnumPlayers"] = bind("IDirectPlay4", "EnumPlayers");
        exports["IDirectPlay4_EnumSessions"] = bind("IDirectPlay4", "EnumSessions");
        exports["IDirectPlay4_GetCaps"] = bind("IDirectPlay4", "GetCaps");
        exports["IDirectPlay4_GetGroupData"] = bind("IDirectPlay4", "GetGroupData");
        exports["IDirectPlay4_GetGroupName"] = bind("IDirectPlay4", "GetGroupName");
        exports["IDirectPlay4_GetMessageCount"] = bind("IDirectPlay4", "GetMessageCount");
        exports["IDirectPlay4_GetPlayerAddress"] = bind("IDirectPlay4", "GetPlayerAddress");
        exports["IDirectPlay4_GetPlayerCaps"] = bind("IDirectPlay4", "GetPlayerCaps");
        exports["IDirectPlay4_GetPlayerData"] = bind("IDirectPlay4", "GetPlayerData");
        exports["IDirectPlay4_GetPlayerName"] = bind("IDirectPlay4", "GetPlayerName");
        exports["IDirectPlay4_GetSessionDesc"] = bind("IDirectPlay4", "GetSessionDesc");
        exports["IDirectPlay4_Initialize"] = bind("IDirectPlay4", "Initialize");
        exports["IDirectPlay4_Open"] = bind("IDirectPlay4", "Open");
        exports["IDirectPlay4_Receive"] = bind("IDirectPlay4", "Receive");
        exports["IDirectPlay4_Send"] = bind("IDirectPlay4", "Send");
        exports["IDirectPlay4_SetGroupData"] = bind("IDirectPlay4", "SetGroupData");
        exports["IDirectPlay4_SetGroupName"] = bind("IDirectPlay4", "SetGroupName");
        exports["IDirectPlay4_SetPlayerData"] = bind("IDirectPlay4", "SetPlayerData");
        exports["IDirectPlay4_SetPlayerName"] = bind("IDirectPlay4", "SetPlayerName");
        exports["IDirectPlay4_SetSessionDesc"] = bind("IDirectPlay4", "SetSessionDesc");
        exports["IDirectPlay4_AddGroupToGroup"] = bind("IDirectPlay4", "AddGroupToGroup");
        exports["IDirectPlay4_CreateGroupInGroup"] = bind("IDirectPlay4", "CreateGroupInGroup");
        exports["IDirectPlay4_DeleteGroupFromGroup"] = bind("IDirectPlay4", "DeleteGroupFromGroup");
        exports["IDirectPlay4_EnumConnections"] = bind("IDirectPlay4", "EnumConnections");
        exports["IDirectPlay4_EnumGroupsInGroup"] = bind("IDirectPlay4", "EnumGroupsInGroup");
        exports["IDirectPlay4_GetGroupConnectionSettings"] = bind("IDirectPlay4", "GetGroupConnectionSettings");
        exports["IDirectPlay4_InitializeConnection"] = bind("IDirectPlay4", "InitializeConnection");
        exports["IDirectPlay4_SecureOpen"] = bind("IDirectPlay4", "SecureOpen");
        exports["IDirectPlay4_SendChatMessage"] = bind("IDirectPlay4", "SendChatMessage");
        exports["IDirectPlay4_SetGroupConnectionSettings"] = bind("IDirectPlay4", "SetGroupConnectionSettings");
        exports["IDirectPlay4_StartSession"] = bind("IDirectPlay4", "StartSession");
        exports["IDirectPlay4_GetGroupFlags"] = bind("IDirectPlay4", "GetGroupFlags");
        exports["IDirectPlay4_GetGroupParent"] = bind("IDirectPlay4", "GetGroupParent");
        exports["IDirectPlay4_GetPlayerAccount"] = bind("IDirectPlay4", "GetPlayerAccount");
        exports["IDirectPlay4_GetPlayerFlags"] = bind("IDirectPlay4", "GetPlayerFlags");
        exports["IDirectPlay4_GetGroupOwner"] = bind("IDirectPlay4", "GetGroupOwner");
        exports["IDirectPlay4_SetGroupOwner"] = bind("IDirectPlay4", "SetGroupOwner");
        exports["IDirectPlay4_SendEx"] = bind("IDirectPlay4", "SendEx");
        exports["IDirectPlay4_GetMessageQueue"] = bind("IDirectPlay4", "GetMessageQueue");
        exports["IDirectPlay4_CancelMessage"] = bind("IDirectPlay4", "CancelMessage");
        exports["IDirectPlay4_CancelPriority"] = bind("IDirectPlay4", "CancelPriority");
        const enumerateProviders = (wide: boolean): ThunkImplementation => (ctx, _mem, args) => {
            const a = args.slice(0, 2);
            return this.enumerate(ctx, a[0], 8, PROVIDERS.map(provider => ({
                pack: () => { const bytes = new Uint8Array(16 + encodeText(provider.name + "\\0", wide).length); bytes.set(unhex(provider.guid)); bytes.set(encodeText(provider.name + "\\0", wide), 16); return bytes; },
                args: base => [base, base + 16, 6, 0, a[1]],
            })));
        };
        exports["directplayenumeratea"] = enumerateProviders(false);
        exports["directplayenumeratew"] = enumerateProviders(true);
        exports["ord_2"] = exports["directplayenumeratea"];
        exports["ord_3"] = exports["directplayenumeratew"];
        const create: ThunkImplementation = (_ctx, _mem, args) => {
            const a = args.slice(0, 3);
            if (!this.valid(a[1], 4, "rw")) return E_POINTER;
            Mem.writeUint32(a[1], 0);
            if (a[2]) return 0x80040110;
            if (a[0] && !this.valid(a[0], 16)) return DP.INVALIDPARAMS;
            if (a[0] && !PROVIDERS.some(p => p.guid === hex(Mem.readBytes(a[0], 16)!))) return DP.UNAVAILABLE;
            const obj = ComObjectFactory.create(IID1, this.tables().IDirectPlay.address);
            if (!obj) return DP.UNAVAILABLE;
            const addr = allocateComObject(this.process.memory, this.process.getCurrentMemory(), this.tables().IDirectPlay.address);
            resource.mapAddressToHandle(addr, obj.handle);
            const state = this.state(addr)!; state.interfaces.set("IDirectPlay", addr);
            if (a[0]) { const hr = state.session.initialize(); if (hr) { obj.release(); return hr; } }
            Mem.writeUint32(a[1], addr); return DP.OK;
        };
        exports["directplaycreate"] = create; exports["ord_1"] = create;
        const lobbyPrefixes = ["IDirectPlayLobby", "IDirectPlayLobbyA", "IDirectPlayLobby2", "IDirectPlayLobby2A", "IDirectPlayLobby3", "IDirectPlayLobby3A", "IDirectPlayLobbyCompatA"];
        for (const iface of lobbyPrefixes) {
            const wide = !iface.endsWith("A");
            exports[`${iface}_QueryInterface`] = (_ctx, _mem, args) => {
                if (!this.valid(args[2], 4, "rw") || !this.valid(args[1], 16)) return E_POINTER;
                Mem.writeUint32(args[2], 0);
                const obj = resource.getComObjectByAddress(args[0]); if (!obj) return DPERR_INVALIDOBJECT;
                const iid = hex(Mem.readBytes(args[1], 16)!);
                const unknown = iid === iidHex("00000000-0000-0000-c000-000000000046");
                const target = dplayxModule.interfaces!.find(i => /^IDirectPlayLobby[23]?A?$/.test(i.name) && i.iid && iidHex(i.iid) === iid);
                if (!target && !unknown) return E_NOINTERFACE;
                let map = this.lobbyInterfaces.get(obj.handle);
                if (!map) { map = new Map([[iface, args[0]]]); this.lobbyInterfaces.set(obj.handle, map); }
                let ptr = unknown ? resource.getPrimaryAddressForHandle(obj.handle)! : map.get(target!.name);
                if (!ptr) {
                    ptr = allocateComObject(this.process.memory, this.process.getCurrentMemory(), this.tables()[target!.name].address);
                    resource.mapAddressToHandle(ptr, obj.handle); map.set(target!.name, ptr);
                }
                obj.addRef(); Mem.writeUint32(args[2], ptr); return DP.OK;
            };
            exports[`${iface}_AddRef`] = (_ctx, _mem, args) => resource.getComObjectByAddress(args[0])?.addRef() ?? 0;
            exports[`${iface}_Release`] = (_ctx, _mem, args) => {
                const obj = resource.getComObjectByAddress(args[0]); if (!obj) return 0;
                const result = obj.release();
                if (!result) {
                    this.lobbyInterfaces.delete(obj.handle);
                    const events = this.lobbyEvents.get(obj.handle); this.lobbyEvents.delete(obj.handle);
                    for (const [game, alias] of events ?? []) {
                        this.releaseLobbyEvent(alias);
                        if (!this.lobbySubscribed(game)) void this.lobbyEndpoint?.call({ op: "subscribe", game: game === this.lobbyEndpoint.ipc.pid ? 0 : game, flags: 0 });
                    }
                }
                return result;
            };
            exports[`${iface}_EnumLocalApplications`] = (ctx, _mem, args) => {
                const a = args.slice();
                if (iface !== "IDirectPlayLobbyCompatA" && a[3]) return DP.INVALIDFLAGS;
                const registry = System.getInstance().registry, path = "Software\\Microsoft\\DirectPlay\\Applications";
                const root = registry.open("hklm", path), entries: EnumerationEntry[] = [];
                for (const name of root ? registry.enumSubKeys(root) : []) {
                    const key = registry.open("hklm", path + "\\" + name);
                    const value = key ? registry.getValue(key, "Guid")?.data : undefined;
                    if (typeof value !== "string" || !/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(value)) continue;
                    entries.push({
                        pack: base => { const b = new BufferWriter(24, encodeText(name + "\0", wide).length, base); b.u32(0, 24); b.bytes.set(unhex(iidHex(value)), 4); b.string(20, name, wide); return b.bytes; },
                        args: base => [base, a[2], 0],
                    });
                }
                return this.enumerate(ctx, a[1], iface === "IDirectPlayLobbyCompatA" ? 12 : 16, entries);
            };
            exports[`${iface}_EnumAddresses`] = (ctx, _mem, args) => {
                const a = args.slice();
                if (a[3] > 65536 || !this.valid(a[2], a[3])) return DP.INVALIDPARAMS;
                const entries: EnumerationEntry[] = [];
                let offset = 0;
                while (offset < a[3]) {
                    if (offset + 20 > a[3]) return DP.INVALIDPARAMS;
                    const size = Mem.readUint32(a[2] + offset + 16)!;
                    if (size > a[3] - offset - 20 || entries.length >= 128) return DP.INVALIDPARAMS;
                    const bytes = Mem.readBytes(a[2] + offset, 20 + size)!.slice();
                    entries.push({ pack: () => bytes, args: base => [base, size, base + 20, a[4]] });
                    offset += 20 + size;
                }
                return this.enumerate(ctx, a[1], 20, entries);
            };
            exports[`${iface}_EnumAddressTypes`] = (ctx, _mem, args) => {
                const a = args.slice();
                if (a[4]) return DP.INVALIDFLAGS;
                if (!this.valid(a[2], 16)) return DP.INVALIDPARAMS;
                const provider = hex(Mem.readBytes(a[2], 16)!);
                if (!PROVIDERS.some(p => p.guid === provider)) return DP.UNAVAILABLE;
                const types = provider === PROVIDERS[0].guid ? [SERVICE_GUID, INET_GUID, INET_PORT_GUID] : [SERVICE_GUID];
                return this.enumerate(ctx, a[1], 20, types.map(type => ({ pack: () => unhex(type), args: base => [base, a[3], 0] })));
            };
            exports[`${iface}_CreateCompoundAddress`] = (_ctx, _mem, args) => {
                const a = args.slice();
                if (!a[2] || a[2] > 128 || !this.valid(a[1], a[2] * 24)) return DP.INVALIDPARAMS;
                const elements: { guid: string; data: Uint8Array }[] = [];
                let total = 24;
                for (let i = 0; i < a[2]; i++) {
                    const ptr = a[1] + i * 24, size = Mem.readUint32(ptr + 16)!, data = Mem.readUint32(ptr + 20)!;
                    total += 20 + size;
                    if (total > 65536 || (size && !this.valid(data, size))) return DP.INVALIDPARAMS;
                    elements.push({ guid: hex(Mem.readBytes(ptr, 16)!), data: size ? Mem.readBytes(data, size)!.slice() : EMPTY });
                }
                return this.buffer(a[3], a[4], () => packAddress(elements));
            };
            exports[`${iface}_CreateAddress`] = (_ctx, _mem, args) => {
                const a = args.slice();
                if (iface === "IDirectPlayLobbyCompatA") return DP.UNSUPPORTED;
                if (!this.valid(a[1], 16) || !this.valid(a[2], 16) || a[4] > 65000 || (a[4] && !this.valid(a[3], a[4]))) return DP.INVALIDPARAMS;
                const elements = [{ guid: SERVICE_GUID, data: Mem.readBytes(a[1], 16)!.slice() },
                    { guid: hex(Mem.readBytes(a[2], 16)!), data: a[4] ? Mem.readBytes(a[3], a[4])!.slice() : EMPTY }];
                return this.buffer(a[5], a[6], () => packAddress(elements));
            };
            exports[`${iface}_SetConnectionSettings`] = (_c, _m, args) => {
                const a = args.slice();
                if (a[1]) return DP.INVALIDFLAGS;
                const settings = this.connection(a[3], wide); if (!settings) return DP.INVALIDPARAMS;
                return this.lobbyHr(this.lobby().call({ op: "set", game: a[2], settings }));
            };
            const connect = (output: number, targetName: string): ReturnType<ThunkImplementation> => {
                if (!this.valid(output, 4, "rw")) return E_POINTER;
                Mem.writeUint32(output, 0);
                // COM allocation occurs on the issuing owner thread, before the broker or
                // network request can yield. A reply contains only owned host-side state.
                const target = dplayxModule.interfaces!.find(i => i.name === targetName)!;
                const table = this.tables()[targetName].address;
                const obj = ComObjectFactory.create(target.iid!, table); if (!obj) return DP.UNAVAILABLE;
                const memory = this.process.getCurrentMemory();
                const addr = allocateComObject(this.process.memory, memory, table);
                resource.mapAddressToHandle(addr, obj.handle);
                const state = this.state(addr)!; state.interfaces.set(targetName, addr);
                const generation = this.generation, endpoint = this.lobby();
                const live = () => generation === this.generation && resource.getComObject(obj.handle) === obj;
                const cleanup = (): void => { state.session.dispose(); this.states.delete(obj.handle); obj.release(); };
                const open = (reply: LobbyReply): number | Promise<number> => {
                    if (!live()) return DP.SESSIONLOST;
                    if (reply.hr || !reply.settings) return reply.hr || 0x8877042e;
                    void endpoint.call({ op: "read" });
                    const initialized = state.session.initialize(); if (initialized) return initialized;
                    return reply.settings.create ? state.session.create(reply.settings.desc) : state.session.join(reply.settings.desc);
                };
                const settings = endpoint.call({ op: "get" });
                const result = settings instanceof Promise ? settings.then(open) : open(settings);
                if (!(result instanceof Promise)) {
                    void endpoint.call({ op: "connected", flags: result ? 1 : 0 });
                    if (result) { cleanup(); return result; }
                    Mem.writeUint32(output, addr); return DP.OK;
                }
                return result.then<ThunkResult>(hr => {
                    if (!live()) return { value: DP.SESSIONLOST };
                    void endpoint.call({ op: "connected", flags: hr ? 1 : 0 });
                    if (!hr) return { value: DP.OK, deferredWrites: [{ address: output, value: addr, size: 4 }] };
                    return { value: hr, startCallbackChain: () => { if (live()) cleanup(); return false; } };
                });
            };
            exports[`${iface}_Connect`] = (_ctx, _mem, args) => {
                if (args[3]) return 0x80040110;
                if (args[1]) return DP.INVALIDFLAGS;
                return connect(args[2], wide ? "IDirectPlay2" : "IDirectPlay2A");
            };
            exports[`${iface}_ConnectEx`] = (_ctx, _mem, args) => {
                if (args[4]) return 0x80040110;
                if (args[1]) return DP.INVALIDFLAGS;
                if (!this.valid(args[2], 16)) return DP.INVALIDPARAMS;
                const iid = hex(Mem.readBytes(args[2], 16)!);
                const target = dplayxModule.interfaces!.find(i => /^IDirectPlay(?:[234]A?)?$/.test(i.name) && i.iid && iidHex(i.iid) === iid);
                if (!target) return E_NOINTERFACE;
                return connect(args[3], target.name);
            };
            exports[`${iface}_GetConnectionSettings`] = (_c, _m, args) => {
                const a = args.slice();
                if (!this.valid(a[3], 4, "rw")) return DP.INVALIDPARAMS;
                const capacity = Mem.readUint32(a[3])!;
                if (a[2] && !this.valid(a[2], capacity, "rw")) return DP.INVALIDPARAMS;
                return this.lobbyBuffer(this.lobby().call({ op: "get", game: a[1] }), a[2], a[3], capacity,
                    (reply, base) => this.packConnection(reply.settings!, base, wide));
            };
            exports[`${iface}_WaitForConnectionSettings`] = (_c, _m, args) => {
                if (args[1] & ~1) return DP.INVALIDFLAGS;
                const system = System.getInstance();
                const app = registeredDirectPlayApplications().find(entry =>
                    system.resolveImagePath(entry.file, entry.path).toLowerCase() === system.executablePath.toLowerCase());
                return this.lobbyHr(this.lobby().call({ op: "wait", flags: args[1], application: app ? iidHex(app.guid) : undefined }));
            };
            exports[`${iface}_SendLobbyMessage`] = (_c, _m, args) => {
                const a = args.slice();
                if (a[1] & ~2) return DP.INVALIDFLAGS;
                if (a[4] > 65536 || !this.valid(a[3], a[4])) return DP.INVALIDPARAMS;
                const data = Mem.readBytes(a[3], a[4])!.slice();
                if (a[1] && (data.length < 4 || ![5, 7].includes(new DataView(data.buffer).getUint32(0, true)))) return DP.INVALIDPARAMS;
                return this.lobbyHr(this.lobby().call({ op: "send", game: a[2], flags: a[1], data }));
            };
            exports[`${iface}_ReceiveLobbyMessage`] = (_c, _m, args) => {
                const a = args.slice();
                if (a[1]) return DP.INVALIDFLAGS;
                if (!this.valid(a[5], 4, "rw")) return DP.INVALIDPARAMS;
                const capacity = Mem.readUint32(a[5])!;
                if (a[4] && (!this.valid(a[4], capacity, "rw") || !this.valid(a[3], 4, "rw"))) return DP.INVALIDPARAMS;
                const result = this.lobby().call({ op: "receive", game: a[2], capacity, output: !!a[4] });
                const generation = this.generation;
                const writes = (reply: LobbyReply): void => {
                    if (reply.size !== undefined) Mem.writeUint32(a[5], reply.size);
                    if (!reply.hr) { Mem.writeUint32(a[3], reply.flags!); Mem.writeBytes(a[4], reply.data!); }
                };
                if (!(result instanceof Promise)) { writes(result); return result.hr; }
                return result.then<ThunkResult>(reply => generation !== this.generation ? { value: DP.SESSIONLOST } :
                    { value: reply.hr, startCallbackChain: () => { if (generation === this.generation) writes(reply); return false; } });
            };
            exports[`${iface}_SetLobbyMessageEvent`] = (_c, _m, args) => {
                const a = args.slice();
                if (a[1]) return DP.INVALIDPARAMS;
                const owner = resource.getComObjectByAddress(a[0])?.handle; if (!owner) return DPERR_INVALIDOBJECT;
                if (a[3] && resource.getKernelObject(a[3])?.kind !== "event") return DP.INVALIDPARAMS;
                const endpoint = this.lobby(), game = a[2] || endpoint.ipc.pid, generation = this.generation;
                const alias = this.retainLobbyEvent(a[3]); if (a[3] && !alias) return 0x8007000e;
                // Install before subscribing: an already queued message can notify before
                // the cross-process subscription reply arrives.
                const previous = this.setLobbyEvent(owner, game, alias);
                const result = endpoint.call({ op: "subscribe", game: a[2], flags: this.lobbySubscribed(game) ? 1 : 0 });
                const finish = (reply: LobbyReply): number => {
                    if (generation !== this.generation) return DP.SESSIONLOST;
                    if (reply.hr) { this.setLobbyEvent(owner, game, previous); this.releaseLobbyEvent(alias); }
                    else this.releaseLobbyEvent(previous);
                    return reply.hr;
                };
                return result instanceof Promise ? result.then<ThunkResult>(reply => ({ value: finish(reply) })) : finish(result);
            };
            exports[`${iface}_RegisterApplication`] = (_c, _m, args) => {
                const a = args.slice(), ptr = a[2];
                if (a[1]) return DP.INVALIDFLAGS;
                if (!this.valid(ptr, 52)) return DP.INVALIDPARAMS;
                const size = Mem.readUint32(ptr)!;
                if (![52, 56].includes(size) || !this.valid(ptr, size)) return DP.INVALIDPARAMS;
                if (Mem.readUint32(ptr + 4)) return DP.INVALIDFLAGS;
                const guid = hex(Mem.readBytes(ptr + 12, 16)!); if (guid === ZERO_GUID) return DP.INVALIDPARAMS;
                const fields: [string, string][] = [];
                for (const [offset, key] of [[8, "Name"], [28, "File"], [32, "CommandLine"], [36, "Path"], [40, "CurrentDirectory"],
                    [44, "DescriptionA"], [48, "DescriptionW"], ...(size === 56 ? [[52, "Launcher"]] : [])] as [number, string][]) {
                    const valuePtr = Mem.readUint32(ptr + offset)!;
                    if (!valuePtr && [8, 28, 36].includes(offset)) return DP.INVALIDPARAMS;
                    const value = this.text(valuePtr, 32767, key === "DescriptionA" ? false : key === "DescriptionW" ? true : wide);
                    if (value === null) return DP.INVALIDPARAMS;
                    fields.push([key, value]);
                }
                const name = fields[0][1], registry = System.getInstance().registry, path = DIRECTPLAY_APPLICATIONS + "\\" + name;
                registry.createKey("hklm", path); const key = registry.open("hklm", path); if (!key) return 0x80004005;
                registry.setValue(key, "Guid", { name: "Guid", type: "REG_SZ", data: guidString(guid) });
                for (const [field, value] of fields.slice(1)) registry.setValue(key, field, { name: field, type: "REG_SZ", data: value });
                return DP.OK;
            };
            exports[`${iface}_UnregisterApplication`] = (_c, _m, args) => {
                if (args[1]) return DP.INVALIDFLAGS;
                if (!this.valid(args[2], 16)) return DP.INVALIDPARAMS;
                const guid = guidString(hex(Mem.readBytes(args[2], 16)!)), registry = System.getInstance().registry;
                for (const app of registeredDirectPlayApplications()) if (app.guid === guid) {
                    const key = registry.open("hklm", DIRECTPLAY_APPLICATIONS + "\\" + app.name);
                    if (key) registry.deleteKey(key);
                }
                return DP.OK;
            };
            exports[`${iface}_RunApplication`] = (_c, _m, args) => {
                const a = args.slice(), settings = this.connection(a[3], wide);
                if (!settings || !this.valid(a[2], 4, "rw")) return DP.INVALIDPARAMS;
                if (a[1]) return DP.INVALIDFLAGS;
                if (a[4] && resource.getKernelObject(a[4])?.kind !== "event") return DP.INVALIDPARAMS;
                const app = registeredDirectPlayApplications().find(entry => entry.guid === guidString(settings.desc.application));
                if (!app) return 0x8877041a; // DPERR_UNKNOWNAPPLICATION (1050)
                const generation = this.generation, endpoint = this.lobby(), system = System.getInstance();
                const owner = resource.getComObjectByAddress(a[0])?.handle; if (!owner) return DPERR_INVALIDOBJECT;
                const eventAlias = this.retainLobbyEvent(a[4]); if (a[4] && !eventAlias) return 0x8007000e;
                const environment = this.process.environment ? [...this.process.environment] : undefined;
                return (async (): Promise<ThunkResult> => {
                    let launch: PreparedChildLaunch | undefined;
                    try {
                        const waiting = await endpoint.call({ op: "findWaiting", application: settings.desc.application });
                        if (generation !== this.generation) { this.releaseLobbyEvent(eventAlias); return { value: DP.SESSIONLOST }; }
                        let pid = waiting.hr === DP.OK ? waiting.pid! : 0;
                        if (!pid) {
                            const imagePath = system.resolveImagePath(app.file, app.path);
                            launch = await prepareChildLaunch({ imagePath, commandLine: app.commandLine,
                                rawCommandLine: '"' + imagePath + '"' + (app.commandLine ? " " + app.commandLine : ""),
                                currentDirectory: app.currentDirectory || app.path, environment }, system);
                            pid = launch.processId;
                        }
                        if (generation !== this.generation) { launch?.cancel(); launch?.closeHandles(); this.releaseLobbyEvent(eventAlias); return { value: DP.SESSIONLOST }; }
                        const reply = await endpoint.call({ op: "launch", pid, settings });
                        if (reply.hr || generation !== this.generation) {
                            launch?.cancel(); launch?.closeHandles(); this.releaseLobbyEvent(eventAlias); return { value: reply.hr || DP.SESSIONLOST };
                        }
                        if (a[4]) {
                            const previous = this.setLobbyEvent(owner, pid, eventAlias); this.releaseLobbyEvent(previous);
                            const subscribed = await endpoint.call({ op: "subscribe", game: pid, flags: 1 });
                            if (subscribed.hr) { launch?.cancel(); launch?.closeHandles(); this.setLobbyEvent(owner, pid, 0); this.releaseLobbyEvent(eventAlias); return { value: subscribed.hr }; }
                        }
                        if (generation !== this.generation) { launch?.cancel(); launch?.closeHandles(); return { value: DP.SESSIONLOST }; }
                        launch?.start(); launch?.closeHandles();
                        return { value: DP.OK, deferredWrites: [{ address: a[2], value: pid, size: 4 }] };
                    } catch { launch?.cancel(); launch?.closeHandles(); this.releaseLobbyEvent(eventAlias); return { value: 0x887703f2 }; } // CANTCREATEPROCESS (1010)
                })();
            };
        }
        const createLobby = (wide: boolean): ThunkImplementation => (_ctx, _mem, args) => {
            if (!this.valid(args[1], 4, "rw")) return E_POINTER;
            Mem.writeUint32(args[1], 0);
            if (args[2]) return 0x80040110;
            if (args[0] || args[3] || args[4]) return DP.INVALIDPARAMS;
            const target = dplayxModule.interfaces!.find(i => i.name === (wide ? "IDirectPlayLobby" : "IDirectPlayLobbyA"))!;
            const table = this.tables()[target.name].address, obj = ComObjectFactory.create(target.iid!, table);
            if (!obj) return DP.UNAVAILABLE;
            const memory = this.process.getCurrentMemory();
            const ptr = allocateComObject(this.process.memory, memory, table);
            resource.mapAddressToHandle(ptr, obj.handle); this.lobbyInterfaces.set(obj.handle, new Map([[target.name, ptr]]));
            Mem.writeUint32(args[1], ptr); return DP.OK;
        };
        exports["directplaylobbycreatea"] = createLobby(false); exports["ord_4"] = exports["directplaylobbycreatea"];
        exports["directplaylobbycreatew"] = createLobby(true); exports["ord_5"] = exports["directplaylobbycreatew"];
    }
}
