import { DPN } from "../constants";
import { DN, decodeNativeProtocolFrame, encodeNativeProtocolFrame, type NativeProtocolFrame, type NativeControlFrame } from "./frame-codec";
import { NativeReceiveWindow, type NativeReassembledMessage } from "./receive-window";
export interface NativeReliableOptions {
    send(packet: Uint8Array): boolean;
    onMessage?(message: NativeReassembledMessage): boolean | void;
    onState?(state: NativeReliableState, result: number): void;
    now?(): number; version?: number; sessionId?: number; retryInterval?: number; retries?: number; timeout?: number;
    fragmentSize?: number; maxMessage?: number; maxBuffered?: number;
}
export type NativeReliableState = "idle" | "listening" | "connecting" | "connected" | "closed";
interface SendJob { data: Uint8Array; offset: number; first: boolean; flags: number; control: number; outstanding: number; assigned: boolean; done: boolean; completion: Promise<number>; finish(result: number): void; }
interface SentFrame { serial: number; command: number; payload: Uint8Array; job: SendJob; time: number; retries: number; control: number; cancelled?: boolean; }
/**
 * Native DNET transport state, separate from DirectPlay's core name table/connect
 * protocol. An established link alone is not an established DirectPlay session.
 * Caller supplies a bounded clock tick and the address-bound UDP transport.
 */
