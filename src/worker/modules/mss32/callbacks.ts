import { Logger, LogCategory } from "../../core/logger";
import { MSSContext } from "./context";
import { MSSSample } from "./types";
import { getMemory, makeView } from "./helpers";

/** Invoke EOS_callback (0x4C) with [sample_handle, user_data]; stdcall 8 bytes. */
export function invokeEOSCallback(ctx: MSSContext, sample: MSSSample): void {
    const mem = getMemory(ctx);
    const view = makeView(mem);
    const eos = view.getUint32(sample.handle + 0x4C, true);
    // 0 = no callback, 0xFFFFFFFF = sentinel "none" (real MSS32 init value)
    if (!eos || eos === 0xFFFFFFFF) return;
    const userData = view.getUint32(sample.handle + 0x40, true);

    if (!ctx.insideAilServe) {
        ctx.pendingEOSCallbacks.push({ callback: eos, handle: sample.handle, user: userData });
        Logger.verbose(LogCategory.SYSTEM,
            `MSS32: Queued EOS_callback for sample 0x${sample.handle.toString(16)} (queue size: ${ctx.pendingEOSCallbacks.length})`);
        return;
    }

    const cm = ctx.process?.dispatcher?.callbackManager;
    if (!cm) return;

    const dispatcher = ctx.process?.dispatcher;
    if (dispatcher?.hasActiveAsyncThunks()) {
        ctx.pendingEOSCallbacks.push({ callback: eos, handle: sample.handle, user: userData });
        Logger.verbose(LogCategory.SYSTEM,
            `MSS32: Queued EOS_callback for sample 0x${sample.handle.toString(16)} - async thunk pending`);
        return;
    }

    try {
        cm.invokeCallback(eos, [sample.handle, userData], 0);
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: EOS_callback invoke failed: ${e}`);
    }
}

/**
 * Process pending timer callbacks that were queued from the scheduler timer wheel.
 * Called during _AIL_serve@0 when CPU state is stable.
 * Only processes ONE callback per call to avoid re-entrancy issues.
 */
export function processPendingTimerCallbacks(ctx: MSSContext): boolean {
    if (ctx.pendingTimerCallbacks.length === 0) return false;

    const cm = ctx.process?.dispatcher?.callbackManager;
    if (!cm) return false;

    const pending = ctx.pendingTimerCallbacks.shift();
    if (!pending) return false;

    try {
        cm.invokeCallback(pending.callback, [pending.user], 0);
        Logger.verbose(LogCategory.SYSTEM,
            `MSS32: Processed timer callback 0x${pending.callback.toString(16)} (${ctx.pendingTimerCallbacks.length} remaining)`);
        return true;
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: Timer callback invoke failed: ${e}`);
        return false;
    }
}

/**
 * Process one pending stream callback (AIL_register_stream_callback), queued when an
 * incrementally fed stream reached the end of its source outside a guest call chain.
 * Miles declares AILSTREAMCB as one argument, HSTREAM — do not pass a second.
 */
export function processPendingStreamCallbacks(ctx: MSSContext): boolean {
    if (ctx.pendingStreamCallbacks.length === 0) return false;

    const cm = ctx.process?.dispatcher?.callbackManager;
    if (!cm) return false;

    const pending = ctx.pendingStreamCallbacks.shift();
    if (!pending) return false;

    try {
        cm.invokeCallback(pending.callback, [pending.handle], 0);
        return true;
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: stream callback invoke failed: ${e}`);
        return false;
    }
}

/**
 * Process pending EOS callbacks that were queued from the scheduler timer wheel.
 * Called during _AIL_serve@0 when CPU state is stable.
 * Only processes ONE callback per call to avoid re-entrancy issues.
 */
export function processPendingEOSCallbacks(ctx: MSSContext): boolean {
    if (ctx.pendingEOSCallbacks.length === 0) return false;

    const cm = ctx.process?.dispatcher?.callbackManager;
    if (!cm) return false;

    const pending = ctx.pendingEOSCallbacks.shift();
    if (!pending) return false;

    try {
        cm.invokeCallback(pending.callback, [pending.handle, pending.user], 0);
        Logger.verbose(LogCategory.SYSTEM,
            `MSS32: Processed EOS callback 0x${pending.callback.toString(16)} (${ctx.pendingEOSCallbacks.length} remaining)`);
        return true;
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: EOS callback invoke failed: ${e}`);
        return false;
    }
}
