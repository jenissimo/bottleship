import type { LanNetwork } from "../../../net/lan-network";
import type { Address, Entity, JoinPlayer, Message, Reply, SessionDesc } from "../../dplayx/session";
import type { DirectPlay8Backend, DirectPlay8Message } from "../backend";
import type { DirectPlay8Role } from "../peer";
import { DPN } from "../constants";
import { NativeDirectPlayChannel } from "./channel";
import { DN } from "./frame-codec";
import type { NativeReassembledMessage } from "./receive-window";
import { decodeNativeCoreConnectInfo, encodeNativePlayerConnect, type NativeCoreApplication, type NativeNameTableEntry } from "./core-connect-codec";
import { decodeNativeCoreOperation, encodeNativeCoreRequest, nativeCoreWide, nativeCoreWords, type NativeCoreOperation } from "./core-operations";

interface Request { finish(reply: Reply): void; timer: ReturnType<typeof setTimeout>; command: number; }
const key = (a: Address): string => a.node.join(".") + ":" + a.port;
const copyAddress = (a: Address): Address => ({ node: a.node.slice(), port: a.port });
const emptyGuid = "0".repeat(32);
/** Native core name table and application protocol; it never borrows guest memory. */
export class NativeDirectPlayCore implements DirectPlay8Backend {
    readonly kind = "native" as const;
    readonly entities = new Map<number, Entity>();
    readonly queue: DirectPlay8Message[] = [];
    desc: SessionDesc | null = null;
    joinReply: Reply | null = null;
    lost = false;
    localId = 0;
    hostId = 0;
    onMessage?: (id: number) => void;
    onChange?: () => void;
    onTermination?: (data: Uint8Array, reason?: number) => void;
    private channel?: NativeDirectPlayChannel;
    private remote?: Address;
    private generation = 0;
    private disposed = false;
    private closing = false;
    private connected = false;
    private resolveConnect?: (result: number) => void;
    private connectTimer?: ReturnType<typeof setTimeout>;
    private entries = new Map<number, NativeNameTableEntry>();
    private operations = new Map<number, NativeCoreOperation>();
    private version = 0;
    private requestId = 1;
    private requests = new Map<number, Request>();
    private queueBytes = 0;
    private localProcessed = new Set<(result: number) => void>();
    private failedClosing?: Promise<number>;
    constructor(readonly network: LanNetwork, readonly role: DirectPlay8Role, readonly timeout = 25000, readonly retryInterval = 200, readonly retries = 14) {}
    get localAddress(): Address { return { node: Array.from(this.network.node), port: this.channel?.localPort ?? 0 }; }
    get hostAddress(): Address | null { return this.remote ? copyAddress(this.remote) : null; }
    get ownKey(): string { return key(this.localAddress); }
    get isHost(): boolean { return false; }
    get currentPlayers(): number { return [...this.entities.values()].filter(e => !e.group).length; }
    get openError(): number { return this.lost ? DPN.CONNECTIONLOST : this.connected && this.desc ? DPN.OK : DPN.NOCONNECTION; }
    async connect(address: Address, desc: SessionDesc, player: JoinPlayer, data: Uint8Array, port = 0): Promise<number> {
        if (this.disposed) return DPN.INVALIDOBJECT;
        if (this.resolveConnect) return DPN.CONNECTING;
        if (this.connected) return DPN.ALREADYCONNECTED;
        if (this.role === "server") return DPN.INVALIDPARAM;
        if (!this.network.connected) return DPN.NOCONNECTION;
        const generation = ++this.generation; this.channel?.close(); this.channel = undefined; this.joinReply = null; this.failedClosing = undefined;
        this.remote = copyAddress(address); this.closing = false; this.lost = false;
        const completion = new Promise<number>(resolve => { this.resolveConnect = resolve; }).then(async result => {
            if (result && generation === this.generation) {
                const channel = this.channel;
                if (this.failedClosing) await this.failedClosing; else channel?.close(result);
                if (channel) await channel.closed;
            }
            return result;
        });
        try {
            this.channel = new NativeDirectPlayChannel(this.network, address, { timeout: this.timeout, retryInterval: this.retryInterval, retries: this.retries,
                onMessage: message => generation !== this.generation || this.receive(message, desc),
                onState: (state, result) => { if (generation === this.generation && state === "closed") this.ended(result); } }, port);
        } catch { this.finishConnect(DPN.INVALIDDEVICEADDRESS); return completion; }
        this.connectTimer = setTimeout(() => { if (generation === this.generation && this.resolveConnect) { this.finishConnect(DPN.TIMEDOUT); this.channel?.close(DPN.TIMEDOUT); } }, this.timeout);
        (this.connectTimer as unknown as { unref?(): void }).unref?.();
        const ready = await this.channel.link.connect();
        if (generation !== this.generation) return DPN.USERCANCEL;
        if (ready) { this.finishConnect(ready); return completion; }
        const info = encodeNativePlayerConnect({ flags: this.role === "client" ? 2 : 4, version: 2, instance: desc.instance, application: desc.application,
            name: player.name.shortNull ? null : player.name.short, data: Uint8Array.from(player.data), password: desc.passwordNull || !desc.password ? null : desc.password,
            connectData: data, url: null, alternate: new Uint8Array() });
        void this.channel.link.sendReliable(info).then(result => { if (generation === this.generation && result) this.finishConnect(result); });
        return completion;
    }
    private finishConnect(result: number): void {
        if (this.connectTimer) clearTimeout(this.connectTimer); this.connectTimer = undefined;
        const finish = this.resolveConnect; this.resolveConnect = undefined;
        if (!result) this.connected = true;
        else if (finish) { this.desc = null; this.entities.clear(); this.entries.clear(); }
        finish?.(result);
    }
    private application(info: NativeCoreApplication): void {
        this.desc = { instance: info.instance, application: info.application, flags: 0, maxPlayers: info.maxPlayers, name: info.name ?? "", nameNull: info.name === null,
            password: info.password ?? "", passwordNull: info.password === null, user: [0, 0, 0, 0], extended: { flags: info.flags, reserved: [...info.reserved], application: [...info.applicationData] } };
    }
    private entity(entry: NativeNameTableEntry): Entity {
        const group = !!(entry.flags & 0x10);
        const owner = entry.id === this.localId || entry.owner === this.localId ? this.ownKey : entry.id === this.hostId || entry.owner === this.hostId ? key(this.remote!) : "native:" + (entry.owner || entry.id);
        return { id: entry.id, group, owner, flags: group && entry.flags & 0x40 ? 1 : entry.flags & 0x400 ? 0x100 : 0,
            name: { short: entry.name ?? "", shortNull: entry.name === null, long: "", longNull: true }, data: [...entry.data], members: [], parent: 0, groupOwner: entry.owner };
    }
    private receive(message: NativeReassembledMessage, requested: SessionDesc): boolean {
        if (!(message.command & DN.USER1)) return this.desc ? this.enqueue(this.hostId, message.payload, message.command & DN.RELIABLE ? 1 : 0) : true;
        if (message.command & DN.USER2) return true; // Voice is a separate DirectPlayVoice channel.
        const bytes = message.payload;
        if (bytes.length < 4) return true;
        const command = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
        if (command === 0xc2) {
            if (!this.resolveConnect || this.desc) return true;
            const info = decodeNativeCoreConnectInfo(bytes); if (!info) return true;
            const self = info.entries.find(e => e.id === info.localId && !(e.flags & 0x10)), host = info.entries.find(e => e.flags & 2 && !(e.flags & 0x10));
            if (!self || !host || self.id === host.id || (requested.application !== emptyGuid && info.application.application !== requested.application) ||
                (requested.instance !== emptyGuid && info.application.instance !== requested.instance) || !!(info.application.flags & 1) !== (this.role === "client")) return true;
            this.localId = self.id; this.hostId = host.id; this.version = info.version; this.application(info.application);
            this.entries = new Map(info.entries.map(entry => [entry.id, entry])); this.entities.clear();
            // Native announces groups, local player, host, then their memberships.
            for (const entry of info.entries) if (entry.flags & 0x10 && !(entry.flags & 4)) this.entities.set(entry.id, this.entity(entry));
            this.entities.set(self.id, this.entity(self)); this.entities.set(host.id, this.entity(host));
            for (const membership of info.members) if (this.entities.has(membership.player)) this.entities.get(membership.group)?.members.push(membership.player);
            this.joinReply = { hr: DPN.OK, id: self.id, data: info.reply.slice() };
            const generation = this.generation;
            void this.sendInternal(nativeCoreWords(0xc3)).then(result => {
                if (generation !== this.generation || !this.resolveConnect) return;
                if (result) { this.finishConnect(result); return; }
                // Existing peers must finish their own C4 connections before exposing them.
                if (info.entries.filter(entry => !(entry.flags & 0x10)).every(entry => this.entities.has(entry.id))) { this.finishConnect(DPN.OK); this.onChange?.(); }
            });
            return true;
        }
        const op = decodeNativeCoreOperation(bytes); if (!op) return true;
        if (op.command === 0xc5 && this.resolveConnect) {
            this.joinReply = { hr: op.reason!, data: op.data! }; this.finishConnect(op.reason!);
            this.failedClosing = this.channel?.link.shutdown(); return true;
        }
        if (!this.desc) return true;
        if (op.command === 0xc6 || op.command === 0xd0 || op.command === 0xd1 || (op.command >= 0xd7 && op.command <= 0xdb)) {
            if (op.version <= this.version) return true;
            if (!this.operations.has(op.version) && this.operations.size >= 1024) return false;
            this.operations.set(op.version, op);
            while (this.operations.has((this.version + 1) >>> 0)) {
                const next = this.operations.get((this.version + 1) >>> 0)!; this.operations.delete(next.version);
                this.apply(next); this.version = next.version;
            }
            if (this.role === "peer" && !(this.version % 4)) void this.sendInternal(nativeCoreWords(0xc9, this.version, 0));
        } else if (op.command === 0xcf) { this.application(op.application!); this.onChange?.(); }
        else if (op.command === 0xca) { /* Host has acknowledged our reported name-table version. */ }
        else if (op.command === 0xde || op.command === 0xe1) this.complete(op.handle!, { hr: op.reason ?? DPN.OK });
        else if (op.command === 0xe0) {
            const generation = this.generation;
            if (!this.enqueue(this.hostId, op.data!, message.command & DN.RELIABLE ? 1 : 0, () => {
                if (generation === this.generation && !this.closing && this.connected) void this.sendInternal(nativeCoreWords(0xe1, op.handle!));
            })) return false;
        } else if (op.command === 0xdf) { this.onTermination?.(op.data!, DPN.HOSTTERMINATEDSESSION); this.closing = true; void this.channel?.link.shutdown(); }
        return true;
    }
    private apply(op: NativeCoreOperation): void {
        if (op.command === 0xd7) { this.entries.set(op.id, op.entry!); this.entities.set(op.id, this.entity(op.entry!)); }
        else if (op.command === 0xd0) this.entries.set(op.id, op.entry!);
        else if (op.command === 0xd1 || op.command === 0xd8) { this.entities.delete(op.id); this.entries.delete(op.id); for (const entity of this.entities.values()) entity.members = entity.members.filter(id => id !== op.id); }
        else if (op.command === 0xd9 || op.command === 0xda) { const group = this.entities.get(op.id); if (group?.group) { group.members = group.members.filter(id => id !== op.player); if (op.command === 0xd9) group.members.push(op.player!); } }
        else if (op.command === 0xdb) {
            const entity = this.entities.get(op.id); if (entity) { if (op.mask! & 1) entity.name = { ...entity.name, short: op.name ?? "", shortNull: op.name === null }; if (op.mask! & 2) entity.data = [...op.data!]; }
        }
        this.onChange?.();
        if (op.requesting === this.localId && op.handle) this.complete(op.handle, { hr: DPN.OK, ...(op.command === 0xd7 ? { id: op.id } : {}) });
    }
    private sendInternal(bytes: Uint8Array): Promise<number> { return this.channel?.link.sendReliable(bytes) ?? Promise.resolve(DPN.NOCONNECTION); }
    private complete(id: number, reply: Reply): void { const request = this.requests.get(id); if (!request) return; this.requests.delete(id); clearTimeout(request.timer); request.finish(reply); }
    private request(command: number, words: number[], blobs: { field: number; data: Uint8Array }[] = []): Promise<Reply> {
        if (this.openError) return Promise.resolve({ hr: this.openError });
        if (this.requests.size >= 256) return Promise.resolve({ hr: DPN.TABLEFULL });
        let id = this.requestId++ >>> 0; while (!id || this.requests.has(id)) id = this.requestId++ >>> 0;
        let finish!: (reply: Reply) => void; const result = new Promise<Reply>(resolve => { finish = resolve; });
        const timer = setTimeout(() => this.complete(id, { hr: DPN.TIMEDOUT }), this.timeout); (timer as unknown as { unref?(): void }).unref?.();
        this.requests.set(id, { finish, timer, command });
        let bytes: Uint8Array;
        try {
            if (command === 0xe0) { const data = blobs[0]?.data ?? new Uint8Array(); bytes = new Uint8Array(8 + data.length); bytes.set(nativeCoreWords(command, id)); bytes.set(data, 8); }
            else bytes = encodeNativeCoreRequest(command, id, words, blobs);
        } catch { this.complete(id, { hr: DPN.INVALIDPARAM }); return result; }
        const generation = this.generation;
        void this.sendInternal(bytes).then(hr => { if (generation === this.generation && hr) this.complete(id, { hr }); });
        return result;
    }
    mutate(change: Record<string, unknown> & { op: string }): Reply | Promise<Reply> {
        if (this.openError) return { hr: this.openError };
        if (change.action === "session") return { hr: DPN.NOTHOST };
        const id = Number(change.id) >>> 0;
        if (change.action === "create" && change.group) {
            const name = (change.name as { short: string } | undefined)?.short ?? null, data = Uint8Array.from((change.data as number[]) ?? []);
            return this.request(0xd2, [Number(change.flags) >>> 0, (name !== null ? 1 : 0) | (data.length ? 2 : 0), 0, 0, 0, 0],
                [{ field: 8, data: nativeCoreWide(name) }, { field: 16, data }]);
        }
        if (change.action === "destroy" && change.group) return this.request(0xd5, [id]);
        if (change.action === "member") return this.request(change.add ? 0xd3 : 0xd4, [id, Number(change.member) >>> 0]);
        if (change.action === "info") {
            const name = (change.name as { short: string } | undefined)?.short, data = change.data as number[] | undefined;
            return this.request(0xd6, [id, (name !== undefined ? 1 : 0) | (data !== undefined ? 2 : 0), 0, 0, 0, 0],
                [{ field: 8, data: nativeCoreWide(name ?? null) }, { field: 16, data: Uint8Array.from(data ?? []) }]);
        }
        return { hr: DPN.INVALIDPARAM };
    }
    send(from: number, to: number, flags: number, data: Uint8Array): number | Promise<number> { return this.sendDpn(to, (flags & 1 ? 8 : 0) | (flags & 0x10000 ? 0 : 0x20), data); }
    async sendDpn(to: number, flags: number, data: Uint8Array): Promise<number> {
        if (this.closing) return DPN.ALREADYCLOSING;
        if (this.openError) return this.openError;
        if (!data.length || ((flags & 0x20) && to === this.localId)) return DPN.INVALIDPARAM;
        const target = this.entities.get(to); if (to && !target) return DPN.INVALIDPLAYER;
        const recipients = !to ? [...this.entities.values()].filter(e => !e.group).map(e => e.id) : target!.group ? target!.members : [to];
        const remote = recipients.filter(id => id !== this.localId);
        if (remote.some(id => id !== this.hostId)) return DPN.CONNECTIONLOST;
        if (data.length > 1024 * 1024) return DPN.DATATOOLARGE;
        let local = Promise.resolve<number>(DPN.OK);
        if (recipients.includes(this.localId) && !(flags & 0x20)) {
            if (flags & 4) {
                if (this.localProcessed.size >= 256) return DPN.TABLEFULL;
                local = new Promise<number>(resolve => {
                    const finish = (result: number) => { if (this.localProcessed.delete(finish)) resolve(result); }; this.localProcessed.add(finish);
                    if (!this.enqueue(this.localId, data, flags & 8 ? 1 : 0, () => finish(DPN.OK))) finish(DPN.TABLEFULL);
                });
            } else if (!this.enqueue(this.localId, data, flags & 8 ? 1 : 0)) return DPN.TABLEFULL;
        }
        if (!remote.length) return local;
        if (flags & 4) {
            // COMPLETEONPROCESS carries the real per-operation handle in the core envelope.
            const [remoteResult, localResult] = await Promise.all([this.request(0xe0, [], [{ field: 0, data }]), local]); return remoteResult.hr || localResult;
        }
        return flags & 8 ? this.channel!.link.sendReliable(data, 0, !(flags & 0x10)) : this.channel!.link.sendUnreliable(data, 0, !(flags & 0x10));
    }
    private enqueue(from: number, bytes: Uint8Array, flags: number, processed?: () => void): boolean {
        if (this.queue.length >= 4096 || this.queueBytes + bytes.length > 4 * 1024 * 1024) return false;
        let acknowledged = false;
        const complete = processed ? () => { if (!acknowledged) { acknowledged = true; processed(); } } : undefined;
        this.queue.push({ from: this.role === "client" && from === this.hostId ? 0 : from, to: this.localId, data: bytes.slice(), flags, processed: complete }); this.queueBytes += bytes.length; this.onMessage?.(from); return true;
    }
    removeMessage(index: number): void { const [message] = this.queue.splice(index, 1); if (message) this.queueBytes -= message.data.length; }
    playerAddress(id: number): Address | null { return id === this.localId ? this.localAddress : id === this.hostId && this.remote ? copyAddress(this.remote) : null; }
    kick(_id: number, _data: Uint8Array): number { return DPN.NOTHOST; }
    terminate(_data: Uint8Array, _reason?: number): number { return DPN.NOTHOST; }
    async shutdown(): Promise<number> {
        this.closing = true; const channel = this.channel;
        if (this.resolveConnect) { this.close(); return DPN.OK; }
        if (!channel || channel.link.state === "closed") { this.clear(); return DPN.OK; }
        const result = await channel.link.shutdown(), drained = await channel.closed; this.clear(); return result || drained;
    }
    private ended(result: number): void {
        if (this.resolveConnect) { this.finishConnect(result || DPN.CONNECTIONLOST); return; }
        if (!this.closing && this.connected) { this.lost = true; this.onTermination?.(new Uint8Array(), result || DPN.CONNECTIONLOST); }
        this.clear();
    }
    private clear(): void {
        this.connected = false; this.desc = null; this.entities.clear(); this.entries.clear(); this.operations.clear();
        this.queue.length = 0; this.queueBytes = 0;
        for (const finish of [...this.localProcessed]) finish(DPN.CONNECTIONLOST);
        for (const id of [...this.requests.keys()]) this.complete(id, { hr: DPN.CONNECTIONLOST });
        this.onChange?.();
    }
    close(): number {
        this.closing = true; ++this.generation; this.finishConnect(DPN.USERCANCEL); this.channel?.close(); this.clear(); this.lost = false; return DPN.OK;
    }
    dispose(): void { this.close(); this.disposed = true; }
}
