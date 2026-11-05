import { CaptureRefusal } from './object-codecs';
import type { Readiness } from './readiness';

export interface HaltIo {
    isPaused(): boolean;
    pause(): void;
    resume(): void;
    isRunning(): boolean;
    flushWriteBuffer(): void;
    readiness(): Readiness;
    sleep(ms: number): Promise<void>;
}

export interface SafePoint {
    release(): void;
    stillReady(): void;
}

export const HALT_ATTEMPTS = 200;
const STOP_POLLS = 500;

const describe = (r: Readiness) => r.blockers.map(b => `${b.kind} (${b.detail})`).join(', ');

async function stopped(io: HaltIo): Promise<void> {
    for (let i = 0; i < STOP_POLLS && io.isRunning(); i++) await io.sleep(2);
    if (io.isRunning()) throw new Error('savestate: v86 did not stop');
}

export async function haltAtSafePoint(io: HaltIo): Promise<SafePoint> {
    const wasPaused = io.isPaused();
    const safePoint = (): SafePoint => ({
        release: () => { if (!wasPaused) io.resume(); },
        stillReady: () => {
            const now = io.readiness();
            if (!now.ready) throw new CaptureRefusal(`savestate: the safe point was lost: ${describe(now)}`);
        },
    });
    const settle = async (): Promise<Readiness> => {
        io.pause();
        try {
            await stopped(io);
        } catch (e) {
            if (!wasPaused) io.resume();
            throw e;
        }
        io.flushWriteBuffer();
        return io.readiness();
    };
    if (wasPaused) {
        const once = await settle();
        if (once.ready) return safePoint();
        throw new CaptureRefusal(`savestate: the session is paused away from a safe point: ${describe(once)}`);
    }
    let last: Readiness | null = null;
    for (let attempt = 0; attempt < HALT_ATTEMPTS; attempt++) {
        last = await settle();
        if (last.ready) return safePoint();
        io.resume();
        await io.sleep(3 + (attempt % 7));
    }
    throw new CaptureRefusal(`savestate: no safe point: ${last ? describe(last) : ''}`);
}
