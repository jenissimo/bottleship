import type { Band, BandInstrument } from "@bottleship/formats/dmusic/band";
import { DMUS_IO_INST_PATCH } from "@bottleship/formats/dmusic/band";
import { F_INSTRUMENT_DRUMS } from "@bottleship/formats/dmusic/dls";
import type { ObjectReference } from "@bottleship/formats/dmusic/reference";
import {
    CLSID_DirectMusicBandTrack, CLSID_DirectMusicSeqTrack, CLSID_DirectMusicTempoTrack, CLSID_DirectMusicTimeSigTrack,
    type BandItem, type Segment, type SeqItem, type TempoItem, type TimeSigItem,
} from "@bottleship/formats/dmusic/segment";

const PPQ = 768;
const DRUM_CHANNEL = 9;

export function isStandardMidiFile(bytes: Uint8Array): boolean {
    return bytes.length >= 14 && bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64;
}

function readVarLen(bytes: Uint8Array, pos: { o: number }, end: number): number {
    let value = 0;
    for (let i = 0; i < 4 && pos.o < end; i++) {
        const b = bytes[pos.o++]!;
        value = (value << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) break;
    }
    return value >>> 0;
}

function bandAt(time: number, instruments: BandInstrument[], name: string): BandItem {
    const band: Band = {
        identity: { objectId: "", name, versionMS: 0, versionLS: 0, hasVersion: false },
        instruments,
    };
    return { time, band };
}

function instrument(channel: number, patch: number, collection: ObjectReference): BandInstrument {
    return {
        patch, assignPatch: 0, noteRanges: [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff],
        pChannel: channel, flags: DMUS_IO_INST_PATCH, pan: 64, volume: 100, transpose: 0,
        channelPriority: 0, pitchBendRange: 2, collection,
    };
}