export class NativeReliableLink {
    state: NativeReliableState = "idle";
    readonly ready: Promise<number>;
    remoteVersion = 0;
    readonly receiver: NativeReceiveWindow;
    private resolveReady!: (result: number) => void;
    private readyDone = false;
    private session: number;
    private readonly version: number;
    private readonly clock: () => number;
    private readonly retryInterval: number;
    private readonly retries: number;
    private readonly timeout: number;
    private readonly fragmentSize: number;
    private readonly maxBuffered: number;
    private role: "client" | "server" = "client";
    private messageId = 0;
    private checkpoints = new Set<number>();
    private responseId = 0;
    private controlSent = 0;
    private controlRetries = 0;
    private begun = 0;
    private lastReceive = 0;
    private lastProbe = 0;
    private sendNext = 0;
    private sendAck = 0;
    private jobs: SendJob[] = [];
    private waiting: SendJob[] = [];
    private bytes = 0;
    private outstanding = new Map<number, SentFrame>();
    private pumping = false;
    private ending?: Promise<number>;
    private resolveEnding?: (result: number) => void;
    private endingBegun = 0;
    private receivedEnd = false;
    private sentEndAcknowledged = false;
    constructor(readonly options: NativeReliableOptions) {
        this.clock = options.now ?? (() => performance.now());
        this.version = options.version ?? 0x10002; this.session = options.sessionId ?? crypto.getRandomValues(new Uint32Array(1))[0];
        this.retryInterval = options.retryInterval ?? 200; this.retries = options.retries ?? 14; this.timeout = options.timeout ?? 25000;
        this.fragmentSize = options.fragmentSize ?? 1200; this.maxBuffered = options.maxBuffered ?? 4 * 1024 * 1024;
        if (!Number.isInteger(this.version) || this.version < 0 || this.version > 0xffffffff || !Number.isInteger(this.session) || this.session < 0 || this.session > 0xffffffff ||
            !Number.isInteger(this.retryInterval) || this.retryInterval < 1 || !Number.isInteger(this.retries) || this.retries < 0 || this.retries > 255 ||
            !Number.isInteger(this.timeout) || this.timeout < 1 || !Number.isInteger(this.fragmentSize) || this.fragmentSize < 64 || this.fragmentSize > 65487)
            throw new RangeError("Invalid DNET link limits");
        this.receiver = new NativeReceiveWindow(0, options.maxMessage ?? 1024 * 1024, this.maxBuffered);
        this.ready = new Promise(resolve => { this.resolveReady = resolve; });
    }
    get pendingBytes(): number { return this.bytes; }
    get pendingFrames(): number { return this.outstanding.size; }
    get pendingMessages(): number { return this.jobs.length; }
    connect(): Promise<number> {
        if (this.state === "idle") { this.role = "client"; this.state = "connecting"; this.begun = this.clock(); this.sendHandshake(); }
        return this.ready;
    }
    listen(): Promise<number> { if (this.state === "idle") { this.role = "server"; this.state = "listening"; } return this.ready; }
    private emitState(result: number): void { try { this.options.onState?.(this.state, result); } catch { this.close(DPN.GENERIC); } }
    private settle(result: number): void { if (!this.readyDone) { this.readyDone = true; this.resolveReady(result); } }
    private transmit(frame: NativeProtocolFrame): boolean {
        if (this.state === "closed") return false;
        try { if (this.options.send(encodeNativeProtocolFrame(frame))) return (this.state as NativeReliableState) !== "closed"; } catch { /* Transport exceptions are failed submissions. */ }
        this.close(DPN.NOCONNECTION); return false;
    }
    private control(opcode: 1 | 2, poll: boolean, responseId = 0): boolean {
        const id = this.messageId++ & 255;
        if (poll) this.checkpoints.add(id);
        return this.transmit({ kind: "control", command: poll ? 0x88 : 0x80, opcode, messageId: id, responseId,
            version: this.version, sessionId: this.session, timestamp: this.clock() >>> 0, extra: new Uint8Array() });
    }
    private sendHandshake(): void {
        this.controlSent = this.clock();
        this.control(this.role === "client" ? DN.CONNECT : DN.CONNECTED, true, this.responseId);
    }
    receive(packet: Uint8Array): void {
        if (this.state === "closed" || this.state === "idle") return;
        const frame = decodeNativeProtocolFrame(packet); if (!frame) return;
        if (frame.kind === "control") { this.receiveControl(frame); return; }
        if (this.state !== "connected") return;
        this.lastReceive = this.clock();
        // Native rejects stale data outside the receive window before using its ACK fields.
        if (frame.kind === "data" && ((frame.sequence - this.receiver.nextReceive) & 255) >= 63) {
            if (frame.command & DN.POLL) this.sendAckFrame(); return;
        }
        const masks = [0, 0, 0, 0]; let i = 0;
        const bits = frame.kind === "data" ? frame.control >>> 4 : frame.flags >>> 1;
        for (let bit = 0; bit < 4; bit++) if (bits & (1 << bit)) masks[bit] = frame.masks[i++];
        this.acknowledge(frame.nextReceive, masks[0], masks[1]);
        if (this.state !== "connected") return;
        if (masks[2] || masks[3]) this.indicate(this.receiver.cancelSendMask(frame.kind === "data" ? frame.sequence : frame.nextSend, masks[2], masks[3]));
        if (frame.kind === "data") { this.indicate(this.receiver.receive(frame)); if (this.state === "connected") this.sendAckFrame(); }
        else if (masks[2] || masks[3] || frame.command & DN.POLL) this.sendAckFrame();
        this.pump();
    }
    private receiveControl(frame: NativeControlFrame): void {
        if ((frame.version >>> 16) !== (this.version >>> 16)) return;
        if (frame.opcode === DN.CONNECT) {
            if (this.state === "listening") {
                this.session = frame.sessionId; this.remoteVersion = frame.version; this.responseId = frame.messageId;
                this.state = "connecting"; this.begun = this.clock(); this.sendHandshake();
            } else if (this.role === "server" && this.state === "connecting" && this.session === frame.sessionId) {
                this.responseId = frame.messageId; this.sendHandshake();
            }
            return;
        }
        if (frame.opcode !== DN.CONNECTED || frame.sessionId !== this.session || (this.state !== "connecting" && this.state !== "connected")) return;
        if (this.state === "connecting" && !this.checkpoints.has(frame.responseId)) return;
        this.remoteVersion = frame.version;
        const first = this.state === "connecting"; this.state = "connected"; this.lastReceive = this.lastProbe = this.clock();
        if (frame.command & DN.POLL) { if (!this.control(DN.CONNECTED, false, frame.messageId)) return; }
        if (first && this.state === "connected") { this.settle(DPN.OK); this.emitState(DPN.OK); this.pump(); }
    }
    private indicate(result: { overflow: boolean; messages: NativeReassembledMessage[] }): void {
        if (result.overflow) { this.close(DPN.TABLEFULL); return; }
        for (const message of result.messages) {
            if (this.state !== "connected") return;
            if (message.control & DN.END_STREAM) {
                this.receivedEnd = true;
                // Native sends three final ACKs: neither direction may disappear merely
                // because its own EOS was acknowledged first (receive.cpp ProcessEndOfStream).
                for (let i = 0; i < 3 && this.state === "connected"; i++) this.sendAckFrame();
                if (this.state !== "connected") return;
                void this.shutdown(); this.finishShutdown(); return;
            }
            try { if (this.options.onMessage?.(message) === false) { this.close(DPN.TABLEFULL); return; } } catch { this.close(DPN.GENERIC); return; }
        }
    }
    private sendMasks(base: number): [number, number] {
        let low = 0, high = 0;
        for (const frame of this.outstanding.values()) if (frame.cancelled) { const bit = base - frame.serial - 1; if (bit >= 0 && bit < 32) low |= 1 << bit; else if (bit >= 32 && bit < 64) high |= 1 << (bit - 32); }
        return [low >>> 0, high >>> 0];
    }
    private sendAckFrame(poll = false): void {
        const [low, high] = this.receiver.sack, [sendLow, sendHigh] = this.sendMasks(this.sendNext), masks: number[] = [];
        let flags = 1; if (low) { flags |= 2; masks.push(low); } if (high) { flags |= 4; masks.push(high); }
        if (sendLow) { flags |= 8; masks.push(sendLow); } if (sendHigh) { flags |= 16; masks.push(sendHigh); }
        this.transmit({ kind: "ack", command: poll ? 0x88 : 0x80, flags, retry: 0, nextSend: this.sendNext & 255, nextReceive: this.receiver.nextReceive,
            reserved: [0, 0], timestamp: this.clock() >>> 0, masks, extra: new Uint8Array() });
    }
    sendReliable(data: Uint8Array, userFlags: number = DN.USER1, sequential = true): Promise<number> {
        if (this.ending) return Promise.resolve(DPN.ALREADYCLOSING);
        return this.enqueueReliable(data, userFlags, sequential);
    }
    /** Unreliable payloads complete on carrier acceptance; bounded sequence metadata remains until ACK/cancel. */
    sendUnreliable(data: Uint8Array, userFlags = 0, sequential = true): Promise<number> {
        if (this.ending) return Promise.resolve(DPN.ALREADYCLOSING);
        return this.enqueueReliable(data, userFlags, sequential, 0, false);
    }
    /** Drain prior messages and finish both acknowledged directions of native END_STREAM. */
    shutdown(): Promise<number> {
        if (this.ending) return this.ending;
        if (this.state !== "connected") return Promise.resolve(DPN.NOCONNECTION);
        this.ending = new Promise<number>(done => { this.resolveEnding = done; }); this.endingBegun = this.clock();
        const prior = this.jobs.map(job => job.completion);
        void Promise.all([...prior, this.enqueueReliable(new Uint8Array(), 0, true, DN.END_STREAM | DN.CORRELATE)]).then(results => {
            if (this.state !== "connected") return;
            const result = results.find(value => value !== DPN.OK) ?? DPN.OK;
            if (result) { this.close(result); return; }
            this.sentEndAcknowledged = true; this.finishShutdown();
        });
        return this.ending;
    }
    private finishShutdown(): void { if (this.receivedEnd && this.sentEndAcknowledged) this.close(DPN.OK); }
    private enqueueReliable(data: Uint8Array, userFlags: number, sequential: boolean, control = 0, reliable = true): Promise<number> {
        if (this.state !== "connected") return Promise.resolve(DPN.NOCONNECTION);
        if (userFlags & ~(DN.USER1 | DN.USER2)) return Promise.resolve(DPN.INVALIDFLAGS);
        if (data.length > this.receiver.maxMessage) return Promise.resolve(DPN.DATATOOLARGE);
        if ((!control && this.jobs.length >= 256) || this.bytes + data.length > this.maxBuffered) return Promise.resolve(DPN.TABLEFULL);
        let resolve!: (result: number) => void;
        const done = new Promise<number>(finish => { resolve = finish; });
        const job: SendJob = { data: data.slice(), offset: 0, first: true, flags: userFlags | (reliable ? DN.RELIABLE : 0) | (sequential ? DN.SEQUENTIAL : 0),
            control, outstanding: 0, assigned: false, done: false, completion: done, finish: result => {
                if (job.done) return; job.done = true; this.bytes -= job.data.length; this.jobs = this.jobs.filter(j => j !== job); resolve(result);
            } };
        this.jobs.push(job); this.waiting.push(job); this.bytes += data.length; this.pump(); return done;
    }
    private pump(): void {
        if (this.pumping || this.state !== "connected") return;
        this.pumping = true;
        try {
            while (this.state === "connected" && this.waiting.length && this.sendNext - this.sendAck < 63) {
                const job = this.waiting[0], end = Math.min(job.data.length, job.offset + this.fragmentSize);
                const command = DN.DATA | job.flags | (job.first ? DN.NEW_MESSAGE : 0) | (end === job.data.length ? DN.END_MESSAGE : 0);
                const frame: SentFrame = { serial: this.sendNext++, command, payload: job.data.slice(job.offset, end), job, time: this.clock(), retries: 0, control: end === job.data.length ? job.control : 0 };
                job.offset = end; job.first = false; job.outstanding++;
                if (end === job.data.length) { job.assigned = true; this.waiting.shift(); }
                this.outstanding.set(frame.serial, frame); this.sendFrame(frame);
                if (!(job.flags & DN.RELIABLE) && job.assigned && this.state === "connected") { job.finish(DPN.OK); job.data = new Uint8Array(); }
            }
        } finally { this.pumping = false; }
    }
    private sendFrame(sent: SentFrame): void {
        const [low, high] = this.receiver.sack, [sendLow, sendHigh] = this.sendMasks(sent.serial), masks: number[] = []; let control = sent.control | (sent.retries ? DN.RETRY : 0);
        if (low) { control |= DN.SACK_LOW; masks.push(low); } if (high) { control |= DN.SACK_HIGH; masks.push(high); }
        if (sendLow) { control |= DN.SEND_LOW; masks.push(sendLow); } if (sendHigh) { control |= DN.SEND_HIGH; masks.push(sendHigh); }
        sent.time = this.clock();
        this.transmit({ kind: "data", command: sent.command | DN.POLL, control, sequence: sent.serial & 255, nextReceive: this.receiver.nextReceive, masks, payload: sent.payload });
        if (!(sent.command & DN.RELIABLE)) sent.payload = new Uint8Array();
    }
    private acknowledge(next: number, low: number, high: number): void {
        const advance = (next - (this.sendAck & 255)) & 255;
        if (advance > this.sendNext - this.sendAck) return; // Stale/forged ACK beyond any frame we sent.
        this.sendAck += advance;
        for (const [serial, frame] of this.outstanding) {
            const bit = serial - this.sendAck - 1;
            if (serial < this.sendAck || (bit >= 0 && bit < 64 && ((bit < 32 ? low >>> bit : high >>> (bit - 32)) & 1))) {
                this.outstanding.delete(serial); frame.job.outstanding--;
                if (frame.job.assigned && !frame.job.outstanding) frame.job.finish(DPN.OK);
            }
        }
    }
    /** No implicit timers: owner calls tick from its own bounded lifecycle pump. */
    tick(now = this.clock()): void {
        if (this.state === "connecting") {
            if (now - this.begun >= this.timeout) { this.close(DPN.TIMEDOUT); return; }
            if (now - this.controlSent >= this.retryInterval) {
                if (this.controlRetries++ >= this.retries) { this.close(DPN.TIMEDOUT); return; } this.sendHandshake();
            }
        } else if (this.state === "connected") {
            if (this.ending && now - this.endingBegun >= this.timeout) { this.close(DPN.CONNECTIONLOST); return; }
            if (now - this.lastReceive >= this.timeout) { this.close(DPN.CONNECTIONLOST); return; }
            for (const sent of [...this.outstanding.values()]) if (now - sent.time >= Math.min(5000, this.retryInterval * 2 ** Math.min(sent.retries, 5))) {
                if (sent.retries++ >= this.retries) { this.close(DPN.CONNECTIONLOST); return; }
                if (!(sent.command & DN.RELIABLE)) { sent.cancelled = true; sent.time = now; this.sendAckFrame(true); }
                else this.sendFrame(sent);
                if (this.state !== "connected") return;
            }
            if (now - this.lastProbe >= 5000) { this.lastProbe = now; void this.sendReliable(new Uint8Array(), 0); }
        }
    }
    close(result: number = DPN.USERCANCEL): void {
        if (this.state === "closed") return; this.state = "closed"; this.settle(result);
        for (const job of [...this.jobs]) job.finish(result);
        this.waiting = []; this.outstanding.clear(); this.checkpoints.clear(); this.receiver.reset();
        const resolveEnding = this.resolveEnding; this.resolveEnding = undefined; resolveEnding?.(result); this.emitState(result);
    }
}
