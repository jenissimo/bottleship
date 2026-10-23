import type { LanNetwork, LanDatagram } from "../../../net/lan-network";
import type { Address, Entity, SessionDesc } from "../../dplayx/session";
import type { DirectPlay8Message } from "../backend";
import { DPN } from "../constants";
import { NativeDirectPlayPort } from "./port";
import { NativeDirectPlayChannel } from "./channel";
import { DN, decodeNativeProtocolFrame } from "./frame-codec";
import type { NativeReassembledMessage } from "./receive-window";
import { decodeNativePlayerConnect, encodeNativeCoreConnectInfo, type NativeCoreApplication, type NativePlayerConnectInfo, type NativeNameTableEntry } from "./core-connect-codec";
import { decodeNativeCoreOperation, nativeCoreWords } from "./core-operations";

export interface NativeHostDecision { hr: number; data?: Uint8Array; context?: unknown; release?(): void; returnBuffer?(): void | Promise<void>; }
export interface NativeHostJoin { address: Address; info: NativePlayerConnectInfo; signal: AbortSignal; }
export interface NativeHostOptions {
    port: number | NativeDirectPlayPort;
    application: NativeCoreApplication;
    player: { name: string | null; data: Uint8Array };
    /** Provider-resolved URLs and ingress policy; no implicit wildcard or guessed NAT address. */
    url(address: Address): string;
    allowIncoming(address: Address): boolean;
    admit(request: NativeHostJoin): NativeHostDecision | Promise<NativeHostDecision>;
    accepted?(id: number, context: unknown): void;
    replyReleased?(decision: NativeHostDecision): void | Promise<void>;
    aborted?(context: unknown): void;
    timeout?: number;
    retryInterval?: number;
}
interface Connection {
    address: Address; channel?: NativeDirectPlayChannel; controller: AbortController;
    phase: "handshake" | "admitting" | "table" | "connected" | "closing";
    generation: number; timer?: ReturnType<typeof setTimeout>; reserved: boolean;
    id?: number; entry?: NativeNameTableEntry; context?: unknown; admitted?: boolean; c3: boolean; replyReleased: boolean;
}
const key = (a: Address) => a.node.join(".") + ":" + a.port;
const clone = (a: Address): Address => ({ node: a.node.slice(), port: a.port });
const zeroGuid = "0".repeat(32);
/**
 * Isolated native one-peer Host state machine. The provider owns physical bind/
 * advertised addresses and supplies an exact ingress policy before start().
 * Not installed into guest COM Host, discovery or a second virtual authority.
 */
