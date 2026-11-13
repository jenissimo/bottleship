import { expect, spyOn, test } from "bun:test";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { Logger } from "../../src/worker/core/logger";
import { DDrawPresenter, type PresentClock } from "../../src/worker/modules/ddraw/presenter";
import type { DirectDrawSurfaceState } from "../../src/worker/modules/ddraw/com-objects";

class ManualClock implements PresentClock {
    t = 0;
    private refresh = new Set<() => void>();
    private timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
    now(): number { return this.t; }
    onRefresh(callback: () => void): () => void {
        this.refresh.add(callback);
        return () => this.refresh.delete(callback);
    }
    setTimer(callback: () => void, ms: number): () => void {
        const timer = { at: this.t + ms, fn: callback, live: true };
        this.timers.push(timer);
        return () => { timer.live = false; };
    }
    async advance(ms: number, refreshEveryMs = 0): Promise<void> {
        const end = this.t + ms;
        let nextRefresh = refreshEveryMs > 0 ? Math.floor(this.t / refreshEveryMs + 1) * refreshEveryMs : Infinity;
        while (true) {
            const timer = this.timers.filter(x => x.live).sort((a, b) => a.at - b.at)[0];
            const next = Math.min(nextRefresh, timer?.at ?? Infinity);
            if (next > end) break;
            this.t = next;
            if (timer && timer.at === next) { timer.live = false; timer.fn(); }
            else { nextRefresh += refreshEveryMs; for (const cb of [...this.refresh]) cb(); }
            await flush();
        }
        this.t = end;
        await flush();
    }
}

async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

const REFRESH = 1000 / 60;

function presenterWithDrawLog() {
    const clock = new ManualClock();
    const presenter = Object.create(DDrawPresenter.prototype) as any;
    Object.assign(presenter, {
        presentCallCount: 0, pendingSurface: null, pendingOptions: null, pendingResolvers: [],
        pumpRunning: false, pumpQueued: false, presentClock: clock, latchedSince: -1,
        refreshUnregister: null, backstopCancel: null,
        lockedSince: -1,
    });
    const drawn: Array<{ options: any; at: number; surface: any }> = [];
    presenter.drawFrame = async (surface: unknown, options: unknown) => { drawn.push({ surface, options, at: clock.t }); };
    return { presenter: presenter as DDrawPresenter, drawn, clock };
}

const primary = { surfacePtr: 0x1000 } as DirectDrawSurfaceState;
const mem = new Uint8Array(0);
const implicit = { throttle: true };
const flip = { throttle: true, frameAlreadyMarked: true, flip: true };

test("implicit presents within one refresh collapse into one draw of the final state at the next refresh", async () => {
    const { presenter, drawn, clock } = presenterWithDrawLog();
    const a = { surfacePtr: 1 } as DirectDrawSurfaceState, b = { surfacePtr: 2 } as DirectDrawSurfaceState;
    void presenter.present(a, mem, implicit);
    await clock.advance(3);
    void presenter.present(b, mem, implicit);
    expect(drawn).toHaveLength(0);
    await clock.advance(20, REFRESH);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.surface).toBe(b);
    expect(drawn[0]!.at).toBeCloseTo(REFRESH, 5);
});

test("a continuous primary writer without Flip is drawn once per refresh, not below it", async () => {
    const { presenter, drawn, clock } = presenterWithDrawLog();
    for (let t = 0; t < 1000; t += 2) {
        void presenter.present(primary, mem, implicit);
        await clock.advance(2, REFRESH);
    }
    expect(drawn.length).toBeGreaterThanOrEqual(58);
    expect(drawn.length).toBeLessThanOrEqual(61);
});

test("an explicit present draws when the slice returns and absorbs a pending implicit one", async () => {
    const { presenter, drawn, clock } = presenterWithDrawLog();
    void presenter.present(primary, mem, implicit);
    await presenter.present(primary, mem, { throttle: false });
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.options).toEqual({ throttle: false });
    await clock.advance(200, REFRESH);
    expect(drawn).toHaveLength(1);
});

test("a locked primary is not drawn; it is drawn at the first refresh after Unlock", async () => {
    const { presenter, drawn, clock } = presenterWithDrawLog();
    const surface = { surfacePtr: 0x1000, activeLeaseId: 3 } as unknown as DirectDrawSurfaceState & { activeLeaseId?: number };
    void presenter.present(surface, mem, implicit);
    await clock.advance(30, REFRESH);
    expect(drawn).toHaveLength(0);
    surface.activeLeaseId = undefined;
    await clock.advance(REFRESH, REFRESH);
    expect(drawn).toHaveLength(1);
});

