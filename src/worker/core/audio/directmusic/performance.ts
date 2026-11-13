/**
 * The DirectMusic performance: music time, the primary and secondary segments playing on
 * it, and the tracks that turn a segment into notes — above all the style track, which
 * picks a pattern for the current groove level and plays its parts over the current chord.
 *
 * The performance is pulled by the synthesizer's output: each render call advances music
 * time by exactly the audio it produces, so sequencing and sound cannot drift apart.
 */
import type { Band, BandInstrument } from "@bottleship/formats/dmusic/band";
import {
    DMUS_IO_INST_PAN, DMUS_IO_INST_PATCH, DMUS_IO_INST_PITCHBENDRANGE, DMUS_IO_INST_TRANSPOSE,
    DMUS_IO_INST_VOLUME,
} from "@bottleship/formats/dmusic/band";
import type { DlsCollection } from "@bottleship/formats/dmusic/dls";
import { F_INSTRUMENT_DRUMS } from "@bottleship/formats/dmusic/dls";
import {
    DMUS_COMMANDT_BREAK, DMUS_COMMANDT_END, DMUS_COMMANDT_ENDANDINTRO, DMUS_COMMANDT_FILL,
    DMUS_COMMANDT_GROOVE, DMUS_COMMANDT_INTRO,
    type ChordItem, type CommandItem, type SeqCurve, type SeqItem, type TempoItem,
} from "@bottleship/formats/dmusic/segment";
import {
    DMUS_EMBELLISHT_BREAK, DMUS_EMBELLISHT_END, DMUS_EMBELLISHT_FILL, DMUS_EMBELLISHT_INTRO, DMUS_PPQ,
    type PartRef, type Style, type StyleCurve, type StylePart, type StylePattern, type TimeSignature,
    ticksPerBeat, ticksPerGrid, ticksPerMeasure,
} from "@bottleship/formats/dmusic/style";
import {
    type ChordContext, DEFAULT_CHORD, DMUS_PLAYMODE_NONE, musicValueToMidi, variationMatchesChord,
} from "./music-value";
import type { DlsSynth } from "./synth";
import type { WaveData } from "./wave";

export const DMUS_SEGF_REFTIME = 1 << 6;
export const DMUS_SEGF_SECONDARY = 1 << 7;
export const DMUS_SEGF_QUEUE = 1 << 8;
export const DMUS_SEGF_CONTROL = 1 << 9;
export const DMUS_SEGF_AFTERPREPARETIME = 1 << 10;
export const DMUS_SEGF_GRID = 1 << 11;
export const DMUS_SEGF_BEAT = 1 << 12;
export const DMUS_SEGF_MEASURE = 1 << 13;
export const DMUS_SEGF_DEFAULT = 1 << 14;
export const DMUS_SEGF_NOINVALIDATE = 1 << 15;

export const DMUS_COMPOSEF_IMMEDIATE = 0x4;
export const DMUS_COMPOSEF_GRID = 0x8;
export const DMUS_COMPOSEF_BEAT = 0x10;
export const DMUS_COMPOSEF_MEASURE = 0x20;

export const DMUS_NOTIFICATION_SEGSTART = 0;
export const DMUS_NOTIFICATION_SEGEND = 1;
export const DMUS_NOTIFICATION_SEGALMOSTEND = 2;
export const DMUS_NOTIFICATION_SEGLOOP = 3;
export const DMUS_NOTIFICATION_SEGABORT = 4;

const DMUS_CURVET_PBCURVE = 3;
const DMUS_CURVET_CCCURVE = 4;
const DMUS_CURVES_INSTANT = 1;
const DMUS_CURVE_RESET = 1;

const DEFAULT_TIME_SIG: TimeSignature = { beatsPerMeasure: 4, beat: 4, gridsPerBeat: 4 };
/** Frames sequenced at a time: the granularity of tempo changes and curve steps. */
const SEQUENCE_FRAMES = 128;
/** Segment positions are sums of fractional ticks; two within this are the same instant. */
const TICK_SLACK = 1e-6;

/** A band with the DLS collection of each instrument resolved (parallel to `instruments`). */
export interface LoadedBand {
    band: Band;
    collections: Array<DlsCollection | null>;
}

interface StyleRef { time: number; style: Style }
interface BandRef { time: number; band: LoadedBand }

/**
 * What an IDirectMusicSegment holds: the track data, shared by every state playing it and
 * mutable while they do (a groove level set on the segment is heard by a state in flight).
 */
export class PerfSegment {
    length = 0;
    playStart = 0;
    loopStart = 0;
    /** Zero: the loop ends where the segment does. */
    loopEnd = 0;
    repeats = 0;
    /** DMUS_SEGF_* boundary PlaySegment uses under DMUS_SEGF_DEFAULT. */
    resolution = 0;
    tempos: TempoItem[] = [];
    /** Null when the segment has no command track. */
    commands: CommandItem[] | null = null;
    styles: StyleRef[] = [];
    bands: BandRef[] = [];
    chords: ChordItem[] = [];
    chordKey = DEFAULT_CHORD.key;
    chordScale = 0;
    events: SeqItem[] = [];
    curves: SeqCurve[] = [];
    /** A motif or transition plays this one pattern instead of choosing by groove level. */
    fixedPattern: { style: Style; pattern: StylePattern } | null = null;
    wave: WaveData | null = null;

    /** The time signature the segment is counted in: its style's. */
    timeSig(): TimeSignature {
        return this.fixedPattern?.pattern.timeSig ?? this.styles[0]?.style.timeSig ?? DEFAULT_TIME_SIG;
    }