export class NativeDirectPlayHost {
    readonly entities = new Map<number, Entity>();
    readonly queue: DirectPlay8Message[] = [];
    onChange?: () => void;
    onMessage?: (id: number) => void;
    localId = 0;
    desc: SessionDesc | null = null;
    private port?: NativeDirectPlayPort;
    private options?: NativeHostOptions;
    private hostEntry?: NativeNameTableEntry;
    private connections = new Map<string, Connection>();
    private generation = 0;
    private version = 2;
    private reservations = 0;
    private decisions = new Set<Connection>();
    private decisionBytes = 0;
    private draining = new Set<NativeDirectPlayChannel>();
    private queueBytes = 0;
    private closing = false;
    private disposed = false;
    private clearing = false;
    private removeState?: () => void;
    private incoming = (packet: LanDatagram) => this.acceptPacket(packet);
    constructor(readonly network: LanNetwork) {}
    get localAddress(): Address { return { node: Array.from(this.network.node), port: this.port?.localPort ?? 0 }; }
    get currentPlayers(): number { return this.entities.size + this.reservations; }
    get pendingAdmissions(): number { return this.decisions.size; }
    get retainedAdmissionBytes(): number { return this.decisionBytes; }
    get pendingPeers(): number { return [...this.connections.values()].filter(c => c.phase !== "connected").length; }
    get peerCount(): number { return this.connections.size; }
    get pendingBytes(): number { return (this.port?.pendingBytes ?? 0) + this.queueBytes; }
    get isHost(): boolean { return !!this.desc && !this.closing; }
    start(options: NativeHostOptions): number {
        if (this.disposed) return DPN.INVALIDOBJECT;
        if (this.clearing) return DPN.ALREADYCLOSING;
        if (this.desc) return DPN.HOSTING;
        // This stage is explicitly the measured Host+one Peer contract.
        if (options.application.maxPlayers !== 2 || options.application.flags !== 0) return DPN.UNSUPPORTED;
        if (!this.network.connected) return DPN.NOCONNECTION;
        if (!/^[0-9a-f]{32}$/i.test(options.application.application) || !/^[0-9a-f]{32}$/i.test(options.application.instance)) return DPN.INVALIDPARAM;
        const appBytes = options.application.reserved.length + options.application.applicationData.length + options.player.data.length +
            2 * ((options.player.name?.length ?? 0) + (options.application.name?.length ?? 0) + (options.application.password?.length ?? 0));
        if (appBytes > 1024 * 1024) return DPN.DATATOOLARGE;
        this.options = { ...options, application: structuredClone(options.application), player: { name: options.player.name, data: options.player.data.slice() } };
        this.closing = false; const generation = ++this.generation; this.version = 2;
        try {
            const port = typeof options.port === "number" ? new NativeDirectPlayPort(this.network, options.port) : options.port;
            if (port.network !== this.network || !port.live) throw Error("Invalid provider UDP binding");
            this.port = port;
            if (!this.port.listen(this.incoming)) throw Error("Native listen unavailable");
            this.localId = this.newId(this.version);
            const app = options.application;
            this.desc = { instance: app.instance, application: app.application, flags: 0, maxPlayers: 2, name: app.name ?? "", nameNull: app.name === null,
                password: app.password ?? "", passwordNull: app.password === null, user: [0, 0, 0, 0], extended: { flags: 0, reserved: [...app.reserved], application: [...app.applicationData] } };
            this.hostEntry = { id: this.localId, owner: 0, flags: 0x102, version: 2, unused: 0, coreVersion: 2, name: options.player.name, data: options.player.data.slice(), url: null };
            this.entities.set(this.localId, this.entity(this.hostEntry, this.localAddress));
            this.removeState = this.network.onStateChange(() => { if (this.port && !this.port.live) this.close(); });
            if (!this.notifyChange()) { this.close(); return DPN.GENERIC; }
            return generation === this.generation && !this.closing ? DPN.OK : DPN.USERCANCEL;
        } catch { this.close(); return DPN.INVALIDDEVICEADDRESS; }
    }
    private newId(version: number): number {
        // NT5 NameTable handles contain a 20-bit slot and 12-bit entry version,
        // XORed with the first DWORD of the instance GUID (wire byte order).
        // FindEntry validates both parts; an arbitrary identifier is not a handle.
        if (version > 0xfff) throw Error("NameTable version exhausted");
        const prefix = this.options!.application.instance.slice(0, 8);
        const mask = parseInt(prefix.match(/../g)!.reverse().join(""), 16) >>> 0;
        const used = new Set<number>();
        for (const id of this.entities.keys()) used.add((id ^ mask) & 0xfffff);
        for (const c of this.connections.values()) if (c.id !== undefined) used.add((c.id ^ mask) & 0xfffff);
        // Slot zero is invalid, slot one belongs to the implicit ALL_PLAYERS group.
        // This isolated Host supports one admitted peer; keep even hostile churn
        // from forcing a native receiver to grow a sparse million-entry table.
        for (let index = 2; index < 64; index++) {
            if (used.has(index)) continue;
            const id = ((version << 20 | index) ^ mask) >>> 0;
            if (id !== 0) return id;
        }
        throw Error("DPNID allocation exhausted");
    }
    private live(c: Connection): boolean { return c.generation === this.generation && !this.closing && this.connections.get(key(c.address)) === c; }
    private acceptPacket(packet: LanDatagram): void {
        if (!this.port?.live || !this.options || this.closing) return;
        const address = { node: Array.from(packet.srcNode), port: packet.srcPort };
        const frame = decodeNativeProtocolFrame(packet.data);
        if (!frame || frame.kind !== "control" || frame.opcode !== DN.CONNECT || frame.version >>> 16 !== 1 ||
            this.connections.size >= 16) return;
        const port = this.port, options = this.options, generation = this.generation;
        try { if (!options.allowIncoming(clone(address))) return; } catch { return; }
        // The provider policy is user code and may close/restart or reenter Host.
        if (generation !== this.generation || this.port !== port || !port.live || this.closing ||
            this.connections.has(key(address)) || this.connections.size >= 16) return;
        const c: Connection = { address, controller: new AbortController(), phase: "handshake", generation: this.generation, reserved: false, c3: false, replyReleased: false };
        this.connections.set(key(address), c);
        try {
            c.channel = new NativeDirectPlayChannel(this.network, address, { timeout: options.timeout, retryInterval: options.retryInterval,
                onMessage: m => !this.live(c) || this.receive(c, m),
                onState: (state, result) => { if (state === "closed" && this.live(c)) this.retire(c, result); } }, 0, port);
            c.timer = setTimeout(() => { if (this.live(c) && c.phase !== "connected") this.retire(c, DPN.TIMEDOUT); }, options.timeout ?? 25000);
            (c.timer as unknown as { unref?(): void }).unref?.();
            void c.channel.link.listen(); c.channel.deliver(packet);
        } catch { this.retire(c, DPN.NOCONNECTION); }
    }
    private receive(c: Connection, message: NativeReassembledMessage): boolean {
        if (message.command & DN.USER2) return true;
        if (!(message.command & DN.USER1)) return c.phase !== "connected" || this.enqueue(c.id!, message.payload, message.command & DN.RELIABLE ? 1 : 0);
        if (c.phase === "handshake") {
            const info = decodeNativePlayerConnect(message.payload);
            if (info) { c.phase = "admitting"; void this.admit(c, info, message.payload.length); }
            return true;
        }
        const op = decodeNativeCoreOperation(message.payload); if (!op) return true;
        if (op.command === 0xc3 && c.phase === "table") { c.c3 = true; this.promote(c); }
        else if (op.command === 0xc9 && c.phase === "connected" && op.version <= this.version)
            void c.channel!.link.sendReliable(nativeCoreWords(0xca, op.version, 0));
        else if (op.command === 0xe0 && c.phase === "connected") {
            let acknowledged = false;
            return this.enqueue(c.id!, op.data!, message.command & DN.RELIABLE ? 1 : 0, () => {
                if (!acknowledged && this.live(c)) { acknowledged = true; void c.channel!.link.sendReliable(nativeCoreWords(0xe1, op.handle!)); }
            });
        }
        return true;
    }
    private validate(info: NativePlayerConnectInfo): number {
        const app = this.options!.application;
        if (info.flags !== 4) return DPN.INVALIDINTERFACE;
        if (info.version >>> 16) return DPN.INVALIDVERSION;
        if (info.application !== zeroGuid && info.application !== app.application) return DPN.INVALIDAPPLICATION;
        if (info.instance !== zeroGuid && info.instance !== app.instance) return DPN.INVALIDINSTANCE;
        if ((info.password ?? "") !== (app.password ?? "")) return DPN.INVALIDPASSWORD;
        if (this.currentPlayers >= app.maxPlayers) return DPN.SESSIONFULL;
        if (this.version >= 0xffe) return DPN.TABLEFULL;
        return DPN.OK;
    }
    private async admit(c: Connection, info: NativePlayerConnectInfo, bytes: number): Promise<void> {
        const options = this.options!, validation = this.validate(info);
        if (validation) { this.reject(c, validation, new Uint8Array()); return; }
        if (this.decisions.size >= 16 || bytes > 4 * 1024 * 1024 - this.decisionBytes) { this.reject(c, DPN.TABLEFULL, new Uint8Array()); return; }
        this.decisions.add(c); this.decisionBytes += bytes;
        c.reserved = true; this.reservations++;
        let decision: NativeHostDecision;
        try { decision = await options.admit({ address: clone(c.address), info: structuredClone(info), signal: c.controller.signal }); }
        catch { decision = { hr: DPN.HOSTREJECTEDCONNECTION }; }
        let copied = false;
        try {
            if (!this.live(c)) return;
            if ((decision.data?.length ?? 0) > 60000) { this.reject(c, DPN.DATATOOLARGE, new Uint8Array()); return; }
            const reply = decision.data?.slice() ?? new Uint8Array();
            if (decision.hr !== DPN.OK) {
                this.releaseReservation(c);
                // Native packs the rejection reply before RETURN_BUFFER and C5.
                const packet = this.failurePacket(DPN.HOSTREJECTEDCONNECTION, reply);
                copied = true; const returned = options.replyReleased?.(decision); if (returned) await returned;
                if (this.live(c)) this.rejectPacket(c, packet);
                return;
            }
            const version = this.version + 1;
            c.id = this.newId(version); c.context = decision.context; c.admitted = true;
            const url = options.url(clone(c.address));
            if (!this.live(c)) return;
            if (url.length > 4096 || !url.startsWith("x-directplay:/")) throw Error("Invalid provider player URL");
            this.version = version;
            c.entry = { id: c.id, owner: 0, flags: 0x100, version, unused: 0, coreVersion: info.version, name: info.name, data: info.data.slice(), url };
            const app = options.application;
            const packet = encodeNativeCoreConnectInfo({ reply, application: { ...app, players: this.currentPlayers }, localId: c.id,
                version: this.version, unused: 0, entries: [this.hostEntry!, c.entry], members: [] });
            c.phase = "table";
            const sent = c.channel!.link.sendReliable(packet);
            copied = true; const returned = options.replyReleased?.(decision); if (returned) await returned;
            if (!this.live(c)) return;
            c.replyReleased = true; this.promote(c);
            void sent.then(result => { if (result && this.live(c)) this.retire(c, result); });
        } catch { if (this.live(c)) this.retire(c, DPN.GENERIC); }
        finally {
            // Host-only ownership cleanup, including a decision arriving after Close.
            try { decision.release?.(); } catch { /* Ownership was returned once. */ }
            if (this.decisions.delete(c)) this.decisionBytes -= bytes;
            if (!copied && this.live(c)) c.replyReleased = true;
        }
    }
    private promote(c: Connection): void {
        if (!this.live(c) || c.phase !== "table" || !c.c3 || !c.replyReleased) return;
        c.phase = "connected"; clearTimeout(c.timer); c.timer = undefined;
        this.releaseReservation(c); this.entities.set(c.id!, this.entity(c.entry!, c.address));
        try {
            this.options!.accepted?.(c.id!, c.context);
            if (!this.live(c)) return;
            if (!this.notifyChange()) { this.retire(c, DPN.GENERIC); return; }
            if (!this.live(c)) return;
            void c.channel!.link.sendReliable(nativeCoreWords(0xc6, c.id!, ++this.version, 0)).then(result => {
                if (result && this.live(c)) this.retire(c, result);
            });
        } catch { if (this.live(c)) this.retire(c, DPN.GENERIC); }
    }
    private failurePacket(result: number, reply: Uint8Array): Uint8Array {
        const packet = new Uint8Array(16 + reply.length); packet.set(nativeCoreWords(0xc5, result, reply.length ? 12 : 0, reply.length)); packet.set(reply, 16); return packet;
    }
    private reject(c: Connection, result: number, reply: Uint8Array): void {
        this.releaseReservation(c); this.rejectPacket(c, this.failurePacket(result, reply));
    }
    private rejectPacket(c: Connection, packet: Uint8Array): void {
        if (!this.live(c)) return;
        c.phase = "closing";
        void c.channel!.link.sendReliable(packet).then(async result => {
            if (!this.live(c)) return;
            if (!result) await c.channel!.link.shutdown();
            if (this.live(c)) this.retire(c, result);
        });
    }
    private entity(entry: NativeNameTableEntry, address: Address): Entity {
        return { id: entry.id, group: false, owner: key(address), flags: 0, name: { short: entry.name ?? "", shortNull: entry.name === null, long: "", longNull: true },
            data: Array.from(entry.data), members: [], parent: 0, groupOwner: 0 };
    }
    private notifyChange(): boolean { try { this.onChange?.(); return true; } catch { return false; } }
    private releaseReservation(c: Connection): void { if (c.reserved) { c.reserved = false; this.reservations--; } }
    private retire(c: Connection, result: number): void {
        if (this.connections.get(key(c.address)) !== c) return;
        this.connections.delete(key(c.address)); clearTimeout(c.timer); c.controller.abort(); c.phase = "closing";
        this.releaseReservation(c);
        try {
            if (c.id && this.entities.delete(c.id)) this.notifyChange();
            else if (c.admitted) this.options?.aborted?.(c.context);
        } catch { /* Observer failure cannot retain a connection. */ }
        finally {
            const channel = c.channel;
            if (channel?.link.state === "closed" && result === DPN.OK) {
                this.draining.add(channel);
                void channel.closed.then(() => this.draining.delete(channel));
            } else channel?.close(result);
        }
    }
    private enqueue(id: number, payload: Uint8Array, flags: number, processed?: () => void): boolean {
        if (this.queue.length >= 4096 || payload.length > 4 * 1024 * 1024 - this.queueBytes) return false;
        this.queue.push({ from: id, to: this.localId, data: payload.slice(), flags, processed }); this.queueBytes += payload.length; this.onMessage?.(id); return true;
    }
    deliverLocal(data: Uint8Array, flags: number, processed?: () => void): boolean { return !!this.desc && !this.closing && this.enqueue(this.localId, data, flags, processed); }
    removeMessage(index: number): void { const [m] = this.queue.splice(index, 1); if (m) this.queueBytes -= m.data.length; }
    playerAddress(id: number): Address | null {
        if (id === this.localId && this.desc) return this.localAddress;
        const c = [...this.connections.values()].find(c => c.id === id && c.phase === "connected"); return c ? clone(c.address) : null;
    }
    async sendDpn(to: number, flags: number, data: Uint8Array): Promise<number> {
        if (this.closing) return DPN.ALREADYCLOSING;
        if (!this.desc) return DPN.NOCONNECTION;
        const c = [...this.connections.values()].find(c => c.id === to && c.phase === "connected");
        if (!c?.channel) return DPN.INVALIDPLAYER;
        if (!data.length || data.length > 1024 * 1024) return DPN.INVALIDPARAM;
        if (flags & ~0x18) return DPN.UNSUPPORTED;
        return flags & 8 ? c.channel.link.sendReliable(data, 0, !(flags & 0x10)) : c.channel.link.sendUnreliable(data, 0, !(flags & 0x10));
    }
    async shutdown(): Promise<number> {
        this.closing = true; this.port?.stopListening(this.incoming);
        const connected: Connection[] = [];
        for (const c of [...this.connections.values()]) {
            if (c.phase === "connected" && c.channel?.link.state === "connected") connected.push(c);
            else this.retire(c, DPN.USERCANCEL);
        }
        const results = await Promise.all([
            ...connected.map(async c => { const result = await c.channel!.link.shutdown(); return result || await c.channel!.closed; }),
            ...[...this.draining].map(channel => channel.closed),
        ]);
        this.close(); return results.find(r => r !== DPN.OK) ?? DPN.OK;
    }
    close(): number {
        if (this.clearing) return DPN.OK;
        this.clearing = true; this.closing = true; ++this.generation;
        try {
            this.removeState?.(); this.removeState = undefined;
            for (const c of [...this.connections.values()]) this.retire(c, DPN.USERCANCEL);
            for (const channel of this.draining) channel.close(DPN.USERCANCEL); this.draining.clear();
            this.port?.close(); this.port = undefined; this.hostEntry = undefined; this.desc = null;
            this.entities.clear(); this.queue.length = 0; this.queueBytes = 0; this.reservations = 0; return this.notifyChange() ? DPN.OK : DPN.GENERIC;
        } finally { this.clearing = false; }
    }
    dispose(): void { this.close(); this.disposed = true; }
}
