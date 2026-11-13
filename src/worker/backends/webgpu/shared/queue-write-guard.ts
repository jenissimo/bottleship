/**
 * The write side of command ordering for queue-level texture writes.
 *
 * `queue.writeTexture`, `queue.copyExternalImageToTexture` and a separately submitted
 * encoder take effect when they are issued, while the executor's recorded commands take
 * effect only when its encoder is submitted. A write to a texture those recorded commands
 * read or write would therefore run ahead of them. Every helper that writes a texture
 * through the queue calls `beforeQueueWrite(texture)` first; an executor whose recorded
 * work references that texture submits it, and does nothing otherwise.
 *
 * Keyed by GPUTexture rather than by surface state, so it holds when a flip chain rotates
 * textures between surfaces. The census in tools/validate-queue-writes.ts keeps the write
 * sites behind this call.
 */

export interface QueueWriteGuard {
    /** Submit recorded work that references `texture` before the caller writes it. */
    beforeQueueWrite(texture: GPUTexture): void;
}

// @transient(the live executors register on construction and leave on destroy; nothing to save)
const guards: QueueWriteGuard[] = [];

export function registerQueueWriteGuard(guard: QueueWriteGuard): void {
    if (!guards.includes(guard)) guards.push(guard);
}

export function unregisterQueueWriteGuard(guard: QueueWriteGuard): void {
    const i = guards.indexOf(guard);
    if (i >= 0) guards.splice(i, 1);
}

/** Call before any queue-level write to `texture`. */
export function beforeQueueWrite(texture: GPUTexture | undefined | null): void {
    if (!texture) return;
    for (let i = 0; i < guards.length; i++) guards[i].beforeQueueWrite(texture);
}