    /**
     * Set the command in force at `time`, as IDirectMusicSegment::SetParam(GUID_CommandParam)
     * does: the command on that measure is replaced, or a new one inserted.
     */
    setCommand(time: number, command: number, grooveLevel: number, grooveRange: number): boolean {
        if (!this.commands) return false;
        const sig = this.timeSig();
        const measureTicks = ticksPerMeasure(sig);
        const measure = Math.floor(time / measureTicks);
        const beat = Math.floor((time - measure * measureTicks) / ticksPerBeat(sig));
        const at = measure * measureTicks + beat * ticksPerBeat(sig);
        const existing = this.commands.find((c) => c.measure === measure && c.beat === beat);
        if (existing) {
            existing.command = command;
            existing.grooveLevel = grooveLevel;
            existing.grooveRange = grooveRange;
        } else {
            this.commands.push({ time: at, measure, beat, command, grooveLevel, grooveRange });
            this.commands.sort((a, b) => a.measure - b.measure || a.beat - b.beat);
        }
        return true;
    }

    /** A segment that plays `pattern` once per repeat — what IDirectMusicStyle::GetMotif returns. */
    static motif(style: Style, pattern: StylePattern): PerfSegment {
        const segment = new PerfSegment();
        const settings = pattern.motifSettings;
        segment.fixedPattern = { style, pattern };
        segment.length = Math.max(1, pattern.measures) * ticksPerMeasure(pattern.timeSig);
        if (settings) {
            segment.repeats = settings.repeats;
            segment.playStart = settings.playStart;
            segment.loopStart = settings.loopStart;
            segment.loopEnd = settings.loopEnd;
            segment.resolution = settings.resolution;
        }
        return segment;
    }

    static fromWave(wave: WaveData): PerfSegment {
        const segment = new PerfSegment();
        segment.wave = wave;
        segment.length = Math.max(1, Math.ceil((wave.frames / wave.rate) * (120 * DMUS_PPQ / 60)));
        return segment;
    }

    static transition(style: Style, tempo: number, command: number, grooveLevel: number): PerfSegment {
        const segment = new PerfSegment();
        segment.length = ticksPerMeasure(style.timeSig);
        segment.styles = [{ time: 0, style }];
        segment.tempos = [{ time: 0, tempo }];
        segment.commands = [{ time: 0, measure: 0, beat: 0, command, grooveLevel, grooveRange: 0 }];
        return segment;
    }

    /** A segment that installs `band` and ends — what IDirectMusicBand::CreateSegment returns. */
    static band(band: LoadedBand): PerfSegment {
        const segment = new PerfSegment();
        segment.length = 1;
        segment.bands = [{ time: 0, band }];
        return segment;
    }
}

interface PartState {
    ref: PartRef;
    part: StylePart;
    /** Variation index in play, -1 when none is eligible for the chord. */
    variation: number;
    lengthTicks: number;
    gridTicks: number;
}

/** One playing instance of a segment — what an IDirectMusicSegmentState stands for. */
export class PerfSegmentState {
    readonly segment: PerfSegment;
    readonly primary: boolean;
    /** Performance time the segment starts (or started) sounding. */
    startTime: number;
    /** Performance time of segment time zero; moves forward by a loop's length on each repeat. */
    base = 0;
    repeatsLeft: number;
    started = false;
    ended = false;
    /** A state to start, as primary, the moment this one ends. */
    queued: PerfSegmentState | null = null;
    /** Set after a start or a loop: tracks re-read what is in force at the new position. */
    fresh = true;
    /** Performance time a boundary-aligned Stop takes effect. */
    stopAt: number | undefined = undefined;

    pattern: StylePattern | null = null;
    patternStyle: Style | null = null;
    patternStart = 0;
    patternEnd = 0;
    parts: PartState[] = [];
    /** Per part: the variation last played, for parts that take them in sequence. */
    readonly sequentialVariation = new Map<string, number>();
    grooveLevel = 0;
    wavePosition = 0;
    output: object | null = null;

    constructor(segment: PerfSegment, primary: boolean, startTime: number) {
        this.segment = segment;
        this.primary = primary;
        this.startTime = startTime;
        this.repeatsLeft = segment.repeats;
    }
}

export interface PerfSegmentStateData {
    primary: boolean;
    startTime: number;
    base: number;
    repeatsLeft: number;
    started: boolean;
    ended: boolean;
    queued: number;
    fresh: boolean;
    stopAt: number | null;
    patternStyle: number;
    pattern: number;
    patternStart: number;
    patternEnd: number;
    variations: number[];
    sequentialVariation: Array<[string, number]>;
    grooveLevel: number;
    wavePosition: number;
    output: number;
}

const NONE = -1;
const FIXED = -2;

export class PerfStateError extends Error {}

function partState(ref: PartRef, part: StylePart, variation: number): PartState {
    return {
        ref, part, variation,
        lengthTicks: Math.max(1, part.measures) * ticksPerMeasure(part.timeSig),
        gridTicks: ticksPerGrid(part.timeSig),
    };
}

export function capturePerfSegmentState(
    s: PerfSegmentState, stateRef: (state: PerfSegmentState) => number, outputRef: (output: object) => number,
): PerfSegmentStateData {
    const fixed = s.segment.fixedPattern;
    const patternStyle = !s.patternStyle ? NONE : s.patternStyle === fixed?.style ? FIXED
        : s.segment.styles.findIndex((item) => item.style === s.patternStyle);
    const pattern = !s.pattern ? NONE : s.pattern === fixed?.pattern ? FIXED : s.patternStyle?.patterns.indexOf(s.pattern) ?? NONE;
    if ((s.patternStyle && patternStyle === NONE) || (s.pattern && pattern === NONE)) {
        throw new PerfStateError("directmusic: a playing pattern is not part of its segment");
    }
    return {
        primary: s.primary, startTime: s.startTime, base: s.base, repeatsLeft: s.repeatsLeft, started: s.started, ended: s.ended,
        queued: s.queued ? stateRef(s.queued) : NONE, fresh: s.fresh, stopAt: s.stopAt ?? null,
        patternStyle, pattern, patternStart: s.patternStart, patternEnd: s.patternEnd,
        variations: s.parts.map((part) => part.variation), sequentialVariation: [...s.sequentialVariation],
        grooveLevel: s.grooveLevel, wavePosition: s.wavePosition, output: s.output ? outputRef(s.output) : NONE,
    };
}

