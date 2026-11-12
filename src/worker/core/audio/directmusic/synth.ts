/**
 * A DLS level 1 wavetable synthesizer — the software synth a DirectMusic port renders
 * with. Channels carry an instrument from a DLS collection plus the usual MIDI
 * controllers; each sounding note is a voice that plays one region's wave through that
 * region's articulation (volume envelope, pitch envelope, LFO) into a stereo float mix.
 */
import {
    CONN_DST_ATTENUATION, CONN_DST_EG1_ATTACKTIME, CONN_DST_EG1_DECAYTIME, CONN_DST_EG1_RELEASETIME,
    CONN_DST_EG1_SUSTAINLEVEL, CONN_DST_EG2_ATTACKTIME, CONN_DST_EG2_DECAYTIME, CONN_DST_EG2_RELEASETIME,
    CONN_DST_EG2_SUSTAINLEVEL, CONN_DST_LFO_FREQUENCY, CONN_DST_LFO_STARTDELAY, CONN_DST_PAN, CONN_DST_PITCH,
    CONN_SRC_CC1, CONN_SRC_EG2, CONN_SRC_KEYNUMBER, CONN_SRC_KEYONVELOCITY, CONN_SRC_LFO, CONN_SRC_NONE,
    F_INSTRUMENT_DRUMS, F_RGN_OPTION_SELFNONEXCLUSIVE,
    type DlsCollection, type DlsConnection, type DlsInstrument, type DlsRegion, type DlsWave,
} from "@bottleship/formats/dmusic/dls";

/** Frames between envelope/LFO updates; gains ramp linearly across one. */
const CONTROL_BLOCK = 32;
/** Depth of an envelope's decay and release, in decibels (DLS level 1). */
const ENVELOPE_RANGE_DB = 96;
/** Release applied to a voice cut short by its key group or a retrigger. */
const CUT_RELEASE_SECONDS = 0.008;
const TIME_ZERO = -0x80000000;
/**
 * Voices are summed with no limiter, and a wave at full velocity on a full-volume channel
 * is already full scale: this is the headroom that keeps an arrangement of a few dozen of
 * them inside the 16-bit output.
 */
const MIX_HEADROOM = 0.5;

interface Articulation {
    eg1Attack: number; eg1Decay: number; eg1Sustain: number; eg1Release: number;
    /** Time cents added to the attack per unit of velocity (0..1). */
    eg1VelToAttack: number;
    eg1KeyToDecay: number;
    eg2Attack: number; eg2Decay: number; eg2Sustain: number; eg2Release: number;
    eg2KeyToDecay: number;
    /** Cents at full envelope. */
    eg2ToPitch: number;
    lfoFrequency: number; lfoDelay: number;
    lfoToPitch: number; lfoToGainDb: number;
    /** Extra vibrato depth in cents at full modulation wheel. */
    modWheelToPitch: number;
    /** -0.5 (left) .. 0.5 (right), added to the channel's pan. */
    pan: number;
}

interface PreparedRegion {
    region: DlsRegion;
    samples: Float32Array;
    sampleRate: number;
    unityNote: number;
    fineTune: number;
    gain: number;
    /** Loop span in frames; loopEnd is exclusive and 0 means "plays once". */
    loopStart: number;
    loopEnd: number;
    articulation: Articulation;
}

interface PreparedInstrument {
    drums: boolean;
    regions: PreparedRegion[];
}

function timeCentsToSeconds(scale: number): number {
    if (scale === TIME_ZERO) return 0;
    return Math.pow(2, scale / 65536 / 1200);
}

