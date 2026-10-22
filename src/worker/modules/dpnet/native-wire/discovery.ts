import type { LanNetwork, LanDatagram, LanEndpoint } from "../../../net/lan-network";
import { PROTO_UDP, isBroadcastNode } from "../../../net/netplay-wire";
import { DPN } from "../constants";
import { decodeNativeEnumResponse, encodeNativeEnumQuery, NATIVE_DP8_MAX_DATAGRAM, type NativeEnumResponse } from "./discovery-codec";
export interface NativeDiscoveryOptions {
    node: Uint8Array; port: number; application: string | null; data?: Uint8Array;
    count?: number; interval?: number; timeout?: number;
    onResponse(response: NativeEnumResponse, from: { node: Uint8Array; port: number }, latency: number): boolean | void;
}
export interface NativeDiscoveryOperation { done: Promise<number>; cancel(): void; }
interface Query {
    key: number; node: Uint8Array; port: number; application: string | null; data: Uint8Array;
    tokens: Map<number, number>; finish(hr: number): void; timer?: ReturnType<typeof setTimeout>;
    onResponse: NativeDiscoveryOptions["onResponse"];
}
/** Native binary UDP discovery; independent of the BottleShip session JSON wire. */
export class NativeDirectPlayDiscovery implements LanEndpoint {
    readonly port: number;
    private queries = new Map<number, Query>();
    private nextKey: number;
    private closed = false;
    private readonly binding: number;
    private removeState: () => void;
    constructor(readonly network: LanNetwork, seed = crypto.getRandomValues(new Uint16Array(1))[0]) {
        this.nextKey = seed % 4095 + 1;
        let port = 0;
        for (let candidate = 2302; candidate <= 2400; candidate++) if (network.bind(candidate, this, PROTO_UDP)) { port = candidate; break; }
        if (!port) throw new Error("No DirectPlay TCP/IP discovery socket available");
        this.port = port; this.binding = network.bindingGeneration(port, PROTO_UDP);
        this.removeState = network.onStateChange(() => this.fail(DPN.NOCONNECTION));
    }
    get pending(): number { return this.queries.size; }
    discover(options: NativeDiscoveryOptions): NativeDiscoveryOperation {
        const count = options.count || 5, interval = options.interval || 1500, timeout = options.timeout || 1500;
        if (this.closed) return { done: Promise.resolve(DPN.UNINITIALIZED), cancel() {} };
        if (this.queries.size >= 64) return { done: Promise.resolve(DPN.TABLEFULL), cancel() {} };
        if (options.node.length !== 6 || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535 ||
            !Number.isInteger(count) || count < 1 || count > 0xffffffff || !Number.isInteger(interval) || interval < 1 || interval > 0xffffffff ||
            !Number.isInteger(timeout) || timeout < 1 || timeout > 0xffffffff || (options.data?.length ?? 0) > NATIVE_DP8_MAX_DATAGRAM - (options.application === null ? 5 : 21)) return { done: Promise.resolve(DPN.INVALIDPARAM), cancel() {} };
        const key = this.nextKey++ % 4095 + 1;
        // At most 64 live keys and 4095 possibilities; refuse accidental wrap reuse.
        if (this.queries.has(key)) return { done: Promise.resolve(DPN.TABLEFULL), cancel() {} };
        let resolve!: (hr: number) => void;
        const done = new Promise<number>(complete => { resolve = complete; });
        const query: Query = {
            key, node: options.node.slice(), port: options.port, application: options.application?.toLowerCase() ?? null,
            data: options.data?.slice() ?? new Uint8Array(), tokens: new Map(), onResponse: options.onResponse,
            finish: hr => { if (this.queries.get(key) !== query) return; this.queries.delete(key); clearTimeout(query.timer); resolve(hr); },
        };
        // Validate and own the entire packet before accepting the asynchronous operation.
        try { encodeNativeEnumQuery({ token: key << 4, application: query.application, data: query.data }); }
        catch { return { done: Promise.resolve(DPN.INVALIDPARAM), cancel() {} }; }
        this.queries.set(key, query);
        let sent = 0;
        const schedule = (delay: number, callback: () => void): void => {
            if (delay === 0xffffffff) return; // Native INFINITE; cancellation and network lifetime still own the query.
            const chunk = Math.min(delay, 0x7fffffff);
            query.timer = setTimeout(delay > chunk ? () => schedule(delay - chunk, callback) : callback, chunk);
            (query.timer as unknown as { unref?(): void }).unref?.();
        };
        const send = () => {
            if (this.queries.get(key) !== query) return;
            const token = (key << 4) | (++sent & 15);
            query.tokens.set(token, performance.now());
            if (this.network.bindingGeneration(this.port, PROTO_UDP) !== this.binding) { query.finish(DPN.NOCONNECTION); return; }
            if (!this.network.send(this.port, query.node, query.port, encodeNativeEnumQuery({ token, application: query.application, data: query.data }), PROTO_UDP) &&
                (!this.network.connected || this.network.bindingGeneration(this.port, PROTO_UDP) !== this.binding)) {
                query.finish(DPN.NOCONNECTION); return;
            }
            // A busy volatile carrier is UDP loss; later enum retries retain their own correlation token.
            // A local, synchronous responder is allowed to cancel during send().
            if (this.queries.get(key) !== query) return;
            schedule(sent < count ? interval : timeout, sent < count ? send : () => query.finish(DPN.OK));
        };
        send();
        return { done, cancel: () => query.finish(DPN.USERCANCEL) };
    }
    deliver(datagram: LanDatagram): void {
        if (this.network.bindingGeneration(this.port, PROTO_UDP) !== this.binding || datagram.srcNode.length !== 6 || !Number.isInteger(datagram.srcPort) || datagram.srcPort < 1 || datagram.srcPort > 65535) return;
        const packet = decodeNativeEnumResponse(datagram.data); if (!packet) return;
        const query = this.queries.get(packet.token >>> 4); if (!query || !query.tokens.has(packet.token)) return;
        if ((!isBroadcastNode(query.node) && (!query.node.every((value, index) => value === datagram.srcNode[index]) || (query.port !== 6073 && datagram.srcPort !== query.port))) ||
            (query.application !== null && query.application !== packet.application)) return;
        try { if (query.onResponse(packet, { node: datagram.srcNode.slice(), port: datagram.srcPort }, Math.max(0, performance.now() - query.tokens.get(packet.token)!)) === false) query.finish(DPN.TABLEFULL); }
        catch { query.finish(DPN.GENERIC); }
    }
    private fail(hr: number): void { for (const query of [...this.queries.values()]) query.finish(hr); }
    close(): void { if (!this.closed) { this.closed = true; this.fail(DPN.USERCANCEL); this.removeState(); this.network.unbind(this.port, this, PROTO_UDP); } }
}
