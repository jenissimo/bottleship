/** CPU staging for one monotonically allocated GPU ring between queue submissions. */
export class GeometryUploadWindow {
    private bytes = new Uint8Array(0);
    private dirtyOffset = 0;

    stage(gpuOffset: number, data: Uint8Array): void {
        const localOffset = gpuOffset - this.dirtyOffset;
        const required = localOffset + data.byteLength;
        if (required > this.bytes.byteLength) {
            let capacity = Math.max(4096, this.bytes.byteLength || 0);
            while (capacity < required) capacity *= 2;
            const grown = new Uint8Array(capacity);
            grown.set(this.bytes);
            this.bytes = grown;
        }
        this.bytes.set(data, localOffset);
    }

    flush(queue: GPUQueue, buffer: GPUBuffer, endOffset: number): void {
        if (endOffset <= this.dirtyOffset) return;
        queue.writeBuffer(buffer, this.dirtyOffset, this.bytes.buffer, 0, endOffset - this.dirtyOffset);
        this.dirtyOffset = endOffset;
    }

    /** Advance past bytes produced by a GPU copy, which must not be overwritten by staging. */
    advanceTo(offset: number): void {
        this.dirtyOffset = offset;
    }

    reset(): void {
        this.dirtyOffset = 0;
    }
}