function buildArticulation(connections: DlsConnection[]): Articulation {
    const art: Articulation = {
        eg1Attack: 0, eg1Decay: 0, eg1Sustain: 1, eg1Release: 0, eg1VelToAttack: 0, eg1KeyToDecay: 0,
        eg2Attack: 0, eg2Decay: 0, eg2Sustain: 1, eg2Release: 0, eg2KeyToDecay: 0, eg2ToPitch: 0,
        lfoFrequency: 5, lfoDelay: 0.01, lfoToPitch: 0, lfoToGainDb: 0, modWheelToPitch: 0, pan: 0,
    };
    for (const c of connections) {
        const value = c.scale / 65536;
        if (c.source === CONN_SRC_NONE) {
            switch (c.destination) {
                case CONN_DST_EG1_ATTACKTIME: art.eg1Attack = timeCentsToSeconds(c.scale); break;
                case CONN_DST_EG1_DECAYTIME: art.eg1Decay = timeCentsToSeconds(c.scale); break;
                case CONN_DST_EG1_RELEASETIME: art.eg1Release = timeCentsToSeconds(c.scale); break;
                case CONN_DST_EG1_SUSTAINLEVEL: art.eg1Sustain = Math.min(1, Math.max(0, value / 1000)); break;
                case CONN_DST_EG2_ATTACKTIME: art.eg2Attack = timeCentsToSeconds(c.scale); break;
                case CONN_DST_EG2_DECAYTIME: art.eg2Decay = timeCentsToSeconds(c.scale); break;
                case CONN_DST_EG2_RELEASETIME: art.eg2Release = timeCentsToSeconds(c.scale); break;
                case CONN_DST_EG2_SUSTAINLEVEL: art.eg2Sustain = Math.min(1, Math.max(0, value / 1000)); break;
                case CONN_DST_LFO_FREQUENCY: art.lfoFrequency = 8.176 * Math.pow(2, value / 1200); break;
                case CONN_DST_LFO_STARTDELAY: art.lfoDelay = timeCentsToSeconds(c.scale); break;
                case CONN_DST_PAN: art.pan = Math.min(0.5, Math.max(-0.5, value / 1000)); break;
            }
        } else if (c.source === CONN_SRC_LFO && c.destination === CONN_DST_PITCH) {
            if (c.control === CONN_SRC_CC1) art.modWheelToPitch = value;
            else art.lfoToPitch = value;
        } else if (c.source === CONN_SRC_LFO && c.destination === CONN_DST_ATTENUATION) {
            art.lfoToGainDb = value / 10;
        } else if (c.source === CONN_SRC_EG2 && c.destination === CONN_DST_PITCH) {
            art.eg2ToPitch = value;
        } else if (c.source === CONN_SRC_KEYONVELOCITY && c.destination === CONN_DST_EG1_ATTACKTIME) {
            art.eg1VelToAttack = value;
        } else if (c.source === CONN_SRC_KEYNUMBER && c.destination === CONN_DST_EG1_DECAYTIME) {
            art.eg1KeyToDecay = value;
        } else if (c.source === CONN_SRC_KEYNUMBER && c.destination === CONN_DST_EG2_DECAYTIME) {
            art.eg2KeyToDecay = value;
        }
    }
    return art;
}

const decodedWaves = new WeakMap<DlsWave, Float32Array>();

/** A wave's first channel as floats; 8-bit PCM is unsigned, 16-bit signed. */
function decodeWave(wave: DlsWave): Float32Array {
    let samples = decodedWaves.get(wave);
    if (samples) return samples;
    const channels = Math.max(1, wave.channels);
    const data = wave.data;
    if (wave.formatTag !== 1) {
        samples = new Float32Array(0);
    } else if (wave.bitsPerSample === 8) {
        samples = new Float32Array(Math.floor(data.length / channels));
        for (let i = 0; i < samples.length; i++) samples[i] = (data[i * channels]! - 128) / 128;
    } else {
        const frameBytes = channels * 2;
        samples = new Float32Array(Math.floor(data.length / frameBytes));
        for (let i = 0, o = 0; i < samples.length; i++, o += frameBytes) {
            const s = data[o]! | (data[o + 1]! << 8);
            samples[i] = (s >= 0x8000 ? s - 0x10000 : s) / 32768;
        }
    }
    decodedWaves.set(wave, samples);
    return samples;
}

