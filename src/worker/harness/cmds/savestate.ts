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
import { videoEngine } from "../../../video/video-engine";
import { assessReadiness } from "../../savestate/readiness";

export function registerSavestateCommands(svc: HarnessService): void {
    svc.register("savestateReadiness", () => {
        const system = System.getInstance();
        const dispatcher = system.process?.dispatcher;
        return assessReadiness({
            asyncParks: () => dispatcher?.asyncParks() ?? [],
            pendingAsyncRestores: () => dispatcher?.pendingAsyncRestoreCount() ?? 0,
            pendingCallbacks: () => dispatcher?.callbackManager?.pendingCallbackCount() ?? 0,
            pendingModals: () => pendingMessageBoxes().length,
            writeBufferPendingBytes: () => dispatcher?.writeBufferPendingBytes() ?? 0,
            sehDispatchInFlight,
            activeLeases: () => leaseRegistry.activeLeaseCount(),
            pendingOverlayWrites: () => system.fileSystem.pendingOverlayWrites(),
            liveChildProcesses: liveChildProcessCount,
            videoSessions: () => videoEngine.activeSessionCount(),
        });
    });
}