export function restorePerfSegmentState(segment: PerfSegment, d: PerfSegmentStateData): PerfSegmentState {
    const s = new PerfSegmentState(segment, d.primary, d.startTime);
    s.base = d.base;
    s.repeatsLeft = d.repeatsLeft;
    s.started = d.started;
    s.ended = d.ended;
    s.fresh = d.fresh;
    s.stopAt = d.stopAt ?? undefined;
    const fixed = segment.fixedPattern;
    const style = d.patternStyle === NONE ? null : d.patternStyle === FIXED ? fixed?.style : segment.styles[d.patternStyle]?.style;
    const pattern = d.pattern === NONE ? null : d.pattern === FIXED ? fixed?.pattern : style?.patterns[d.pattern];
    if (style === undefined || pattern === undefined) throw new Error("directmusic: a saved pattern is not part of its segment");
    s.patternStyle = style;
    s.pattern = pattern;
    s.patternStart = d.patternStart;
    s.patternEnd = d.patternEnd;
    if (style && pattern) {
        for (const ref of pattern.partRefs) {
            const part = style.parts.get(ref.partId);
            if (part) s.parts.push(partState(ref, part, d.variations[s.parts.length] ?? NONE));
        }
    }
    if (s.parts.length !== d.variations.length) throw new Error("directmusic: a saved pattern has other parts than its style");
    for (const [key, variation] of d.sequentialVariation) s.sequentialVariation.set(key, variation);
    s.grooveLevel = d.grooveLevel;
    s.wavePosition = d.wavePosition;
    return s;
}

export function linkPerfSegmentState(
    s: PerfSegmentState, d: PerfSegmentStateData, stateOf: (ref: number) => PerfSegmentState, outputOf: (ref: number) => object,
): void {
    s.queued = d.queued === NONE ? null : stateOf(d.queued);
    s.output = d.output === NONE ? null : outputOf(d.output);
}

export interface PerformanceData {
    now: number;
    tempo: number;
    masterTempo: number;
    randomState: number;
    states: number[];
    events: Array<[time: number, kind: string, channel: number, a: number, b: number, owner: number]>;
    transpose: Array<[number, number]>;
    drumChannels: number[];
    installed: Array<[channel: number, collection: number, patch: number]>;
    defaultCollection: number;
}

interface PendingEvent {
    /** Performance time. */
    time: number;
    kind: "on" | "off" | "cc" | "bend";
    channel: number;
    a: number;
    b: number;
    owner: PerfSegmentState | null;
}

export class Performance {
    readonly synth: DlsSynth;
    /** Random source; replaceable so a test can make pattern and variation choices repeatable. */
    random: () => number = Math.random;
    randomState = 0;
    /** Segment notifications: (DMUS_NOTIFICATION_SEG*, state, music time it happens at). */
    onNotification: ((type: number, state: PerfSegmentState, time: number) => void) | null = null;
    /** Instruments a band takes from the default (GM) collection resolve here. */
    defaultCollection: DlsCollection | null = null;

    private now = 0;
    private tempo = 120;
    private masterTempo = 1;
    private states: PerfSegmentState[] = [];
    private events: PendingEvent[] = [];
    private readonly transpose = new Map<number, number>();
    private readonly drumChannels = new Set<number>();
    private readonly installed = new Map<number, { collection: DlsCollection | null; patch: number }>();

    constructor(synth: DlsSynth) {
        this.synth = synth;
    }

    seedRandom(seed: number): void {
        this.randomState = seed >>> 0;
        this.random = () => {
            let t = this.randomState = (this.randomState + 0x6d2b79f5) >>> 0;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
        };
    }

    captureState(stateRef: (state: PerfSegmentState) => number, collectionRef: (collection: DlsCollection | null) => number): PerformanceData {
        return {
            now: this.now, tempo: this.tempo, masterTempo: this.masterTempo, randomState: this.randomState,
            states: this.states.map(stateRef),
            events: this.events.map((e) => [e.time, e.kind, e.channel, e.a, e.b, e.owner && !e.owner.ended ? stateRef(e.owner) : NONE]),
            transpose: [...this.transpose], drumChannels: [...this.drumChannels],
            installed: [...this.installed].map(([channel, entry]) => [channel, collectionRef(entry.collection), entry.patch]),
            defaultCollection: collectionRef(this.defaultCollection),
        };
    }

    restoreState(d: PerformanceData, stateOf: (ref: number) => PerfSegmentState, collectionOf: (ref: number) => DlsCollection | null): void {
        this.now = d.now;
        this.tempo = d.tempo;
        this.masterTempo = d.masterTempo;
        this.seedRandom(d.randomState);
        this.states = d.states.map(stateOf);
        this.events = d.events.map(([time, kind, channel, a, b, owner]) => (
            { time, kind: kind as PendingEvent["kind"], channel, a, b, owner: owner === NONE ? null : stateOf(owner) }));
        this.transpose.clear();
        for (const [channel, value] of d.transpose) this.transpose.set(channel, value);
        this.drumChannels.clear();
        for (const channel of d.drumChannels) this.drumChannels.add(channel);
        this.installed.clear();
        for (const [channel, collection, patch] of d.installed) this.installed.set(channel, { collection: collectionOf(collection), patch });
        this.defaultCollection = collectionOf(d.defaultCollection);
    }

