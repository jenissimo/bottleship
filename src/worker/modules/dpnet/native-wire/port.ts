import type { LanNetwork, LanDatagram, LanEndpoint } from "../../../net/lan-network";
import { PROTO_UDP } from "../../../net/netplay-wire";
import type { Address } from "../../dplayx/session";
import { DPN } from "../constants";
interface PeerEndpoint extends LanEndpoint { close(result?: number): void; }
const key = (address: Address) => address.node.join(".") + ":" + address.port;
/** One generation-bound UDP socket shared by explicitly registered native peer tuples. */
export class NativeDirectPlayPort implements LanEndpoint {
    readonly localPort: number;
    readonly binding: number;
    readonly maxPeers: number;
    private peers = new Map<string, PeerEndpoint>();
    private ended = false;
    private removeState?: () => void;
    private carrierJobs = 0;
    private carrierBytes = 0;
    private sendJobs = 0;
    private sendBytes = 0;
    private receiveBytes = 0;
    private receiveFragments = 0;
    readonly receiveBudget = {
        reserve: (bytes: number, fragments = 0): boolean => {
            if (!this.live || bytes > 4 * 1024 * 1024 - this.receiveBytes || fragments > 65536 - this.receiveFragments) return false;
            this.receiveBytes += bytes; this.receiveFragments += fragments; return true;
        },
        release: (bytes: number, fragments = 0): void => { this.receiveBytes -= bytes; this.receiveFragments -= fragments; },
    };
    readonly sendBudget = {
        reserve: (bytes: number): boolean => {
            if (!this.live || this.sendJobs >= 320 || bytes > 4 * 1024 * 1024 - this.sendBytes) return false;
            this.sendJobs++; this.sendBytes += bytes; return true;
        },
        release: (bytes: number): void => { this.sendJobs--; this.sendBytes -= bytes; },
    };
    constructor(readonly network: LanNetwork, port = 0, maxPeers = 64) {
        if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(maxPeers) || maxPeers < 1 || maxPeers > 64)
            throw new RangeError("Invalid native UDP port limits");
        this.maxPeers = maxPeers;
        let chosen = port;
        if (port) { if (!network.bind(port, this, PROTO_UDP)) throw Error("Native UDP port unavailable"); }
        else { for (chosen = 2302; chosen <= 2400 && !network.bind(chosen, this, PROTO_UDP); chosen++); if (chosen > 2400) throw Error("Native UDP ports exhausted"); }
        this.localPort = chosen; this.binding = network.bindingGeneration(chosen, PROTO_UDP);
        this.removeState = network.onStateChange(() => { if (!this.live) this.close(DPN.NOCONNECTION); });
    }
    get live(): boolean { return !this.ended && this.network.connected && this.network.bindingGeneration(this.localPort, PROTO_UDP) === this.binding; }
    get peerCount(): number { return this.peers.size; }
    get pendingFragments(): number { return this.receiveFragments; }
    get pendingBytes(): number { return this.carrierBytes + this.sendBytes + this.receiveBytes; }
    attach(address: Address, endpoint: PeerEndpoint): boolean {
        const id = key(address);
        if (!this.live || this.peers.has(id) || this.peers.size >= this.maxPeers) return false;
        this.peers.set(id, endpoint); return true;
    }
    detach(address: Address, endpoint: PeerEndpoint): void { const id = key(address); if (this.peers.get(id) === endpoint) this.peers.delete(id); }
    reservePacket(bytes: number): boolean {
        if (!this.live || this.carrierJobs >= 256 || bytes > 4 * 1024 * 1024 - this.carrierBytes) return false;
        this.carrierJobs++; this.carrierBytes += bytes; return true;
    }
    releasePacket(bytes: number): void { this.carrierJobs--; this.carrierBytes -= bytes; }
    deliver(packet: LanDatagram): void {
        if (!this.live) return;
        this.peers.get(key({ node: Array.from(packet.srcNode), port: packet.srcPort }))?.deliver(packet);
    }
    close(result: number = DPN.USERCANCEL): void {
        if (this.ended) return; this.ended = true;
        this.removeState?.(); this.removeState = undefined;
        for (const endpoint of [...this.peers.values()]) endpoint.close(result);
        this.peers.clear(); this.network.unbind(this.localPort, this, PROTO_UDP);
    }
}
