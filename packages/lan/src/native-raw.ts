import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { RAW_MAX_PACKET } from "./protocol";
import { TCP_WINDOW } from "./tcp-protocol";
const error = (code: number, message: string) => Object.assign(new Error(message), { code });

/** Bounded datagram IPC to the optional OS raw-socket helper. */
export class NativeRawSocket extends EventEmitter {
    private child: ChildProcessWithoutNullStreams | null = null;
    private input: Buffer = Buffer.alloc(0);
    private readonly writes = new Map<number, { bytes: number; callback: (failure?: Error) => void }>();
    private nextId = 1;
    private bytes = 0;
    private closed = false;
    constructor(private readonly executable: string) { super(); }
    connect(host: string, family: 4 | 6, protocol: number, headerIncluded: boolean): void {
        this.start(["raw" + family, host, String(protocol), headerIncluded ? "1" : "0"]);
    }
    connectUdp(host: string, family: 4 | 6, port: number): void { this.start(["udp" + family, host, String(port)]); }
    private start(args: string[]): void {
        if (this.closed || this.child) return;
        const child = this.child = spawn(this.executable, args,
            { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        child.stdout.on("data", (bytes: Buffer) => this.accept(bytes)); child.stderr.resume();
        child.stdin.on("error", failure => { if (!this.closed && !["EPIPE", "ECONNRESET"].includes((failure as { code?: string }).code ?? "")) this.fail(failure); });
        child.on("error", failure => this.fail(Object.assign(failure, { code: 10045 })));
        child.on("close", () => { if (!this.closed) this.fail(error(10054, "Native raw helper exited")); });
        const credit = Buffer.alloc(4); credit.writeUInt32LE(TCP_WINDOW); this.command(4, credit);
    }
    setGuestAddresses(source:Uint8Array,destination:Uint8Array):void {
        if(source.length!==destination.length || (source.length!==4&&source.length!==16))throw new RangeError("Invalid raw guest addresses");
        const payload=Buffer.alloc(36);payload.writeUInt32LE(source.length===4?4:6);payload.set(source,4);payload.set(destination,20);this.command(8,payload);
    }
    setUdpTuple(guestPort:number,remotePort:number):void {
        if(!Number.isInteger(guestPort)||guestPort<0||guestPort>65535||!Number.isInteger(remotePort)||remotePort<0||remotePort>65535)throw new RangeError("Invalid raw UDP tuple");
        const payload=Buffer.alloc(8);payload.writeUInt32LE(guestPort);payload.writeUInt32LE(remotePort,4);this.command(9,payload);
    }
    setIpOptions(ttl: number, tos: number): void {
        const payload = Buffer.alloc(8); payload.writeInt32LE(ttl); payload.writeUInt32LE(tos, 4); this.command(7, payload);
    }
    send(packet: Uint8Array, callback: (failure?: Error) => void): boolean {
        if (this.closed || !this.child || packet.length > RAW_MAX_PACKET || this.bytes + packet.length > TCP_WINDOW || this.writes.size >= 64) return false;
        const id = this.nextId++;
        const payload = Buffer.alloc(4 + packet.length); payload.writeUInt32LE(id); payload.set(packet, 4);
        this.writes.set(id, { bytes: packet.length, callback }); this.bytes += packet.length;
        if (!this.command(1, payload)) { this.fail(error(10057, "Native raw helper pipe closed")); return false; }
        return true;
    }
    private command(kind: number, payload: Buffer): boolean {
        if (this.closed || !this.child?.stdin.writable) return false;
        const frame = Buffer.alloc(8 + payload.length); frame.writeUInt32LE(kind); frame.writeUInt32LE(payload.length, 4); payload.copy(frame, 8);
        this.child.stdin.write(frame); return true;
    }
    private accept(bytes: Buffer): void {
        if (this.closed) return;
        if (this.input.length + bytes.length > TCP_WINDOW * 2) { this.fail(error(10055, "Native raw output exceeded its bound")); return; }
        this.input = this.input.length ? Buffer.concat([this.input, bytes]) : bytes;
        while (!this.closed && this.input.length >= 8) {
            const kind = this.input.readUInt32LE(), length = this.input.readUInt32LE(4);
            if (length > RAW_MAX_PACKET) { this.fail(error(10022, "Invalid native raw record")); return; }
            if (this.input.length < length + 8) return;
            const data = this.input.subarray(8, 8 + length); this.input = this.input.subarray(8 + length);
            if (kind === 10 && !length) this.emit("connect");
            else if(kind===18&&length===12){
                const tuple={guestPort:data.readUInt32LE(),remotePort:data.readUInt32LE(4),nativePort:data.readUInt32LE(8)};
                if(tuple.guestPort>65535||tuple.remotePort>65535||tuple.nativePort<1||tuple.nativePort>65535){this.fail(error(10022,"Invalid native UDP tuple"));return;}
                this.emit("udpTuple",tuple);
            }
            else if (kind === 17) {
                this.emit("message", new Uint8Array(data));
                if (length) { const credit = Buffer.alloc(4); credit.writeUInt32LE(length); this.command(4, credit); }
            } else if (kind === 14 && length === 4) this.fail(error(data.readUInt32LE(), "Native raw socket operation failed"));
            else if (kind === 15 && length === 4) {
                const id = data.readUInt32LE(), pending = this.writes.get(id);
                if (!pending) { this.fail(error(10022, "Unknown native raw acknowledgement")); return; }
                this.writes.delete(id); this.bytes -= pending.bytes; pending.callback();
            } else { this.fail(error(10022, "Invalid native raw event")); return; }
        }
    }
    private fail(failure: Error): void {
        if (this.closed) return;
        this.emit("error", failure); this.close();
    }
    close(): void {
        if (this.closed) return;
        this.closed = true;
        const pending = [...this.writes.values()]; this.writes.clear(); this.bytes = 0;
        this.input = Buffer.alloc(0);
        this.child?.stdin.destroy(); this.child?.stdout.destroy(); this.child?.stderr.destroy(); this.child?.kill(); this.child = null;
        for (const write of pending) write.callback(error(10054, "Native raw socket closed"));
        this.emit("close");
    }
}