    reinstallInstruments(collection: DlsCollection): void {
        for (const [channel, entry] of this.installed) {
            if (entry.collection === collection) this.synth.setInstrument(channel, collection, entry.patch);
        }
    }

    /** Current music time in ticks (768 per quarter note). */
    get musicTime(): number { return this.now; }
    get currentTempo(): number { return this.tempo * this.masterTempo; }

    setMasterTempo(scale: number): void {
        if (scale > 0) this.masterTempo = Math.min(100, Math.max(0.01, scale));
    }

    /** The primary segment state sounding now, if any. */
    primaryState(): PerfSegmentState | null {
        for (const s of this.states) if (s.primary && s.started && !s.ended) return s;
        return null;
    }

    activeStates(): readonly PerfSegmentState[] { return this.states; }

    // ── scheduling ──────────────────────────────────────────────────────────────

    /** The next boundary at or after `time` the DMUS_SEGF_* resolution flags ask for. */
    private resolveBoundary(flags: number, time: number, segment: PerfSegment | null): number {
        let resolution = flags;
        if ((flags & DMUS_SEGF_DEFAULT) && segment) resolution = segment.resolution;
        const primary = this.primaryState();
        const sig = primary?.segment.timeSig() ?? DEFAULT_TIME_SIG;
        const unit = resolution & DMUS_SEGF_MEASURE ? ticksPerMeasure(sig)
            : resolution & DMUS_SEGF_BEAT ? ticksPerBeat(sig)
            : resolution & DMUS_SEGF_GRID ? ticksPerGrid(sig) : 0;
        if (unit <= 0) return time;
        // Bars are counted from where the primary segment's time zero falls.
        const origin = primary ? primary.base : 0;
        return origin + Math.ceil((time - origin) / unit - 1e-9) * unit;
    }

    /**
     * IDirectMusicPerformance::PlaySegment. A primary segment replaces the current one at
     * the boundary `flags` names; a secondary one plays alongside it.
     */
    playSegment(segment: PerfSegment, flags: number): PerfSegmentState {
        const secondary = (flags & DMUS_SEGF_SECONDARY) !== 0;
        const current = this.primaryState();
        if (!secondary && (flags & DMUS_SEGF_QUEUE) && current) {
            const queued = new PerfSegmentState(segment, true, Infinity);
            let tail = current;
            while (tail.queued) tail = tail.queued;
            tail.queued = queued;
            return queued;
        }
        const start = this.resolveBoundary(flags, this.now, segment);
        const state = new PerfSegmentState(segment, !secondary, start);
        if (!secondary) {
            // A primary segment not yet started is superseded by this one.
            for (const s of this.states) if (s.primary && !s.started) this.finish(s, DMUS_NOTIFICATION_SEGABORT, this.now);
            this.states = this.states.filter((s) => !s.ended);
        }
        this.states.push(state);
        return state;
    }

    /**
     * IDirectMusicPerformance::Stop. With neither a segment nor a state, everything stops.
     * `flags` may name a boundary; zero stops at once.
     */
    stop(segment: PerfSegment | null, state: PerfSegmentState | null, flags: number): void {
        const at = this.resolveBoundary(flags, this.now, null);
        for (const s of this.states) {
            if (s.ended) continue;
            if (state ? s !== state : segment ? s.segment !== segment : false) continue;
            this.dropQueued(s, this.now);
            if (at <= this.now || !s.started) this.finish(s, DMUS_NOTIFICATION_SEGABORT, Math.max(this.now, s.startTime));
            else s.stopAt = at;
        }
        if (!segment && !state) {
            this.synth.allNotesOff();
            this.events = this.events.filter((e) => e.kind !== "on");
        }
        this.states = this.states.filter((s) => !s.ended);
    }

    /** IDirectMusicPerformance::IsPlaying for a segment, a state, or both. */
    isPlaying(segment: PerfSegment | null, state: PerfSegmentState | null): boolean {
        for (const s of this.states) {
            if (s.ended || !s.started) continue;
            if (state && s !== state) continue;
            if (segment && s.segment !== segment) continue;
            if (!segment && !state) continue;
            return true;
        }
        return false;
    }

    /**
     * IDirectMusicComposer::AutoTransition: one measure of the playing style under `command`
     * (an embellishment, or the groove) at the boundary `composeFlags` names, then `to`.
     * With nothing playing there is nothing to transition from, and `to` simply starts.
     */
    autoTransition(to: PerfSegment | null, command: number, composeFlags: number): {
        transition: PerfSegment | null;
        transitionState: PerfSegmentState | null;
        toState: PerfSegmentState | null;
    } {
        const from = this.primaryState();
        const boundary = composeFlags & DMUS_COMPOSEF_IMMEDIATE ? 0
            : composeFlags & DMUS_COMPOSEF_GRID ? DMUS_SEGF_GRID
            : composeFlags & DMUS_COMPOSEF_BEAT ? DMUS_SEGF_BEAT : DMUS_SEGF_MEASURE;
        const style = from ? (from.patternStyle ?? styleAt(from.segment, this.now - from.base)) : null;
        if (!from || !style) {
            const toState = to ? this.playSegment(to, boundary) : null;
            if (!to && from) this.stop(null, from, boundary);
            return { transition: null, transitionState: null, toState };
        }

        const transition = PerfSegment.transition(style, this.tempo, command, from.grooveLevel || 1);
        const transitionState = this.playSegment(transition, boundary);
        let toState: PerfSegmentState | null = null;
        if (to) {
            toState = new PerfSegmentState(to, true, Infinity);
            transitionState.queued = toState;
        }
        return { transition, transitionState, toState };
    }

