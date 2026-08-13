/**
 * The state machine for the one GPUDevice this worker owns.
 *
 * A lost WebGPU device does not throw. Every later call against it is a validated no-op, so
 * a frame loop keeps "succeeding" against a device that will never draw again — which is why
 * loss has to be a STATE the rest of the system reads, not an exception somebody catches.
 *
 * `generation` is the join key. Everything that caches a device-derived handle (pipeline,
 * bind group, texture, sampler, buffer, the canvas configuration) either registers an
 * observer here or stamps the generation it was built at; anything stamped older is stale by
 * construction, with no per-handle bookkeeping.
 *
 * The guest-visible contracts are DERIVED from this and nowhere else: d3d9
 * TestCooperativeLevel / Reset, d3d8's pair, and DirectDraw's IsLost / Restore /
 * RestoreAllSurfaces. See `gpu-device-loss-contract.ts`.
 */

import { Logger, LogCategory } from "../logger";

export type GpuDeviceStatus =
    /** A live device. */
    | "ok"
    /** No device; a replacement is being requested. */
    | "lost"
    /** No device and not asking for another one — the adapter itself is gone. */
    | "unavailable";

export interface GpuDeviceObserver {
    /**
     * The old device is gone. DROP every handle derived from it and clear every cache
     * keyed by one. Never touch the GPU from here — there is no device to touch.
     */
    onDeviceLost?(): void;
    /**
     * A new device is live. Only holders that build something EAGERLY need this; a cache
     * that fills lazily is already correct after onDeviceLost cleared it.
     */
    onDeviceRecreated?(device: GPUDevice): void;
}

interface Registration {
    label: string;
    obs: GpuDeviceObserver;
}

export interface GpuDeviceLifecycleReport {
    status: GpuDeviceStatus;
    /** Bumped once per successful recreation; 0 is the device the app booted on. */
    generation: number;
    /** How many times a device was lost (forced losses included). */
    losses: number;
    /** How many times a replacement device was obtained. */
    recreations: number;
    /** requestAdapter/requestDevice attempts that failed while recovering. */
    failedAttempts: number;
    lastReason: string | null;
    lastMessage: string | null;
    /** Wall-clock ms the most recent loss took to recover; null while still lost. */
    lastRecoveryMs: number | null;
    /** ms since the current loss began; null when not lost. */
    lostForMs: number | null;
    /** Observers registered, in registration order — the recovery inventory, readable. */
    observers: string[];
    /** Observer callbacks that threw. A recovery that silently skipped a cache is worse
     *  than one that failed loudly, so these are counted and named. */
    observerErrors: Array<{ label: string; phase: "lost" | "recreated"; message: string }>;
}

class GpuDeviceLifecycle {
    private state: GpuDeviceStatus = "ok";
    private gen = 0;
    private losses = 0;
    private recreations = 0;
    private failedAttempts = 0;
    private lastReason: string | null = null;
    private lastMessage: string | null = null;
    private lostAtMs = 0;
    private lastRecoveryMs: number | null = null;
    private registrations: Registration[] = [];
    private observerErrors: Array<{ label: string; phase: "lost" | "recreated"; message: string }> = [];

    register(label: string, obs: GpuDeviceObserver): () => void {
        const entry: Registration = { label, obs };
        this.registrations.push(entry);
        return () => {
            const i = this.registrations.indexOf(entry);
            if (i >= 0) this.registrations.splice(i, 1);
        };
    }

    status(): GpuDeviceStatus {
        return this.state;
    }

    /** True while a device exists. The single question every GPU path should ask. */
    isUsable(): boolean {
        return this.state === "ok";
    }

    /** Bumped on every successful recreation. Stamp it on anything device-derived. */
    generation(): number {
        return this.gen;
    }

    countFailedAttempt(): void {
        this.failedAttempts++;
    }

    /**
     * The device is gone. Runs every observer's onDeviceLost synchronously so no stale
     * handle survives into the next turn, then leaves the system in `lost` until the owner
     * (WebGPUBackend) reports a replacement.
     */
    notifyLost(reason: string, message: string): void {
        if (this.state === "lost") return;
        this.state = "lost";
        this.losses++;
        this.lastReason = reason;
        this.lastMessage = message;
        this.lostAtMs = performance.now();
        this.lastRecoveryMs = null;
        Logger.error(LogCategory.SYSTEM,
            `[GPU-LOST] device lost (reason=${reason}) gen=${this.gen} — invalidating ${this.registrations.length} caches: ${message}`);
        this.fan("lost", (obs) => obs.onDeviceLost?.());
    }

    /** A replacement device is live. Bumps the generation, then rebuilds eager holders. */
    notifyRecreated(device: GPUDevice): void {
        this.gen++;
        this.recreations++;
        this.state = "ok";
        this.lastRecoveryMs = this.lostAtMs > 0 ? performance.now() - this.lostAtMs : null;
        Logger.log(LogCategory.SYSTEM,
            `[GPU-LOST] recovered — generation ${this.gen} in ${this.lastRecoveryMs?.toFixed(0) ?? "?"}ms`);
        this.fan("recreated", (obs) => obs.onDeviceRecreated?.(device));
    }

    /** No adapter at all. Stays lost, and says so, instead of retrying forever. */
    notifyUnavailable(message: string): void {
        this.state = "unavailable";
        this.lastMessage = message;
        Logger.error(LogCategory.SYSTEM, `[GPU-LOST] no replacement device available — ${message}`);
    }

    private fan(phase: "lost" | "recreated", call: (obs: GpuDeviceObserver) => void): void {
        // A snapshot: an observer may unregister itself from inside the callback.
        for (const { label, obs } of [...this.registrations]) {
            try {
                call(obs);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.observerErrors.push({ label, phase, message });
                if (this.observerErrors.length > 32) this.observerErrors.shift();
                Logger.error(LogCategory.SYSTEM,
                    `[GPU-LOST] observer "${label}" threw during ${phase}: ${message}`);
            }
        }
    }

    report(): GpuDeviceLifecycleReport {
        return {
            status: this.state,
            generation: this.gen,
            losses: this.losses,
            recreations: this.recreations,
            failedAttempts: this.failedAttempts,
            lastReason: this.lastReason,
            lastMessage: this.lastMessage,
            lastRecoveryMs: this.lastRecoveryMs,
            lostForMs: this.state === "ok" || this.lostAtMs === 0 ? null : performance.now() - this.lostAtMs,
            observers: this.registrations.map((r) => r.label),
            observerErrors: [...this.observerErrors],
        };
    }
}

export const gpuDeviceLifecycle = new GpuDeviceLifecycle();

/** Register a holder of device-derived state. Returns an unregister function. */
export function registerGpuDeviceObserver(label: string, obs: GpuDeviceObserver): () => void {
    return gpuDeviceLifecycle.register(label, obs);
}

/** True while a device exists — the guard every GPU path checks before doing work. */
export function gpuDeviceUsable(): boolean {
    return gpuDeviceLifecycle.isUsable();
}
