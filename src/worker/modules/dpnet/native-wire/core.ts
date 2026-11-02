import type { LanNetwork } from "../../../net/lan-network";
import type { Address, Entity, JoinPlayer, Message, Reply, SessionDesc } from "../../dplayx/session";
import type { DirectPlay8Backend, DirectPlay8Message, DirectPlay8ConnectCompletionLease } from "../backend";
import type { DirectPlay8Role } from "../peer";
import { DPN } from "../constants";
import { NativeDirectPlayChannel } from "./channel";
import { NativeDirectPlayPort } from "./port";
import { NativeLocalDelivery } from "./local-delivery";
import { NativePeerChannels } from "./peer-channels";
import { NativeGroupMemberships, type GroupState } from "./group-memberships";
import { DN } from "./frame-codec";
import type { NativeReassembledMessage } from "./receive-window";
import { decodeNativeCoreConnectInfo, encodeNativePlayerConnect, type NativeCoreApplication, type NativeNameTableEntry } from "./core-connect-codec";
import { decodeNativeCoreOperation, encodeNativeCoreRequest, nativeCoreWide, nativeCoreWords, type NativeCoreOperation } from "./core-operations";

interface Request { finish(reply: Reply): void; timer: ReturnType<typeof setTimeout>; command: number; target: number; removeAbort?(): void;
    groupId?: number; playerId?: number; entityId?: number; groupContext?: number; completed?(reply: Reply): void; }