    // ── rendering ───────────────────────────────────────────────────────────────

    /** Produce `frames` of audio into `left`/`right` (added to), advancing music time. */
    render(left: Float32Array, right: Float32Array, frames: number): void {
        const rate = this.synth.sampleRate;
        for (let done = 0; done < frames;) {
            const count = Math.min(SEQUENCE_FRAMES, frames - done);
            const ticksPerFrame = (this.tempo * this.masterTempo * DMUS_PPQ) / 60 / rate;
            const t0 = this.now;
            const t1 = t0 + count * ticksPerFrame;
            this.sequence(t0, t1);

            // Dispatch what falls in this slice at its own frame, rendering in between.
            this.events.sort((a, b) => a.time - b.time);
            let cursor = 0;
            let taken = 0;
            for (; taken < this.events.length; taken++) {
                const e = this.events[taken]!;
                if (e.time >= t1) break;
                const at = Math.min(count, Math.max(cursor, Math.floor((e.time - t0) / ticksPerFrame)));
                if (at > cursor) {
                    this.synth.render(left, right, done + cursor, at - cursor);
                    cursor = at;
                }
                this.dispatch(e);
            }
            if (taken > 0) this.events.splice(0, taken);
            if (cursor < count) this.synth.render(left, right, done + cursor, count - cursor);
            this.mixWaves(left, right, done, count, t1);

            this.now = t1;
            done += count;
        }
    }

    statesOnOutput(output: object): readonly PerfSegmentState[] {
        return this.states.filter(state => state.output === output && !state.ended);
    }

    hasWaveOn(output: object): boolean {
        for (const s of this.states) if (s.output === output && s.segment.wave && !s.ended) return true;
        return false;
    }

    endWavesOn(output: object): void {
        let ended = false;
        for (const s of this.states) {
            if (s.output !== output || !s.segment.wave || s.ended) continue;
            this.finish(s, DMUS_NOTIFICATION_SEGEND, this.now);
            ended = true;
        }
        if (ended) this.states = this.states.filter((s) => !s.ended);
    }

    renderWaves(output: object, left: Float32Array, right: Float32Array, frames: number, rate: number): void {
        this.mixWaves(left, right, 0, frames, this.now, output, rate);
    }

    private mixWaves(left: Float32Array, right: Float32Array, offset: number, count: number, sliceEnd: number,
        output: object | null = null, rate = this.synth.sampleRate): void {
        let ended = false;
        for (const s of this.states) {
            const wave = s.segment.wave;
            if (!wave || !s.started || s.ended || s.output !== output) continue;
            if (wave.frames === 0) {
                this.finish(s, DMUS_NOTIFICATION_SEGEND, sliceEnd);
                ended = true;
                continue;
            }
            const step = wave.rate / rate;
            let pos = s.wavePosition;
            for (let i = 0; i < count; i++) {
                let idx = pos | 0;
                if (idx >= wave.frames) {
                    if (s.repeatsLeft > 0) {
                        s.repeatsLeft--;
                        pos -= wave.frames;
                        idx = pos | 0;
                        this.onNotification?.(DMUS_NOTIFICATION_SEGLOOP, s, sliceEnd);
                    } else {
                        this.finish(s, DMUS_NOTIFICATION_SEGEND, sliceEnd);
                        ended = true;
                        break;
                    }
                }
                const frac = pos - idx;
                const next = idx + 1 < wave.frames ? idx + 1 : idx;
                left[offset + i] = left[offset + i]! + wave.left[idx]! + (wave.left[next]! - wave.left[idx]!) * frac;
                right[offset + i] = right[offset + i]! + wave.right[idx]! + (wave.right[next]! - wave.right[idx]!) * frac;
                pos += step;
            }
            s.wavePosition = pos;
        }
        if (ended) this.states = this.states.filter((s) => !s.ended);
    }

    private dispatch(e: PendingEvent): void {
        switch (e.kind) {
            case "on": this.synth.noteOn(e.channel, e.a, e.b); break;
            case "off": this.synth.noteOff(e.channel, e.a); break;
            case "cc": this.synth.controlChange(e.channel, e.a, e.b); break;
            case "bend": this.synth.pitchBend(e.channel, e.a); break;
        }
    }

    /** Run every segment's tracks over performance time [t0, t1). */
    private sequence(t0: number, t1: number): void {
        // Index loop: starting or ending a state can append to the list.
        for (let i = 0; i < this.states.length; i++) {
            const s = this.states[i]!;
            if (s.ended || s.startTime >= t1) continue;
            if (!s.started) this.start(s);
            let from = Math.max(t0, s.startTime);
            const until = s.stopAt !== undefined ? Math.min(t1, s.stopAt) : t1;
            while (from < until && !s.ended) from = this.playState(s, from, until);
            if (!s.ended && s.stopAt !== undefined && s.stopAt <= t1) {
                this.finish(s, DMUS_NOTIFICATION_SEGABORT, s.stopAt);
            }
        }
        this.states = this.states.filter((s) => !s.ended);
    }

    private start(s: PerfSegmentState): void {
        s.started = true;
        s.base = s.startTime - s.segment.playStart;
        s.fresh = true;
        if (s.primary) {
            for (const other of this.states) {
                if (other !== s && other.primary && other.started && !other.ended) {
                    this.finish(other, DMUS_NOTIFICATION_SEGABORT, s.startTime);
                }
            }
        }
        this.onNotification?.(DMUS_NOTIFICATION_SEGSTART, s, s.startTime);
    }

