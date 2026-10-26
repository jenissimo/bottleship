import type { LanNetwork } from "../../../net/lan-network";
import { isAddressNode } from "../../../net/netplay-wire";
import type { Address, Reply, SessionDesc } from "../../dplayx/session";
import type { DirectPlay8Backend, DirectPlay8HostProvider, DirectPlay8HostReady } from "../backend";
import { DPN } from "../constants";
import { NativeDirectPlayHost, type NativeHostDecision, type NativeHostJoin } from "./host";
import { NativeDirectPlayPort } from "./port";
import { NativeLocalDelivery } from "./local-delivery";
const clone = (a: Address): Address => ({ node: a.node.slice(), port: a.port });
const key = (a: Address) => a.node.join(".") + ":" + a.port;
interface RemoteProcessing {
    recipient: number; generation: number;
    resolve(result: number): void; reject(error: unknown): void; removeAbort?(): void;
}
/** Native authority attached only after its provider acknowledges the actual listener. */
export class NativeHostBackend implements DirectPlay8Backend {
    readonly kind = "native" as const;
    readonly host: NativeDirectPlayHost;
    readonly localDelivery = new NativeLocalDelivery();
    onChange?: () => void;
    onMessage?: (id: number) => void;
    onInfo?: (id: number, returned: (result?: number) => void) => void;
    onTermination?: (data: Uint8Array, reason?: number) => void;
    lost = false;
    private port?: NativeDirectPlayPort;
    private ready?: DirectPlay8HostReady;
    private advertised?: Address;
    private pending?: AbortController;
    private generation = 0;
    private closing = false;
    private disposed = false;
    // Local bounded request ownership, not a measured Windows capacity limit.
    private remoteProcessing = new Map<number, RemoteProcessing>();
    private nextProcessingHandle = 1; // Never reset/reuse a handle across Host generations.
    constructor(readonly network: LanNetwork, readonly timeout = 25000, readonly retryInterval = 200) {
        this.host = new NativeDirectPlayHost(network);
        this.host.onMessage = id => this.onMessage?.(id);
        this.host.onProcessingComplete = (id, handle) => {
            const request = this.remoteProcessing.get(handle);
            if (request && request.recipient === id && request.generation === this.generation && !this.closing && !this.lost)
                this.completeRemoteProcessing(handle, DPN.OK);
        };
        this.host.onInfo = (id, returned) => { if (this.onInfo) this.onInfo(id, returned); else { this.onChange?.(); returned(); } };
        this.host.onChange = () => {
            if (!this.host.desc) {
                if (this.ready && !this.closing) { this.lost = true; this.localDelivery.cancel(DPN.CONNECTIONLOST); }
                this.cancelRemoteProcessing(DPN.CONNECTIONLOST);
                this.releaseReady();
            } else {
                for (const [handle, request] of [...this.remoteProcessing])
                    if (!this.host.entities.has(request.recipient)) this.completeRemoteProcessing(handle, DPN.CONNECTIONLOST);
            }
            this.onChange?.();
        };
    }
    get entities() { return this.host.entities; }
    get queue() { return this.host.queue; }
    get desc() { return this.host.desc; }
    get localId(): number { return this.host.localId; }
    get localAddress(): Address { return this.host.localAddress; }
    get advertisedAddress(): Address | undefined { return this.advertised ? clone(this.advertised) : undefined; }
    get hostAddress(): Address | null { return this.desc ? this.localAddress : null; }
    get ownKey(): string { return key(this.localAddress); }
    get joinReply(): Reply | null { return null; }
    get currentPlayers(): number { return this.host.currentPlayers; }
    get isHost(): boolean { return this.host.isHost; }
    get openError(): number { return this.lost ? DPN.CONNECTIONLOST : this.desc ? DPN.OK : DPN.NOCONNECTION; }
    get pendingLocalProcessing(): number { return this.localDelivery.pending; }
    private takeRemoteProcessing(handle: number): RemoteProcessing | undefined {
        const request = this.remoteProcessing.get(handle); if (!request) return undefined;
        this.remoteProcessing.delete(handle); request.removeAbort?.(); return request;
    }
    private completeRemoteProcessing(handle: number, result: number): void { this.takeRemoteProcessing(handle)?.resolve(result); }
    private rejectRemoteProcessing(handle: number, error: unknown): void { this.takeRemoteProcessing(handle)?.reject(error); }
    private cancelRemoteProcessing(result: number): void {
        for (const handle of [...this.remoteProcessing.keys()]) this.completeRemoteProcessing(handle, result);
    }
    private requestRemoteProcessing(recipient: number, flags: number, data: Uint8Array, signal?: AbortSignal): Promise<number> {
        if (signal?.aborted) return Promise.resolve(DPN.USERCANCEL);
        if (this.remoteProcessing.size >= 256 || this.nextProcessingHandle > 0xffffffff) return Promise.resolve(DPN.TABLEFULL);
        const handle = this.nextProcessingHandle++;
        let resolve!: (result: number) => void, reject!: (error: unknown) => void;
        const result = new Promise<number>((done, failed) => { resolve = done; reject = failed; });
        const abort = () => this.completeRemoteProcessing(handle, DPN.USERCANCEL);
        this.remoteProcessing.set(handle, { recipient, generation: this.generation, resolve, reject,
            removeAbort: signal ? () => signal.removeEventListener("abort", abort) : undefined });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { this.completeRemoteProcessing(handle, DPN.USERCANCEL); return result; }
        // Install ownership before sending: a synchronous carrier may deliver E1 reentrantly.
        void this.host.sendDpn(recipient, flags & 0x1c, data, handle).then(
            hr => { if (hr) this.completeRemoteProcessing(handle, hr); },
            error => this.rejectRemoteProcessing(handle, error));
        return result;
    }
    private releaseReady(): void {
        const ready = this.ready; this.ready = undefined; this.advertised = undefined;
        try { ready?.release(); } catch { /* Binding teardown must still finish. */ }
    }
    async start(desc: SessionDesc, player: { name: string | null; data: Uint8Array }, provider: DirectPlay8HostProvider, portNumber: number,
        admit: (request: NativeHostJoin) => NativeHostDecision | Promise<NativeHostDecision>, accepted: (id: number, context: unknown) => void, aborted?: (context: unknown) => void): Promise<number> {
        if (this.disposed) return DPN.INVALIDOBJECT;
        if (this.pending) return DPN.CONNECTING;
        if (this.desc) return DPN.HOSTING;
        if (desc.extended?.flags ?? 0) return DPN.UNSUPPORTED;
        if (!Number.isInteger(desc.maxPlayers) || desc.maxPlayers < 0 || desc.maxPlayers > 0xffffffff) return DPN.INVALIDPARAM;
        this.closing = false; this.lost = false;
        const generation = ++this.generation, controller = new AbortController(); this.pending = controller;
        let port: NativeDirectPlayPort | undefined, offered: DirectPlay8HostReady | undefined;
        let removeState: (() => void) | undefined, removeAbort: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
        const live = () => generation === this.generation && !this.closing && !controller.signal.aborted && !!port?.live;
        const release = (ready: DirectPlay8HostReady) => { try { ready.release(); } catch { /* Old provider lifetime is still retired. */ } };
        try {
            port = this.port = new NativeDirectPlayPort(this.network, portNumber);
            removeState = this.network.onStateChange(() => { if (!port!.live) controller.abort(); });
            const cancelled = new Promise<never>((_resolve, reject) => {
                const abort = () => reject(Error("Native Host preparation cancelled"));
                controller.signal.addEventListener("abort", abort, { once: true }); removeAbort = () => controller.signal.removeEventListener("abort", abort);
            });
            timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeout);
            (timer as unknown as { unref?(): void }).unref?.();
            const prepared = Promise.resolve(provider.prepare({ localPort: port.localPort, bindingGeneration: port.binding,
                localAddress: { node: Array.from(this.network.node), port: port.localPort }, signal: controller.signal })).then(ready => {
                if (!live()) { release(ready); throw Error("Retired native Host READY"); }
                offered = ready; return ready;
            });
            const ready = await Promise.race([prepared, cancelled]);
            if (!live()) return DPN.USERCANCEL;
            const address = ready.address;
            if (!address || !Array.isArray(address.node) || address.node.length !== 6 || address.node.some(n => !Number.isInteger(n) || n < 0 || n > 255) ||
                !isAddressNode(Uint8Array.from(address.node)) || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535 ||
                typeof ready.allowIncoming !== "function" || typeof ready.url !== "function" || typeof ready.release !== "function" || ready.isLive?.() === false)
                return DPN.INVALIDDEVICEADDRESS;
            this.ready = ready; this.advertised = clone(address); offered = undefined;
            const providerLost = () => {
                if (this.ready !== ready || generation !== this.generation || this.closing || this.disposed) return;
                this.lost = true; this.localDelivery.cancel(DPN.CONNECTIONLOST);
                this.cancelRemoteProcessing(DPN.CONNECTIONLOST);
                this.host.close(); port?.close(); if (this.port === port) this.port = undefined; this.releaseReady();
            };
            void ready.closed?.then(providerLost, providerLost);
            let instance = desc.instance;
            if (instance === "0".repeat(32)) {
                const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[7] = (bytes[7] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
                instance = Array.from(bytes, n => n.toString(16).padStart(2, "0")).join("");
            }
            const result = this.host.start({ port, application: { instance, application: desc.application,
                flags: desc.extended?.flags ?? 0, maxPlayers: desc.maxPlayers, players: 1, name: desc.nameNull ? null : desc.name,
                password: desc.passwordNull || !desc.password ? null : desc.password,
                reserved: Uint8Array.from(desc.extended?.reserved ?? []), applicationData: Uint8Array.from(desc.extended?.application ?? []) },
                player, timeout: this.timeout, retryInterval: this.retryInterval,
                url: address => ready.url(clone(address)), allowIncoming: address => ready.isLive?.() !== false && ready.allowIncoming(clone(address)),
                admit, accepted, aborted, replyReleased: decision => decision.returnBuffer?.() });
            if (result) { this.releaseReady(); port.close(result); }
            return result;
        } catch {
            return timedOut ? DPN.TIMEDOUT : controller.signal.aborted || generation !== this.generation ? DPN.USERCANCEL : DPN.INVALIDDEVICEADDRESS;
        } finally {
            if (timer) clearTimeout(timer); removeState?.(); removeAbort?.();
            if (offered) release(offered);
            if (!this.desc) { port?.close(); if (this.port === port) this.port = undefined; this.releaseReady(); }
            if (this.pending === controller) this.pending = undefined;
        }
    }
    playerAddress(id: number): Address | null { return id === this.localId && this.ready ? this.advertisedAddress! : this.host.playerAddress(id); }
    removeMessage(index: number): void { this.host.removeMessage(index); }
    async sendDpn(to: number, flags: number, data: Uint8Array, signal?: AbortSignal, acceptedLocal?: () => void, completedLocal?: (result: number) => void): Promise<number> {
        if (signal?.aborted) return DPN.USERCANCEL;
        if (this.closing) return DPN.ALREADYCLOSING;
        if (this.openError) return this.openError;
        if (!data.length || ((flags & 0x20) && to === this.localId)) return DPN.INVALIDPARAM;
        if (data.length > 1024 * 1024) return DPN.DATATOOLARGE;
        const target = this.entities.get(to); if (to && !target) return DPN.INVALIDPLAYER;
        const recipients = !to ? [...this.entities.values()].filter(e => !e.group).map(e => e.id) : target!.group ? target!.members : [to];
        const remote = recipients.filter(id => id !== this.localId);
        if ((flags & 4) && (remote.length > 256 - this.remoteProcessing.size ||
            remote.length > 0xffffffff - this.nextProcessingHandle + 1)) return DPN.TABLEFULL;
        const generation = this.generation;
        let local = Promise.resolve<number>(DPN.OK);
        if (recipients.includes(this.localId) && !(flags & 0x20)) {
            const result = this.localDelivery.deliver(to === this.localId, flags, data,
                (bytes, wireFlags, processed) => this.host.deliverLocal(bytes, wireFlags, processed), signal, acceptedLocal, completedLocal);
            if (typeof result === "number" && result) return result;
            local = Promise.resolve(result);
        }
        if (flags & 4) {
            if (generation !== this.generation || this.closing) return DPN.USERCANCEL;
            const [results, localResult] = await Promise.all([
                Promise.all(remote.map(id => this.requestRemoteProcessing(id, flags, data, signal))), local]);
            return results.find(result => result !== DPN.OK) ?? localResult;
        }
        const results = await Promise.all(remote.map(id => this.host.sendDpn(id, flags & 0x18, data)));
        return results.find(result => result !== DPN.OK) ?? await local;
    }
    send(_from: number, _to: number, _flags: number, _data: Uint8Array): number { return DPN.UNSUPPORTED; }
    mutate(change: Record<string, unknown> & { op: string }): Reply {
        if (change.action !== "info") return { hr: DPN.UNSUPPORTED };
        const named = change.name as { short?: string; shortNull?: boolean } | undefined, data = change.data as number[] | undefined;
        if (named && typeof named.short !== "string" || data && (!Array.isArray(data) || data.some(n => !Number.isInteger(n) || n < 0 || n > 255))) return { hr: DPN.INVALIDPARAM };
        return { hr: this.host.setInfo(Number(change.id) >>> 0, (named ? 1 : 0) | (data ? 2 : 0),
            named?.shortNull ? null : named?.short ?? null, Uint8Array.from(data ?? [])) };
    }
    kick(_id: number, _data: Uint8Array): number { return DPN.UNSUPPORTED; }
    terminate(_data: Uint8Array, _reason?: number): number { return DPN.UNSUPPORTED; }
    async shutdown(): Promise<number> {
        this.closing = true; this.pending?.abort(); this.localDelivery.cancel(DPN.USERCANCEL);
        this.cancelRemoteProcessing(DPN.USERCANCEL);
        const result = await this.host.shutdown(); this.releaseReady(); this.port = undefined; return result;
    }
    close(): number {
        this.closing = true; ++this.generation; this.pending?.abort(); this.localDelivery.cancel(DPN.USERCANCEL);
        this.cancelRemoteProcessing(DPN.USERCANCEL);
        const result = this.host.close(); this.port?.close(); this.port = undefined; this.releaseReady(); return result;
    }
    dispose(): void { this.close(); this.host.dispose(); this.disposed = true; }
}
