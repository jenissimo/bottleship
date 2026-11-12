import type { MidiRouter } from "./midi-router";
import type { SmfSong } from "./smf-events";

export class SmfPlayer {
    private next = 0;
    private anchorWall = 0;
    private anchorMs = 0;
    private toMs = 0;
    playing = false;
    private onEnd: (() => void) | null = null;

    constructor(readonly song: SmfSong, private readonly router: MidiRouter) {}

    positionAt(now: number): number {
        if (!this.playing) return this.anchorMs;
        return Math.min(this.song.lengthMs, this.anchorMs + (now - this.anchorWall));
    }

    seek(ms: number): void {
        const target = Math.max(0, Math.min(this.song.lengthMs, ms));
        this.playing = false;
        this.router.allNotesOff();
        this.router.resetChannels();
        let i = 0;
        for (; i < this.song.events.length && this.song.events[i]!.ms < target; i++) {
            const e = this.song.events[i]!;
            if (e.sysex) continue;
            const kind = e.message & 0xf0;
            if (kind === 0xb0 || kind === 0xc0 || kind === 0xe0) this.router.shortMessage(e.message, 0);
        }
        this.router.flush();
        this.next = i;
        this.anchorMs = target;
    }

    play(now: number, toMs: number, onEnd: (() => void) | null): void {
        this.toMs = toMs > 0 ? Math.min(toMs, this.song.lengthMs) : this.song.lengthMs;
        this.onEnd = onEnd;
        this.anchorWall = now;
        this.playing = true;
    }

    pause(now: number): void {
        if (!this.playing) return;
        this.anchorMs = this.positionAt(now);
        this.playing = false;
        this.router.allNotesOff();
    }

    stop(now: number): void {
        this.pause(now);
        this.onEnd = null;
    }

    tick(now: number): void {
        if (!this.playing) return;
        const position = this.anchorMs + (now - this.anchorWall);
        const limit = Math.min(position, this.toMs);
        const events = this.song.events;
        while (this.next < events.length && events[this.next]!.ms <= limit) {
            const e = events[this.next++]!;
            const at = this.anchorWall + (e.ms - this.anchorMs);
            if (e.sysex) this.router.systemExclusive(e.sysex);
            else this.router.shortMessage(e.message, at);
        }
        if (position >= this.toMs) {
            this.anchorMs = this.toMs;
            this.playing = false;
            for (let ch = 0; ch < 16; ch++) this.router.shortMessage(0xb0 | ch | (123 << 8), now);
            const done = this.onEnd;
            this.onEnd = null;
            done?.();
        }
    }
}