    /** End a state at performance time `at`: silence what it left sounding and hand over. */
    private finish(s: PerfSegmentState, notification: number, at: number): void {
        if (s.ended) return;
        s.ended = true;
        // Notes this state started stop with it; ones it had yet to start never do.
        this.events = this.events.filter((e) => e.owner !== s || e.kind === "off" || e.time < at);
        for (const e of this.events) if (e.owner === s && e.kind === "off" && e.time > at) e.time = at;
        if (s.started) this.onNotification?.(notification, s, at);
        const next = s.queued;
        if (next && notification === DMUS_NOTIFICATION_SEGEND) {
            s.queued = null;
            next.startTime = at;
            this.states.push(next);
        } else {
            this.dropQueued(s, at);
        }
    }

    private dropQueued(s: PerfSegmentState, at: number): void {
        const next = s.queued;
        s.queued = null;
        if (next && next !== s) this.finish(next, DMUS_NOTIFICATION_SEGABORT, at);
    }

    /**
     * Play one stretch of a state, from performance time `from` up to `until` or the
     * segment's next loop point or end. Returns where it got to.
     */
    private playState(s: PerfSegmentState, from: number, until: number): number {
        const seg = s.segment;
        if (seg.wave) return until;
        const loopEnd = seg.loopEnd > 0 ? seg.loopEnd : seg.length;
        const looping = s.repeatsLeft > 0 && loopEnd > seg.loopStart;
        const boundary = s.base + (looping ? loopEnd : seg.length);
        const end = Math.min(until, boundary);
        if (end > from) this.playTracks(s, from - s.base, end - s.base);
        if (end < boundary) return end;
        if (looping) {
            s.repeatsLeft--;
            s.base += loopEnd - seg.loopStart;
            s.fresh = true;
            this.onNotification?.(DMUS_NOTIFICATION_SEGLOOP, s, boundary);
        } else {
            this.finish(s, DMUS_NOTIFICATION_SEGEND, boundary);
        }
        return end;
    }

    /** The tracks of `s` over segment time [a, b). */
    private playTracks(s: PerfSegmentState, a: number, b: number): void {
        const seg = s.segment;
        const fresh = s.fresh;
        s.fresh = false;

        // A fresh position takes the item in force there; after that, items as they come.
        for (const item of due(seg.tempos, a, b, fresh)) {
            if (Number.isFinite(item.tempo) && item.tempo >= 1 && item.tempo <= 1000) this.tempo = item.tempo;
        }
        for (const item of due(seg.bands, a, b, fresh)) this.applyBand(item.band);

        if (seg.fixedPattern || seg.styles.length > 0) this.playPatterns(s, a, b, fresh);
        if (seg.events.length > 0 || seg.curves.length > 0) this.playSequence(s, a, b);
    }

    private applyBand(loaded: LoadedBand): void {
        loaded.band.instruments.forEach((inst: BandInstrument, index: number) => {
            const channel = inst.pChannel;
            if (inst.flags & DMUS_IO_INST_PATCH) {
                const collection = loaded.collections[index] ?? this.defaultCollection;
                this.synth.setInstrument(channel, collection, inst.patch);
                this.installed.set(channel, { collection, patch: inst.patch });
                if (inst.patch & F_INSTRUMENT_DRUMS) this.drumChannels.add(channel);
                else this.drumChannels.delete(channel);
            }
            if (inst.flags & DMUS_IO_INST_VOLUME) this.synth.controlChange(channel, 7, inst.volume);
            if (inst.flags & DMUS_IO_INST_PAN) this.synth.controlChange(channel, 10, inst.pan);
            if (inst.flags & DMUS_IO_INST_TRANSPOSE) this.transpose.set(channel, inst.transpose);
            if (inst.flags & DMUS_IO_INST_PITCHBENDRANGE) {
                this.synth.controlChange(channel, 101, 0);
                this.synth.controlChange(channel, 100, 0);
                this.synth.controlChange(channel, 6, inst.pitchBendRange);
            }
        });
    }

    // ── style playback ──────────────────────────────────────────────────────────

    private playPatterns(s: PerfSegmentState, a: number, b: number, fresh: boolean): void {
        let t = a;
        let reselect = fresh;
        while (t < b) {
            if (reselect || t >= s.patternEnd) this.selectPattern(s, t);
            reselect = false;
            const end = Math.min(b, s.patternEnd);
            if (s.pattern && end > t) this.playPattern(s, t, end);
            if (end <= t) break;
            t = end;
        }
    }

    /** Choose what plays from segment time `t`: the pattern, how long, and each part's variation. */
    private selectPattern(s: PerfSegmentState, t: number): void {
        const seg = s.segment;
        if (seg.fixedPattern) {
            const { style, pattern } = seg.fixedPattern;
            const length = Math.max(1, pattern.measures) * ticksPerMeasure(pattern.timeSig);
            s.patternStart = Math.floor(t / length) * length;
            s.patternEnd = s.patternStart + length;
            this.enterPattern(s, style, pattern, chordAt(seg, t));
            return;
        }

        const style = styleAt(seg, t);
        s.patternStart = t;
        if (!style) {
            s.pattern = null;
            s.patternEnd = Infinity;
            return;
        }
        const measureTicks = ticksPerMeasure(style.timeSig);

        // The command in force. An embellishment belongs to the measure it is on; once that
        // has been played its groove level stays, its embellishment does not.
        let command = DMUS_COMMANDT_GROOVE;
        let level = s.grooveLevel || 1;
        let range = 0;
        let next = Infinity;
        for (const c of seg.commands ?? []) {
            const at = commandTime(c, style.timeSig);
            if (at <= t + TICK_SLACK) {
                command = at >= t - TICK_SLACK ? c.command : DMUS_COMMANDT_GROOVE;
                level = c.grooveLevel;
                range = c.grooveRange;
            } else if (at < next) {
                next = at;
            }
        }
        if (range > 1) level += Math.round((this.random() - 0.5) * range);
        level = Math.min(100, Math.max(1, level));
        s.grooveLevel = level;

        const pattern = this.choosePattern(style, command, level, (next - t) / measureTicks);
        if (!pattern) {
            // Nothing in the style answers this command: rest until the next bar or command.
            s.pattern = null;
            s.patternEnd = Math.min(next, (Math.floor(t / measureTicks) + 1) * measureTicks);
            return;
        }
        s.patternEnd = Math.min(next, t + Math.max(1, pattern.measures) * ticksPerMeasure(pattern.timeSig));
        this.enterPattern(s, style, pattern, chordAt(seg, t));
    }

