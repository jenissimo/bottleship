/**
 * DOM buffer-view casts.
 *
 * TypeScript 5.7+ made `Uint8Array` generic over its backing buffer
 * (`Uint8Array<ArrayBufferLike>`) and tightened the DOM lib types so that
 * `BufferSource` / `BlobPart` / `FileSystemWriteChunkType` / `bufferData` /
 * `createImageData` accept only `ArrayBuffer`-backed views, explicitly
 * excluding `SharedArrayBuffer`.
 *
 * Our entire guest address space is SharedArrayBuffer-backed, so every view we
 * hand to a browser sink is now `Uint8Array<ArrayBufferLike>` and rejected at
 * the type level. At RUNTIME browsers accept SAB-backed views into all of these
 * sinks — the tightening is purely type-level. Copying SAB -> ArrayBuffer here
 * would defeat the zero-alloc hot paths, so we cast at the boundary instead.
 *
 * Keep these casts localized to the DOM boundary; do not widen them into
 * general `any` usage.
 */

/** TextDecoder and SubtleCrypto can reject a view into a shared Wasm memory in Chrome. */
export function asBufferSource(v: ArrayBufferView): BufferSource {
  if (v.buffer instanceof ArrayBuffer) return v as ArrayBufferView<ArrayBuffer>;
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
}

export const asBlobPart = (v: ArrayBufferView): BlobPart =>
  v as unknown as BlobPart;

export const asWriteChunk = (v: ArrayBufferView): FileSystemWriteChunkType =>
  v as unknown as FileSystemWriteChunkType;

/**
 * Cast a typed-array view for the `ImageData` constructor / `createImageData` /
 * WebGL `bufferData` / `texImage2D` overloads that require an
 * `ArrayBuffer`-backed view.
 *
 * The `ImageData` constructor (and `ImageDataArray`) demand the *nominal*
 * `Uint8ClampedArray<ArrayBuffer>`, not merely a view whose `.buffer` is an
 * `ArrayBuffer` — a structural intersection (`T & { buffer: ArrayBuffer }`) is
 * rejected because inherited methods like `subarray()` still carry the
 * `ArrayBufferLike` parameter. So map the element-buffer type param to
 * `ArrayBuffer` on the way out.
 */
export const asArrayBufferView = <T extends ArrayBufferView>(
  v: T,
): T extends Uint8ClampedArray<ArrayBufferLike>
  ? Uint8ClampedArray<ArrayBuffer>
  : T extends Uint8Array<ArrayBufferLike>
    ? Uint8Array<ArrayBuffer>
    : T & { buffer: ArrayBuffer } => v as never;

/** Cast a SAB-or-ArrayBuffer to `ArrayBuffer` for sinks typed `ArrayBuffer`. */
export const asArrayBuffer = (b: ArrayBufferLike): ArrayBuffer =>
  b as ArrayBuffer;