const preparedInstruments = new WeakMap<DlsInstrument, PreparedInstrument>();

export type WaveDecoder = (collection: DlsCollection, inst: DlsInstrument, progress: () => void) => Promise<void>;

// @transient(installed once per worker by the bank loader; holds no session data)
let waveDecoder: WaveDecoder | null = null;

export function setWaveDecoder(decoder: WaveDecoder | null): void {
    waveDecoder = decoder;
}

function hasUndecodedWaves(collection: DlsCollection, inst: DlsInstrument): boolean {
    return inst.regions.some((r) => {
        const wave = collection.waves[r.waveIndex];
        return wave !== null && wave !== undefined && wave.formatTag !== 1;
    });
}

function prepareInstrument(collection: DlsCollection, inst: DlsInstrument): PreparedInstrument {
    let prepared = preparedInstruments.get(inst);
    if (prepared) return prepared;
    prepared = { drums: (inst.bank & F_INSTRUMENT_DRUMS) !== 0, regions: [] };
    const shared = buildArticulation(inst.articulation);
    for (const region of inst.regions) {
        const wave = collection.waves[region.waveIndex];
        if (!wave) continue;
        const samples = decodeWave(wave);
        const sample = region.sample ?? wave.sample;
        if (samples.length === 0) continue;
        let loopStart = 0;
        let loopEnd = 0;
        if (sample?.loop && sample.loop.length > 0) {
            loopStart = Math.min(sample.loop.start, samples.length - 1);
            loopEnd = Math.min(sample.loop.start + sample.loop.length, samples.length);
            if (loopEnd <= loopStart) loopEnd = 0;
        }
        prepared.regions.push({
            region, samples,
            sampleRate: wave.sampleRate,
            unityNote: sample?.unityNote ?? 60,
            fineTune: sample?.fineTune ?? 0,
            gain: Math.pow(10, (sample?.attenuation ?? 0) / 655360 / 20),
            loopStart, loopEnd,
            articulation: region.articulation.length > 0 ? buildArticulation(region.articulation) : shared,
        });
    }
    preparedInstruments.set(inst, prepared);
    return prepared;
}

/** The instrument in `collection` a band patch (program, bank LSB/MSB, drum bit) selects. */
export function findInstrument(collection: DlsCollection, patch: number): DlsInstrument | null {
    const program = patch & 0x7f;
    const bankLsb = (patch >>> 8) & 0x7f;
    const bankMsb = (patch >>> 16) & 0x7f;
    const drums = (patch & F_INSTRUMENT_DRUMS) !== 0;
    for (const inst of collection.instruments) {
        if ((inst.program & 0x7f) !== program) continue;
        if ((inst.bank & 0x7f) !== bankLsb || ((inst.bank >>> 8) & 0x7f) !== bankMsb) continue;
        if (((inst.bank & F_INSTRUMENT_DRUMS) !== 0) !== drums) continue;
        return inst;
    }
    if (bankLsb !== 0 || bankMsb !== 0) return findInstrument(collection, (patch & 0x7f) | (patch & F_INSTRUMENT_DRUMS));
    if (drums && program !== 0) return findInstrument(collection, F_INSTRUMENT_DRUMS);
    return null;
}

class Channel {
    instrument: PreparedInstrument | null = null;
    collection: DlsCollection | null = null;
    patch = 0;
    pendingDecode: object | null = null;
    volume = 100;
    expression = 127;
    pan = 64;
    modWheel = 0;
    sustain = false;
    /** -1..1. */
    pitchBend = 0;
    bendRangeCents = 200;
    rpn = 0x3fff;
    /** Linear gain from volume and expression, and pan as 0 (left) .. 1 (right). */
    gain = 0;
    panPosition = 0.5;

    constructor() { this.update(); }

