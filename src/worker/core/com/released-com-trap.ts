/**
 * The released-COM-object trap.
 *
 * `freeComObject` rewrites a freed object's vptr to a vtable whose every slot is an
 * OUT-trap stub registered here. A guest that dispatches through a stale interface
 * pointer therefore lands on a named fatal that says WHICH interface it used to be
 * and WHICH slot it called — instead of running whatever object later recycled the
 * block, which is silent right up to the point the two interfaces' stack cleanups
 * disagree and the caller walks off its own frame.
 */
import { Process } from "../process";
import { System } from "../system";
import { Logger, LogCategory } from "../logger";
import { installComVtable, ComVtableMethod } from "./install-com-vtable";
import { Mem } from "../memory/mem-accessor";
import {
    lookupReleasedComObject, setReleasedComVtable, getReleasedComVtable, verifyComVtableSlot,
} from "./com-memory";
import { ThunkImplementation } from "../thunking/thunk-dispatcher";

/** Widest COM vtable we publish is well under this; a stale call past it is caught by the guard. */
const RELEASED_SLOT_COUNT = 64;

const MODULE_NAME = "releasedcom";

/**
 * A slot's stack cleanup is unknowable — the whole point is that the guest thinks
 * this is some other interface — so the stubs pop nothing and the handler never
 * returns normally: it routes into the crash funnel. Returning would resume the
 * guest on a frame we cannot balance.
 */
function slotHandler(slot: number): ThunkImplementation {
    return (_ctx, _mem, args) => {
        const thisPtr = (args[0] ?? 0) >>> 0;
        const rec = lookupReleasedComObject(thisPtr);
        const who = rec
            ? `${rec.iface} (owner=${rec.owner}, released ${Math.round(performance.now() - rec.freedAt)}ms ago` +
              (rec.freedBy ? ` at ${rec.freedBy}` : "") + ")"
            : "an unknown COM object";
        const reason =
            `Call through RELEASED COM object 0x${thisPtr.toString(16)}: vtable slot ${slot} of ${who}. ` +
            `The guest kept using this interface pointer after its final Release.`;

        Logger.error(LogCategory.COM, reason);

        const sys = System.getInstance();
        const cpu = sys.process?.v86?.cpu ?? (sys.process?.v86 as any)?.v86?.cpu;
        const eip = (cpu?.instruction_pointer?.[0] ?? 0) >>> 0;
        sys.reportGuestCrash({
            reason,
            eip,
            fault: { faultAddr: thisPtr, lastThunk: `${MODULE_NAME}:Slot${slot}` },
        });
        return 0;
    };
}

/** Does the recorded vtable still hold real OUT-trap stubs in THIS process? */
function trapVtableIsLive(process: Process, vtableAddr: number): boolean {
    const mem = process.getCurrentMemory();
    for (let i = 0; i < RELEASED_SLOT_COUNT; i++) {
        const slot = (Mem.readUint32(vtableAddr + i * 4) ?? 0) >>> 0;
        if (!verifyComVtableSlot(mem, slot)) return false;
    }
    return true;
}

/** Idempotent; safe to call on every vtable registration and after a process reset. */
export function ensureReleasedComTrap(process: Process): void {
    if ((globalThis as any).__noComTrap) return;
    // Verify, don't trust: a worker that builds a SECOND process (launcher re-exec) keeps
    // this module's state but gets fresh THUNK arenas, so a remembered address reads back
    // as zeros — and poisoning with an all-zero vtable turns every later dispatch into
    // `call 0`, which on an identity-mapped address space is a wild jump, not a #PF.
    // Re-installing when the recorded slots no longer hold stubs is what keeps the net
    // from silently becoming the sharpest thing pointed at the guest.
    const known = getReleasedComVtable();
    if (known && trapVtableIsLive(process, known)) return;

    const methods: ComVtableMethod[] = [];
    const handlers: Record<string, ThunkImplementation> = {};
    for (let i = 0; i < RELEASED_SLOT_COUNT; i++) {
        const name = `Slot${i}`;
        methods.push({ name, argCount: 1, stackCleanupBytes: 0 });
        handlers[name] = slotHandler(i);
    }

    const installed = installComVtable(process, {
        moduleName: MODULE_NAME,
        methods,
        handlers,
        logLabel: "released-COM trap",
    });
    if (!installed) {
        Logger.error(LogCategory.COM, "released-COM trap: vtable install failed — stale dispatches stay silent");
        return;
    }
    setReleasedComVtable(installed.vtableAddr);
    Logger.log(LogCategory.COM,
        `released-COM trap installed: vtable=0x${installed.vtableAddr.toString(16)} (${RELEASED_SLOT_COUNT} slots)`);
}
