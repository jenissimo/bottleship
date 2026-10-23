import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
    UDP_BOUND as P, decodeUdpAddress, encodeUdpAddress, encodeUdpFrame, nativeUdpEndpoint,
    nativeUdpEndpointKey, udpFailure,
    type NativeUdpEndpoint, type NativeUdpLossCounters, type NativeUdpPeerError,
} from "./udp-bound-protocol";

const INPUT_BYTES = P.bytes + P.txRecords * 24 + P.controls * 64 + 128;
let nextGeneration = 1;
interface Request {
    expected: number; opcode: number; resolve(body: Buffer): void; reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}
interface Peer { epoch: number; endpoint: NativeUdpEndpoint; active: boolean; }
interface Write { peerId: number; epoch: number; bytes: number; callback(error?: Error | null): void; }
export interface NativeBoundUdpOptions {
    spawnHelper?: typeof spawn;
    startupTimeoutMs?: number;
    operationTimeoutMs?: number;
    closeTimeoutMs?: number;
    /** Tests/manual consumers may withhold delivery credits while errors still drain. */
    automaticReceiveCredit?: boolean;
}

/** One process/socket with bounded whole-datagram admission and tuple-attributed errors. */
export class NativeBoundUdpDriver extends EventEmitter {
    readonly ready: Promise<NativeUdpEndpoint>;
    readonly closed: Promise<void>;
    private child: ChildProcessWithoutNullStreams;
    private input:Buffer = Buffer.alloc(0);
    private requests = new Map<number, Request>();
    private writes = new Map<number, Write>();
    private peers = new Map<number, Peer>();
    private next = 1;
    private generation = nextGeneration++ >>> 0 || nextGeneration++ >>> 0;
    private writeBytes = 0;
    private pipeBytes = 0;
    private rxBytes = 0;
    private rxPackets = 0;
    private creditBytes = 0;
    private creditPackets = 0;
    private creditInFlight = false;
    private started = false;
    private ending = false;
    private abortRequested = false;
    private dead = false;
    private sawClosed = false;
    private exited = false;
    private terminalError?: Error;
    private closeIds = new Set<number>();
    private closeTimer?: ReturnType<typeof setTimeout>;
    private resolveReady!: (address: NativeUdpEndpoint) => void;
    private rejectReady!: (error: Error) => void;
    private resolveClosed!: () => void;
    private bound?: NativeUdpEndpoint;
    private lastLosses: NativeUdpLossCounters = { rxPackets: 0n, rxBytes: 0n, errorRecords: 0n, unattributedErrors: 0n };
    private readonly operationTimeout: number;
    private readonly closeTimeout: number;
    private readonly automaticCredit: boolean;

    constructor(executable: string, readonly family: 4 | 6, options: NativeBoundUdpOptions = {}) {
        super();
        if (!executable || (family !== 4 && family !== 6)) throw new TypeError("Invalid bound UDP helper configuration");
        this.operationTimeout = options.operationTimeoutMs ?? 5000;
        this.closeTimeout = options.closeTimeoutMs ?? 5000;
        this.automaticCredit = options.automaticReceiveCredit !== false;
        this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
        // A port can be detached while BIND is pending, before anyone awaits ready.
        void this.ready.catch(() => {});
        this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
        this.child = (options.spawnHelper ?? spawn)(executable, [], {
            stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        }) as ChildProcessWithoutNullStreams;
        this.child.stdout.on("data", (bytes: Buffer) => this.accept(bytes));
        this.child.stderr.resume();
        this.child.stdin.on("error", () => {
            if (!this.sawClosed && !this.dead) this.fail(udpFailure(10050, "Bound UDP helper input pipe failed"));
        });
        this.child.on("error", () => this.fail(udpFailure(10045, "Bound UDP helper is unavailable")));
        this.child.on("close", () => {
            if (!this.sawClosed && !this.dead) this.fail(udpFailure(10050, "Bound UDP helper exited unexpectedly"));
            this.finishExit();
        });
        const initial: NativeUdpEndpoint = { family, address: family === 4 ? "0.0.0.0" : "::", port: 0 };
        void this.request(P.bind, P.ready, encodeUdpAddress(initial, true), options.startupTimeoutMs ?? 5000).then(body => {
            if (body.length !== 48 || body.readUInt32LE(24) !== P.capabilities ||
                body.readUInt32LE(28) !== P.txRecords || body.readUInt32LE(32) !== P.bytes ||
                body.readUInt32LE(36) !== P.rxRecords || body.readUInt32LE(40) !== P.controls ||
                body.readUInt32LE(44) !== P.peers) throw udpFailure(10045, "Incompatible bound UDP helper capabilities");
            const address = decodeUdpAddress(body.subarray(0, 24));
            if (address.family !== family || !address.port) throw udpFailure(10022, "Invalid bound UDP READY address");
            this.bound = address; this.started = true;
            if (!this.ending && this.automaticCredit) this.grantReceiveCredit(P.bytes, P.rxRecords);
            this.resolveReady(address);
        }).catch(error => {
            this.rejectReady(error);
            if (!this.ending) this.fail(error);
        });
    }

