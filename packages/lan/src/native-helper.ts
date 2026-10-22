import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TCP_SEGMENT, TCP_WINDOW } from "./tcp-protocol";

const DATA = 1, OOB = 2, FIN = 3, CREDIT = 4, CONTROL = 11;
const INPUT_BUDGET = TCP_WINDOW + 8192, CONTROL_RECORDS = 64;
const CONNECTED = 10, READ = 11, URGENT = 12, EOF = 13, ERROR = 14, ACK = 15, CLOSED = 16, FINISHED = 19, OPTION_VALUE = 20, CONTROL_ACK = 21;
type ReadItem = { data: Buffer; offset: number } | { urgent: number };
function failure(code: number, message: string): Error & { code: number } { return Object.assign(new Error(message), { code }); }

/** One explicitly configured helper process owns one native TCP socket. */
export class NativeHelperSocket extends EventEmitter {
    private child: ChildProcessWithoutNullStreams | null = null;
    private input: Buffer = Buffer.alloc(0);
    private readonly reads: ReadItem[] = [];
    private readonly writes = new Map<number, { bytes: number; callback: (error?: Error | null) => void }>();
    private nextWrite = 1;
    private nextControl = 1;
    private readonly controls = new Map<number, number>();
    private pendingCredit = 0;
    private creditScheduled = false;
    private readBytes = 0;
    private writeBytes = 0;
    private pendingCommandBytes = 0;
    private closed = false;
    private sawEof = false;
    private emittedEof = false;
    private emittedClose = false;
    private sawClose = false;
    private connected = false;
    private noDelay = false;
    private keepAlive = false;
    private endRequested = false;
    private endFinished = false;
    private readonly endCallbacks: (() => void)[] = [];
    constructor(private readonly executable: string, private inline = false) { super(); }
    setOobInline(enabled: boolean): void { this.inline = enabled; this.setNativeOption(0, enabled); }
    get readableLength(): number { return this.readBytes; }
    setNoDelay(enabled: boolean): this { this.noDelay = enabled; this.setNativeOption(2, enabled); return this; }
    setKeepAlive(enabled: boolean): this { this.keepAlive = enabled; this.setNativeOption(1, enabled); return this; }
    private setNativeOption(option: number, enabled: boolean): void {
        if (!this.child) return;
        if (this.closed) return;
        if (this.controls.size >= CONTROL_RECORDS) { this.fail(failure(10055, "Native helper control window exhausted")); return; }
        let id = this.nextControl;
        while (this.controls.has(id)) id = (id + 1) >>> 0 || 1;
        this.nextControl = (id + 1) >>> 0 || 1;
        const payload = Buffer.allocUnsafe(12);
        payload.writeUInt32LE(id); payload.writeUInt32LE(option, 4); payload.writeUInt32LE(+enabled, 8);
        this.controls.set(id, option);
        if (!this.command(CONTROL, payload)) this.fail(failure(10057, "Native helper pipe closed"));
    }
    connect(port: number, host: string): void {
        if (this.closed || this.child) return;
        const child = this.child = spawn(this.executable, ["tcp", host, String(port), this.inline ? "1" : "0", this.keepAlive ? "1" : "0", this.noDelay ? "1" : "0"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        child.stdout.on("data", (data: Buffer) => this.accept(data));
        child.stderr.resume();
        child.stdin.on("error", failure => { if (!this.closed && !["EPIPE", "ECONNRESET"].includes((failure as { code?: string }).code ?? "")) this.fail(failure); });
        child.on("error", error => this.fail(Object.assign(error, { code: 10045 })));
        child.on("close", code => {
            if (this.closed) return;
            if (!this.sawClose && !(this.sawEof && code === 0)) this.fail(failure(10054, "Native socket helper exited unexpectedly"));
            else this.maybeEnd();
        });
        this.command(CREDIT, this.word(TCP_WINDOW));
    }
    private word(value: number): Buffer { const bytes = Buffer.allocUnsafe(4); bytes.writeUInt32LE(value); return bytes; }
    private command(kind: number, payload: Buffer = Buffer.alloc(0)): boolean {
        if (this.closed || !this.child?.stdin.writable) return false;
        const size = 8 + payload.length, child = this.child;
        // DATA has a separate native-send window, but control/CREDIT records also
        // occupy the pipe's JS queue while the helper is not reading.
        if (this.pendingCommandBytes + size > INPUT_BUDGET) {
            this.fail(failure(10055, "Native helper input exceeded its bound")); return false;
        }
        const frame = Buffer.allocUnsafe(size);
        frame.writeUInt32LE(kind); frame.writeUInt32LE(payload.length, 4); payload.copy(frame, 8);
        this.pendingCommandBytes += size;
        const complete = (error?: Error | null) => {
            if (this.closed || this.child !== child) return;
            this.pendingCommandBytes -= size;
            if (error) this.fail(failure(10054, "Native helper input pipe failed"));
        };
        try { child.stdin.write(frame, complete); }
        catch { complete(failure(10054, "Native helper input pipe failed")); return false; }
        // write(false) still accepted this record; the explicit byte bound above
        // limits its memory until the write callback returns the credit.
        return true;
    }
    private accept(bytes: Buffer): void {
        if (this.closed) return;
        if (this.input.length + bytes.length > TCP_WINDOW * 2) { this.fail(failure(10055, "Native helper output exceeded its bound")); return; }
        this.input = this.input.length ? Buffer.concat([this.input, bytes]) : bytes;
        while (this.input.length >= 8 && !this.closed) {
            const kind = this.input.readUInt32LE(), size = this.input.readUInt32LE(4);
            if (size > TCP_SEGMENT) { this.fail(failure(10022, "Invalid native helper frame")); return; }
            if (this.input.length < size + 8) return;
            const payload = this.input.subarray(8, size + 8);
            this.input = this.input.subarray(size + 8);
            if (kind === CONNECTED && !size && !this.connected) { this.connected = true; this.emit("connect"); }
            else if (kind === READ && size && this.readBytes + size <= TCP_WINDOW) {
                this.reads.push({ data: Buffer.from(payload), offset: 0 }); this.readBytes += size; this.emit("readable");
            } else if (kind === URGENT && size === 1 && this.reads.length < 65536) {
                this.reads.push({ urgent: payload[0] }); this.emit("readable");
            } else if (kind === EOF && !size) { this.sawEof = true; this.maybeEnd(); }
            else if (kind === OPTION_VALUE && size === 8 && (payload.readUInt32LE() === 1 || payload.readUInt32LE() === 2) && payload.readUInt32LE(4) <= 1) {
                this.emit("option", { option: payload.readUInt32LE(), enabled: !!payload.readUInt32LE(4) });
            }
            else if (kind === CONTROL_ACK && size === 12 && payload.readUInt32LE(8) <= 1) {
                const id = payload.readUInt32LE(), option = payload.readUInt32LE(4), enabled = !!payload.readUInt32LE(8);
                if (this.controls.get(id) !== option) { this.fail(failure(10022, "Unknown native control acknowledgement")); return; }
                this.controls.delete(id);
                if (option === 0) this.inline = enabled;
                else this.emit("option", { option, enabled });
                this.emit("control", { id, option, enabled });
            }
            else if (kind === FINISHED && !size && this.endRequested && !this.endFinished) {
                this.endFinished = true;
                for (const callback of this.endCallbacks.splice(0)) callback();
            }
            else if (kind === ERROR && size === 4) { this.fail(failure(payload.readUInt32LE(), "Native socket operation failed")); }
            else if (kind === ACK && size === 4) {
                const id = payload.readUInt32LE(), pending = this.writes.get(id);
                if (!pending) { this.fail(failure(10022, "Unknown native write acknowledgement")); return; }
                this.writes.delete(id); this.writeBytes -= pending.bytes; pending.callback();
            } else if (kind === CLOSED && !size) { this.sawClose = true; this.maybeEnd(); }
            else { this.fail(failure(10022, "Invalid native helper event")); return; }
        }
    }
    /** DATA preceding the urgent mark must leave the relay before OOB. */
    bytesBeforeUrgent(): number {
        let count = 0;
        for (const item of this.reads) { if ("urgent" in item) break; count += item.data.length - item.offset; }
        return count;
    }
    takeUrgent(): number | null {
        const first = this.reads[0];
        if (!first || !("urgent" in first)) return null;
        this.reads.shift(); this.returnCredit(1); this.maybeEnd();
        return first.urgent;
    }
    get urgentReady(): boolean { return !!this.reads[0] && "urgent" in this.reads[0]; }
    read(length = 0): Buffer | null {
        if (!length || !this.readBytes) return null;
        length = Math.min(length, this.bytesBeforeUrgent());
        if (!length) return null;
        const bytes = Buffer.allocUnsafe(length); let offset = 0;
        while (offset < length) {
            const item = this.reads[0];
            if ("urgent" in item) break;
            const size = Math.min(length - offset, item.data.length - item.offset);
            item.data.copy(bytes, offset, item.offset, item.offset + size);
            item.offset += size; offset += size;
            if (item.offset === item.data.length) this.reads.shift();
        }
        this.readBytes -= offset; this.returnCredit(offset); this.maybeEnd();
        return bytes;
    }
    private returnCredit(bytes: number): void {
        this.pendingCredit += bytes;
        if (this.creditScheduled) return;
        this.creditScheduled = true;
        queueMicrotask(() => {
            this.creditScheduled = false;
            if (this.closed) return;
            const credit = this.pendingCredit; this.pendingCredit = 0;
            if (credit && !this.command(CREDIT, this.word(credit))) this.fail(failure(10057, "Native helper pipe closed"));
        });
    }
    write(bytes: Uint8Array, callback: (error?: Error | null) => void = () => {}): boolean {
        const records = Math.ceil(bytes.length / TCP_SEGMENT);
        const stateError = this.closed || !this.connected || !this.child?.stdin.writable ? 10057 : this.endRequested ? 10058 : 0;
        // Reserve the complete call before serializing any segment: both the
        // native ACK window and the input pipe include every resulting record.
        if (stateError || this.writeBytes + bytes.length > TCP_WINDOW || this.writes.size + records > 256 ||
            this.pendingCommandBytes + bytes.length + records * 12 > INPUT_BUDGET) {
            queueMicrotask(() => callback(failure(stateError || 10055, "Native helper write unavailable"))); return false;
        }
        if (!bytes.length) { queueMicrotask(() => callback()); return true; }
        let remaining = records, failed = false;
        for (let offset = 0; offset < bytes.length && !this.closed; offset += TCP_SEGMENT) {
            const part = bytes.subarray(offset, offset + TCP_SEGMENT);
            this.writeOne(DATA, part, error => {
                if (failed) return;
                if (error) { failed = true; callback(error); } else if (!--remaining) callback();
            });
        }
        return !this.closed;
    }
    sendUrgent(byte: number, callback: (error?: Error | null) => void): void {
        const stateError = this.closed || !this.connected || !this.child?.stdin.writable ? 10057 : this.endRequested ? 10058 : 0;
        if (stateError || this.writeBytes >= TCP_WINDOW || this.writes.size >= 256 ||
            this.pendingCommandBytes + 13 > INPUT_BUDGET) {
            queueMicrotask(() => callback(failure(stateError || 10055, "Native helper urgent write unavailable"))); return;
        }
        this.writeOne(OOB, Uint8Array.of(byte), callback);
    }
    private writeOne(kind: number, bytes: Uint8Array, callback: (error?: Error | null) => void): void {
        let id = this.nextWrite;
        while (this.writes.has(id)) id = (id + 1) >>> 0 || 1;
        this.nextWrite = (id + 1) >>> 0 || 1;
        const payload = Buffer.allocUnsafe(4 + bytes.length); payload.writeUInt32LE(id); payload.set(bytes, 4);
        this.writes.set(id, { bytes: bytes.length, callback }); this.writeBytes += bytes.length;
        if (!this.command(kind, payload)) this.fail(failure(10057, "Native helper pipe closed"));
    }
    end(callback?: () => void): void {
        if (this.closed) return;
        if (this.endFinished) { if (callback) queueMicrotask(callback); return; }
        if (callback) this.endCallbacks.push(callback);
        if (!this.endRequested) {
            this.endRequested = true;
            if (!this.command(FIN)) this.fail(failure(10057, "Native helper pipe closed"));
        }
    }
    private maybeEnd(): void {
        if (this.sawEof && !this.reads.length && (!this.emittedEof || (this.sawClose && !this.emittedClose))) queueMicrotask(() => {
            if (this.closed || this.reads.length) return;
            if (!this.emittedEof) { this.emittedEof = true; this.emit("end"); }
            if (this.sawClose && !this.emittedClose) { this.emittedClose = true; this.emit("close"); }
        });
    }
    private fail(error: Error): void {
        if (this.closed) return;
        this.emit("error", error);
        this.destroy();
    }
    destroy(): void {
        if (this.closed) return;
        this.closed = true;
        this.reads.length = 0; this.readBytes = 0; this.input = Buffer.alloc(0);
        for (const pending of this.writes.values()) pending.callback(failure(10054, "Native helper socket closed"));
        this.writes.clear(); this.controls.clear(); this.writeBytes = 0; this.pendingCommandBytes = 0;
        this.pendingCredit = 0; this.endCallbacks.length = 0;
        this.child?.stdin.destroy(); this.child?.stdout.destroy(); this.child?.stderr.destroy();
        this.child?.kill(); this.child = null;
        if (!this.emittedClose) { this.emittedClose = true; this.emit("close"); }
    }
}