    update(): void {
        const volume = this.volume / 127;
        const expression = this.expression / 127;
        this.gain = volume * volume * expression * expression;
        // 64 is the centre of a 0..127 controller, so the two halves scale differently.
        this.panPosition = 0.5 + (this.pan - 64) / (this.pan < 64 ? 128 : 126);
    }
}

const enum Stage { Attack, Decay, Sustain, Release, Off }

class Voice {
    active = false;
    channelId = 0;
    channel!: Channel;
    key = 0;
    region!: PreparedRegion;
    collection: DlsCollection | null = null;
    patch = 0;
    position = 0;
    /** Playback rate before pitch modulation, in source frames per output frame. */
    baseStep = 0;
    velocityGain = 0;
    age = 0;
    held = false;
    releasePending = false;

    stage: Stage = Stage.Off;
    /** Attack progress 0..1, then attenuation in dB once past it. */
    attackLevel = 0;
    attenuationDb = 0;
    attackRate = 0;
    decayRate = 0;
    sustainDb = 0;
    releaseRate = 0;

    eg2Stage: Stage = Stage.Off;
    eg2Level = 0;
    eg2AttackRate = 0;
    eg2DecayRate = 0;
    eg2ReleaseRate = 0;

    lfoPhase = 0;
    lfoDelayFrames = 0;
    gainLeft = 0;
    gainRight = 0;
    started = false;
}

const CHANNEL_VALUES = ["volume", "expression", "pan", "modWheel", "pitchBend", "bendRangeCents", "rpn"] as const;
const VOICE_VALUES = [
    "channelId", "key", "patch", "position", "baseStep", "velocityGain", "age", "stage", "attackLevel", "attenuationDb", "attackRate",
    "decayRate", "sustainDb", "releaseRate", "eg2Stage", "eg2Level", "eg2AttackRate", "eg2DecayRate", "eg2ReleaseRate", "lfoPhase",
    "lfoDelayFrames", "gainLeft", "gainRight",
] as const;
const VOICE_FLAGS = ["held", "releasePending", "started"] as const;

export const SYNTH_STATE_KEYS = {
    channel: ["id", "collection", "patch", "sustain", ...CHANNEL_VALUES],
    voice: ["slot", "collection", "region", ...VOICE_FLAGS, ...VOICE_VALUES],
} as const;

export interface SynthData {
    masterGain: number;
    noteCounter: number;
    stats: [notes: number, noInstrument: number, noRegion: number];
    channels: Array<{ id: number; collection: number; patch: number; sustain: boolean; values: number[] }>;
    voices: Array<{ slot: number; collection: number; region: number; flags: boolean[]; values: number[] }>;
}

export class DlsSynth {
    readonly sampleRate: number;
    private readonly voices: Voice[] = [];
    private readonly channels = new Map<number, Channel>();
    private masterGain = 1;
    private noteCounter = 0;
    /** Note-ons since creation: sounded, on a channel with no instrument, outside every region. */
    readonly stats = { notes: 0, noInstrument: 0, noRegion: 0 };

    constructor(sampleRate: number, maxVoices: number) {
        this.sampleRate = sampleRate;
        for (let i = 0; i < Math.max(1, maxVoices); i++) this.voices.push(new Voice());
    }

    captureState(collectionRef: (collection: DlsCollection | null) => number): SynthData {
        const voices: SynthData["voices"] = [];
        this.voices.forEach((v, slot) => {
            const inst = v.active && v.collection ? findInstrument(v.collection, v.patch) : null;
            const region = inst ? inst.regions.indexOf(v.region.region) : -1;
            if (region < 0) return;
            voices.push({
                slot, collection: collectionRef(v.collection), region,
                flags: VOICE_FLAGS.map((key) => v[key]), values: VOICE_VALUES.map((key) => v[key]),
            });
        });
        return {
            masterGain: this.masterGain, noteCounter: this.noteCounter,
            stats: [this.stats.notes, this.stats.noInstrument, this.stats.noRegion],
            channels: [...this.channels].map(([id, ch]) => ({
                id, collection: collectionRef(ch.collection), patch: ch.patch, sustain: ch.sustain, values: CHANNEL_VALUES.map((key) => ch[key]),
            })),
            voices,
        };
    }

