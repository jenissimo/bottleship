import type { LanNetwork, LanEndpoint, LanDatagram } from "../../../net/lan-network";
import { PROTO_UDP } from "../../../net/netplay-wire";
import type { Address } from "../../dplayx/session";
import { DPN } from "../constants";
import { NativeReliableLink, type NativeReliableOptions } from "./reliable-link";

/** A single native UDP tuple, fenced by the exact local adapter binding. */
export class NativeDirectPlayChannel implements LanEndpoint {
    readonly link: NativeReliableLink;
    readonly localPort: number;
    readonly closed: Promise<number>;
    readonly stats = { carrierAccepted: 0, carrierRejected: 0, queued: 0 };
    private resolveClosed!: (result: number) => void;
    private pending: Uint8Array[] = [];
    private pendingBytes = 0;
    private flushing = false;
    private closing = false;
    private closeResult = DPN.OK as number;
    private closeDeadline = 0;
    private removeWritable?: () => void;
    private binding = 0;
    private released = false;
    private timer?: ReturnType<typeof setInterval>;
    private removeState?: () => void;
    private removeError?: () => void;
    constructor(readonly network: LanNetwork, readonly remote: Address, options: Omit<NativeReliableOptions, "send">, port = 0) {
        if (!Number.isInteger(remote.port) || remote.port < 1 || remote.port > 65535 || remote.node.length !== 6 ||
            remote.node.some(n => !Number.isInteger(n) || n < 0 || n > 255) || !Number.isInteger(port) || port < 0 || port > 65535)
            throw new RangeError("Invalid native UDP endpoint");
        let localPort = port;
        if (port) { if (!network.bind(port, this, PROTO_UDP)) throw Error("Native UDP port unavailable"); }
        else { for (localPort = 2302; localPort <= 2400 && !network.bind(localPort, this, PROTO_UDP); localPort++); if (localPort > 2400) throw Error("Native UDP ports exhausted"); }
        this.localPort = localPort; this.binding = network.bindingGeneration(localPort, PROTO_UDP);
        this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
        this.link = new NativeReliableLink({ ...options, send: bytes => {
            if (!this.live) return false;
            if (!this.pending.length && this.submit(bytes)) return true;
            if (!this.live) return false;
            if (this.pending.length >= 256 || this.pendingBytes + bytes.length > 4 * 1024 * 1024) { this.link.close(DPN.TABLEFULL); return false; }
            this.pending.push(bytes.slice()); this.pendingBytes += bytes.length; this.stats.queued++; return true;
        }, onState: (state, result) => { try { options.onState?.(state, result); } finally { if (state === "closed") { if (result) this.release(result); else { this.closing = true; this.closeResult = result; this.closeDeadline = performance.now() + Math.min(3000, options.timeout ?? 25000); this.flush(); } } } } });
        this.removeState = network.onStateChange(() => { if (!this.live) this.link.close(DPN.NOCONNECTION); });
        this.removeError = network.onSocketError(error => {
            if (error.proto === PROTO_UDP && error.localPort === this.localPort && error.remotePort === this.remote.port &&
                (error.bindingGeneration === undefined || error.bindingGeneration === this.binding) && error.node.every((n, i) => n === this.remote.node[i]))
                this.link.close(DPN.NOCONNECTION);
        });
        this.removeWritable = network.onWritable(() => this.flush());
        this.timer = setInterval(() => {
            if (!this.live) { this.link.close(DPN.NOCONNECTION); this.release(DPN.NOCONNECTION); return; }
            this.flush();
            if (this.closing) { if (performance.now() >= this.closeDeadline) this.release(DPN.NOCONNECTION); }
            else this.link.tick();
        }, 10);
        (this.timer as unknown as { unref?(): void }).unref?.();
    }
    private submit(bytes: Uint8Array): boolean {
        const sent = this.network.send(this.localPort, new Uint8Array(this.remote.node), this.remote.port, bytes, PROTO_UDP);
        if (sent) this.stats.carrierAccepted++; else this.stats.carrierRejected++;
        return sent;
    }
    private flush(): void {
        if (this.flushing || this.released) return; this.flushing = true;
        try {
            while (this.pending.length && this.live) { const bytes = this.pending[0]; if (!this.submit(bytes) || !this.live) break; this.pending.shift(); this.pendingBytes -= bytes.length; }
        } finally { this.flushing = false; }
        if (this.closing && !this.pending.length) this.release(this.closeResult);
    }
    private get live(): boolean { return !this.released && this.network.connected && this.network.bindingGeneration(this.localPort, PROTO_UDP) === this.binding; }
    deliver(packet: LanDatagram): void {
        if (!this.live || packet.srcPort !== this.remote.port || !packet.srcNode.every((n, i) => n === this.remote.node[i])) return;
        this.link.receive(packet.data);
    }
    close(result: number = DPN.USERCANCEL): void { this.link.close(result); this.release(result); }
    private release(result: number): void {
        if (this.released) return; this.released = true;
        if (this.timer) clearInterval(this.timer); this.timer = undefined; this.removeState?.(); this.removeState = undefined; this.removeError?.(); this.removeError = undefined;
        this.removeWritable?.(); this.removeWritable = undefined; this.pending = []; this.pendingBytes = 0;
        this.network.unbind(this.localPort, this, PROTO_UDP); this.resolveClosed(result);
    }
}