test("a primary that stays locked is still drawn after the bounded hold", async () => {
    const { presenter, drawn, clock } = presenterWithDrawLog();
    const surface = { surfacePtr: 0x1000, activeLeaseId: 3 } as unknown as DirectDrawSurfaceState;
    void presenter.present(surface, mem, implicit);
    await clock.advance(70, REFRESH);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.at).toBeLessThanOrEqual(50 + REFRESH);
});

test("without refresh ticks an implicit present is still drawn by the backstop", async () => {
    const { presenter, drawn, clock } = presenterWithDrawLog();
    void presenter.present(primary, mem, implicit);
    await clock.advance(49);
    expect(drawn).toHaveLength(0);
    await clock.advance(2);
    expect(drawn).toHaveLength(1);
});

test("by default a front-buffer update after each Flip is drawn at the next refresh", async () => {
    const { presenter, drawn, clock } = presenterWithDrawLog();
    for (let frame = 0; frame < 30; frame++) {
        void presenter.present(primary, mem, flip);
        await clock.advance(2, REFRESH);
        void presenter.present(primary, mem, implicit);
        await clock.advance(1000 / 30 - 2, REFRESH);
    }
    expect(drawn.filter(d => d.options.flip === true)).toHaveLength(30);
    expect(drawn.filter(d => d.options.flip !== true)).toHaveLength(30);
});

test("Flip, an implicit present 10 ms later, then 300 ms idle: drawn at the next refresh by default", async () => {
    const { presenter, drawn, clock } = presenterWithDrawLog();
    await presenter.present(primary, mem, flip);
    await clock.advance(10, REFRESH);
    void presenter.present(primary, mem, implicit);
    await clock.advance(300, REFRESH);
    expect(drawn).toHaveLength(2);
    expect(drawn[1]!.at).toBeLessThanOrEqual(10 + REFRESH);
});

test("a primary that stays locked is drawn once per refresh after the first hold", async () => {
    const { presenter, drawn, clock } = presenterWithDrawLog();
    const surface = { surfacePtr: 0x1000, activeLeaseId: 3 } as unknown as DirectDrawSurfaceState;
    for (let t = 0; t < 1000; t += REFRESH) {
        void presenter.present(surface, mem, implicit);
        await clock.advance(REFRESH, REFRESH);
    }
    expect(drawn.length).toBeGreaterThanOrEqual(55);
    expect(drawn[0]!.at).toBeLessThanOrEqual(50 + REFRESH);
});

test("a Flip superseded by an implicit present while a draw is in flight is still drawn at once", async () => {
    const { presenter, drawn, clock } = presenterWithDrawLog();
    let release!: () => void;
    const p = presenter as any;
    const draw = p.drawFrame;
    p.drawFrame = (surface: unknown, options: unknown) => new Promise<void>(r => { release = () => { void draw(surface, options).then(r); }; });
    void presenter.present(primary, mem, flip);
    await clock.advance(1);
    void presenter.present(primary, mem, flip);
    const late = { surfacePtr: 0x3000 } as DirectDrawSurfaceState;
    void presenter.present(late, mem, implicit);
    p.drawFrame = draw;
    release();
    await clock.advance(0);
    expect(drawn).toHaveLength(2);
    expect(drawn[1]!.surface).toBe(late);
    expect(drawn[1]!.at).toBe(1);
});

test("a manifest that still sets ddrawHoldPresentsUntilFlip loads, logs that the key is ignored, and holds nothing", async () => {
    const cfg = EmulatorConfig.getInstance();
    cfg.reset();
    const logs: string[] = [];
    const spy = spyOn(Logger, "log").mockImplementation(((_c: unknown, m: string) => { logs.push(m); }) as never);
    try {
        cfg.applyFromManifest({ formatVersion: 2, name: "t", entrypoint: "rom/game.exe", emulator: { ddrawHoldPresentsUntilFlip: true } });
    } finally {
        spy.mockRestore();
        cfg.reset();
    }
    expect(logs.filter(m => m.includes("ddrawHoldPresentsUntilFlip is ignored"))).toHaveLength(1);
    expect("ddrawHoldPresentsUntilFlip" in cfg).toBe(false);
    const { presenter, drawn, clock } = presenterWithDrawLog();
    await presenter.present(primary, mem, flip);
    await clock.advance(2, REFRESH);
    void presenter.present(primary, mem, implicit);
    await clock.advance(REFRESH, REFRESH);
    expect(drawn).toHaveLength(2);
});