    restoreState(d: SynthData, collectionOf: (ref: number) => DlsCollection | null): number {
        this.masterGain = d.masterGain;
        this.noteCounter = d.noteCounter;
        [this.stats.notes, this.stats.noInstrument, this.stats.noRegion] = d.stats;
        this.channels.clear();
        for (const saved of d.channels) {
            const ch = this.channel(saved.id);
            this.setInstrument(saved.id, collectionOf(saved.collection), saved.patch);
            ch.sustain = saved.sustain;
            CHANNEL_VALUES.forEach((key, i) => { ch[key] = saved.values[i]!; });
            ch.update();
        }
        for (const v of this.voices) v.active = false;
        let dropped = 0;
        for (const saved of d.voices) {
            const v = this.voices[saved.slot];
            const collection = collectionOf(saved.collection);
            const patch = saved.values[VOICE_VALUES.indexOf("patch")]!;
            const inst = collection ? findInstrument(collection, patch) : null;
            const wanted = inst?.regions[saved.region];
            const region = collection && inst && wanted ? prepareInstrument(collection, inst).regions.find((r) => r.region === wanted) : undefined;
            if (!v || !region) {
                dropped++;
                continue;
            }
            VOICE_VALUES.forEach((key, i) => { v[key] = saved.values[i]!; });
            VOICE_FLAGS.forEach((key, i) => { v[key] = saved.flags[i]!; });
            v.channel = this.channel(v.channelId);
            v.collection = collection;
            v.region = region;
            v.active = true;
        }
        return dropped;
    }

    /** Master volume in hundredths of a decibel, as GUID_PerfMasterVolume gives it. */
    setMasterVolume(hundredthsDb: number): void {
        this.masterGain = Math.pow(10, hundredthsDb / 2000);
    }

    get activeVoiceCount(): number {
        let n = 0;
        for (const v of this.voices) if (v.active) n++;
        return n;
    }

    private channel(id: number): Channel {
        let ch = this.channels.get(id);
        if (!ch) {
            ch = new Channel();
            this.channels.set(id, ch);
        }
        return ch;
    }

    /** Install the instrument a band patch names; an unknown patch leaves the channel silent. */
    setInstrument(channelId: number, collection: DlsCollection | null, patch: number): boolean {
        const ch = this.channel(channelId);
        const inst = collection ? findInstrument(collection, patch) : null;
        ch.collection = collection;
        ch.patch = patch;
        ch.pendingDecode = null;
        if (inst && collection && waveDecoder && hasUndecodedWaves(collection, inst)) {
            const token = {};
            ch.pendingDecode = token;
            const refresh = (): void => {
                preparedInstruments.delete(inst);
                if (ch.pendingDecode === token) ch.instrument = prepareInstrument(collection, inst);
            };
            void waveDecoder(collection, inst, refresh).then(() => {
                refresh();
                if (ch.pendingDecode === token) ch.pendingDecode = null;
            });
        }
        ch.instrument = inst && collection ? prepareInstrument(collection, inst) : null;
        return ch.instrument !== null;
    }

    controlChange(channelId: number, controller: number, value: number): void {
        const ch = this.channel(channelId);
        switch (controller) {
            case 1: ch.modWheel = value; break;
            case 7: ch.volume = value; ch.update(); break;
            case 10: ch.pan = value; ch.update(); break;
            case 11: ch.expression = value; ch.update(); break;
            case 64:
                ch.sustain = value >= 64;
                if (!ch.sustain) {
                    for (const v of this.voices) {
                        if (v.active && v.channel === ch && v.releasePending) this.release(v);
                    }
                }
                break;
            case 100: ch.rpn = (ch.rpn & 0x3f80) | value; break;
            case 101: ch.rpn = (ch.rpn & 0x7f) | (value << 7); break;
            case 6: if (ch.rpn === 0) ch.bendRangeCents = value * 100 + (ch.bendRangeCents % 100); break;
            case 38: if (ch.rpn === 0) ch.bendRangeCents = Math.floor(ch.bendRangeCents / 100) * 100 + value; break;
            case 120: this.silence(channelId); break;
            case 121:
                ch.modWheel = 0; ch.expression = 127; ch.pitchBend = 0; ch.sustain = false; ch.update();
                break;
            case 123: this.allNotesOff(channelId); break;
        }
    }

