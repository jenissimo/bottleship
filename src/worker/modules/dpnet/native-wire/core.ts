import type { LanNetwork } from "../../../net/lan-network";
import type { Address, Entity, JoinPlayer, Message, Reply, SessionDesc } from "../../dplayx/session";
import type { DirectPlay8Backend, DirectPlay8Message } from "../backend";
import type { DirectPlay8Role } from "../peer";
import { DPN } from "../constants";
import { NativeDirectPlayChannel } from "./channel";
import { NativeDirectPlayPort } from "./port";
import { NativeLocalDelivery } from "./local-delivery";
import { NativePeerChannels } from "./peer-channels";
import { DN } from "./frame-codec";
import type { NativeReassembledMessage } from "./receive-window";
import { decodeNativeCoreConnectInfo, encodeNativePlayerConnect, type NativeCoreApplication, type NativeNameTableEntry } from "./core-connect-codec";
import { decodeNativeCoreOperation, encodeNativeCoreRequest, nativeCoreWide, nativeCoreWords, type NativeCoreOperation } from "./core-operations";

interface Request { finish(reply: Reply): void; timer: ReturnType<typeof setTimeout>; command: number; target: number; removeAbort?(): void; }
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
    onInfo?: (id: number, returned: (result?: number) => void) => void;
    onTermination?: (data: Uint8Array, reason?: number) => void;
    private channel?: NativeDirectPlayChannel;
    private port?: NativeDirectPlayPort;
    private mesh?: NativePeerChannels;
    private requiredPeers = new Set<number>();
    private hostAcknowledged = false;
    private remote?: Address;
    private generation = 0;
    private disposed = false;
    private closing = false;
    private connected = false;
    private resolveConnect?: (result: number) => void;
    private connectTimer?: ReturnType<typeof setTimeout>;
    private entries = new Map<number, NativeNameTableEntry>();
    private operations = new Map<number, NativeCoreOperation>();
    private operationSizes = new Map<number, number>();
    private pendingOperationBytes = 0;
    private tableBytes = 0;
    private version = 0;
    private requestId = 1;
    private requests = new Map<number, Request>();
    private queueBytes = 0;
    private localDelivery = new NativeLocalDelivery();
    private failedClosing?: Promise<number>;
    constructor(readonly network: LanNetwork, readonly role: DirectPlay8Role, readonly timeout = 25000, readonly retryInterval = 200, readonly retries = 14) {}
    get pendingLocalProcessing(): number { return this.localDelivery.pending; }
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
        const generation = ++this.generation; this.mesh?.close(); this.mesh = undefined; this.port?.close(); this.port = undefined; this.channel?.close(); this.channel = undefined; this.joinReply = null; this.failedClosing = undefined;
        this.remote = copyAddress(address); this.closing = false; this.lost = false;
        this.operations.clear(); this.operationSizes.clear(); this.pendingOperationBytes = 0; this.tableBytes = 0;
        const completion = new Promise<number>(resolve => { this.resolveConnect = resolve; }).then(async result => {
            if (result && generation === this.generation) {
                const channel = this.channel;
                if (this.failedClosing) await this.failedClosing; else channel?.close(result);
                if (channel) await channel.closed;
                if (generation === this.generation) { this.mesh?.close(); this.mesh = undefined; this.port?.close(result); this.port = undefined; }
            }
            return result;
        });
        try {
            this.port = new NativeDirectPlayPort(this.network, port);
            this.channel = new NativeDirectPlayChannel(this.network, address, { timeout: this.timeout, retryInterval: this.retryInterval, retries: this.retries,
                onMessage: message => generation !== this.generation || this.receive(message, desc),
                onState: (state, result) => { if (generation === this.generation && state === "closed") this.ended(result); } }, 0, this.port);
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
        else if (finish) { this.desc = null; this.entities.clear(); this.entries.clear(); this.tableBytes = 0; }
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
        if (message.command & DN.USER2) return true; // Voice is a separate DirectPlayVoice channel.
        if (!(message.command & DN.USER1)) return this.desc ? this.enqueue(this.hostId, message.payload, message.command & DN.RELIABLE ? 1 : 0) : true;
        const bytes = message.payload;
        if (bytes.length < 4) return true;
        const command = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
        if (command === 0xc2) {
            if (!this.resolveConnect || this.desc) return true;
            const info = decodeNativeCoreConnectInfo(bytes); if (!info) return true;
            const self = info.entries.find(e => e.id === info.localId && !(e.flags & 0x10)), host = info.entries.find(e => e.flags & 2 && !(e.flags & 0x10));
            if (!self || !host || self.id === host.id || (requested.application !== emptyGuid && info.application.application !== requested.application) ||
                (requested.instance !== emptyGuid && info.application.instance !== requested.instance) || !!(info.application.flags & 1) !== (this.role === "client")) return true;
            if (info.entries.length > 4096 || info.entries.filter(entry => !(entry.flags & 0x10)).length > 64 || info.entries.reduce((n, entry) => n + this.entryBytes(entry), 0) > 4 * 1024 * 1024) return true;
            this.localId = self.id; this.hostId = host.id; this.version = info.version; this.application(info.application);
            this.entries = new Map(info.entries.map(entry => [entry.id, entry])); this.tableBytes = info.entries.reduce((n, entry) => n + this.entryBytes(entry), 0); this.entities.clear();
            // Native announces groups, local player, host, then their memberships.
            for (const entry of info.entries) if (entry.flags & 0x10 && !(entry.flags & 4)) this.entities.set(entry.id, this.entity(entry));
            this.entities.set(self.id, this.entity(self)); this.entities.set(host.id, this.entity(host));
            for (const membership of info.members) if (this.entities.has(membership.player)) this.entities.get(membership.group)?.members.push(membership.player);
            this.joinReply = { hr: DPN.OK, id: self.id, data: info.reply.slice() };
            const generation = this.generation;
            this.hostAcknowledged = false;
            const existing = info.entries.filter(entry => !(entry.flags & 0x10) && entry.id !== self.id && entry.id !== host.id);
            this.requiredPeers = new Set(existing.map(entry => entry.id));
            const mesh = new NativePeerChannels(this.network, this.port!, this.localId, this.remote!, {
                ready: id => {
                    if (generation !== this.generation || this.mesh !== mesh || this.closing) return;
                    const entry = this.entries.get(id); if (!entry) return;
                    this.entities.set(id, this.entity(entry)); this.requiredPeers.delete(id);
                    for (const membership of info.members) if (membership.player === id) this.entities.get(membership.group)?.members.push(id);
                    this.checkConnected(); this.onChange?.();
                },
                message: (id, message) => generation !== this.generation || this.receivePeer(id, message),
                lost: id => {
                    if (generation !== this.generation || this.closing || !this.entities.has(id)) return;
                    // Captured E2 and NT5 DNPlayerDisconnectNew: retire availability,
                    // retain the versioned entry until the host's D1, request integrity.
                    void this.request(0xe2, [id]);
                    this.entities.delete(id);
                    for (const entity of this.entities.values()) entity.members = entity.members.filter(member => member !== id);
                    for (const [handle, request] of this.requests) if (request.target === id) this.complete(handle, { hr: DPN.CONNECTIONLOST });
                    this.onChange?.();
                },
                failed: (id, result) => {
                    if (generation !== this.generation || this.closing) return;
                    if (this.resolveConnect) this.finishConnect(result);
                    else void this.sendInternal(nativeCoreWords(0xc7, id));
                },
            }, this.timeout, this.retryInterval, this.retries);
            this.mesh = mesh;
            void Promise.all(existing.map(entry => mesh.expect(entry, false))).then(async results => {
                if (generation !== this.generation || !this.resolveConnect || this.closing) return;
                const failure = results.find(result => result !== DPN.OK); if (failure) { this.finishConnect(failure); return; }
                const result = await this.sendInternal(nativeCoreWords(0xc3));
                if (generation !== this.generation || !this.resolveConnect || this.closing) return;
                if (result) { this.finishConnect(result); return; }
                this.hostAcknowledged = true; this.checkConnected();
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
            if (this.operations.has(op.version)) return true;
            if (this.operations.size >= 1024 || bytes.length > 4 * 1024 * 1024 - this.pendingOperationBytes) return false;
            this.operations.set(op.version, op); this.operationSizes.set(op.version, bytes.length); this.pendingOperationBytes += bytes.length;
            while (this.operations.has((this.version + 1) >>> 0)) {
                const next = this.operations.get((this.version + 1) >>> 0)!, generation = this.generation;
                if (!this.apply(next)) return false;
                if (generation !== this.generation || this.closing) return true;
                this.operations.delete(next.version); this.pendingOperationBytes -= this.operationSizes.get(next.version) ?? 0; this.operationSizes.delete(next.version);
                this.version = next.version;
            }
            if (this.role === "peer" && !(this.version % 4)) void this.sendInternal(nativeCoreWords(0xc9, this.version, 0));
        } else if (op.command === 0xcf) { this.application(op.application!); this.onChange?.(); }
        else if (op.command === 0xca) { /* Host has acknowledged our reported name-table version. */ }
        else if (op.command === 0xde || op.command === 0xe1) this.complete(op.handle!, { hr: op.reason ?? DPN.OK }, this.hostId);
        else if (op.command === 0xe0) {
            const generation = this.generation;
            if (!this.enqueue(this.hostId, op.data!, message.command & DN.RELIABLE ? 1 : 0, () => {
                if (generation === this.generation && !this.closing && this.connected) void this.sendInternal(nativeCoreWords(0xe1, op.handle!));
            })) return false;
        } else if (op.command === 0xdf) { this.onTermination?.(op.data!, DPN.HOSTTERMINATEDSESSION); this.closing = true; void this.channel?.link.shutdown(); }
        return true;
    }
    private checkConnected(): void {
        if (this.resolveConnect && this.hostAcknowledged && !this.requiredPeers.size && !this.closing) { this.finishConnect(DPN.OK); this.onChange?.(); }
    }
    private receivePeer(id: number, message: NativeReassembledMessage): boolean {
        if (this.closing || !this.entities.has(id) || message.command & DN.USER2) return true;
        if (!(message.command & DN.USER1)) return this.enqueue(id, message.payload, message.command & DN.RELIABLE ? 1 : 0);
        const op = decodeNativeCoreOperation(message.payload); if (!op) return true;
        if (op.command === 0xe1) this.complete(op.handle!, { hr: DPN.OK }, id);
        else if (op.command === 0xe0) {
            const generation = this.generation, channel = this.mesh?.channel(id);
            return this.enqueue(id, op.data!, message.command & DN.RELIABLE ? 1 : 0, () => {
                if (generation === this.generation && !this.closing && this.mesh?.channel(id) === channel)
                    void channel?.link.sendReliable(nativeCoreWords(0xe1, op.handle!));
            });
        }
        return true;
    }
    private entryBytes(entry: NativeNameTableEntry): number { return 48 + entry.data.length + (entry.name?.length ?? 0) * 2 + (entry.url?.length ?? 0); }
    private installEntry(entry: NativeNameTableEntry): boolean {
        const prior = this.entries.get(entry.id), bytes = this.tableBytes - (prior ? this.entryBytes(prior) : 0) + this.entryBytes(entry);
        if ((!prior && this.entries.size >= 4096) || bytes > 4 * 1024 * 1024 ||
            (!prior && !(entry.flags & 0x10) && [...this.entries.values()].filter(item => !(item.flags & 0x10)).length >= 64)) return false;
        this.entries.set(entry.id, entry); this.tableBytes = bytes; return true;
    }
    private apply(op: NativeCoreOperation): boolean {
        if (op.command === 0xd7) { if (!this.installEntry(op.entry!)) return false; this.entities.set(op.id, this.entity(op.entry!)); }
        else if (op.command === 0xd0) { if (!this.installEntry(op.entry!)) return false; }
        else if (op.command === 0xc6 && op.id !== this.localId) {
            const entry = this.entries.get(op.id), self = this.entries.get(this.localId);
            if (entry && self && entry.version >= self.version) void this.mesh?.expect(entry, true);
        }
        else if (op.command === 0xd1 || op.command === 0xd8) { this.mesh?.remove(op.id); this.requiredPeers.delete(op.id); this.entities.delete(op.id); const entry = this.entries.get(op.id); if (entry) this.tableBytes -= this.entryBytes(entry); this.entries.delete(op.id); for (const entity of this.entities.values()) entity.members = entity.members.filter(id => id !== op.id); }
        else if (op.command === 0xd9 || op.command === 0xda) { const group = this.entities.get(op.id); if (group?.group) { group.members = group.members.filter(id => id !== op.player); if (op.command === 0xd9) group.members.push(op.player!); } }
        else if (op.command === 0xdb) {
            const prior = this.entries.get(op.id);
            if (prior && !this.installEntry({ ...prior, ...(op.mask! & 1 ? { name: op.name ?? null } : {}), ...(op.mask! & 2 ? { data: op.data! } : {}) })) return false;
            const entity = this.entities.get(op.id); if (entity) { if (op.mask! & 1) entity.name = { ...entity.name, short: op.name ?? "", shortNull: op.name === null }; if (op.mask! & 2) entity.data = [...op.data!]; }
        }
        const generation = this.generation;
        let returned = false;
        const complete = (result: number = DPN.OK) => {
            if (returned) return; returned = true;
            if (generation === this.generation && op.requesting === this.localId && op.handle)
                this.complete(op.handle, { hr: result, ...(op.command === 0xd7 ? { id: op.id } : {}) });
        };
        if (op.command === 0xdb && this.onInfo) this.onInfo(op.id, complete);
        else { this.onChange?.(); complete(); }
        return true;
    }
    private sendInternal(bytes: Uint8Array, target = this.hostId): Promise<number> { return (target === this.hostId ? this.channel : this.mesh?.channel(target))?.link.sendReliable(bytes) ?? Promise.resolve(DPN.NOCONNECTION); }
    private complete(id: number, reply: Reply, source?: number): void { const request = this.requests.get(id); if (!request || (source !== undefined && request.target !== source)) return; this.requests.delete(id); clearTimeout(request.timer); request.removeAbort?.(); request.finish(reply); }
    private request(command: number, words: number[], blobs: { field: number; data: Uint8Array }[] = [], signal?: AbortSignal, target = this.hostId): Promise<Reply> {
        if (signal?.aborted) return Promise.resolve({ hr: DPN.USERCANCEL });
        if (this.openError) return Promise.resolve({ hr: this.openError });
        if (this.requests.size >= 256) return Promise.resolve({ hr: DPN.TABLEFULL });
        let id = this.requestId++ >>> 0; while (!id || this.requests.has(id)) id = this.requestId++ >>> 0;
        let finish!: (reply: Reply) => void; const result = new Promise<Reply>(resolve => { finish = resolve; });
        const timer = setTimeout(() => this.complete(id, { hr: DPN.TIMEDOUT }), this.timeout); (timer as unknown as { unref?(): void }).unref?.();
        const abort = () => this.complete(id, { hr: DPN.USERCANCEL });
        this.requests.set(id, { finish, timer, command, target, removeAbort: signal ? () => signal.removeEventListener("abort", abort) : undefined });
        signal?.addEventListener("abort", abort, { once: true });
        let bytes: Uint8Array;
        try {
            if (command === 0xe0) { const data = blobs[0]?.data ?? new Uint8Array(); bytes = new Uint8Array(8 + data.length); bytes.set(nativeCoreWords(command, id)); bytes.set(data, 8); }
            else bytes = encodeNativeCoreRequest(command, id, words, blobs);
        } catch { this.complete(id, { hr: DPN.INVALIDPARAM }); return result; }
        const generation = this.generation;
        void this.sendInternal(bytes, target).then(hr => { if (generation === this.generation && hr) this.complete(id, { hr }); });
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
            const named = change.name as { short: string; shortNull?: boolean } | undefined;
            const name = named ? named.shortNull ? null : named.short : undefined, data = change.data as number[] | undefined;
            return this.request(0xd6, [id, (name !== undefined ? 1 : 0) | (data !== undefined ? 2 : 0), 0, 0, 0, 0],
                [{ field: 8, data: nativeCoreWide(name ?? null) }, { field: 16, data: Uint8Array.from(data ?? []) }]);
        }
        return { hr: DPN.INVALIDPARAM };
    }
    send(from: number, to: number, flags: number, data: Uint8Array): number | Promise<number> { return this.sendDpn(to, (flags & 1 ? 8 : 0) | (flags & 0x10000 ? 0 : 0x20), data); }
    async sendDpn(to: number, flags: number, data: Uint8Array, signal?: AbortSignal, acceptedLocal?: () => void, completedLocal?: (result: number) => void): Promise<number> {
        if (signal?.aborted) return DPN.USERCANCEL;
        if (this.closing) return DPN.ALREADYCLOSING;
        if (this.openError) return this.openError;
        if (!data.length || ((flags & 0x20) && to === this.localId)) return DPN.INVALIDPARAM;
        const target = this.entities.get(to); if (to && !target) return DPN.INVALIDPLAYER;
        const recipients = !to ? [...this.entities.values()].filter(e => !e.group).map(e => e.id) : target!.group ? target!.members : [to];
        const remote = recipients.filter(id => id !== this.localId);
        if (remote.some(id => id !== this.hostId && !this.mesh?.channel(id))) return DPN.CONNECTIONLOST;
        if (data.length > 1024 * 1024) return DPN.DATATOOLARGE;
        let local = Promise.resolve<number>(DPN.OK);
        if (recipients.includes(this.localId) && !(flags & 0x20)) {
            const result = this.localDelivery.deliver(to === this.localId, flags, data,
                (bytes, wireFlags, processed) => this.enqueue(this.localId, bytes, wireFlags, processed), signal, acceptedLocal, completedLocal);
            if (typeof result === "number" && result) return result;
            local = Promise.resolve(result);
        }
        if (!remote.length) return local;
        if (flags & 4) {
            // COMPLETEONPROCESS carries the real per-operation handle in the core envelope.
            const [results, localResult] = await Promise.all([Promise.all(remote.map(id => this.request(0xe0, [], [{ field: 0, data }], signal, id))), local]); return results.find(result => result.hr)?.hr || localResult;
        }
        const results = await Promise.all(remote.map(id => { const link = (id === this.hostId ? this.channel : this.mesh!.channel(id))!.link; return flags & 8 ? link.sendReliable(data, 0, !(flags & 0x10)) : link.sendUnreliable(data, 0, !(flags & 0x10)); }));
        return results.find(result => result !== DPN.OK) ?? DPN.OK;
    }
    private enqueue(from: number, bytes: Uint8Array, flags: number, processed?: () => void): boolean {
        if (this.queue.length >= 4096 || this.queueBytes + bytes.length > 4 * 1024 * 1024) return false;
        let acknowledged = false;
        const complete = processed ? () => { if (!acknowledged) { acknowledged = true; processed(); } } : undefined;
        this.queue.push({ from: this.role === "client" && from === this.hostId ? 0 : from, to: this.localId, data: bytes.slice(), flags, processed: complete }); this.queueBytes += bytes.length; this.onMessage?.(from); return true;
    }
    removeMessage(index: number): void { const [message] = this.queue.splice(index, 1); if (message) this.queueBytes -= message.data.length; }
    playerAddress(id: number): Address | null { return id === this.localId ? this.localAddress : id === this.hostId && this.remote ? copyAddress(this.remote) : this.mesh?.address(id) ?? null; }
    kick(_id: number, _data: Uint8Array): number { return DPN.NOTHOST; }
    terminate(_data: Uint8Array, _reason?: number): number { return DPN.NOTHOST; }
    async shutdown(): Promise<number> {
        this.closing = true; const channel = this.channel;
        if (this.resolveConnect) { this.close(); return DPN.OK; }
        if (!channel || channel.link.state === "closed") { this.clear(); return DPN.OK; }
        const [result, mesh] = await Promise.all([channel.link.shutdown(), this.mesh?.shutdown() ?? Promise.resolve(DPN.OK)]), drained = await channel.closed;
        this.clear(); return result || mesh || drained;
    }
    private ended(result: number): void {
        if (this.closing) return;
        if (this.resolveConnect) { this.finishConnect(result || DPN.CONNECTIONLOST); return; }
        if (!this.closing && this.connected) { this.lost = true; this.onTermination?.(new Uint8Array(), result || DPN.CONNECTIONLOST); }
        this.clear();
    }
    private clear(): void {
        this.mesh?.close(); this.mesh = undefined; this.port?.close(); this.port = undefined; this.requiredPeers.clear(); this.hostAcknowledged = false;
        this.connected = false; this.desc = null; this.entities.clear(); this.entries.clear(); this.operations.clear(); this.operationSizes.clear(); this.pendingOperationBytes = 0; this.tableBytes = 0;
        this.queue.length = 0; this.queueBytes = 0;
        this.localDelivery.cancel(DPN.CONNECTIONLOST);
        for (const id of [...this.requests.keys()]) this.complete(id, { hr: DPN.CONNECTIONLOST });
        this.onChange?.();
    }
    close(): number {
        this.closing = true; ++this.generation; this.finishConnect(DPN.USERCANCEL); this.channel?.close(); this.clear(); this.lost = false; return DPN.OK;
    }
    dispose(): void { this.close(); this.disposed = true; }
}