    get pendingWrites(): number { return this.writes.size; }
    get pendingWriteBytes(): number { return this.writeBytes; }
    get pendingPipeBytes(): number { return this.pipeBytes; }
    get closing(): boolean { return this.ending || this.dead; }
    private id(): number {
        if (this.next > 0xffffffff) throw udpFailure(10055, "Bound UDP request identity exhausted");
        return this.next++;
    }
    private frame(opcode: number, id: number, body: Buffer = Buffer.alloc(0), reserved = false): void {
        if (this.dead || this.sawClosed || !this.child.stdin.writable) {
            this.fail(udpFailure(10050, "Bound UDP helper pipe is closed")); return;
        }
        const bytes = encodeUdpFrame(opcode, id, this.generation, body);
        if (!reserved && this.pipeBytes + bytes.length > INPUT_BYTES) {
            this.fail(udpFailure(10055, "Bound UDP command pipe budget exhausted")); return;
        }
        this.pipeBytes += bytes.length;
        let completed = false;
        const complete = (error?: Error | null) => {
            if (completed) return; completed = true;
            if (this.dead || this.sawClosed) return;
            this.pipeBytes -= bytes.length;
            if (error) this.fail(udpFailure(10050, "Bound UDP command write failed"));
        };
        try { this.child.stdin.write(bytes, complete); } catch { complete(udpFailure(10050, "Bound UDP pipe write failed")); }
    }
    private request(opcode: number, expected: number, body: Buffer, timeout = this.operationTimeout): Promise<Buffer> {
        // One command slot stays reserved for coalesced receive credit.
        const limit = opcode === P.credit ? P.controls : P.controls - 1;
        if (this.dead || this.sawClosed || (this.ending && opcode !== P.bind)) return Promise.reject(udpFailure(10058, "Bound UDP binding is closing", "control"));
        if (this.requests.size >= limit || this.pipeBytes + P.header + body.length > INPUT_BYTES)
            return Promise.reject(udpFailure(10055, "Bound UDP control window exhausted", "control"));
        let id: number;
        try { id = this.id(); } catch (error) { return Promise.reject(error); }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.fail(udpFailure(10060, "Bound UDP control timed out")), timeout);
            timer.unref?.();
            this.requests.set(id, { opcode, expected, resolve, reject, timer });
            this.frame(opcode, id, body);
        });
    }
    async registerPeer(peerId: number, epoch: number, host: string, port: number): Promise<void> {
        if (!Number.isInteger(peerId) || peerId < 1 || peerId > 0xffffffff ||
            !Number.isInteger(epoch) || epoch < 1 || epoch > 0xffffffff)
            throw udpFailure(10022, "Invalid native UDP peer identity", "control");
        const endpoint = nativeUdpEndpoint(host, port, this.family);
        await this.ready;
        const previous = this.peers.get(peerId);
        if (!previous && this.peers.size >= P.peers) throw udpFailure(10055, "Native UDP peer history exhausted", "control");
        if (previous && (epoch <= previous.epoch || nativeUdpEndpointKey(previous.endpoint) !== nativeUdpEndpointKey(endpoint)))
            throw udpFailure(10022, "Native UDP peer identity cannot be replayed or moved", "control");
        const peer = { epoch, endpoint, active: false };
        this.peers.set(peerId, peer);
        const body = Buffer.allocUnsafe(8 + P.address);
        body.writeUInt32LE(peerId); body.writeUInt32LE(epoch, 4); encodeUdpAddress(endpoint).copy(body, 8);
        try {
            const reply = await this.request(P.peer, P.peerReady, body);
            if (reply.length !== 12 || reply.readUInt32LE() !== peerId || reply.readUInt32LE(4) !== epoch)
                throw udpFailure(10022, "Invalid PEER_READY acknowledgement");
            if (reply.readUInt32LE(8)) throw udpFailure(reply.readUInt32LE(8), "Native UDP peer admission refused", "control");
            if (this.peers.get(peerId) === peer && !this.ending) peer.active = true;
        } catch (error) {
            if (this.peers.get(peerId) === peer) peer.active = false;
            throw error;
        }
    }
    async retirePeer(peerId: number, epoch: number): Promise<void> {
        const peer = this.peers.get(peerId);
        if (!peer || peer.epoch !== epoch || this.ending || this.dead) return;
        peer.active = false;
        const body = Buffer.allocUnsafe(8); body.writeUInt32LE(peerId); body.writeUInt32LE(epoch, 4);
        const reply = await this.request(P.retire, P.retired, body);
        if (reply.length !== 12 || reply.readUInt32LE() !== peerId || reply.readUInt32LE(4) !== epoch)
            throw udpFailure(10022, "Invalid RETIRED acknowledgement");
        if (reply.readUInt32LE(8) && this.peers.get(peerId) === peer)
            throw udpFailure(reply.readUInt32LE(8), "Native UDP retirement refused", "control");
    }
    send(peerId: number, epoch: number, bytes: Uint8Array, callback: (error?: Error | null) => void): boolean {
        const peer = this.peers.get(peerId);
        const code = this.ending ? 10058 : this.dead || !this.started ? 10057 :
            !peer?.active || peer.epoch !== epoch ? 10013 :
            bytes.length > (this.family === 4 ? 65507 : P.maxPayload) ? 10040 :
            this.writes.size >= P.txRecords || this.writeBytes + bytes.length > P.bytes ||
            this.pipeBytes + P.header + 8 + bytes.length > INPUT_BYTES ? 10055 : 0;
        if (code) { queueMicrotask(() => callback(udpFailure(code, "Native UDP SEND not admitted", "send"))); return false; }
        let id: number;
        try { id = this.id(); } catch (error) { queueMicrotask(() => callback(error as Error)); return false; }
        const body = Buffer.allocUnsafe(8 + bytes.length);
        body.writeUInt32LE(peerId); body.writeUInt32LE(epoch, 4);
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).copy(body, 8);
        this.writes.set(id, { peerId, epoch, bytes: bytes.length, callback }); this.writeBytes += bytes.length;
        // After local admission an I/O failure has an unknown native outcome.
        // Report that once; never turn it into an automatic datagram replay.
        this.frame(P.send, id, body); return true;
    }
    grantReceiveCredit(bytes: number, packets: number): void {
        if (this.ending || this.dead) return;
        if (!Number.isInteger(bytes) || !Number.isInteger(packets) || bytes < 0 || packets < 0 ||
            this.rxBytes + this.creditBytes + bytes > P.bytes || this.rxPackets + this.creditPackets + packets > P.rxRecords)
            throw udpFailure(10055, "Bound UDP receive credit exceeded its limits", "control");
        this.creditBytes += bytes; this.creditPackets += packets; this.flushCredit();
    }
    private flushCredit(): void {
        if (!this.started || this.creditInFlight || this.ending || this.dead || (!this.creditBytes && !this.creditPackets)) return;
        const bytes = this.creditBytes, packets = this.creditPackets;
        this.creditBytes = this.creditPackets = 0; this.creditInFlight = true;
        this.rxBytes += bytes; this.rxPackets += packets;
        const body = Buffer.allocUnsafe(8); body.writeUInt32LE(bytes); body.writeUInt32LE(packets, 4);
        void this.request(P.credit, P.creditApplied, body).then(reply => {
            if (reply.length !== 8 || reply.readUInt32LE() > P.bytes || reply.readUInt32LE(4) > P.rxRecords)
                throw udpFailure(10022, "Invalid receive-credit acknowledgement");
        }).catch(error => { if (!this.ending) this.fail(error); }).finally(() => {
            this.creditInFlight = false; this.flushCredit();
        });
    }
    close(mode: "graceful" | "abort" = "graceful"): Promise<void> {
        if (!this.dead && !this.sawClosed && (!this.ending || (mode === "abort" && !this.abortRequested))) {
            this.ending = true; this.abortRequested ||= mode === "abort";
            let id: number;
            try { id = this.id(); } catch (error) { this.fail(error as Error); return this.closed; }
            this.closeIds.add(id); this.frame(mode === "abort" ? P.abort : P.close, id, Buffer.alloc(0), true);
            if (!this.closeTimer) {
                this.closeTimer = setTimeout(() => this.fail(udpFailure(10060, "Bound UDP close timed out")), this.closeTimeout);
                this.closeTimer.unref?.();
            }
        }
        return this.closed.then(() => { if (this.terminalError) throw this.terminalError; });
    }
    private accept(bytes: Buffer): void {
        if (this.dead || this.sawClosed) return;
        if (this.input.length + bytes.length > P.bytes * 2 + P.maxFrame) {
            this.fail(udpFailure(10055, "Bound UDP output parser exceeded its bound")); return;
        }
        this.input = this.input.length ? Buffer.concat([this.input, bytes]) : bytes;
        while (this.input.length >= P.header && !this.dead && !this.sawClosed) {
            const length = this.input.readUInt32LE();
            if (length < P.header || length > P.maxFrame || this.input[4] !== P.version ||
                this.input.readUInt16LE(6) || this.input.readUInt32LE(12) !== this.generation) {
                this.fail(udpFailure(10022, "Invalid bound UDP frame header")); return;
            }
            if (this.input.length < length) return;
            const frame = this.input.subarray(0, length); this.input = this.input.subarray(length);
            try { this.event(frame[5], frame.readUInt32LE(8), frame.subarray(P.header)); }
            catch (error) { this.fail(error as Error); return; }
        }
    }
    private event(opcode: number, id: number, body: Buffer): void {
        if (opcode === P.failure) {
            if (body.length !== 4) throw udpFailure(10022, "Invalid bound UDP failure");
            this.fail(udpFailure(body.readUInt32LE(), "Native bound UDP binding failed")); return;
        }
        if (opcode === P.closed) {
            if (!this.ending || !this.closeIds.has(id) || body.length !== 88 || this.writes.size || this.requests.size)
                throw udpFailure(10022, "Unexpected bound UDP CLOSED");
            const rawAddress = body.subarray(40, 64);
            const address = !this.bound && rawAddress.every(byte => byte === 0) ? undefined : decodeUdpAddress(rawAddress);
            if (this.bound && (!address || nativeUdpEndpointKey(address) !== nativeUdpEndpointKey(this.bound)))
                throw udpFailure(10022, "Bound UDP address changed during close");
            if (body.readUInt32LE(84)) throw udpFailure(body.readUInt32LE(84), "Native bound UDP close failed");
            this.sawClosed = true; this.rejectReady(udpFailure(10004, "UDP binding closed before readiness", "control"));
            this.child.stdin.end(); return;
        }
        if (opcode === P.sendResult) {
            const pending = this.writes.get(id);
            if (!pending || body.length !== 24 || body.readUInt32LE() !== pending.peerId ||
                body.readUInt32LE(4) !== pending.epoch || body.readUInt32LE(8) > 2)
                throw udpFailure(10022, "Invalid or duplicate native UDP SEND_RESULT");
            const disposition = body.readUInt32LE(8), code = body.readUInt32LE(12), native = body.readUInt32LE(16);
            if (!disposition && (code || native)) throw udpFailure(10022, "Accepted UDP send carries an error");
            this.writes.delete(id); this.writeBytes -= pending.bytes;
            pending.callback(disposition ? udpFailure(code || 10050, "Native UDP send was not accepted", "send", native) : null);
            return;
        }
        const request = this.requests.get(id);
        if (request) {
            if (opcode !== request.expected && opcode !== P.controlCancelled) throw udpFailure(10022, "Wrong bound UDP control acknowledgement");
            if (opcode === P.controlCancelled && (body.length !== 8 || body.readUInt32LE() !== request.opcode))
                throw udpFailure(10022, "Invalid control cancellation");
            this.requests.delete(id); clearTimeout(request.timer);
            if (opcode === P.controlCancelled) {
                request.reject(udpFailure(body.readUInt32LE(4), "Native UDP control cancelled", "control"));
            } else request.resolve(Buffer.from(body));
            return;
        }
        if (opcode === P.receive) {
            if (id || body.length < 32 || !this.rxPackets || body.length - 32 > this.rxBytes)
                throw udpFailure(10022, "Native UDP receive exceeded credit");
            const size = body.length - 32, peerId = body.readUInt32LE(), epoch = body.readUInt32LE(4);
            const endpoint = decodeUdpAddress(body.subarray(8, 32)), peer = this.peers.get(peerId);
            this.rxBytes -= size; this.rxPackets--;
            try {
                if (!this.ending && peer?.active && peer.epoch === epoch &&
                    nativeUdpEndpointKey(endpoint) === nativeUdpEndpointKey(peer.endpoint))
                    this.emit("message", Buffer.from(body.subarray(32)), { peerId, epoch, endpoint });
            } finally { if (this.automaticCredit) this.grantReceiveCredit(size, 1); }
            return;
        }
        if (opcode === P.peerError) {
            if (id || body.length !== 56) throw udpFailure(10022, "Invalid native UDP peer error");
            const peerId = body.readUInt32LE(), epoch = body.readUInt32LE(4);
            const endpoint = decodeUdpAddress(body.subarray(8, 32)), peer = this.peers.get(peerId);
            if (this.ending || !peer?.active || peer.epoch !== epoch || nativeUdpEndpointKey(endpoint) !== nativeUdpEndpointKey(peer.endpoint)) return;
            const error: NativeUdpPeerError = { peerId, epoch, endpoint, code: body.readUInt32LE(32),
                nativeCode: body.readUInt32LE(36), origin: body.readUInt32LE(40), type: body.readUInt32LE(44),
                icmpCode: body.readUInt32LE(48), occurrences: body.readUInt32LE(52) };
            if (!error.occurrences || (error.code !== 0 && error.code !== 10054)) throw udpFailure(10022, "Unrecognized UDP error mapping");
            this.emit(error.code ? "peerError" : "nativeError", error); return;
        }
        if (opcode === P.losses) {
            if (id || body.length !== 32) throw udpFailure(10022, "Invalid UDP loss counters");
            const counters: NativeUdpLossCounters = { rxPackets: body.readBigUInt64LE(), rxBytes: body.readBigUInt64LE(8),
                errorRecords: body.readBigUInt64LE(16), unattributedErrors: body.readBigUInt64LE(24) };
            for (const key of Object.keys(counters) as (keyof NativeUdpLossCounters)[])
                if (counters[key] < this.lastLosses[key]) throw udpFailure(10022, "UDP loss counters moved backwards");
            this.lastLosses = counters; this.emit("losses", counters); return;
        }
        throw udpFailure(10022, "Unknown bound UDP helper event");
    }
    private fail(error: Error): void {
        if (this.dead || this.sawClosed) return;
        this.dead = true; this.ending = true; this.terminalError = error;
        this.rejectReady(error);
        for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error); }
        this.requests.clear();
        const writes = [...this.writes.values()]; this.writes.clear(); this.writeBytes = this.pipeBytes = 0;
        for (const write of writes) { try { write.callback(error); } catch { /* All admitted results still retire exactly once. */ } }
        try { this.emit("bindingError", error); }
        finally {
            this.child.stdin.destroy();
            if (!this.exited) this.child.kill();
        }
    }
    private finishExit(): void {
        if (this.exited) return; this.exited = true;
        if (this.closeTimer) clearTimeout(this.closeTimer); this.closeTimer = undefined;
        this.input = Buffer.alloc(0); this.peers.clear(); this.resolveClosed(); this.emit("closed");
    }
}