    /** `value` is the 14-bit wheel position, 0x2000 at rest. */
    pitchBend(channelId: number, value: number): void {
        this.channel(channelId).pitchBend = (value - 0x2000) / 0x2000;
    }

    noteOn(channelId: number, key: number, velocity: number): void {
        if (velocity <= 0) { this.noteOff(channelId, key); return; }
        const ch = this.channel(channelId);
        const inst = ch.instrument;
        if (!inst) { this.stats.noInstrument++; return; }
        const matches = inst.regions.filter((r) => key >= r.region.keyLow && key <= r.region.keyHigh
            && (r.region.velocityHigh === 0 || (velocity >= r.region.velocityLow && velocity <= r.region.velocityHigh)));
        if (matches.length === 0) { this.stats.noRegion++; return; }
        this.stats.notes++;
        for (const region of matches) this.cutExclusive(ch, key, region);
        for (const region of matches) this.startVoice(channelId, ch, key, velocity, region);
    }

    private cutExclusive(ch: Channel, key: number, region: PreparedRegion): void {
        // A key group is exclusive (an open hi-hat is cut by the closed one), and unless the
        // region says otherwise so is a second strike of the same key.
        const group = region.region.keyGroup;
        const selfExclusive = !(region.region.options & F_RGN_OPTION_SELFNONEXCLUSIVE);
        for (const v of this.voices) {
            if (!v.active || v.channel !== ch || v.stage === Stage.Off) continue;
            if ((group !== 0 && v.region.region.keyGroup === group) || (selfExclusive && v.key === key)) this.cut(v);
        }
    }

    private startVoice(channelId: number, ch: Channel, key: number, velocity: number, region: PreparedRegion): void {
        const voice = this.allocateVoice();
        const art = region.articulation;
        const rate = this.sampleRate;
        voice.active = true;
        voice.channelId = channelId;
        voice.channel = ch;
        voice.key = key;
        voice.region = region;
        voice.collection = ch.collection;
        voice.patch = ch.patch;
        voice.position = 0;
        voice.baseStep = (region.sampleRate / rate)
            * Math.pow(2, ((key - region.unityNote) * 100 + region.fineTune) / 1200);
        const v01 = velocity / 127;
        voice.velocityGain = v01 * v01 * region.gain * MIX_HEADROOM;
        voice.age = ++this.noteCounter;
        voice.held = true;
        voice.releasePending = false;
        voice.started = false;

        const attack = art.eg1Attack * Math.pow(2, (art.eg1VelToAttack * v01) / 1200);
        const decay = art.eg1Decay * Math.pow(2, (art.eg1KeyToDecay * (key / 128)) / 1200);
        voice.stage = attack > 0 ? Stage.Attack : Stage.Decay;
        voice.attackLevel = attack > 0 ? 0 : 1;
        voice.attenuationDb = 0;
        voice.attackRate = attack > 0 ? 1 / (attack * rate) : 0;
        voice.decayRate = decay > 0 ? ENVELOPE_RANGE_DB / (decay * rate) : Infinity;
        voice.sustainDb = ENVELOPE_RANGE_DB * (1 - art.eg1Sustain);
        voice.releaseRate = art.eg1Release > 0 ? ENVELOPE_RANGE_DB / (art.eg1Release * rate) : Infinity;

        const decay2 = art.eg2Decay * Math.pow(2, (art.eg2KeyToDecay * (key / 128)) / 1200);
        voice.eg2Stage = art.eg2Attack > 0 ? Stage.Attack : Stage.Decay;
        voice.eg2Level = art.eg2Attack > 0 ? 0 : 1;
        voice.eg2AttackRate = art.eg2Attack > 0 ? 1 / (art.eg2Attack * rate) : 0;
        voice.eg2DecayRate = decay2 > 0 ? 1 / (decay2 * rate) : Infinity;
        voice.eg2ReleaseRate = art.eg2Release > 0 ? 1 / (art.eg2Release * rate) : Infinity;

        voice.lfoPhase = 0;
        voice.lfoDelayFrames = art.lfoDelay * rate;
    }

