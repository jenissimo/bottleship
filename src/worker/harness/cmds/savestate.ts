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
import { deleteSlot, lastLoad, listSlots, requestLoadOnNextBoot, saveToSlot } from "../../savestate/host";
import { haltAtSafePoint, type HaltIo } from "../../savestate/halt";

export function registerSavestateCommands(svc: HarnessService): void {
    svc.register("savestateReadiness", () => readiness());
    svc.register("savestateSave", async (args) => saveToSlot(String(args[0] ?? "quick"), () => haltAtSafePoint(haltIo()), permanentBlockers));
    svc.register("savestateSlots", async () => listSlots());
    svc.register("savestateDelete", async (args) => deleteSlot(String(args[0] ?? "")));
    svc.register("savestateLoadOnNextBoot", async (args) => {
        await requestLoadOnNextBoot(String(args[0] ?? "quick"));
        return { pending: String(args[0] ?? "quick"), reloadRequired: true, note: "the load runs when the game boots in a fresh worker: reload the tab" };
    });
    svc.register("savestateLastLoad", () => lastLoad());
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

function haltIo(): HaltIo {
    const g = globalThis as unknown as { __harnessPause?: () => void; __harnessResume?: () => void };
    return {
        isPaused: () => System.getInstance().isPaused,
        pause: () => g.__harnessPause?.(),
        resume: () => g.__harnessResume?.(),
        isRunning: () => (System.getInstance().process?.v86 as { is_running?: () => boolean } | undefined)?.is_running?.() ?? false,
        flushWriteBuffer: () => System.getInstance().process?.dispatcher?.executeWbufQueue(),
        readiness,
        sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    };
}

function permanentBlockers(): string[] {
    const out: string[] = [];
    if (liveChildProcessCount() > 0) out.push('a child process is running');
    if (videoEngine.activeSessionCount() > 0) out.push('a video is playing');
    return out;
}
