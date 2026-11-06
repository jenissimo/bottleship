import { decodeOggVorbis } from "./vorbis-decode";

interface Request { id: number; oggs: Uint8Array[] }

self.onmessage = async (event: MessageEvent<Request>) => {
    const { id, oggs } = event.data;
    const pcms: Array<Int16Array | null> = [];
    for (const ogg of oggs) pcms.push(await decodeOggVorbis(ogg).catch(() => null));
    const transfer = pcms.filter((p): p is Int16Array => p !== null).map((p) => p.buffer as ArrayBuffer);
    (self as unknown as Worker).postMessage({ id, pcms }, transfer);
};