    /**
     * The pattern for a command: one whose embellishment and groove range match, preferring
     * the longest that fits in the measures left before the next command, at random among
     * equals. An embellishment the style has at no matching groove level is still played.
     */
    private choosePattern(style: Style, command: number, level: number, measuresLeft: number): StylePattern | null {
        const want = command === DMUS_COMMANDT_FILL ? DMUS_EMBELLISHT_FILL
            : command === DMUS_COMMANDT_INTRO ? DMUS_EMBELLISHT_INTRO
            : command === DMUS_COMMANDT_BREAK ? DMUS_EMBELLISHT_BREAK
            : command === DMUS_COMMANDT_END || command === DMUS_COMMANDT_ENDANDINTRO ? DMUS_EMBELLISHT_END : 0;
        const inGroove = (p: StylePattern): boolean => level >= p.grooveBottom && level <= p.grooveTop;
        const ofKind = (p: StylePattern): boolean => want ? (p.embellishment & want) !== 0 : p.embellishment === 0;

        let candidates = style.patterns.filter((p) => ofKind(p) && inGroove(p));
        if (candidates.length === 0 && want) candidates = style.patterns.filter(ofKind);
        if (candidates.length === 0 && want) candidates = style.patterns.filter((p) => p.embellishment === 0 && inGroove(p));
        if (candidates.length === 0) return null;

        const fitting = candidates.filter((p) => p.measures <= measuresLeft + 1e-9);
        let best: StylePattern[];
        if (fitting.length > 0) {
            const longest = Math.max(...fitting.map((p) => p.measures));
            best = fitting.filter((p) => p.measures === longest);
        } else {
            const shortest = Math.min(...candidates.map((p) => p.measures));
            best = candidates.filter((p) => p.measures === shortest);
        }
        return best[Math.min(best.length - 1, Math.floor(this.random() * best.length))]!;
    }

    private enterPattern(s: PerfSegmentState, style: Style, pattern: StylePattern, chord: ChordContext): void {
        s.pattern = pattern;
        s.patternStyle = style;
        s.parts = [];
        const locked = new Map<number, number>();
        for (const ref of pattern.partRefs) {
            const part = style.parts.get(ref.partId);
            if (!part) continue;
            const eligible: number[] = [];
            for (let i = 0; i < 32; i++) {
                if (variationMatchesChord(part.variationChoices[i] ?? 0, chord)) eligible.push(i);
            }
            let variation = -1;
            const lock = ref.variationLockId;
            if (lock && locked.has(lock) && eligible.includes(locked.get(lock)!)) {
                variation = locked.get(lock)!;
            } else if (eligible.length > 0) {
                if (ref.randomVariation) {
                    variation = eligible[Math.min(eligible.length - 1, Math.floor(this.random() * eligible.length))]!;
                } else {
                    const key = `${ref.partId}/${ref.pChannel}`;
                    const last = s.sequentialVariation.get(key) ?? -1;
                    variation = eligible.find((i) => i > last) ?? eligible[0]!;
                    s.sequentialVariation.set(key, variation);
                }
                if (lock) locked.set(lock, variation);
            }
            s.parts.push(partState(ref, part, variation));
        }
    }

    /** Emit the notes and curves of the current pattern that fall in segment time [a, b). */
    private playPattern(s: PerfSegmentState, a: number, b: number): void {
        const chord = chordAt(s.segment, a);
        const start = s.patternStart;
        for (const ps of s.parts) {
            if (ps.variation < 0) continue;
            const bit = 1 << ps.variation;
            const part = ps.part;
            const channel = ps.ref.pChannel;
            // A part shorter than the pattern repeats. An event may sit a little before its
            // grid line, so the repetition after the window's is looked at too.
            const first = Math.max(0, Math.floor((a - start) / ps.lengthTicks));
            const last = Math.floor((b - start) / ps.lengthTicks) + 1;
            for (let k = first; k <= last; k++) {
                const loopBase = start + k * ps.lengthTicks;
                if (loopBase >= s.patternEnd) break;
                for (const note of part.notes) {
                    if (!(note.variation & bit)) continue;
                    let time = loopBase + note.gridStart * ps.gridTicks + note.timeOffset;
                    if (time < start) time = start;
                    if (time < a || time >= b) continue;
                    const mode = note.playModeFlags === DMUS_PLAYMODE_NONE ? part.playModeFlags : note.playModeFlags;
                    let key = musicValueToMidi(note.musicValue, chord, mode);
                    if (!this.drumChannels.has(channel)) key += this.transpose.get(channel) ?? 0;
                    if (key < 0 || key > 127) continue;
                    let velocity = note.velocity;
                    if (note.velRange) velocity += Math.round((this.random() - 0.5) * note.velRange);
                    let duration = note.duration;
                    if (note.durRange) duration += Math.round((this.random() - 0.5) * note.durRange);
                    this.note(s, time + s.base, channel, key, Math.min(127, Math.max(1, velocity)), Math.max(1, duration));
                }
                for (const curve of part.curves) {
                    if (!(curve.variation & bit)) continue;
                    const time = Math.max(start, loopBase + curve.gridStart * ps.gridTicks + curve.timeOffset);
                    this.playCurve(s, a, b, time, channel, curve);
                }
            }
        }
    }