    noteOff(channelId: number, key: number): void {
        const ch = this.channels.get(channelId);
        if (!ch) return;
        for (const v of this.voices) {
            if (!v.active || v.channel !== ch || v.key !== key || !v.held) continue;
            v.held = false;
            if (ch.sustain) v.releasePending = true;
            else this.release(v);
        }
    }

    /** Release every held note; omit the channel for all of them. */
    allNotesOff(channelId?: number): void {
        for (const v of this.voices) {
            if (!v.active || (channelId !== undefined && v.channelId !== channelId)) continue;
            v.held = false;
            this.release(v);
        }
    }

    /** Stop sounding at once, without release tails. */
    silence(channelId?: number): void {
        for (const v of this.voices) {
            if (v.active && (channelId === undefined || v.channelId === channelId)) this.cut(v);
        }
    }

    private release(v: Voice): void {
        v.releasePending = false;
        if (v.stage === Stage.Release || v.stage === Stage.Off) return;
        if (v.stage === Stage.Attack) {
            // The release starts from wherever the attack got to, expressed as attenuation.
            v.attenuationDb = v.attackLevel > 0 ? Math.min(ENVELOPE_RANGE_DB, -20 * Math.log10(v.attackLevel)) : ENVELOPE_RANGE_DB;
        }
        v.stage = Stage.Release;
        if (v.eg2Stage !== Stage.Off) v.eg2Stage = Stage.Release;
    }

    private cut(v: Voice): void {
        this.release(v);
        v.held = false;
        v.releaseRate = Math.max(v.releaseRate, ENVELOPE_RANGE_DB / (CUT_RELEASE_SECONDS * this.sampleRate));
    }

    /** A free voice, else the quietest candidate: the oldest released one, then the oldest. */
    private allocateVoice(): Voice {
        let steal: Voice | null = null;
        for (const v of this.voices) {
            if (!v.active) return v;
            if (!steal) { steal = v; continue; }
            const vReleased = v.stage === Stage.Release;
            const sReleased = steal.stage === Stage.Release;
            if (vReleased !== sReleased) { if (vReleased) steal = v; continue; }
            if (v.age < steal.age) steal = v;
        }
        return steal!;
    }

    /** Advance a voice's envelopes by `frames` and return its envelope gain. */
    private advanceEnvelope(v: Voice, frames: number): number {
        let gain: number;
        switch (v.stage) {
            case Stage.Attack:
                v.attackLevel += v.attackRate * frames;
                if (v.attackLevel >= 1) { v.attackLevel = 1; v.stage = Stage.Decay; }
                gain = v.attackLevel;
                break;
            case Stage.Decay:
                v.attenuationDb += v.decayRate * frames;
                if (!(v.attenuationDb < v.sustainDb)) { v.attenuationDb = v.sustainDb; v.stage = Stage.Sustain; }
                gain = Math.pow(10, -v.attenuationDb / 20);
                break;
            case Stage.Sustain:
                gain = Math.pow(10, -v.attenuationDb / 20);
                break;
            case Stage.Release:
                v.attenuationDb += v.releaseRate * frames;
                gain = Math.pow(10, -v.attenuationDb / 20);
                break;
            default:
                gain = 0;
        }
        if (v.attenuationDb >= ENVELOPE_RANGE_DB) { v.stage = Stage.Off; gain = 0; }

        switch (v.eg2Stage) {
            case Stage.Attack:
                v.eg2Level += v.eg2AttackRate * frames;
                if (v.eg2Level >= 1) { v.eg2Level = 1; v.eg2Stage = Stage.Decay; }
                break;
            case Stage.Decay: {
                const sustain = v.region.articulation.eg2Sustain;
                v.eg2Level -= v.eg2DecayRate * frames;
                if (!(v.eg2Level > sustain)) { v.eg2Level = sustain; v.eg2Stage = Stage.Sustain; }
                break;
            }
            case Stage.Release:
                v.eg2Level -= v.eg2ReleaseRate * frames;
                if (!(v.eg2Level > 0)) { v.eg2Level = 0; v.eg2Stage = Stage.Off; }
                break;
        }
        return gain;
    }

