/**
 * savestateReadiness() — is the session at a point a snapshot could be taken, and if not,
 * the named blockers (issue #66). Read-only.
 */
import type { HarnessService } from "../service";
import { System } from "../../core/system";
import { leaseRegistry } from "../../core/memory/lease-registry";
import { sehDispatchInFlight } from "../../core/seh-dispatch";
import { liveChildProcessCount } from "../../core/child-process";
import { pendingMessageBoxes } from "../../runtime/dialog-bridge";
import { hasWaitingModalPump } from "../../modules/user32/modal-dialog-state";
import { videoEngine } from "../../../video/video-engine";
import { assessReadiness, type Readiness } from "../../savestate/readiness";
import { deleteSlot, listSlots, requestLoadOnNextBoot, saveToSlot, type SafePoint } from "../../savestate/host";
import { CaptureRefusal } from "../../savestate/object-codecs";

export function registerSavestateCommands(svc: HarnessService): void {
    svc.register("savestateReadiness", () => readiness());
    svc.register("savestateSave", async (args) => saveToSlot(String(args[0] ?? "quick"), haltAtSafePoint));
    svc.register("savestateSlots", async () => listSlots());
    svc.register("savestateDelete", async (args) => deleteSlot(String(args[0] ?? "")));
    svc.register("savestateLoadOnNextBoot", async (args) => {
        await requestLoadOnNextBoot(String(args[0] ?? "quick"));
        return { pending: String(args[0] ?? "quick") };
    });
}

function readiness(): Readiness {
    const system = System.getInstance();
    const dispatcher = system.process?.dispatcher;
    return assessReadiness({
        asyncParks: () => dispatcher?.asyncParks() ?? [],
        pendingAsyncRestores: () => dispatcher?.pendingAsyncRestoreCount() ?? 0,
        pendingCallbacks: () => dispatcher?.callbackManager?.pendingCallbackCount() ?? 0,
        suspendedFrames: () => dispatcher?.callbackManager?.suspendedFrames() ?? [],
        modalPumpArmed: hasWaitingModalPump,
        pendingModals: () => pendingMessageBoxes().length,
        writeBufferPendingBytes: () => dispatcher?.writeBufferPendingBytes() ?? 0,
        sehDispatchInFlight,
        activeLeases: () => leaseRegistry.activeLeaseCount(),
        pendingOverlayWrites: () => system.fileSystem.pendingOverlayWrites(),
        liveChildProcesses: liveChildProcessCount,
        videoSessions: () => videoEngine.activeSessionCount(),
    });
}

const HALT_ATTEMPTS = 200;

async function stopped(): Promise<void> {
    const v86 = System.getInstance().process?.v86 as { is_running?: () => boolean } | undefined;
    for (let i = 0; i < 500 && (v86?.is_running?.() ?? false); i++) await new Promise(r => setTimeout(r, 2));
}

async function haltAtSafePoint(): Promise<SafePoint> {
    const g = globalThis as unknown as { __harnessPause?: () => void; __harnessResume?: () => void };
    const wasPaused = System.getInstance().isPaused;
    let last: Readiness | null = null;
    for (let attempt = 0; attempt < HALT_ATTEMPTS; attempt++) {
        g.__harnessPause?.();
        await stopped();
        System.getInstance().process?.dispatcher?.executeWbufQueue();
        last = readiness();
        if (last.ready) {
            return {
                release: () => { if (!wasPaused) g.__harnessResume?.(); },
                stillReady: () => {
                    const now = readiness();
                    if (!now.ready) throw new CaptureRefusal(`savestate: the safe point was lost: ${now.blockers.map(b => `${b.kind} (${b.detail})`).join(", ")}`);
                },
            };
        }
        g.__harnessResume?.();
        await new Promise(r => setTimeout(r, 3 + (attempt % 7)));
    }
    if (wasPaused) g.__harnessPause?.();
    throw new Error(`savestate: no safe point: ${last?.blockers.map(b => `${b.kind} (${b.detail})`).join(", ")}`);
}
