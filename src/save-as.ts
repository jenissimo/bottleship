import { downloadBlob } from "./settings/SettingsIconBtn";
import { asWriteChunk } from "./dom-buffer";

const WGB_PICKER_TYPES = [
    {
        description: "WGB Game Bundle",
        accept: { "application/octet-stream": [".wgb"] },
    },
];

/** Worker-side packing finishes around this percent; disk write uses 55–100. */
export const WGB_SAVE_PACK_PERCENT = 55;

const WRITE_CHUNK_BYTES = 4 * 1024 * 1024;

export type WriteProgressFn = (written: number, total: number) => void;

export function isSaveFilePickerSupported(): boolean {
    return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
}

/** Prompt Save As while a user gesture is still active. Returns null when cancelled or unsupported. */
export async function pickSaveWgbFile(suggestedName: string): Promise<FileSystemFileHandle | null> {
    const picker = (globalThis as { showSaveFilePicker?: (opts: {
        suggestedName: string;
        types: typeof WGB_PICKER_TYPES;
    }) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (typeof picker !== "function") return null;
    try {
        return await picker({ suggestedName, types: WGB_PICKER_TYPES });
    } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return null;
        throw err;
    }
}

async function toUint8Array(data: BlobPart): Promise<Uint8Array> {
    if (data instanceof Uint8Array) return data;
    return new Uint8Array(await new Blob([data]).arrayBuffer());
}

export async function writeBytesToFileHandle(
    handle: FileSystemFileHandle,
    data: BlobPart,
    onProgress?: WriteProgressFn,
): Promise<void> {
    const blob = data instanceof Blob ? data : null;
    const bytes = blob ? null : await toUint8Array(data);
    const total = blob ? blob.size : bytes!.byteLength;
    onProgress?.(0, total);
    const w = await handle.createWritable();
    try {
        for (let offset = 0; offset < total; offset += WRITE_CHUNK_BYTES) {
            const end = Math.min(offset + WRITE_CHUNK_BYTES, total);
            await w.write(blob ? blob.slice(offset, end) : asWriteChunk(bytes!.subarray(offset, end)));
            onProgress?.(end, total);
        }
        await w.close();
    } catch (err) {
        try {
            await w.abort();
        } catch {
            /* ignore */
        }
        throw err;
    }
}

/** Save As when supported; otherwise trigger a normal browser download. */
export async function saveBytesAs(
    data: BlobPart,
    suggestedFilename: string,
    onProgress?: WriteProgressFn,
): Promise<void> {
    const handle = await pickSaveWgbFile(suggestedFilename);
    if (handle) {
        await writeBytesToFileHandle(handle, data, onProgress);
        return;
    }
    downloadBlob(data, suggestedFilename);
}
