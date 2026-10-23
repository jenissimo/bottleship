import {System} from "../system";
import {getCPU} from "./thunk-utils";
import type {ThunkResult} from "./thunk-dispatcher";

/** Use only where the native API lets an application buffer fault escape to SEH.
 * The caller publishes any native-observed partial output before dispatching.
 */
export function raiseGuestAccessViolation(
    ctx: {esp: number}, mem: Uint8Array, badAddress: number,
    access: "r" | "w", cleanupBytes: number,
): ThunkResult {
    const system = System.getInstance(), process = system.process;
    const cpu = getCPU(process?.v86);
    const result = cpu && process?.dispatcher?.setupGuestAccessViolationDispatch(
        cpu, mem, ctx.esp, badAddress, access === "w", cleanupBytes,
    );
    if (result) return result;
    system.isExiting = true;
    system.scheduler.exitThread(0xc0000005);
    return {value: 0, terminated: true};
}
