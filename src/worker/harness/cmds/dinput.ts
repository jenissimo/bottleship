/**
 * DirectInput device readout. Whether the host captures the pointer is decided by the
 * cooperative level the game asked for and by acquisition — neither of which any
 * screenshot shows, and whose log line is long gone by the time input misbehaves.
 */
import type { HarnessService } from "../service";
import { describeDInputDevices } from "../../modules/dinput/dinput";
import { describePointerPolicy } from "../../core/pointer-policy";

export function registerDInputCommands(svc: HarnessService): void {
    svc.register("dinputState", () => ({ devices: describeDInputDevices() }));
    // The guest half of what the host-side `inputSab` readout shows: `inputSab` reports the
    // pointer the user sees and the lock the host took, this reports the facts they were
    // derived from. A disagreement between the two names the broken layer.
    svc.register("pointerPolicy", () => describePointerPolicy());
}
