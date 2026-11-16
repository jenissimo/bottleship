import {Mem} from "../core/memory/mem-accessor";
import {raiseGuestAccessViolation} from "../core/thunking/guest-fault";
import type {ThunkImplementation} from "../core/thunking/thunk-dispatcher";

export class CrtReadFault extends Error {
    constructor(readonly address: number) { super("CRT guest string read failed"); }
}

/** Only these checked readers' faults are converted; unrelated host errors still propagate. */
export function withCrtReadFault(implementation: ThunkImplementation): ThunkImplementation {
    return (ctx, mem, args) => {
        try { return implementation(ctx, mem, args); }
        catch (error) {
            if (!(error instanceof CrtReadFault)) throw error;
            return raiseGuestAccessViolation(ctx, mem, error.address, "r", 0);
        }
    };
}

export function readCrtWString(ptr: number, maxChars: number): string {
    if (!ptr) return "";
    const limit = Math.max(1, Math.min(maxChars >>> 0, 0x10000));
    let text = "";
    for (let i = 0; i < limit; i++) {
        const address = ptr + i * 2, unit = Mem.readUint16(address);
        if (unit === null) throw new CrtReadFault(Mem.firstInaccessibleByte(address, 2, "r"));
        if (unit === 0) break;
        text += String.fromCharCode(unit);
    }
    return text;
}