    /** Mix `count` frames into `left`/`right` starting at `offset`. The buffers are added to. */
    render(left: Float32Array, right: Float32Array, offset: number, count: number): void {
        const rate = this.sampleRate;
        for (const v of this.voices) {
            if (!v.active) continue;
            const region = v.region;
            const art = region.articulation;
            const samples = region.samples;
            const length = samples.length;
            const loopEnd = region.loopEnd;
            const loopLength = loopEnd - region.loopStart;
            const ch = v.channel;

            for (let done = 0; done < count && v.active;) {
                const frames = Math.min(CONTROL_BLOCK, count - done);
                const envelope = this.advanceEnvelope(v, frames);

                let lfo = 0;
                if (v.lfoDelayFrames > 0) {
                    v.lfoDelayFrames -= frames;
                } else {
                    lfo = Math.sin(v.lfoPhase * 2 * Math.PI);
                    v.lfoPhase += (art.lfoFrequency * frames) / rate;
                    v.lfoPhase -= Math.floor(v.lfoPhase);
                }
                const cents = ch.pitchBend * ch.bendRangeCents + v.eg2Level * art.eg2ToPitch
                    + lfo * (art.lfoToPitch + art.modWheelToPitch * (ch.modWheel / 127));
                const step = cents === 0 ? v.baseStep : v.baseStep * Math.pow(2, cents / 1200);

                let gain = envelope * v.velocityGain * ch.gain * this.masterGain;
                if (art.lfoToGainDb !== 0) gain *= Math.pow(10, (lfo * art.lfoToGainDb) / 20);
                const pan = Math.min(1, Math.max(0, ch.panPosition + art.pan));
                const targetLeft = gain * Math.sqrt(1 - pan);
                const targetRight = gain * Math.sqrt(pan);
                if (!v.started) {
                    v.started = true;
                    v.gainLeft = targetLeft;
                    v.gainRight = targetRight;
                }
                const stepLeft = (targetLeft - v.gainLeft) / frames;
                const stepRight = (targetRight - v.gainRight) / frames;

                let position = v.position;
                let gl = v.gainLeft;
                let gr = v.gainRight;
                const base = offset + done;
                let i = 0;
                for (; i < frames; i++) {
                    if (loopEnd > 0) {
                        if (position >= loopEnd) position -= loopLength * Math.floor((position - region.loopStart) / loopLength);
                    } else if (position >= length - 1) {
                        v.active = false;
                        break;
                    }
                    const index = position | 0;
                    const frac = position - index;
                    const a = samples[index]!;
                    const next = index + 1;
                    const b = loopEnd > 0 && next >= loopEnd ? samples[region.loopStart]! : samples[next < length ? next : index]!;
                    const s = a + (b - a) * frac;
                    left[base + i] = left[base + i]! + s * gl;
                    right[base + i] = right[base + i]! + s * gr;
                    gl += stepLeft;
                    gr += stepRight;
                    position += step;
                }
                v.position = position;
                v.gainLeft = targetLeft;
                v.gainRight = targetRight;
                done += frames;
                if (v.stage === Stage.Off) v.active = false;
            }
        }
    }
}