const key = (a: Address): string => a.node.join(".") + ":" + a.port;
const copyAddress = (a: Address): Address => ({ node: a.node.slice(), port: a.port });
const emptyGuid = "0".repeat(32);
interface NameTableHistoryRecord {
    readonly operation: NativeCoreOperation; readonly payload: Uint8Array; readonly generation: number;
    indexed: boolean; active: boolean; state: "queued" | "active" | "failed" | "adopted";
}
interface NameTableDrainInvocation { readonly generation: number; reportDue: boolean; finished: boolean; }
interface ClientConnectOwner {
    readonly generation: number; channel?: NativeDirectPlayChannel; host?: NativeNameTableEntry;
    state: "held" | "releasing" | "released" | "cancelled"; ready: boolean; entered: boolean;
    readonly pending: DirectPlay8Message[]; bytes: number; lease: DirectPlay8ConnectCompletionLease;
}
type NameTableApplyResult = boolean | "held" | "blocked";
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
    onInfo?: (id: number, returned: (result?: number) => void, notify?: boolean) => void;
    onGroupCreated?: (id: number, returned: (result?: number) => void, context?: number) => void;
    onGroupDestroyed?: (id: number, returned: (result?: number) => void) => void;
    onGroupMember?: (group: number, player: number, add: boolean, returned: (result?: number) => void) => void;
    onTermination?: (data: Uint8Array, reason?: number) => void;
    onPlayerDestroyReason?: (id: number, reason: number) => void;
    onNativeTermination?: (data: Uint8Array, reason: number, returned: (result?: number) => void) => void;
    private termination?: { generation: number; channel: NativeDirectPlayChannel; returned: boolean; lostResult?: number };
    private readonly terminationDrains = new Set<{ channel: NativeDirectPlayChannel; mesh?: NativePeerChannels; port?: NativeDirectPlayPort }>();
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
    private destroyingGroups = new Map<number, NativeCoreOperation>();
    private inUseOperations = new Set<NativeCoreOperation>();
    private failedOperations = new Set<NativeCoreOperation>();
    private memberships = new NativeGroupMemberships();
    private historyRecords = new Map<NativeCoreOperation, NameTableHistoryRecord>();
    private activeOperationVersions = new Map<number, NameTableHistoryRecord>();
    private historyBytes = 0;
    private clientConnect?: ClientConnectOwner;
    private clientLocal?: NativeNameTableEntry;
    private clientHost?: NativeNameTableEntry;
    private clientPlayerCount = 0;
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
    get currentPlayers(): number { return this.role === "client" ? this.clientPlayerCount : [...this.entities.values()].filter(e => !e.group).length; }
    get openError(): number { return this.lost ? DPN.CONNECTIONLOST : this.connected && this.desc ? DPN.OK : DPN.NOCONNECTION; }
    async connect(address: Address, desc: SessionDesc, player: JoinPlayer, data: Uint8Array, port = 0): Promise<number> {
        if (this.disposed) return DPN.INVALIDOBJECT;
        if (this.resolveConnect) return DPN.CONNECTING;
        if (this.connected) return DPN.ALREADYCONNECTED;
        if (this.role === "server") return DPN.INVALIDPARAM;
        if (!this.network.connected) return DPN.NOCONNECTION;
        const generation = ++this.generation; this.mesh?.close(); this.mesh = undefined; this.port?.close(); this.port = undefined; this.channel?.close(); this.channel = undefined; this.joinReply = null; this.failedClosing = undefined;
        this.remote = copyAddress(address); this.closing = false; this.lost = false;
        this.clearClientConnect(); this.clearHistory(); this.memberships.clear(DPN.USERCANCEL); this.tableBytes = 0;
        if (this.role === "client") this.clientConnect = this.newClientConnectOwner(generation);
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
            if (this.clientConnect) this.clientConnect.channel = this.channel;
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
        if (!result) { this.connected = true; if (this.clientConnect) this.clientConnect.ready = true; }
        else if (finish) {
            this.desc = null; this.entities.clear(); this.entries.clear(); this.clearClientConnect(); this.clearHistory();
            this.memberships.clear(result); this.tableBytes = 0;
        }
        finish?.(result);
    }
    connectCompletionLease(): DirectPlay8ConnectCompletionLease | undefined {
        const owner = this.clientConnect;
        return owner?.ready && owner.state === "held" ? owner.lease : undefined;
    }
    private newClientConnectOwner(generation: number): ClientConnectOwner {
        const owner: ClientConnectOwner = { generation, state: "held", ready: false, entered: false, pending: [], bytes: 0, lease: null! };
        const current = () => this.clientConnect === owner && owner.generation === this.generation &&
            owner.state === "held" && !this.closing && !this.disposed && this.channel === owner.channel;
        owner.lease = {
            current,
            get entered() { return owner.entered; },
            enter: () => {
                if (current() && owner.ready && owner.host && this.clientHost === owner.host) owner.entered = true;
            },
            complete: () => {
                if (!current() || !owner.ready || !owner.entered || !owner.host || this.clientHost !== owner.host) return;
                owner.state = "releasing";
                try {
                    // Keep the delivery fence through synchronous reentry so new receives cannot overtake this FIFO.
                    while (this.clientConnect === owner && owner.generation === this.generation &&
                        !this.closing && owner.state === "releasing" && owner.pending.length) {
                        const message = owner.pending.shift()!;
                        owner.bytes -= message.data.length; message.to = this.localId;
                        this.queue.push(message); this.queueBytes += message.data.length;
                        this.onMessage?.(this.hostId);
                    }
                    if (this.clientConnect === owner && owner.state === "releasing") owner.state = "released";
                } catch (error) {
                    if (this.clientConnect === owner && owner.generation === this.generation) owner.channel?.close(DPN.GENERIC);
                    throw error;
                }
            },
            cancel: (result = DPN.USERCANCEL) => {
                if (!current()) return;
                owner.state = "cancelled"; owner.pending.length = 0; owner.bytes = 0;
                const reason = result || DPN.USERCANCEL, channel = owner.channel;
                if (this.resolveConnect) this.finishConnect(reason);
                channel?.close(reason);
            },
        };
        return owner;
    }
    private clearClientConnect(): void {
        const owner = this.clientConnect;
        this.clientConnect = undefined; this.clientLocal = undefined; this.clientHost = undefined; this.clientPlayerCount = 0;
        if (owner) { owner.state = "cancelled"; owner.pending.length = 0; owner.bytes = 0; }
    }
    private application(info: NativeCoreApplication): void {
        if (this.role === "client") this.clientPlayerCount = info.players;
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
        if (!(message.command & DN.USER1)) return this.desc || this.clientConnect ?
            this.enqueue(this.hostId, message.payload, message.command & DN.RELIABLE ? 1 : 0) : true;
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
            if (this.role === "client") {
                const owner = this.clientConnect;
                if (!owner || owner.state !== "held" || owner.host || owner.channel !== this.channel) return true;
                // Client shortcuts are not general name-table entries; the Server never supplies a sibling mesh.
                this.clientLocal = self; this.clientHost = host; owner.host = host;
                this.entries.clear(); this.entities.clear();
                this.tableBytes = this.entryBytes(self) + this.entryBytes(host);
                this.entities.set(self.id, this.entity(self)); this.entities.set(host.id, this.entity(host));
                this.joinReply = { hr: DPN.OK, id: self.id, data: new Uint8Array(info.reply) };
                this.hostAcknowledged = true;
                const generation = this.generation, channel = this.channel;
                // C3 is reliable, but its carrier ACK is not the Client connect-parent completion boundary.
                void this.sendInternal(nativeCoreWords(0xc3)).then(result => {
                    if (result && generation === this.generation && this.channel === channel && !this.closing) channel?.close(result);
                }, () => { if (generation === this.generation && this.channel === channel && !this.closing) channel?.close(DPN.GENERIC); });
                this.finishConnect(DPN.OK); this.onChange?.(); return true;
            }
            this.entries = new Map(info.entries.map(entry => [entry.id, entry])); this.tableBytes = info.entries.reduce((n, entry) => n + this.entryBytes(entry), 0); this.entities.clear();
            // Seed every name-table identity, including players whose mesh is not yet presented.
            let selfEntity: Entity | undefined, hostEntity: Entity | undefined;
            for (const entry of info.entries) {
                const entity = this.entity(entry), presented = !!(entry.flags & 0x10) || entry.id === self.id || entry.id === host.id;
                const tracked = this.memberships.track(entity, presented);
                if (tracked) { this.finishConnect(tracked); return true; }
                if (entity.group && !(entry.flags & 4)) this.entities.set(entry.id, entity);
                else if (entry.id === self.id) selfEntity = entity;
                else if (entry.id === host.id) hostEntity = entity;
            }
            // Native presentation order is groups, local player, host, then ready mesh players.
            this.entities.set(self.id, selfEntity!); this.entities.set(host.id, hostEntity!);
            for (const membership of info.members) {
                const seeded = this.memberships.seed(membership.group, membership.player, membership.version);
                if (seeded) { this.finishConnect(seeded); return true; }
            }
            for (const entity of this.entities.values()) if (entity.group) entity.members = this.memberships.members(entity.id);
            this.joinReply = { hr: DPN.OK, id: self.id, data: info.reply.slice() };
            const generation = this.generation;
            this.hostAcknowledged = false;
            const existing = info.entries.filter(entry => !(entry.flags & 0x10) && entry.id !== self.id && entry.id !== host.id);
            this.requiredPeers = new Set(existing.map(entry => entry.id));
            const mesh = new NativePeerChannels(this.network, this.port!, this.localId, this.remote!, {
                ready: id => {
                    if (generation !== this.generation || this.mesh !== mesh || this.closing) return;
                    const entry = this.entries.get(id); if (!entry) return;
                    const entity = this.entity(entry), tracked = this.memberships.track(entity);
                    if (tracked) { this.channel?.close(tracked); return; }
                    this.entities.set(id, entity); this.memberships.created(id); this.requiredPeers.delete(id);
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
        if (!this.desc) {
            if (this.role === "client" && this.clientConnect && op.command === 0xe0) {
                const generation = this.generation, channel = this.channel;
                return this.enqueue(this.hostId, op.data!, message.command & DN.RELIABLE ? 1 : 0, () => {
                    if (generation === this.generation && this.channel === channel && !this.closing && this.connected)
                        void this.sendInternal(nativeCoreWords(0xe1, op.handle!));
                });
            }
            return true;
        }
        if (op.command === 0xc6 || op.command === 0xd0 || op.command === 0xd1 || (op.command >= 0xd7 && op.command <= 0xdb)) {
            if (this.role !== "peer") return this.performDirectOperation(bytes);
            // An active unadopted replacement remains an explicitly unresolved native race.
            if (op.version > this.version && this.activeOperationVersions.has(op.version)) return true;
            const previous = this.operations.get(op.version), old = previous ? this.historyRecords.get(previous) : undefined;
            const reclaim = old && !old.active ? old : undefined;
            const projectedRecords = this.historyRecords.size + 1 - (reclaim ? 1 : 0);
            const projectedBytes = this.historyBytes + bytes.length - (reclaim ? reclaim.payload.length : 0);
            if (projectedRecords > 1024 || projectedBytes > 4 * 1024 * 1024) return false;
            // Keep original bytes, including noncanonical trailing data. Never reconstruct history from an encoder.
            const record: NameTableHistoryRecord = { operation: op, payload: new Uint8Array(bytes), generation: this.generation,
                indexed: true, active: false, state: op.version <= this.version ? "adopted" : "queued" };
            if (old) { old.indexed = false; this.releaseHistory(old); }
            this.operations.set(op.version, op); this.historyRecords.set(op, record); this.historyBytes += record.payload.length;
            if (!this.drainOperations()) return false;
        } else if (op.command === 0xcf) { this.application(op.application!); this.onChange?.(); }
        else if (op.command === 0xca && this.role === "peer") this.pruneHistory(op.version);
        else if (op.command === 0xde || op.command === 0xe1) this.complete(op.handle!, { hr: op.reason ?? DPN.OK }, this.hostId);
        else if (op.command === 0xe0) {
            const generation = this.generation;
            if (!this.enqueue(this.hostId, op.data!, message.command & DN.RELIABLE ? 1 : 0, () => {
                if (generation === this.generation && !this.closing && this.connected) void this.sendInternal(nativeCoreWords(0xe1, op.handle!));
            })) return false;
        } else if (op.command === 0xdf) {
            this.receiveTermination(op.data!);
        }
        return true;
    }
    private receiveTermination(data: Uint8Array): void {
        const channel = this.channel;
        if (!channel || this.termination || this.closing || this.disposed) return;
        const owner: { generation: number; channel: NativeDirectPlayChannel; returned: boolean; lostResult?: number } =
            { generation: this.generation, channel, returned: false };
        this.termination = owner;
        const returned = (result?: number) => {
            if (owner.returned) return;
            owner.returned = true;
            if (this.termination !== owner || this.generation !== owner.generation || this.channel !== channel || this.closing || this.disposed) return;
            // Discard cancels the lease; only actual callback return starts the DF teardown.
            if (result) {
                this.termination = undefined;
                if (owner.lostResult !== undefined) this.ended(owner.lostResult);
                return;
            }
            this.closing = true;
            const drain = { channel, mesh: this.mesh, port: this.port };
            this.terminationDrains.add(drain);
            // Detach the old generation before notifying observers or allowing reentrant reconnect.
            this.channel = undefined;
            this.clear(true);
            if (!this.terminationDrains.has(drain)) return;
            void Promise.all([channel.link.shutdown(), drain.mesh?.shutdown() ?? Promise.resolve(DPN.OK)])
                .then(() => channel.closed).then(() => this.finishTerminationDrain(drain), () => this.finishTerminationDrain(drain));
        };
        const copy = data.slice();
        try {
            if (this.onNativeTermination) this.onNativeTermination(copy, DPN.HOSTTERMINATEDSESSION, returned);
            else { this.onTermination?.(copy, DPN.HOSTTERMINATEDSESSION); returned(); }
        } catch (error) { returned(DPN.USERCANCEL); throw error; }
    }
    private finishTerminationDrain(drain: { channel: NativeDirectPlayChannel; mesh?: NativePeerChannels; port?: NativeDirectPlayPort }): void {
        if (!this.terminationDrains.delete(drain)) return;
        drain.channel.close(); drain.mesh?.close(); drain.port?.close();
    }
    /** Nonpeer dispatch owns each actual invocation independently, even for overlapping equal versions. */
    private performDirectOperation(bytes: Uint8Array): boolean {
        if (this.historyRecords.size >= 1024 || bytes.length > 4 * 1024 * 1024 - this.historyBytes) return false;
        const payload = new Uint8Array(bytes), op = decodeNativeCoreOperation(payload);
        if (!op) return true;
        const record: NameTableHistoryRecord = { operation: op, payload, generation: this.generation,
            indexed: false, active: true, state: "active" };
        this.historyRecords.set(op, record); this.historyBytes += payload.length;
        const returned = () => { if (this.ownsOperationLease(op)) this.finishOperationLease(record); };
        const result = op.command === 0xdb ? this.applyClientInfo(op, returned) : this.apply(op, returned);
        if (record.generation !== this.generation || this.closing) { this.finishOperationLease(record); return true; }
        if (result === "held") return true;
        // D8 explicitly adopts even a missing/rejected group; other helpers own their actual adoption points.
        if (result === true && op.command === 0xd8 && record.state !== "adopted") this.adoptOperation(op);
        if (result === false || result === "blocked") record.state = "failed";
        this.finishOperationLease(record);
        return true; // DNNTPerformOperation ignores helper errors, without forcing their adoption.
    }
    private applyClientInfo(op: NativeCoreOperation, resume: () => void): NameTableApplyResult {
        const local = this.clientLocal, host = this.clientHost, generation = this.generation;
        if (!local || !host || (op.id !== host.id && op.id !== local.id)) return true;
        const candidate = op.requesting === local.id && op.handle ? this.requests.get(op.handle) : undefined;
        const request = candidate?.command === 0xd6 && candidate.entityId === op.id && candidate.target === this.hostId ? candidate : undefined;
        if (request) clearTimeout(request.timer);
        // Own-client DB is only an ACK. NT5 deliberately does not reapply its payload to the local shortcut.
        if (op.id === host.id) {
            const next: NativeNameTableEntry = { ...host, ...(op.mask! & 1 ? { name: op.name ?? null } : {}),
                ...(op.mask! & 2 ? { data: new Uint8Array(op.data!) } : {}) };
            const bytes = this.tableBytes - this.entryBytes(host) + this.entryBytes(next);
            if (bytes > 4 * 1024 * 1024) return false;
            Object.assign(host, next); this.tableBytes = bytes;
            const entity = this.entities.get(host.id);
            if (entity) {
                if (op.mask! & 1) entity.name = { ...entity.name, short: host.name ?? "", shortNull: host.name === null };
                if (op.mask! & 2) entity.data = [...host.data];
            }
        }
        let returned = false, invoking = true, settled = false, failed = false, returnResult: number = DPN.OK;
        const settle = (result: number, tail: boolean) => {
            if (settled) return; settled = true;
            if (generation !== this.generation || this.closing || !this.ownsOperationLease(op) ||
                this.clientLocal !== local || this.clientHost !== host) return;
            if (result !== DPN.OK) {
                failed = true;
                try {
                    if (request && op.handle && this.requests.get(op.handle) === request) this.complete(op.handle, { hr: result }, this.hostId);
                } finally { if (generation === this.generation && !this.closing) this.channel?.close(result); }
                return;
            }
            try {
                // DNProcessUpdateInfo adopts the exact incoming version AFTER the actual notification returns.
                this.adoptOperation(op);
                if (request && op.handle && this.requests.get(op.handle) === request) this.complete(op.handle, { hr: DPN.OK }, this.hostId);
            } finally { if (tail && generation === this.generation && !this.closing) resume(); }
        };
        const complete = (result: number = DPN.OK) => {
            if (returned) return; returned = true; returnResult = result;
            if (!invoking) settle(result, true);
        };
        try {
            if (op.id === host.id && host.flags & 0x400) {
                const notify = !!this.clientConnect?.entered;
                if (this.onInfo) this.onInfo(host.id, complete, notify);
                else { if (notify) this.onChange?.(); complete(); }
            } else complete();
        } catch { if (!returned || returnResult === DPN.OK) returnResult = DPN.GENERIC; returned = true; }
        invoking = false;
        if (returned) settle(returnResult, false);
        return failed || !returned ? "held" : true;
    }
    /** Test diagnostics copy real retained bytes; no mutable backing storage escapes. */
    private historySnapshot(): { version: number; command: number; payload: Uint8Array;
        state: NameTableHistoryRecord["state"]; indexed: boolean; active: boolean }[] {
        return [...this.historyRecords.values()].map(record => ({ version: record.operation.version, command: record.operation.command,
            payload: record.payload.slice(), state: record.state, indexed: record.indexed, active: record.active }))
            .sort((a, b) => a.version - b.version || Number(b.indexed) - Number(a.indexed));
    }
    private get historyUsage(): { records: number; bytes: number } { return { records: this.historyRecords.size, bytes: this.historyBytes }; }
    private releaseHistory(record: NameTableHistoryRecord): void {
        if (record.indexed || record.active || this.historyRecords.get(record.operation) !== record) return;
        this.historyRecords.delete(record.operation); this.historyBytes -= record.payload.length;
        this.inUseOperations.delete(record.operation); this.failedOperations.delete(record.operation);
    }
    private pruneHistory(boundary: number): void {
        // One-shot strict inequality, not a monotonic tombstone or a semantic version update.
        for (const [version, op] of this.operations) if (version < boundary) {
            this.operations.delete(version);
            const record = this.historyRecords.get(op);
            if (record) { record.indexed = false; this.releaseHistory(record); }
        }
    }
    private clearHistory(): void {
        for (const record of this.historyRecords.values()) { record.indexed = false; record.active = false; }
        this.operations.clear(); this.historyRecords.clear(); this.activeOperationVersions.clear(); this.historyBytes = 0;
        this.destroyingGroups.clear(); this.inUseOperations.clear(); this.failedOperations.clear();
    }
    private ownsOperationLease(op: NativeCoreOperation): boolean {
        const record = this.historyRecords.get(op);
        return !!record?.active && record.generation === this.generation &&
            (this.role !== "peer" || this.activeOperationVersions.get(op.version) === record);
    }
    private finishOperationLease(record: NameTableHistoryRecord): void {
        if (this.historyRecords.get(record.operation) !== record || !record.active) return;
        record.active = false;
        if (this.activeOperationVersions.get(record.operation.version) === record) this.activeOperationVersions.delete(record.operation.version);
        this.releaseHistory(record);
    }
    private finishDrain(invocation: NameTableDrainInvocation): void {
        if (invocation.finished) return; invocation.finished = true;
        if (invocation.reportDue && invocation.generation === this.generation && !this.closing && this.desc && this.role === "peer")
            void this.sendInternal(nativeCoreWords(0xc9, this.version, 0));
    }
    /** Only this invocation's tail waits for its helper; reentrant receives own independent report intent. */
    private drainOperations(invocation: NameTableDrainInvocation = { generation: this.generation, reportDue: false, finished: false }): boolean {
        if (invocation.finished || invocation.generation !== this.generation || this.closing) return true;
        while (this.operations.has((this.version + 1) >>> 0)) {
            const next = this.operations.get((this.version + 1) >>> 0)!, record = this.historyRecords.get(next);
            if (!record || record.state !== "queued" || record.active) { this.finishDrain(invocation); return true; }
            record.active = true; record.state = "active"; this.activeOperationVersions.set(next.version, record);
            if (!(next.version % 4)) invocation.reportDue = true;
            const result = this.apply(next, () => {
                if (invocation.generation !== this.generation || this.closing || !this.ownsOperationLease(next)) return;
                this.finishOperationLease(record);
                if (!this.drainOperations(invocation)) this.channel?.close(DPN.TABLEFULL);
            });
            if (invocation.generation !== this.generation || this.closing) { this.finishOperationLease(record); return true; }
            if (result === "held") return true;
            if (result === "blocked" || result === false) {
                record.state = "failed"; this.failedOperations.add(next);
                this.finishOperationLease(record); this.finishDrain(invocation); return result !== false;
            }
            this.adoptOperation(next);
            this.finishOperationLease(record);
        }
        this.finishDrain(invocation); return true;
    }
    private adoptOperation(op: NativeCoreOperation): void {
        const record = this.historyRecords.get(op);
        if (!record || record.generation !== this.generation) return;
        record.state = "adopted"; this.version = this.role === "peer" ? Math.max(this.version, op.version) : op.version;
        // Only peer-mode DNNTAddOperation retains applied history. Nonpeer keeps just an actual active lease.
        if (this.role !== "peer" && this.operations.get(op.version) === op) {
            this.operations.delete(op.version); record.indexed = false; this.releaseHistory(record);
        }
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
    queryGroup(id: number): Entity | undefined { return this.memberships.queryGroup(id); }
    groupState(id: number): GroupState { return this.memberships.groupState(id); }
    private notifyMember(group: number, player: number, add: boolean, returned: (result?: number) => void): void {
        if (this.onGroupMember) this.onGroupMember(group, player, add, returned);
        else { this.onChange?.(); returned(); }
    }
    private applyGroupMember(op: NativeCoreOperation, resume: () => void): NameTableApplyResult {
        const add = op.command === 0xd9, player = op.player!, generation = this.generation;
        const candidate = op.requesting === this.localId && op.handle ? this.requests.get(op.handle) : undefined;
        const request = candidate?.command === (add ? 0xd3 : 0xd4) && candidate.target === this.hostId &&
            candidate.groupId === op.id && candidate.playerId === player ? candidate : undefined;
        if (request) clearTimeout(request.timer);
        this.inUseOperations.add(op);
        const group = this.entries.get(op.id), member = this.entries.get(player);
        if (!group || !member) {
            // Missing entries adopt the publication, without requester success.
            this.inUseOperations.delete(op); this.adoptOperation(op); return true;
        }
        const pair = add ? this.memberships.beginAdd(op.id, player, op.version) : this.memberships.beginRemove(op.id, player, op.version);
        // A completed helper error remains InUse and unadopted; only a fresh replacement node can retry.
        if (typeof pair === "number") { this.failedOperations.add(op); return "blocked"; }
        const entity = this.memberships.queryGroup(op.id);
        if (entity) entity.members = this.memberships.members(op.id);
        // Normal ADD/REMOVE reserves/adopts before notification; reentrant v+1 may proceed.
        this.adoptOperation(op);
        let returned = false, invoking = true;
        this.memberships.notify(pair, add, (g, p, adding, done) => this.notifyMember(g, p, adding, done), result => {
            if (returned) return; returned = true;
            if (generation !== this.generation || this.closing || !this.inUseOperations.delete(op)) return;
            try {
                if (result) {
                    try {
                        if (request && op.handle && this.requests.get(op.handle) === request)
                            this.complete(op.handle, { hr: result }, this.hostId);
                    } finally {
                        if (generation === this.generation && !this.closing) this.channel?.close(result);
                    }
                    return; // Infrastructure failure does not roll back the already committed membership/version.
                }
                this.onChange?.();
                if (request && op.handle && this.requests.get(op.handle) === request)
                    this.complete(op.handle, { hr: DPN.OK }, this.hostId);
            } finally {
                if (!result && !invoking && generation === this.generation && !this.closing) resume();
            }
        });
        invoking = false;
        return returned ? true : "held";
    }
    private applyGroupDestroyed(op: NativeCoreOperation, resume: () => void): boolean | "held" {
        const entry = this.entries.get(op.id), entity = this.entities.get(op.id);
        // NT5 adopts an unusable D8 version, but does not complete its requester successfully.
        if (!entry || !(entry.flags & 0x10) || !entity?.group) return true;
        const candidate = op.requesting === this.localId && op.handle ? this.requests.get(op.handle) : undefined;
        const request = candidate?.command === 0xd5 && candidate.target === this.hostId && candidate.groupId === op.id ? candidate : undefined;
        if (request) clearTimeout(request.timer);
        const generation = this.generation;
        this.destroyingGroups.set(op.id, op);
        let returned = false, invoking = true, committed = false;
        const result = this.memberships.destroy(op.id, (g, p, add, done) => this.notifyMember(g, p, add, done),
            this.onGroupDestroyed, hr => {
                if (returned) return; returned = true;
                if (generation !== this.generation || this.closing || this.destroyingGroups.get(op.id) !== op ||
                    !this.ownsOperationLease(op) || this.entries.get(op.id) !== entry || this.entities.get(op.id) !== entity) return;
                if (hr) {
                    try {
                        if (request && op.handle && this.requests.get(op.handle) === request)
                            this.complete(op.handle, { hr }, this.hostId);
                    } finally {
                        if (generation === this.generation && !this.closing) this.channel?.close(hr);
                    }
                    return;
                }
                try {
                    // Its own implicit REMOVE tails finished. External unlinked refs may retain deferred DESTROY.
                    this.tableBytes -= this.entryBytes(entry); this.entries.delete(op.id); this.entities.delete(op.id);
                    this.memberships.committed(op.id);
                    this.destroyingGroups.delete(op.id); this.adoptOperation(op); committed = true;
                    this.onChange?.();
                    if (request && op.handle && this.requests.get(op.handle) === request)
                        this.complete(op.handle, { hr: DPN.OK }, this.hostId);
                } finally {
                    if (!invoking && generation === this.generation && !this.closing) resume();
                }
            });
        invoking = false;
        if (result) {
            if (this.destroyingGroups.get(op.id) === op) this.destroyingGroups.delete(op.id);
            return true; // Immediate helper rejection adopts D8, without a successful request completion.
        }
        return committed ? true : "held";
    }
    private apply(op: NativeCoreOperation, resume: () => void): NameTableApplyResult {
        if (op.command === 0xd8) return this.applyGroupDestroyed(op, resume);
        if (op.command === 0xd9 || op.command === 0xda) return this.applyGroupMember(op, resume);
        if (op.command === 0xd7) {
            if (!(op.entry!.flags & 0x10) || this.entries.has(op.id) || !this.installEntry(op.entry!)) return false;
            const entity = this.entity(op.entry!);
            if (this.memberships.track(entity, false)) return false;
            this.entities.set(op.id, entity);
        }
        else if (op.command === 0xd0) { if (!this.installEntry(op.entry!) || this.memberships.track(this.entity(op.entry!), false)) return false; }
        else if (op.command === 0xc6 && this.role === "peer" && op.id !== this.localId) {
            const entry = this.entries.get(op.id), self = this.entries.get(this.localId);
            if (entry && self && entry.version >= self.version) void this.mesh?.expect(entry, true);
        }
        else if (op.command === 0xd1) {
            const entry = this.entries.get(op.id), generation = this.generation;
            // NT5 presets the reason on the existing entry before disconnect can reenter.
            if (entry && this.entities.has(op.id) && op.reason) this.onPlayerDestroyReason?.(op.id, op.reason);
            if (generation !== this.generation || this.closing || this.entries.get(op.id) !== entry) return true;
            this.memberships.retirePlayer(op.id);
            this.mesh?.remove(op.id); this.requiredPeers.delete(op.id); this.entities.delete(op.id);
            if (entry) this.tableBytes -= this.entryBytes(entry); this.entries.delete(op.id);
            if (op.command === 0xd1) for (const [id, group] of this.entries) if ((group.flags & 0x40) && (group.flags & 0x10) && group.owner === op.id) {
                // Each peer derives AUTO cleanup from the owner departure itself.
                this.memberships.retireGroup(id);
                this.tableBytes -= this.entryBytes(group); this.entries.delete(id); this.entities.delete(id);
            }
            for (const entity of this.entities.values()) entity.members = entity.members.filter(id => id !== op.id);
        }
        else if (op.command === 0xdb) {
            const prior = this.entries.get(op.id);
            if (prior && !this.installEntry({ ...prior, ...(op.mask! & 1 ? { name: op.name ?? null } : {}), ...(op.mask! & 2 ? { data: op.data! } : {}) })) return false;
            const entity = this.entities.get(op.id); if (entity) { if (op.mask! & 1) entity.name = { ...entity.name, short: op.name ?? "", shortNull: op.name === null }; if (op.mask! & 2) entity.data = [...op.data!]; }
        }
        // Commit before callbacks: a reentrant drain may apply v+1, but never this operation twice.
        this.adoptOperation(op);
        const generation = this.generation;
        const candidate = (op.command === 0xd7 || op.command === 0xdb) && op.requesting === this.localId && op.handle ? this.requests.get(op.handle) : undefined;
        const groupRequest = op.command === 0xd7 && candidate?.command === 0xd2 && candidate.target === this.hostId ? candidate : undefined;
        const infoRequest = op.command === 0xdb && candidate?.command === 0xd6 && candidate.entityId === op.id && candidate.target === this.hostId ? candidate : undefined;
        const request = groupRequest ?? infoRequest;
        // The exact publication arrived. Actual held notification is not a wire timeout.
        if (request) clearTimeout(request.timer);
        let returned = false, invoking = true, settled = false, callbackFailed = false, returnResult: number = DPN.OK;
        const settle = (result: number, resumeTail: boolean) => {
            if (settled) return; settled = true;
            if (generation !== this.generation || this.closing || !this.ownsOperationLease(op)) return;
            if (result !== DPN.OK) {
                callbackFailed = true; // Nonzero is bridge infrastructure failure; guest HRESULT is already ignored.
                try {
                    if (request && op.handle && this.requests.get(op.handle) === request) this.complete(op.handle, { hr: result }, this.hostId);
                } finally {
                    if (generation === this.generation && !this.closing) this.channel?.close(result);
                }
                return; // No rollback of precommitted table state and no successful invocation report.
            }
            try {
                if (op.command === 0xd7) this.memberships.created(op.id);
                if (request && op.handle && this.requests.get(op.handle) === request)
                    this.complete(op.handle, { hr: DPN.OK, ...(groupRequest ? { id: op.id } : {}) }, this.hostId);
            } finally {
                if (resumeTail && generation === this.generation && !this.closing) resume();
            }
        };
        const complete = (result: number = DPN.OK) => {
            if (returned) return; returned = true; returnResult = result;
            if (!invoking) settle(result, true);
        };
        try {
            if (op.command === 0xd7 && this.onGroupCreated) this.onGroupCreated(op.id, complete, groupRequest?.groupContext ?? 0);
            else if (op.command === 0xdb && this.onInfo) this.onInfo(op.id, complete);
            else { this.onChange?.(); complete(); }
        } catch { if (!returned || returnResult === DPN.OK) returnResult = DPN.GENERIC; returned = true; }
        invoking = false;
        if (returned) settle(returnResult, false);
        return callbackFailed || !returned ? "held" : true;
    }
    private sendInternal(bytes: Uint8Array, target = this.hostId): Promise<number> { return (target === this.hostId ? this.channel : this.mesh?.channel(target))?.link.sendReliable(bytes) ?? Promise.resolve(DPN.NOCONNECTION); }
    private complete(id: number, reply: Reply, source?: number): void {
        const request = this.requests.get(id); if (!request || (source !== undefined && request.target !== source)) return;
        this.requests.delete(id); clearTimeout(request.timer); request.removeAbort?.();
        try { request.completed?.(reply); } finally { request.finish(reply); }
    }
    private request(command: number, words: number[], blobs: { field: number; data: Uint8Array }[] = [], signal?: AbortSignal, target = this.hostId,
        local?: { groupContext?: number; completed?: (reply: Reply) => void }): Promise<Reply> {
        const refuse = (hr: number) => { const reply = { hr }; local?.completed?.(reply); return Promise.resolve(reply); };
        if (signal?.aborted) return refuse(DPN.USERCANCEL);
        if (this.openError) return refuse(this.openError);
        if (this.requests.size >= 256) return refuse(DPN.TABLEFULL);
        let id = this.requestId++ >>> 0; while (!id || this.requests.has(id)) id = this.requestId++ >>> 0;
        let finish!: (reply: Reply) => void; const result = new Promise<Reply>(resolve => { finish = resolve; });
        const timer = setTimeout(() => this.complete(id, { hr: DPN.TIMEDOUT }), this.timeout); (timer as unknown as { unref?(): void }).unref?.();
        const abort = () => this.complete(id, { hr: DPN.USERCANCEL });
        this.requests.set(id, { finish, timer, command, target, groupId: command === 0xd5 || command === 0xd3 || command === 0xd4 ? words[0] : undefined,
            playerId: command === 0xd3 || command === 0xd4 ? words[1] : undefined, entityId: command === 0xd6 ? words[0] : undefined, groupContext: local?.groupContext, completed: local?.completed,
            removeAbort: signal ? () => signal.removeEventListener("abort", abort) : undefined });
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
        if (this.openError) {
            const reply = { hr: this.openError };
            if (((change.action === "create" || change.action === "destroy") && change.group || change.action === "member" || change.action === "info") && typeof change.completed === "function")
                (change.completed as (reply: Reply) => void)(reply);
            return reply;
        }
        if (change.action === "session") return { hr: DPN.NOTHOST };
        const id = Number(change.id) >>> 0;
        if (change.action === "create" && change.group) {
            const completed = typeof change.completed === "function" ? change.completed as (reply: Reply) => void : undefined;
            const named = change.name as { short?: string; shortNull?: boolean } | undefined, input = change.data;
            const flags = Number(change.flags), context = change.context === undefined ? 0 : Number(change.context);
            if (named && typeof named.short !== "string" || !Array.isArray(input) ||
                input.some(n => !Number.isInteger(n) || n < 0 || n > 255) || !Number.isInteger(flags) || flags < 0 || flags > 1 ||
                !Number.isInteger(context) || context < 0 || context > 0xffffffff) {
                const reply = { hr: DPN.INVALIDPARAM }; completed?.(reply); return reply;
            }
            const name = named?.shortNull ? null : named?.short ?? null, data = Uint8Array.from(input);
            let nameBytes: Uint8Array;
            try { nameBytes = nativeCoreWide(name); } catch {
                const reply = { hr: DPN.INVALIDPARAM }; completed?.(reply); return reply;
            }
            return this.request(0xd2, [flags, (name !== null ? 1 : 0) | (data.length ? 2 : 0), 0, 0, 0, 0],
                [{ field: 8, data: nameBytes }, { field: 16, data }], undefined, this.hostId, { groupContext: context, completed });
        }
        if (change.action === "destroy" && change.group) {
            const completed = typeof change.completed === "function" ? change.completed as (reply: Reply) => void : undefined;
            const state = this.groupState(id);
            if (state === "disconnecting" || state === "deleted") {
                const reply = { hr: state === "deleted" ? DPN.CONNECTIONLOST : DPN.INVALIDGROUP }; completed?.(reply); return reply;
            }
            return this.request(0xd5, [id], [], undefined, this.hostId, { completed });
        }
        if (change.action === "member") {
            const completed = typeof change.completed === "function" ? change.completed as (reply: Reply) => void : undefined;
            const state = this.groupState(id);
            if (state === "disconnecting" || state === "deleted") {
                const reply = { hr: state === "deleted" ? DPN.CONNECTIONLOST : DPN.INVALIDGROUP }; completed?.(reply); return reply;
            }
            return this.request(change.add ? 0xd3 : 0xd4, [id, Number(change.member) >>> 0], [], undefined, this.hostId, { completed });
        }
        if (change.action === "info") {
            const completed = typeof change.completed === "function" ? change.completed as (reply: Reply) => void : undefined;
            const state = this.groupState(id);
            if (state === "disconnecting" || state === "deleted") {
                const reply = { hr: state === "deleted" ? DPN.CONNECTIONLOST : DPN.INVALIDGROUP }; completed?.(reply); return reply;
            }
            const named = change.name as { short: string; shortNull?: boolean } | undefined;
            const name = named ? named.shortNull ? null : named.short : undefined, data = change.data as number[] | undefined;
            return this.request(0xd6, [id, (name !== undefined ? 1 : 0) | (data !== undefined ? 2 : 0), 0, 0, 0, 0],
                [{ field: 8, data: nativeCoreWide(name ?? null) }, { field: 16, data: Uint8Array.from(data ?? []) }], undefined, this.hostId, { completed });
        }
        return { hr: DPN.INVALIDPARAM };
    }
    send(from: number, to: number, flags: number, data: Uint8Array): number | Promise<number> { return this.sendDpn(to, (flags & 1 ? 8 : 0) | (flags & 0x10000 ? 0 : 0x20), data); }
    async sendDpn(to: number, flags: number, data: Uint8Array, signal?: AbortSignal, acceptedLocal?: () => void, completedLocal?: (result: number) => void): Promise<number> {
        if (signal?.aborted) return DPN.USERCANCEL;
        if (this.closing) return DPN.ALREADYCLOSING;
        if (this.openError) return this.openError;
        if (!data.length || ((flags & 0x20) && to === this.localId)) return DPN.INVALIDPARAM;
        // IDirectPlay8Client sends only to its original Server connection.
        if (this.role === "client") to = this.hostId;
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
        const owner = this.role === "client" ? this.clientConnect : undefined;
        if (this.queue.length + (owner?.pending.length ?? 0) >= 4096 ||
            this.queueBytes + (owner?.bytes ?? 0) + bytes.length > 4 * 1024 * 1024) return false;
        let acknowledged = false;
        const complete = processed ? () => { if (!acknowledged) { acknowledged = true; processed(); } } : undefined;
        const message = { from: this.role === "client" && from === this.hostId ? 0 : from, to: this.localId,
            data: this.role === "client" ? new Uint8Array(bytes) : bytes.slice(), flags, processed: complete };
        if (owner && (owner.state === "held" || owner.state === "releasing")) {
            owner.pending.push(message); owner.bytes += bytes.length; return true;
        }
        this.queue.push(message); this.queueBytes += bytes.length; this.onMessage?.(from); return true;
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
        // A received DF owns the notification until return or discard; retain physical loss for discard.
        if (this.closing) return;
        if (this.termination) { this.termination.lostResult = result || DPN.CONNECTIONLOST; return; }
        if (this.resolveConnect) { this.finishConnect(result || DPN.CONNECTIONLOST); return; }
        // DNPIIndicateDisconnect only notifies Client termination after the public object became CONNECTED.
        const preparingClient = this.role === "client" && this.clientConnect?.ready && !this.clientConnect.entered;
        if (!this.closing && this.connected && !preparingClient) { this.lost = true; this.onTermination?.(new Uint8Array(), result || DPN.CONNECTIONLOST); }
        this.clear();
    }
    private clear(retainTransport = false): void {
        this.termination = undefined;
        if (!retainTransport) { this.mesh?.close(); this.port?.close(); }
        this.mesh = undefined; this.port = undefined; this.requiredPeers.clear(); this.hostAcknowledged = false;
        this.connected = false; this.desc = null; this.entities.clear(); this.entries.clear(); this.clearClientConnect(); this.clearHistory();
        this.memberships.clear(DPN.CONNECTIONLOST); this.tableBytes = 0;
        this.queue.length = 0; this.queueBytes = 0;
        this.localDelivery.cancel(DPN.CONNECTIONLOST);
        for (const id of [...this.requests.keys()]) this.complete(id, { hr: DPN.CONNECTIONLOST });
        this.onChange?.();
    }
    close(): number {
        this.closing = true; ++this.generation;
        for (const drain of this.terminationDrains) this.finishTerminationDrain(drain);
        this.finishConnect(DPN.USERCANCEL); this.channel?.close(); this.clear(); this.lost = false; return DPN.OK;
    }
    dispose(): void { this.close(); this.disposed = true; }
}