export function smfToSegment(bytes: Uint8Array, name: string, gm: ObjectReference): Segment | null {
    if (!isStandardMidiFile(bytes)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLen = view.getUint32(4, false);
    const ntrks = view.getUint16(10, false);
    let division = view.getUint16(12, false);
    if (division & 0x8000 || division === 0) division = 480;
    const scale = (t: number): number => Math.round(t * PPQ / division);

    const tempos: TempoItem[] = [];
    const sigs: TimeSigItem[] = [];
    const events: SeqItem[] = [];
    const programs: Array<{ time: number; channel: number; patch: number }> = [];
    const usedChannels = new Set<number>();
    let length = 0;

    let o = 8 + headerLen;
    for (let track = 0; track < ntrks && o + 8 <= bytes.length; track++) {
        const id = String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
        const size = view.getUint32(o + 4, false);
        const start = o + 8;
        const end = Math.min(bytes.length, start + size);
        o = start + size;
        if (id !== "MTrk") continue;
        const pos = { o: start };
        let tick = 0;
        let running = 0;
        const open = new Map<number, Array<{ time: number; velocity: number }>>();
        const bankMsb = new Array(16).fill(0);
        const bankLsb = new Array(16).fill(0);
        while (pos.o < end) {
            tick += readVarLen(bytes, pos, end);
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
                    if (us > 0) tempos.push({ time: scale(tick), tempo: 60000000 / us });
                } else if (type === 0x58 && len >= 2) {
                    sigs.push({ time: scale(tick), timeSig: { beatsPerMeasure: bytes[d]!, beat: 1 << bytes[d + 1]!, gridsPerBeat: 4 } });
                }
                pos.o = d + len;
                if (type === 0x2f) break;
                continue;
            }
            if (status === 0xf0 || status === 0xf7) {
                running = 0;
                pos.o += readVarLen(bytes, pos, end);
                continue;
            }
            running = status;
            const kind = status & 0xf0;
            const channel = status & 0x0f;
            const b1 = bytes[pos.o++] ?? 0;
            const b2 = kind === 0xc0 || kind === 0xd0 ? 0 : (bytes[pos.o++] ?? 0);
            const time = scale(tick);
            length = Math.max(length, time);
            const noteKey = channel * 128 + b1;
            if (kind === 0x90 && b2 > 0) {
                const stack = open.get(noteKey) ?? [];
                stack.push({ time, velocity: b2 });
                open.set(noteKey, stack);
                usedChannels.add(channel);
            } else if (kind === 0x80 || (kind === 0x90 && b2 === 0)) {
                const on = open.get(noteKey)?.shift();
                if (on) {
                    events.push({ time: on.time, duration: Math.max(1, time - on.time), pChannel: channel, offset: 0,
                        status: 0x90 | channel, byte1: b1, byte2: on.velocity });
                }
            } else if (kind === 0xb0) {
                if (b1 === 0) bankMsb[channel] = b2;
                else if (b1 === 32) bankLsb[channel] = b2;
                else events.push({ time, duration: 0, pChannel: channel, offset: 0, status, byte1: b1, byte2: b2 });
            } else if (kind === 0xc0) {
                const msb = bankMsb[channel];
                const drums = channel === DRUM_CHANNEL || msb === 120 ? F_INSTRUMENT_DRUMS : 0;
                const melodicMsb = msb === 121 ? 0 : msb;
                const patch = drums ? (b1 & 0x7f) | drums : (b1 & 0x7f) | (bankLsb[channel] << 8) | (melodicMsb << 16);
                programs.push({ time, channel, patch });
            } else if (kind === 0xe0) {
                events.push({ time, duration: 0, pChannel: channel, offset: 0, status, byte1: b1, byte2: b2 });
            }
        }
        for (const [key, stack] of open) {
            for (const on of stack) {
                events.push({ time: on.time, duration: Math.max(1, length - on.time), pChannel: key >> 7, offset: 0,
                    status: 0x90 | (key >> 7), byte1: key & 0x7f, byte2: on.velocity });
            }
        }
    }

    for (const e of events) length = Math.max(length, e.time + e.duration);
    events.sort((a, b) => a.time - b.time);
    tempos.sort((a, b) => a.time - b.time);
    if (tempos.length === 0 || tempos[0]!.time > 0) tempos.unshift({ time: 0, tempo: 120 });
    if (sigs.length === 0) sigs.push({ time: 0, timeSig: { beatsPerMeasure: 4, beat: 4, gridsPerBeat: 4 } });

    const initial = new Map<number, number>();
    for (const ch of usedChannels) initial.set(ch, ch === DRUM_CHANNEL ? F_INSTRUMENT_DRUMS : 0);
    const bands: BandItem[] = [];
    const byTime = new Map<number, Map<number, number>>();
    for (const p of programs) {
        if (p.time === 0) { initial.set(p.channel, p.patch); continue; }
        const slot = byTime.get(p.time) ?? new Map<number, number>();
        slot.set(p.channel, p.patch);
        byTime.set(p.time, slot);
    }
    bands.push(bandAt(0, [...initial].map(([ch, patch]) => instrument(ch, patch, gm)), name));
    for (const [time, slot] of [...byTime].sort((a, b) => a[0] - b[0])) {
        bands.push(bandAt(time, [...slot].map(([ch, patch]) => instrument(ch, patch, gm)), name));
    }

    const base = { group: 1, position: 0 };
    return {
        identity: { objectId: "", name, versionMS: 0, versionLS: 0, hasVersion: false },
        header: { repeats: 0, length: Math.max(1, length), playStart: 0, loopStart: 0, loopEnd: 0, resolution: 0 },
        tracks: [
            { ...base, classId: CLSID_DirectMusicTempoTrack, kind: "tempo", items: tempos },
            { ...base, classId: CLSID_DirectMusicTimeSigTrack, kind: "timesig", items: sigs },
            { ...base, classId: CLSID_DirectMusicBandTrack, kind: "band", items: bands },
            { ...base, classId: CLSID_DirectMusicSeqTrack, kind: "seq", events, curves: [] },
        ],
    };
}
