import {decodeDirectPlay4SystemTcpFrame, type DirectPlay4SystemTcpFrame} from "./tcp-frame";

/**
 * Bounded incremental reader for the normal system-message slice of DirectPlay
 * TCP. It does not authenticate the peer, authorize an address, or handle the
 * other provider tokens. A malformed stream is terminal for this reader.
 */
export class DirectPlay4SystemTcpStream {
    private readonly buffer: Uint8Array;
    private used = 0;
    private expected = 0;
    private terminal = false;

    constructor(private readonly maxFrameBytes: number, private readonly maxFramesPerPush: number,
        private readonly maxBatchBytes: number) {
        if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 28 || maxFrameBytes > 0xfffff ||
            !Number.isInteger(maxFramesPerPush) || maxFramesPerPush < 1 || maxFramesPerPush > 4096 ||
            !Number.isInteger(maxBatchBytes) || maxBatchBytes < maxFrameBytes || maxBatchBytes > 0x1000000)
            throw new RangeError("invalid DirectPlay stream limits");
        this.buffer = new Uint8Array(maxFrameBytes);
    }

    /** Returns owned frames in wire order. A failed batch returns no frames and closes the reader. */
    push(chunk: Uint8Array): DirectPlay4SystemTcpFrame[] {
        if (this.terminal) throw new Error("DirectPlay stream is closed");
        const frames: DirectPlay4SystemTcpFrame[] = [];
        let offset = 0, batchBytes = 0;
        try {
            if (!(chunk instanceof Uint8Array)) throw new TypeError("chunk must be bytes");
            while (offset < chunk.length) {
                const target = this.expected || 4;
                const count = Math.min(target - this.used, chunk.length - offset);
                this.buffer.set(chunk.subarray(offset, offset + count), this.used);
                offset += count;
                this.used += count;
                if (!this.expected && this.used === 4) {
                    const header = new DataView(this.buffer.buffer).getUint32(0, true);
                    const length = header & 0xfffff;
                    if (((header & 0xfff00000) >>> 0) !== 0xfab00000 || length < 28 || length > this.maxFrameBytes)
                        throw new RangeError("invalid DirectPlay stream frame header");
                    this.expected = length;
                }
                if (this.expected && this.used === this.expected) {
                    if (frames.length >= this.maxFramesPerPush || this.used > this.maxBatchBytes - batchBytes)
                        throw new RangeError("DirectPlay frame batch limit exceeded");
                    batchBytes += this.used;
                    const frame = decodeDirectPlay4SystemTcpFrame(this.buffer.subarray(0, this.used), this.maxFrameBytes);
                    if (!frame) throw new Error("incomplete DirectPlay frame");
                    frames.push(frame);
                    this.used = 0;
                    this.expected = 0;
                }
            }
            return frames;
        } catch (error) {
            this.terminal = true;
            this.used = 0;
            this.expected = 0;
            throw error;
        }
    }

    /** EOF succeeds only at a frame boundary. */
    finish(): void {
        if (this.terminal) throw new Error("DirectPlay stream is closed");
        this.terminal = true;
        if (this.used !== 0) {
            this.used = 0;
            this.expected = 0;
            throw new RangeError("truncated DirectPlay frame");
        }
    }
}
