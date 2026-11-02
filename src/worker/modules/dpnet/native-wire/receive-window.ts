import { DN, type NativeDataFrame } from "./frame-codec";
export interface NativeReassembledMessage { command: number; control: number; payload: Uint8Array; firstSequence: number; lastSequence: number; }
interface StoredFrame { frame?: NativeDataFrame; delivered: boolean; }
interface PartialMessage { command: number; first: number; parts: Uint8Array[]; size: number; }
export interface NativeReceiveResult { accepted: boolean; duplicate: boolean; overflow: boolean; messages: NativeReassembledMessage[]; }
/**
 * DNET's 8-bit receive sequence, bounded 63-frame acceptance window, SACK masks,
 * unordered message indication, and contiguous fragment assembly. No guest memory.
 */
export class NativeReceiveWindow {
    private frames = new Map<number, StoredFrame>();
    private partial?: PartialMessage;
    private retained = 0;
    private failed = false;
    private next: number;
    constructor(initialSequence = 0, readonly maxMessage = 1024 * 1024, readonly maxRetained = 4 * 1024 * 1024, readonly maxFragments = 65536, private budget?: { reserve(bytes: number, fragments?: number): boolean; release(bytes: number, fragments?: number): void }) {
        if (!Number.isInteger(initialSequence) || initialSequence < 0 || initialSequence > 255 ||
            !Number.isInteger(maxMessage) || maxMessage < 1 || !Number.isInteger(maxRetained) || maxRetained < maxMessage || !Number.isInteger(maxFragments) || maxFragments < 1 || maxFragments > 65536)
            throw new RangeError("Invalid DNET receive budget");
        this.next = initialSequence;
    }
    get nextReceive(): number { return this.next; }
    get bufferedBytes(): number { return this.retained; }
    get bufferedFrames(): number { return this.frames.size; }
    get overflow(): boolean { return this.failed; }
    get sack(): [number, number] {
        let low = 0, high = 0;
        for (const sequence of this.frames.keys()) {
            const bit = ((sequence - this.next) & 255) - 1;
            if (bit >= 0 && bit < 32) low |= 1 << bit;
            else if (bit < 64 && bit >= 32) high |= 1 << (bit - 32);
        }
        return [low >>> 0, high >>> 0];
    }
    reset(sequence = 0): void { this.budget?.release(this.retained, this.frames.size + (this.partial?.parts.length ?? 0)); this.frames.clear(); this.partial = undefined; this.retained = 0; this.failed = false; this.next = sequence & 255; }
    receive(frame: NativeDataFrame): NativeReceiveResult {
        const result: NativeReceiveResult = { accepted: false, duplicate: false, overflow: this.failed, messages: [] };
        if (this.failed) return result;
        const delta = (frame.sequence - this.next) & 255;
        if (delta >= 63 || this.frames.has(frame.sequence)) { result.duplicate = delta >= 128 || this.frames.has(frame.sequence); return result; }
        if (frame.payload.length > this.maxMessage || this.retained + frame.payload.length > this.maxRetained) return this.exhaust(result);
        if (this.budget && !this.budget.reserve(frame.payload.length, 1)) return this.exhaust(result);
        this.frames.set(frame.sequence, { frame: { ...frame, masks: frame.masks.slice(), payload: frame.payload.slice() }, delivered: false });
        this.retained += frame.payload.length; result.accepted = true;
        this.drain(result);
        if (!this.failed) this.indicateUnordered(result);
        return result;
    }
    /** SEND bit zero cancels sequence base-1, unlike SACK's ascending base+1. */
    cancelSendMask(base: number, low: number, high: number): NativeReceiveResult {
        const result: NativeReceiveResult = { accepted: !this.failed, duplicate: false, overflow: this.failed, messages: [] };
        if (this.failed) return result;
        for (let bit = 0; bit < 64; bit++) if ((bit < 32 ? low >>> bit : high >>> (bit - 32)) & 1) {
            const sequence = (base - 1 - bit) & 255;
            if (((sequence - this.next) & 255) <= 63 && !this.frames.has(sequence)) {
                if (this.budget && !this.budget.reserve(0, 1)) return this.exhaust(result);
                this.frames.set(sequence, { delivered: false });
            }
        }
        this.drain(result);
        if (!this.failed) this.indicateUnordered(result);
        return result;
    }
    private exhaust(result: NativeReceiveResult): NativeReceiveResult {
        this.failed = true; result.overflow = true; result.accepted = false; return result;
    }
    private dropPartial(): void { if (this.partial) { this.retained -= this.partial.size; this.budget?.release(this.partial.size, this.partial.parts.length); } this.partial = undefined; }
    private assemble(command: number, control: number, parts: Uint8Array[], size: number, first: number, last: number): NativeReassembledMessage {
        const payload = new Uint8Array(size); let offset = 0;
        for (const part of parts) { payload.set(part, offset); offset += part.length; }
        return { command, control, payload, firstSequence: first, lastSequence: last };
    }
    private drain(result: NativeReceiveResult): void {
        while (!this.failed) {
            const entry = this.frames.get(this.next); if (!entry) return;
            const sequence = this.next, frame = entry.frame;
            this.frames.delete(sequence); this.next = (sequence + 1) & 255;
            if (!frame || entry.delivered) { this.budget?.release(0, 1); this.dropPartial(); continue; }
            this.retained -= frame.payload.length;
            if (frame.command & DN.NEW_MESSAGE) {
                // A second start within an incomplete message invalidates both messages.
                if (this.partial) { this.dropPartial(); this.budget?.release(frame.payload.length, 1); continue; }
                this.partial = { command: frame.command, first: sequence, parts: [], size: 0 };
            }
            const message = this.partial; if (!message) { this.budget?.release(frame.payload.length, 1); continue; }
            if (message.size + frame.payload.length > this.maxMessage || message.parts.length >= this.maxFragments) { this.dropPartial(); this.budget?.release(frame.payload.length, 1); this.exhaust(result); return; }
            message.parts.push(frame.payload); message.size += frame.payload.length; this.retained += frame.payload.length;
            if (frame.command & DN.END_MESSAGE) {
                if (message.size || frame.control & DN.END_STREAM)
                    result.messages.push(this.assemble(message.command, frame.control, message.parts, message.size, message.first, sequence));
                this.dropPartial();
            }
        }
    }
    private indicateUnordered(result: NativeReceiveResult): void {
        for (const [sequence, entry] of this.frames) {
            const start = entry.frame; if (!start || entry.delivered || !(start.command & DN.NEW_MESSAGE) || start.command & DN.SEQUENTIAL) continue;
            const frames: StoredFrame[] = []; let next = sequence, size = 0;
            for (let count = 0; count < 63; count++, next = (next + 1) & 255) {
                const item = this.frames.get(next), frame = item?.frame;
                if (!item || !frame || item.delivered || frame.command & DN.SEQUENTIAL || (count > 0 && frame.command & DN.NEW_MESSAGE)) break;
                frames.push(item); size += frame.payload.length;
                if (size > this.maxMessage || frames.length > this.maxFragments) { this.exhaust(result); return; }
                if (frame.command & DN.END_MESSAGE) {
                    if (size || frame.control & DN.END_STREAM) result.messages.push(this.assemble(start.command, frame.control, frames.map(e => e.frame!.payload), size, sequence, next));
                    for (const part of frames) { this.retained -= part.frame!.payload.length; this.budget?.release(part.frame!.payload.length); part.frame = { ...part.frame!, payload: new Uint8Array() }; part.delivered = true; }
                    break;
                }
            }
        }
    }
}
