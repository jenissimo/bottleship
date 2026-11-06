import { isStandardMidiFile } from "./directmusic/smf";

export interface SmfEvent {
    ms: number;
    message: number;
    sysex: Uint8Array | null;
}

export interface SmfSong {
    events: SmfEvent[];
    lengthMs: number;
    tracks: number;
}

interface RawEvent { tick: number; order: number; message: number; sysex: Uint8Array | null; tempo: number }

function readVarLen(bytes: Uint8Array, pos: { o: number }, end: number): number {
    let value = 0;
    for (let i = 0; i < 4 && pos.o < end; i++) {
        const b = bytes[pos.o++]!;
        value = (value << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) break;
    }
    return value >>> 0;
}

function riffMidi(bytes: Uint8Array): Uint8Array {
    if (bytes.length < 20 || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF"
        || String.fromCharCode(...bytes.subarray(8, 12)) !== "RMID") return bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let o = 12; o + 8 <= bytes.length;) {
        const id = String.fromCharCode(...bytes.subarray(o, o + 4));
        const size = view.getUint32(o + 4, true);
        if (id === "data") return bytes.subarray(o + 8, Math.min(bytes.length, o + 8 + size));
        o += 8 + size + (size & 1);
    }
    return bytes;
}

export function parseSmfSong(input: Uint8Array): SmfSong | null {
    const bytes = riffMidi(input);
    if (!isStandardMidiFile(bytes)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLen = view.getUint32(4, false);
    const ntrks = view.getUint16(10, false);
    const division = view.getUint16(12, false);
    const smpte = (division & 0x8000) !== 0;
    const ticksPerSecond = smpte ? (256 - (division >> 8)) * (division & 0xff) : 0;
    const ppq = smpte ? 0 : division || 480;

    const raw: RawEvent[] = [];
    let order = 0;
    let tracks = 0;
    let o = 8 + headerLen;
    for (let track = 0; track < ntrks && o + 8 <= bytes.length; track++) {
        const id = String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
        const size = view.getUint32(o + 4, false);
        const start = o + 8;
        const end = Math.min(bytes.length, start + size);
        o = start + size;
        if (id !== "MTrk") continue;
        tracks++;
        const pos = { o: start };
        let tick = 0;
        let running = 0;
        while (pos.o < end) {
            tick += readVarLen(bytes, pos, end);
            if (pos.o >= end) break;
            let status = bytes[pos.o]!;
            if (status & 0x80) pos.o++;
            else status = running;
            if (status === 0xff) {
                running = 0;
                const type = bytes[pos.o++]!;
                const len = readVarLen(bytes, pos, end);
                const d = pos.o;
                if (type === 0x51 && len >= 3) {
                    const us = (bytes[d]! << 16) | (bytes[d + 1]! << 8) | bytes[d + 2]!;
                    if (us > 0) raw.push({ tick, order: order++, message: 0, sysex: null, tempo: us });
                }
                pos.o = d + len;
                if (type === 0x2f) {
                    raw.push({ tick, order: order++, message: -1, sysex: null, tempo: 0 });
                    break;
                }
                continue;
            }
            if (status === 0xf0 || status === 0xf7) {
                running = 0;
                const len = readVarLen(bytes, pos, end);
                const body = bytes.subarray(pos.o, Math.min(end, pos.o + len));
                pos.o += len;
                const sysex = new Uint8Array(status === 0xf0 ? body.length + 1 : body.length);
                if (status === 0xf0) { sysex[0] = 0xf0; sysex.set(body, 1); } else sysex.set(body);
                raw.push({ tick, order: order++, message: 0, sysex, tempo: 0 });
                continue;
            }
            if (status < 0x80) break;
            running = status;
            const kind = status & 0xf0;
            const b1 = bytes[pos.o++] ?? 0;
            const b2 = kind === 0xc0 || kind === 0xd0 ? 0 : (bytes[pos.o++] ?? 0);
            raw.push({ tick, order: order++, message: status | (b1 << 8) | (b2 << 16), sysex: null, tempo: 0 });
        }
    }
    raw.sort((a, b) => a.tick - b.tick || a.order - b.order);

    const events: SmfEvent[] = [];
    let usPerQuarter = 500000;
    let lastTick = 0;
    let ms = 0;
    for (const e of raw) {
        const delta = e.tick - lastTick;
        ms += smpte ? (delta * 1000) / ticksPerSecond : (delta * usPerQuarter) / ppq / 1000;
        lastTick = e.tick;
        if (e.tempo) { usPerQuarter = e.tempo; continue; }
        if (e.message < 0) continue;
        events.push({ ms, message: e.message, sysex: e.sysex });
    }
    return { events, lengthMs: Math.ceil(ms), tracks };
}