    private note(owner: PerfSegmentState, time: number, channel: number, key: number, velocity: number, duration: number): void {
        this.events.push({ time, kind: "on", channel, a: key, b: velocity, owner });
        this.events.push({ time: time + duration, kind: "off", channel, a: key, b: 0, owner });
    }

    /**
     * A curve starting at segment time `time`, as far as it falls in [a, b): an instant
     * curve is one controller event, a shaped one a step per sequencing slice.
     */
    private playCurve(
        s: PerfSegmentState, a: number, b: number, time: number, channel: number,
        c: Pick<StyleCurve, "duration" | "resetDuration" | "startValue" | "endValue" | "resetValue" | "curveShape" | "ccData" | "flags"> & { eventType: number },
    ): void {
        const emit = (at: number, value: number): void => {
            if (c.eventType === DMUS_CURVET_PBCURVE) {
                this.events.push({ time: at + s.base, kind: "bend", channel, a: Math.min(0x3fff, Math.max(0, value)), b: 0, owner: null });
            } else if (c.eventType === DMUS_CURVET_CCCURVE) {
                this.events.push({ time: at + s.base, kind: "cc", channel, a: c.ccData, b: Math.min(127, Math.max(0, value)), owner: null });
            }
        };
        const instant = c.curveShape === DMUS_CURVES_INSTANT || c.duration <= 0;
        if (instant) {
            if (time >= a && time < b) emit(time, c.endValue);
        } else if (time < b && time + c.duration >= a) {
            const at = Math.max(a, time);
            const progress = Math.min(1, (Math.min(b, time + c.duration) - time) / c.duration);
            emit(at, Math.round(c.startValue + (c.endValue - c.startValue) * shape(c.curveShape, progress)));
        }
        if (c.flags & DMUS_CURVE_RESET) {
            const resetAt = time + Math.max(0, c.duration) + c.resetDuration;
            if (resetAt >= a && resetAt < b) emit(resetAt, c.resetValue);
        }
    }

    /** A sequence track: plain channel-voice events at fixed times. */
    private playSequence(s: PerfSegmentState, a: number, b: number): void {
        for (const e of s.segment.events) {
            const time = e.time + e.offset;
            if (time < a || time >= b) continue;
            const status = e.status & 0xf0;
            if (status === 0x90 && e.byte2 > 0) {
                this.note(s, time + s.base, e.pChannel, e.byte1, e.byte2, Math.max(1, e.duration));
            } else if (status === 0xb0) {
                this.events.push({ time: time + s.base, kind: "cc", channel: e.pChannel, a: e.byte1, b: e.byte2, owner: null });
            } else if (status === 0xe0) {
                this.events.push({ time: time + s.base, kind: "bend", channel: e.pChannel, a: e.byte1 | (e.byte2 << 7), b: 0, owner: null });
            }
        }
        for (const c of s.segment.curves) {
            this.playCurve(s, a, b, c.time + c.offset, c.pChannel, { ...c, eventType: c.type });
        }
    }
}

/** Curve shapes as a 0..1 easing: linear, exponential, logarithmic, sine. */
function shape(curveShape: number, x: number): number {
    switch (curveShape) {
        case 2: return x * x;
        case 3: return Math.sqrt(x);
        case 4: return (1 - Math.cos(Math.PI * x)) / 2;
        default: return x;
    }
}

/**
 * The items of a timed track to act on over segment time [a, b): those starting inside it,
 * and when the position is fresh also the latest one at or before `a`.
 */
function due<T extends { time: number }>(items: T[], a: number, b: number, fresh: boolean): T[] {
    const out: T[] = [];
    let latest: T | null = null;
    for (const item of items) {
        if (item.time < a - TICK_SLACK || (fresh && item.time <= a + TICK_SLACK)) {
            if (fresh && (!latest || item.time >= latest.time)) latest = item;
        } else if (item.time < b - TICK_SLACK) {
            out.push(item);
        }
    }
    if (latest) out.unshift(latest);
    return out;
}

function commandTime(c: CommandItem, sig: TimeSignature): number {
    return c.measure * ticksPerMeasure(sig) + c.beat * ticksPerBeat(sig);
}

function styleAt(seg: PerfSegment, t: number): Style | null {
    let found: StyleRef | null = null;
    for (const item of seg.styles) if (item.time <= t && (!found || item.time >= found.time)) found = item;
    return (found ?? seg.styles[0])?.style ?? null;
}

/** The chord in force at segment time `t`; a segment without a chord track plays the default. */
function chordAt(seg: PerfSegment, t: number): ChordContext {
    let found: ChordItem | null = null;
    for (const item of seg.chords) if (item.time <= t && (!found || item.time >= found.time)) found = item;
    const sub = (found ?? seg.chords[0])?.subChords[0];
    if (!sub) return DEFAULT_CHORD;
    return {
        chordPattern: sub.chordPattern,
        scalePattern: sub.scalePattern || seg.chordScale || DEFAULT_CHORD.scalePattern,
        chordRoot: sub.chordRoot,
        scaleRoot: sub.scaleRoot,
        key: seg.chordKey,
    };
}
