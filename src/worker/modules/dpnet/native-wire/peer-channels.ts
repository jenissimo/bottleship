import type { LanNetwork } from "../../../net/lan-network";
import type { Address } from "../../dplayx/session";
import { parseIpv4 } from "../../../net/netplay-wire";
import { DirectPlayAddress } from "../address";
import { DP8_TCPIP, DPN } from "../constants";
import { NativeDirectPlayChannel } from "./channel";
import { NativeDirectPlayPort } from "./port";
import { DN } from "./frame-codec";
import { nativeCoreWords } from "./core-operations";
import type { NativeNameTableEntry } from "./core-connect-codec";
import type { NativeReassembledMessage } from "./receive-window";
interface Peer {
    entry: NativeNameTableEntry; address?: Address; channel?: NativeDirectPlayChannel;
    lease?: { release(): void }; cancel: AbortController; preparing: Promise<number>; ready: boolean; identified: boolean;
}
interface MeshCallbacks {
    ready(id: number): void;
    message(id: number, message: NativeReassembledMessage): boolean;
    failed(id: number, result: number): void;
    lost(id: number, result: number): void;
}
/** Authenticated by the host's bounded name table, then by the exact UDP tuple and C4 DPNID. */
export class NativePeerChannels {
    private peers = new Map<number, Peer>();
    private ended = false;
    private shuttingDown = false;
    constructor(readonly network: LanNetwork, readonly port: NativeDirectPlayPort, readonly localId: number,
        readonly hostAddress: Address, private callbacks: MeshCallbacks, private timeout: number, private retryInterval: number, private retries: number) {}
    get size(): number { return this.peers.size; }
    ready(id: number): boolean { return !!this.peers.get(id)?.ready; }
    channel(id: number): NativeDirectPlayChannel | undefined { const peer = this.peers.get(id); return peer?.ready ? peer.channel : undefined; }
    address(id: number): Address | null { const address = this.peers.get(id)?.address; return address ? { node: address.node.slice(), port: address.port } : null; }
    private live(peer: Peer): boolean { return !this.ended && !peer.cancel.signal.aborted && this.peers.get(peer.entry.id) === peer && this.port.live; }
    expect(entry: NativeNameTableEntry, outgoing: boolean): Promise<number> {
        const old = this.peers.get(entry.id);
        if (old) return old.preparing;
        if (this.shuttingDown) return Promise.resolve(DPN.ALREADYCLOSING);
        if (this.ended || this.peers.size >= this.port.maxPeers - 1 || entry.id === this.localId || entry.flags & 0x10) return Promise.resolve(DPN.TABLEFULL);
        const peer: Peer = { entry, cancel: new AbortController(), preparing: Promise.resolve(DPN.OK), ready: false, identified: false };
        this.peers.set(entry.id, peer);
        peer.preparing = this.prepare(peer, outgoing).catch(() => DPN.INVALIDHOSTADDRESS).then(result => {
            if (result && this.live(peer)) { this.remove(entry.id); this.callbacks.failed(entry.id, result); }
            return result;
        });
        return peer.preparing;
    }
    private async prepare(peer: Peer, outgoing: boolean): Promise<number> {
        if (!peer.entry.url) return DPN.INVALIDHOSTADDRESS;
        const address = new DirectPlayAddress(); if (address.buildURL(peer.entry.url) || address.guid("provider") !== DP8_TCPIP) return DPN.INVALIDHOSTADDRESS;
        const host = address.text("hostname"), port = address.dword("port");
        if (!host || !port || port > 65535) return DPN.INVALIDHOSTADDRESS;
        let ip = parseIpv4(host);
        if (!ip) {
            const resolved = await this.network.resolve(host, 4, peer.cancel.signal);
            const found = resolved.addresses.find(item => item.family === 4); ip = found ? parseIpv4(found.address) : null;
        }
        if (!this.live(peer)) return DPN.USERCANCEL;
        if (!ip) return DPN.INVALIDHOSTADDRESS;
        const remote: Address = { node: Array.from(this.network.routeIpv4(ip)), port };
        const same = (value: Address) => value.port === remote.port && value.node.every((n, i) => n === remote.node[i]);
        if (same(this.hostAddress) || [...this.peers.values()].some(item => item !== peer && item.address && same(item.address))) return DPN.INVALIDHOSTADDRESS;
        peer.address = remote;
        const channel = new NativeDirectPlayChannel(this.network, remote, {
            timeout: this.timeout, retryInterval: this.retryInterval, retries: this.retries,
            onMessage: message => {
                if (!this.live(peer) || message.command & DN.USER2) return true;
                if ((message.command & DN.USER1) && message.payload.length === 8 &&
                    new DataView(message.payload.buffer, message.payload.byteOffset, 8).getUint32(0, true) === 0xc4) {
                    if (!outgoing && new DataView(message.payload.buffer, message.payload.byteOffset, 8).getUint32(4, true) === peer.entry.id) { peer.identified = true; this.promote(peer); }
                    return true;
                }
                return !peer.ready || this.callbacks.message(peer.entry.id, message);
            },
            onState: (state, result) => {
                if (state !== "closed" || !this.live(peer)) return;
                const wasReady = peer.ready; peer.ready = false;
                if (wasReady) {
                    // Preserve the channel's final carrier ACKs before releasing its lease.
                    void peer.channel!.closed.then(() => { if (this.live(peer)) this.remove(peer.entry.id); });
                    this.callbacks.lost(peer.entry.id, result || DPN.CONNECTIONLOST);
                } else { this.remove(peer.entry.id); this.callbacks.failed(peer.entry.id, result || DPN.CONNECTIONLOST); }
            },
        }, 0, this.port);
        peer.channel = channel;
        if (!outgoing) void channel.link.listen();
        peer.lease = await this.network.leaseUdpPeer(this.port.localPort, Uint8Array.from(remote.node), remote.port, peer.cancel.signal);
        if (!this.live(peer)) { peer.lease.release(); return DPN.USERCANCEL; }
        if (!outgoing && peer.identified) this.promote(peer);
        if (outgoing) {
            const ready = await channel.link.connect(); if (!this.live(peer)) return DPN.USERCANCEL; if (ready) return ready;
            const sent = await channel.link.sendReliable(nativeCoreWords(0xc4, this.localId));
            if (!this.live(peer)) return DPN.USERCANCEL; if (sent) return sent;
            this.promote(peer);
        }
        return DPN.OK;
    }
    private promote(peer: Peer): void { if (!this.shuttingDown && this.live(peer) && peer.lease && !peer.ready) { peer.ready = true; this.callbacks.ready(peer.entry.id); } }
    remove(id: number): void {
        const peer = this.peers.get(id); if (!peer) return;
        this.peers.delete(id); peer.cancel.abort(); peer.channel?.close(); peer.lease?.release();
    }
    async shutdown(): Promise<number> {
        this.shuttingDown = true;
        const peers = [...this.peers.values()];
        const results = await Promise.all(peers.map(async peer => {
            if (!peer.channel) { this.remove(peer.entry.id); return DPN.OK; }
            if (peer.channel.link.state === "closed") { await peer.channel.closed; this.remove(peer.entry.id); return DPN.OK; }
            if (!peer.ready) { this.remove(peer.entry.id); return DPN.OK; }
            const result = await peer.channel.link.shutdown(), drained = await peer.channel.closed; return result || drained;
        }));
        return results.find(result => result !== DPN.OK) ?? DPN.OK;
    }
    close(): void { if (this.ended) return; this.ended = true; for (const id of [...this.peers.keys()]) this.remove(id); }
}
